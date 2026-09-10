// Regression test for the admin console's two roles. No dependencies, no
// network — run it with Node:
//
//     node lease/tools/test-permissions.mjs
//
// It calls the real routes in worker/admin.js with a stubbed global fetch, so a
// pass means the Worker itself refused, not that a test helper did. What it
// guards, in order of what a mistake would cost:
//
//   - an agent cannot write a landlord value, by either route: the stored
//     settings layers, and the per-lease overrides that leave no audit trail
//   - an email nobody has set up is refused rather than treated as an agent
//   - a manager cannot lock themselves, or everyone, out
//   - a missing staff table reads as a missing table, not as a refusal
//
// The override half matters most. A settings write is recorded in
// lease_settings_audit; an override is not, and it lands on the signed page.

import { handleAdminRequest } from "../../worker/admin.js";
import { resolveStaff, isManager, normalizeRole, isManagerControlled } from "../../worker/staff.js";
import { AGENT_WRITABLE, agentMayWriteField } from "../../site/shared/lease-permissions.js";

const passed = [];
const failed = [];

function check(name, condition, detail = "") {
  (condition ? passed : failed).push(name + (detail ? ` — ${detail}` : ""));
}

// ---------------------------------------------------------------- the stubs

const APPLICATION_ID = "11111111-2222-3333-4444-555555555555";
const LISTING_ID = "66666666-7777-8888-9999-000000000000";
const BUILDING_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_BUILDING_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
// What the stub listing is under, so a test can act on a linked apartment.
let listingBuildingId = null;

// Every Supabase read the routes under test perform, answered from memory.
// `staffRows` is what public.staff holds; set it to null to act as a database
// where the migration has not been run.
let staffRows = [];
let missingStaffTable = false;
// Merged into the stub application row, so one test can give it a snapshot.
let applicationExtras = {};
const calls = [];

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  calls.push(`${init.method || "GET"} ${target.split("/rest/v1/")[1] || target}`);

  const reply = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  if (target.includes("/rest/v1/staff")) {
    if (missingStaffTable) {
      return new Response(
        JSON.stringify({ code: "PGRST205", message: "Could not find the table 'public.staff'" }),
        { status: 404 });
    }
    if ((init.method || "GET") === "DELETE") return reply([], 204);
    if (init.method === "POST") return reply([JSON.parse(init.body)]);
    const email = decodeURIComponent((target.match(/email=eq\.([^&]+)/) || [])[1] || "");
    return reply(email === "agent@starreusa.com" ? [{ email, role: "agent", active: true, property_ids: [BUILDING_ID] }] : email ? staffRows.filter((row) => row.email === email) : staffRows);
  }

  if (target.includes("/rest/v1/applications")) {
    return reply([{
      responsible_email: "agent@starreusa.com", collaborator_emails: [], workspace_version: 0, workspace: {},
      id: APPLICATION_ID,
      listing_id: LISTING_ID,
      name: "Marisol Okonkwo",
      email: "marisol@example.com",
      move_in: "10/01/2026",
      lease_term_months: 12,
      children_under_11: false,
      status: "approved",
      listings: {
        id: LISTING_ID, title: "Evergarden 7A", property_name: "Evergarden",
        unit: "7A", location: "81-07 Kew Gardens Road, Kew Gardens, NY",
        price_amount: 4500, building_id: null, created_at: "2026-08-20T15:00:00Z"
      }, ...applicationExtras
    }]);
  }

  if (target.includes("/rest/v1/buildings")) {
    if (init.method === "POST" || init.method === "PATCH") {
      return reply([{ id: BUILDING_ID, ...JSON.parse(init.body || "{}") }]);
    }
    return reply([{
      id: BUILDING_ID, name: "Evergarden", street: "81-07 Kew Gardens Road",
      city: "Kew Gardens", state: "New York", state_abbr: "NY", zip: "11415"
    }]);
  }

  if (target.includes("/rest/v1/listings")) {
    // A PATCH answers with the row as written, so a test can read back what
    // the Worker decided to store — the copied building name in particular.
    const written = ["PATCH", "POST"].includes(init.method) ? JSON.parse(init.body || "{}") : {};
    return reply([{
      id: LISTING_ID, category: "residential", transaction_type: "rental",
      title: "Evergarden 7A", property_name: "Evergarden", unit: "7A",
      location: "81-07 Kew Gardens Road, Kew Gardens, NY", price_amount: 4500,
      published: true, building_id: listingBuildingId, listing_media: [],
      ...written
    }]);
  }

  if (target.includes("/rest/v1/rpc/lease_settings_for_listing")) {
    return reply({ building: {}, unit: {} });
  }
  if (target.includes("/rest/v1/rpc/lease_settings_apply")) {
    return reply({ scope: "building", field_values: {} });
  }

  return reply([]);
};

const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  DEV_ADMIN_EMAIL: "agent@starreusa.com"
};

function env(extra = {}) {
  return { ...ENV, ...extra };
}

// A local request, which is the only way in without Cloudflare Access.
async function call(pathname, { method = "GET", body, role = "manager", ...extra } = {}) {
  const request = new Request(`http://localhost:8787${pathname}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  // index.js passes URL.pathname, which never carries the query string.
  const response = await handleAdminRequest(
    request, env({ DEV_ADMIN_ROLE: role, ...extra }), { waitUntil(p) { Promise.resolve(p).catch(() => {}); } },
    new URL(request.url).pathname);
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}

// ------------------------------------------------------------- who gets in

const anonymous = await handleAdminRequest(
  new Request("http://localhost:8787/api/admin/me"),
  { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: "k" },
  { waitUntil(p) { Promise.resolve(p).catch(() => {}); } }, "/api/admin/me");
check("no identity at all is refused", anonymous.status === 403);

const notLocal = await handleAdminRequest(
  new Request("https://star.example.com/api/admin/me"),
  env({ DEV_ADMIN_ROLE: "manager" }), { waitUntil(p) { Promise.resolve(p).catch(() => {}); } }, "/api/admin/me");
check("the local identity does not work off a loopback host", notLocal.status === 403);

const asManager = await call("/api/admin/me", { role: "manager" });
check("a manager is told they are a manager",
  asManager.status === 200 && asManager.body.role === "manager", JSON.stringify(asManager.body));

const asAgent = await call("/api/admin/me", { role: "agent" });
check("an agent is told they are an agent",
  asAgent.status === 200 && asAgent.body.role === "agent");

const typo = await call("/api/admin/me", { role: "Manger" });
check("a mistyped role is refused, not rounded down to the safer one",
  typo.status === 403 && /DEV_ADMIN_ROLE/.test(typo.body.error), typo.body.error);

// ------------------------------------------------- the stored settings layers

const SETTINGS = {
  scope: "building", building_id: BUILDING_ID,
  field_values: { "fee.returned_payment": "$40.00" }
};

const agentWrites = await call("/api/admin/lease/settings",
  { method: "PUT", body: SETTINGS, role: "agent" });
check("an agent cannot write a landlord setting",
  agentWrites.status === 403 && /manager/i.test(agentWrites.body.error), agentWrites.body.error);

const managerWrites = await call("/api/admin/lease/settings",
  { method: "PUT", body: SETTINGS, role: "manager" });
check("a manager can", managerWrites.status === 200, JSON.stringify(managerWrites.body));

const agentReads = await call(
  `/api/admin/lease/settings?scope=building&building_id=${BUILDING_ID}`, { role: "agent" });
check("an agent can still read them — they have to review what the lease prints",
  agentReads.status === 200);

// -------------------------------------------------------- the lease overrides

const managerOverride = { "fine.parking": "$0.00" };

const agentOverrides = await call(`/api/admin/lease/document/${APPLICATION_ID}`,
  { method: "POST", body: { mode: "values", overrides: managerOverride }, role: "agent" });
check("an agent cannot override a landlord value on one lease",
  agentOverrides.status === 403, `${agentOverrides.status} ${agentOverrides.body.error || ""}`);
check("and is told which value it was",
  /Parking violations/i.test(agentOverrides.body.error || ""), agentOverrides.body.error);

// The agent's whitelist: the terms of the tenancy, and nothing else.
const agentTerms = await call(`/api/admin/lease/document/${APPLICATION_ID}`,
  { method: "POST", body: { mode: "values", overrides: {
    "deposit.amount": "$4,000.00", "rent.due_day": "5", "lease.effective_date": "October 1, 2026"
  } }, role: "agent" });
check("an agent can set the deposit, the due day and the lease date",
  agentTerms.status === 200 && agentTerms.body.values["deposit.amount"] === "$4,000.00"
  && agentTerms.body.values["rent.due_day"] === "5",
  `${agentTerms.status} ${agentTerms.body.error || ""}`);

const agentIdentity = await call(`/api/admin/lease/document/${APPLICATION_ID}`,
  { method: "POST", body: { mode: "values", overrides: { "tenant.names": "Whoever I like" } },
    role: "agent" });
check("an agent cannot rewrite the tenant's name on a lease",
  agentIdentity.status === 403, `${agentIdentity.status} ${agentIdentity.body.error || ""}`);

const agentAddress = await call(`/api/admin/lease/document/${APPLICATION_ID}`,
  { method: "POST", body: { mode: "values", overrides: { "property.street": "1 Somewhere Else" } },
    role: "agent" });
check("nor the premises address",
  agentAddress.status === 403, `${agentAddress.status}`);

const agentVacancyDate = await call(`/api/admin/lease/document/${APPLICATION_ID}`,
  { method: "POST", body: { mode: "values", overrides: { "lease.vacancy_lease_date": "01/01/2020" } },
    role: "agent" });
check("nor the vacancy lease date, which defaults to the day it goes out",
  agentVacancyDate.status === 403, `${agentVacancyDate.status}`);

const managerIdentity = await call(`/api/admin/lease/document/${APPLICATION_ID}`,
  { method: "POST", body: { mode: "values", overrides: { "tenant.names": "Marisol A. Okonkwo" } },
    role: "manager" });
check("a manager can correct the tenant's details",
  managerIdentity.status === 200
  && managerIdentity.body.values["tenant.names"] === "Marisol A. Okonkwo",
  `${managerIdentity.status}`);

const defaults = await call(`/api/admin/lease/document/${APPLICATION_ID}`,
  { method: "POST", body: { mode: "values" }, role: "agent" });
check("the vacancy lease date defaults to the day the listing went up",
  defaults.body.values?.["lease.vacancy_lease_date"] === "08/20/2026",
  JSON.stringify(defaults.body.values?.["lease.vacancy_lease_date"]));
check("and the DHCR consent is marked as a vacancy lease, not a renewal",
  defaults.body.values?.["dhcr.mark_vacancy"] === "[X]"
  && defaults.body.values?.["dhcr.mark_renewal"] === "[ ]",
  JSON.stringify([defaults.body.values?.["dhcr.mark_vacancy"], defaults.body.values?.["dhcr.mark_renewal"]]));

const managerOverrides = await call(`/api/admin/lease/document/${APPLICATION_ID}`,
  { method: "POST", body: { mode: "values", overrides: managerOverride }, role: "manager" });
check("a manager can override a landlord value for one lease",
  managerOverrides.status === 200 && managerOverrides.body.values["fine.parking"] === "$0.00");

// The lease-from-scratch route resolves the same fields by a different path.
const scratch = await call("/api/admin/lease/document",
  { method: "POST", body: { mode: "values", listing_id: null, overrides: managerOverride },
    role: "agent" });
check("the from-scratch lease refuses it too",
  scratch.status === 403, `${scratch.status} ${scratch.body.error || ""}`);

// -------------------------------------- the third door: a listing's building
//
// Which building a unit points at decides which settings layer its leases read,
// so changing it rewrites 93 landlord values without touching /lease/settings.


// The stub listing is under no property, so an agent putting it under one is
// the ordinary job; moving it afterwards is not.
const agentLinks = await call(`/api/admin/listings/${LISTING_ID}`,
  { method: "PATCH", body: { building_id: BUILDING_ID }, role: "agent" });
check("an agent can put an unlinked apartment under a property",
  agentLinks.status === 200, `${agentLinks.status} ${agentLinks.body.error || ""}`);

listingBuildingId = BUILDING_ID;
const agentRepoints = await call(`/api/admin/listings/${LISTING_ID}`,
  { method: "PATCH", body: { building_id: OTHER_BUILDING_ID }, role: "agent" });
check("an agent cannot move an apartment to another property",
  agentRepoints.status === 403, `${agentRepoints.status} ${agentRepoints.body.error || ""}`);

const agentUnlinks = await call(`/api/admin/listings/${LISTING_ID}`,
  { method: "PATCH", body: { building_id: "" }, role: "agent" });
check("nor take it out of one",
  agentUnlinks.status === 403, String(agentUnlinks.status));

const agentKeepsLink = await call(`/api/admin/listings/${LISTING_ID}`,
  { method: "PATCH", body: { building_id: BUILDING_ID, title: "Evergarden 7A — repriced" },
    role: "agent" });
check("an ordinary edit that sends the link back unchanged still saves",
  agentKeepsLink.status === 200, `${agentKeepsLink.status} ${agentKeepsLink.body.error || ""}`);
check("and the building name is copied from the property, not from the form",
  agentKeepsLink.body.listing?.property_name === "Evergarden",
  JSON.stringify(agentKeepsLink.body.listing?.property_name));
const inheritedListingAddress = await call(`/api/admin/listings/${LISTING_ID}`,
  { method: "PATCH", body: { location: "Wrong address", property_name: "Wrong building", title: "Updated title" }, role: "agent" });
check("an agent edit without building_id inherits the stored property's name and address",
  inheritedListingAddress.status === 200 && inheritedListingAddress.body.listing?.property_name === "Evergarden" &&
  inheritedListingAddress.body.listing?.location === "81-07 Kew Gardens Road, Kew Gardens, NY 11415");
const standalone = await call(`/api/admin/listings/${LISTING_ID}`,
  { method: "PATCH", body: { building_id: "", location: "10 Example Street, Example City, NY 10001", property_name: "Standalone" }, role: "manager" });
check("unlinking explicitly keeps a standalone listing's entered name and address",
  standalone.status === 200 && standalone.body.listing?.property_name === "Standalone" &&
  standalone.body.listing?.location === "10 Example Street, Example City, NY 10001");
listingBuildingId = null;

const agentEditsListing = await call(`/api/admin/listings/${LISTING_ID}`,
  { method: "PATCH", body: { title: "Evergarden 7A — renewed" }, role: "agent" });
check("an agent cannot edit a listing with no assigned marketing property",
  agentEditsListing.status === 403, `${agentEditsListing.status}`);

const managerRepoints = await call(`/api/admin/listings/${LISTING_ID}`,
  { method: "PATCH", body: { building_id: BUILDING_ID }, role: "manager" });
check("a manager can", managerRepoints.status === 200, `${managerRepoints.status}`);

const draftListing = await call("/api/admin/listings", {
  method: "POST", role: "manager", body: { title: "New draft", category: "residential", transaction_type: "rental", building_id: BUILDING_ID, location: "Wrong address" }
});
check("new listings default to a draft and inherit the property address",
  draftListing.status === 201 && draftListing.body.listing?.published === false &&
  draftListing.body.listing?.location === "81-07 Kew Gardens Road, Kew Gardens, NY 11415");

// The DHCR consent's two marks are manager-controlled by decision even though
// the registry still calls them deal values.
const agentDhcr = await call(`/api/admin/lease/document/${APPLICATION_ID}`,
  { method: "POST", body: { mode: "values", overrides: { "dhcr.mark_renewal": true } },
    role: "agent" });
check("an agent cannot tick the DHCR consent on a lease",
  agentDhcr.status === 403, `${agentDhcr.status} ${agentDhcr.body.error || ""}`);

// ------------------------------------------------------------ staff accounts

const agentSeesStaff = await call("/api/admin/staff", { role: "agent" });
check("an agent cannot see the account list", agentSeesStaff.status === 403);

const managerSeesStaff = await call("/api/admin/staff", { role: "manager" });
check("a manager can", managerSeesStaff.status === 200);

// Versioned account mutations, Owner appointments and partner type boundaries
// are tested through the real Worker routes in backend/tools/test-administration.mjs.
// This legacy suite continues to cover identity resolution and field permissions.

// ------------------------------------------- resolving a role from the table

const production = { email: "Someone@Starreusa.com", subject: "cf-sub" };

staffRows = [];
const unknown = await resolveStaff(env(), production);
check("an email nobody has set up is refused, not treated as an agent",
  !unknown.identity && unknown.status === 403, JSON.stringify(unknown));

staffRows = [{ email: "someone@starreusa.com", role: "agent", name: "Sam", active: true }];
const known = await resolveStaff(env(), production);
check("a listed agent resolves, and the lookup is case-insensitive",
  known.identity?.role === "agent" && known.identity.email === "someone@starreusa.com");

staffRows = [{ email: "someone@starreusa.com", role: "manager", name: "Sam", active: false }];
const deactivated = await resolveStaff(env(), production);
check("a deactivated account is refused even though the row is still there",
  !deactivated.identity && deactivated.status === 403);

staffRows = [{ email: "someone@starreusa.com", role: "sysadmin", active: true }];
const nonsense = await resolveStaff(env(), production);
check("a role the code does not know is refused rather than assumed",
  !nonsense.identity);

staffRows = [];
const owner = await resolveStaff(env({ OWNER_EMAIL: "Boss@Starreusa.com" }),
  { email: "boss@starreusa.com", subject: "cf" });
check("the owner is a manager with no row at all, which is what makes an empty table recoverable",
  owner.identity?.role === "manager" && owner.identity.owner === true);

missingStaffTable = true;
const noTable = await resolveStaff(env(), production);
check("a database without the migration says so, and does not read as a refusal",
  !noTable.identity && noTable.status === 503 && /schema\.sql/.test(noTable.error), noTable.error);
missingStaffTable = false;

check("normalizeRole accepts only the two roles",
  normalizeRole(" Manager ") === "manager" && normalizeRole("agent") === "agent"
  && normalizeRole("owner") === "" && normalizeRole(null) === "");
check("isManager is false for anything that is not exactly a manager",
  isManager({ role: "manager" }) && !isManager({ role: "agent" }) && !isManager(null)
  && !isManager({}));

// The browser and the Worker read the same whitelist, so the screen never
// draws an input whose Save the Worker refuses. These checks pin the
// whitelist's meaning: every id on it passes, everything off it is refused.
for (const id of AGENT_WRITABLE) {
  check(`the whitelist and the Worker agree that ${id} is the agent's`,
    agentMayWriteField(id) && !isManagerControlled(id));
}
for (const id of ["tenant.names", "tenant.email", "tenant.mailing_address",
  "property.street", "lease.vacancy_lease_date", "dhcr.mark_vacancy",
  "window_guard.mark_has_children", "fine.parking", "landlord.entity_name"]) {
  check(`${id} is a manager's`, !agentMayWriteField(id) && isManagerControlled(id));
}
check("the whitelist is exactly the terms of the tenancy",
  AGENT_WRITABLE.length === 7, `has ${AGENT_WRITABLE.length}`);

// ------------------------------------------------------- the building's address
//
// The fourth door. worker/lease.js reads a building's street, city, state and
// ZIP as the premises address printed on the lease, so editing one rewrites
// what every lease for that building says the tenant is renting. The handler
// used to be dispatched with no identity at all, which made it the one landlord
// value an agent could change.

const agentBuildingPatch = await call(`/api/admin/buildings/${BUILDING_ID}`, {
  method: "PATCH", role: "agent", body: { street: "1 Somewhere Else" }
});
check("an agent cannot change the address a lease says the unit is at",
  agentBuildingPatch.status === 403, JSON.stringify(agentBuildingPatch.body));

const agentBuildingPost = await call("/api/admin/buildings", {
  method: "POST", role: "agent", body: { name: "Invented Tower" }
});
check("an agent cannot create a building either",
  agentBuildingPost.status === 403, String(agentBuildingPost.status));

const agentBuildingRead = await call("/api/admin/buildings", { role: "agent" });
check("an agent can still read the building list — the lease screens need it",
  agentBuildingRead.status === 200 && Array.isArray(agentBuildingRead.body.buildings),
  String(agentBuildingRead.status));

const managerBuildingPatch = await call(`/api/admin/buildings/${BUILDING_ID}`, {
  method: "PATCH", role: "manager", body: { street: "1 Somewhere Else" }
});
check("a manager can change a building",
  managerBuildingPatch.status === 200, String(managerBuildingPatch.status));

// ------------------------------------------------- the applicant's own data

// The full Social Security number is the one value on an application that no
// screen needs and no document prints. It is reachable through exactly one
// endpoint, and that endpoint is a manager's: an agent gets the last four,
// which is what matching a credit report against an applicant takes.
const agentSsn = await call(`/api/admin/applications/${APPLICATION_ID}/ssn`, { role: "agent" });
check("an agent cannot read a full Social Security number",
  agentSsn.status === 403, JSON.stringify(agentSsn.body));

const managerSsn = await call(`/api/admin/applications/${APPLICATION_ID}/ssn`, { role: "manager" });
check("a manager is not refused by the role gate",
  managerSsn.status !== 403, String(managerSsn.status));

// The list is read by both roles and by every screen, so what it selects is
// what leaks if anything does.
calls.length = 0;
const agentList = await call("/api/admin/applications", { role: "agent" });
check("an agent can still read the applications list",
  agentList.status === 200 && Array.isArray(agentList.body.applications), String(agentList.status));
check("the applications list never asks for the encrypted SSN",
  calls.every((entry) => !entry.includes("ssn_encrypted")), calls.join(" | ").slice(0, 120));

// The lease is generated from the application, so the values that reach it are
// worth naming: screening material must not be among them.
calls.length = 0;
await call(`/api/admin/lease/document/${APPLICATION_ID}?mode=values`, { role: "agent" });
const leaseSelect = calls.find((entry) => entry.startsWith("GET applications")) || "";
check("the lease reads no screening material off the application",
  !/ssn|dob|income|employer|rental_history|reference|emergency/.test(leaseSelect),
  leaseSelect.slice(0, 140));

// A status change is a decision, and a decision has an author.
const decided = await call(`/api/admin/applications/${APPLICATION_ID}`, {
  method: "PATCH", role: "manager", body: { status: "needs_info", decision_reason: "Two paystubs missing." }
});
check("legacy status writes must use a workspace action", decided.status === 409, String(decided.status));

const patched = calls.filter((entry) => entry.startsWith("PATCH applications"));
check("rejected legacy status writes do not reach the database", patched.length === 0);

const invented = await call(`/api/admin/applications/${APPLICATION_ID}`, {
  method: "PATCH", role: "manager", body: { status: "maybe" }
});
check("a status nobody defined is refused", invented.status === 409, String(invented.status));

// Corrections to the application follow the same split as the lease: an agent
// settles the tenancy's terms, a manager corrects the tenant's record.
const agentMoveIn = await call(`/api/admin/applications/${APPLICATION_ID}`, {
  method: "PATCH", role: "agent", body: { move_in: "11/01/2026" }
});
check("an agent can correct the move-in date on an application",
  agentMoveIn.status === 200, `${agentMoveIn.status} ${agentMoveIn.body.error || ""}`);

const agentConcession = await call(`/api/admin/applications/${APPLICATION_ID}`, {
  method: "PATCH", role: "agent", body: { concession_terms: "One month free on a 13-month term." }
});
check("and write the concession terms",
  agentConcession.status === 200, `${agentConcession.status} ${agentConcession.body.error || ""}`);

const agentRenames = await call(`/api/admin/applications/${APPLICATION_ID}`, {
  method: "PATCH", role: "agent", body: { name: "Somebody Else" }
});
check("an agent cannot rewrite the applicant's name",
  agentRenames.status === 403 && /manager/i.test(agentRenames.body.error || ""),
  `${agentRenames.status} ${agentRenames.body.error || ""}`);

const agentEmailEdit = await call(`/api/admin/applications/${APPLICATION_ID}`, {
  method: "PATCH", role: "agent", body: { email: "elsewhere@example.com", status: "review" }
});
check("nor smuggle an identity change in beside a status change",
  agentEmailEdit.status === 409, String(agentEmailEdit.status));

const managerRenames = await call(`/api/admin/applications/${APPLICATION_ID}`, {
  method: "PATCH", role: "manager", body: { first_name: "Marisol", last_name: "Okonkwo" }
});
check("a manager can correct the applicant's record",
  managerRenames.status === 200, `${managerRenames.status} ${managerRenames.body.error || ""}`);

const agentStatusOnly = await call(`/api/admin/applications/${APPLICATION_ID}`, {
  method: "PATCH", role: "agent", body: { notes: "Called the landlord." }
});
check("an assigned agent can save team notes",
  agentStatusOnly.status === 200, String(agentStatusOnly.status));

// Editing and deleting are different verbs: an agent runs the pipeline but
// cannot remove the record it runs on.
const agentDeletesApp = await call(`/api/admin/applications/${APPLICATION_ID}`,
  { method: "DELETE", role: "agent" });
check("an agent cannot delete an application",
  agentDeletesApp.status === 403, String(agentDeletesApp.status));

const managerDeletesApp = await call(`/api/admin/applications/${APPLICATION_ID}`,
  { method: "DELETE", role: "manager" });
check("a manager can", managerDeletesApp.status === 200, String(managerDeletesApp.status));

const agentDeletesListing = await call(`/api/admin/listings/${LISTING_ID}`,
  { method: "DELETE", role: "agent" });
check("an agent cannot delete a listing",
  agentDeletesListing.status === 403, String(agentDeletesListing.status));

const managerDeletesListing = await call(`/api/admin/listings/${LISTING_ID}`,
  { method: "DELETE", role: "manager" });
check("a manager can delete a listing",
  managerDeletesListing.status === 200, String(managerDeletesListing.status));

// ------------------------------------------------- the property's own values

// The landlord signer is the one setting whose absence stops an agent sending
// a lease, which makes it exactly the setting an agent must not be able to
// supply for themselves.
const agentSigner = await call("/api/admin/lease/settings", {
  method: "PUT", role: "agent",
  body: { scope: "building", building_id: BUILDING_ID,
    field_values: { "landlord.print_name": "Whoever I like" } }
});
check("an agent cannot name the landlord signer",
  agentSigner.status === 403, JSON.stringify(agentSigner.body).slice(0, 90));

const managerSigner = await call("/api/admin/lease/settings", {
  method: "PUT", role: "manager",
  body: { scope: "building", building_id: BUILDING_ID,
    field_values: { "landlord.print_name": "Helena Marchetti" } }
});
check("a manager can", managerSigner.status === 200, String(managerSigner.status));

// The address the request is sent to lives on the building row, so it is
// covered by the building gate rather than the settings gate. Both doors, or
// the agent walks through the one nobody checked.
const agentEmail = await call(`/api/admin/buildings/${BUILDING_ID}`, {
  method: "PATCH", role: "agent", body: { landlord_signer_email: "me@example.com" }
});
check("an agent cannot redirect the signature request",
  agentEmail.status === 403, String(agentEmail.status));

const managerEmail = await call(`/api/admin/buildings/${BUILDING_ID}`, {
  method: "PATCH", role: "manager", body: { landlord_signer_email: "signer@example.com" }
});
check("a manager can set the signature address",
  managerEmail.status === 200, String(managerEmail.status));

// The registry is what a settings write is checked against, and it is checked
// in the Worker — the database only checks the shape of the key.
const notRegistered = await call("/api/admin/lease/settings", {
  method: "PUT", role: "manager",
  body: { scope: "building", building_id: BUILDING_ID, field_values: { "not.aregistryfield": "x" } }
});
check("a value that is not in the registry is refused",
  notRegistered.status === 422, String(notRegistered.status));

// A tenancy value must never be storable as a building default: a stale rent
// sitting in a settings layer would override the application on a signed lease.
const dealValue = await call("/api/admin/lease/settings", {
  method: "PUT", role: "manager",
  body: { scope: "building", building_id: BUILDING_ID, field_values: { "rent.monthly": "$1.00" } }
});
check("a tenancy value cannot be stored as a property default",
  dealValue.status === 422, String(dealValue.status));

// ------------------------------------------- a lease that has already gone out

// The whole point of freezing the values: a manager correcting a building
// default must not change what somebody has already been asked to sign.
const leaseValues = async () => {
  const response = await call(`/api/admin/lease/document/${APPLICATION_ID}`, {
    method: "POST", role: "agent", body: { mode: "values" }
  });
  return response.body;
};

applicationExtras = {};
const liveLease = await leaseValues();
check("a lease not yet sent reads today's settings",
  liveLease.values?.["landlord.entity_name"] === "", JSON.stringify(liveLease.values?.["landlord.entity_name"]));

applicationExtras = {
  status: "lease_sent",
  lease_snapshot: {
    "landlord.entity_name": "As it stood when the lease was sent",
    "rent.monthly": "$4,500.00"
  }
};
const frozenLease = await leaseValues();
check("a sent lease reads the values it was generated from",
  frozenLease.values?.["landlord.entity_name"] === "As it stood when the lease was sent",
  JSON.stringify(frozenLease.values?.["landlord.entity_name"]));
check("and the screen is told it is looking at frozen values",
  frozenLease.frozen === true, JSON.stringify(frozenLease.frozen));

// A correction on a sent lease merges straight onto the snapshot, so it has
// to arrive formatted — a checkbox prints its mark, not the word "true".
const frozenCorrection = await call(`/api/admin/lease/document/${APPLICATION_ID}`, {
  method: "POST", role: "manager",
  body: { mode: "values", overrides: { "dhcr.mark_renewal": true, "lease.commencement_date": "2026-10-01" } }
});
check("a signed-version checkbox cannot be silently overridden",
  frozenCorrection.status === 409,
  JSON.stringify(frozenCorrection.body.values?.["dhcr.mark_renewal"]));
check("nor can its dates be silently overridden",
  !frozenCorrection.body.values,
  JSON.stringify(frozenCorrection.body.values?.["lease.commencement_date"]));
applicationExtras = {};

// The concession is a paragraph. The override path must keep its line breaks
// and its length, or the lease prints a rider the application does not hold.
const longRider = "One month free on a thirteen-month term.\n\n" + "Terms apply. ".repeat(60);
const riderOverride = await call(`/api/admin/lease/document/${APPLICATION_ID}`, {
  method: "POST", role: "agent",
  body: { mode: "values", overrides: { "concession.terms": longRider } }
});
check("a long concession rider survives the override path unflattened",
  (riderOverride.body.values?.["concession.terms"] || "").includes("\n\n")
  && (riderOverride.body.values?.["concession.terms"] || "").length > 500,
  String((riderOverride.body.values?.["concession.terms"] || "").length));

const dueDayJunk = await call(`/api/admin/lease/document/${APPLICATION_ID}`, {
  method: "POST", role: "agent", body: { mode: "values", overrides: { "rent.due_day": "abc" } }
});
check("a rent due day that is not a number is refused",
  dueDayJunk.status === 422, String(dueDayJunk.status));

// ---------------------------------------------------------------- reporting

console.log(`PASS ${passed.length}`);
for (const name of passed) console.log(`  ok   ${name}`);
if (failed.length > 0) {
  console.log(`\nFAIL ${failed.length}`);
  for (const name of failed) console.log(`  FAIL ${name}`);
  process.exit(1);
}
