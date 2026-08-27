// Regression test for the rental application endpoint. No dependencies, no
// network — run it with Node:
//
//     node lease/tools/test-apply.mjs
//
// It calls worker/apply.js's real route with a stubbed global fetch, so a pass
// means the Worker itself refused, not that a test helper did. What it guards,
// in order of what a mistake would cost:
//
//   - the Social Security Number — or the passport number standing in for
//     one — reaches Supabase as ciphertext and reaches a log line, an email
//     or an error message not at all
//   - a body that is not JSON is answered with a page rather than parsed. That
//     is the no-JavaScript fallback, and it is also the CSRF defence: an HTML
//     form cannot set Content-Type: application/json whatever it does with
//     enctype, so no cross-site form can reach this route
//   - the required rules are the ones the form enforces — two references, a
//     current landlord, an applicant over 18, and the work-or-school branch:
//     an employer and an income for one answer, a school for the other
//   - without the encryption key nothing is accepted at all
//
// The SSNs here are the canonical never-issued test numbers. No real one
// belongs in a test file, a fixture, or a log.

import { handleApplication, handleRoommateInvites } from "../../worker/apply.js";
import { decryptSsn } from "../../worker/ssn.js";

const passed = [];
const failed = [];

function check(name, condition, detail = "") {
  (condition ? passed : failed).push(name + (detail ? ` — ${detail}` : ""));
}

// ---------------------------------------------------------------- the stubs

const LISTING_ID = "12341234-5678-9abc-def0-0123456789ab";
const ACCOUNT = "applicant@example.invalid";
// Never issued: 000 is not a valid area number, and 666 never will be.
const TEST_SSN = "000112222";

let inserted = [];
let sentEmails = [];
let insertFails = false;
let published = true;
let bedroomsValue = null;
let failEmailTo = null;
const logs = [];

const realError = console.error;
console.error = (...parts) => { logs.push(parts.map(String).join(" ")); };

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const reply = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  if (target.includes("/auth/v1/user")) {
    return reply({ email: ACCOUNT });
  }

  if (target.includes("/rest/v1/listings")) {
    return reply(published
      ? [{
        id: LISTING_ID, category: "residential", transaction_type: "rental",
        title: "Evergarden 7A", building_name: "Evergarden", unit: "7A",
        location: "81-07 Kew Gardens Road, Kew Gardens, NY", price_amount: 4500,
        published: true, position: 0, building_id: null, listing_media: [],
        ...(bedroomsValue === null ? {} : { bedrooms: bedroomsValue })
      }]
      : []);
  }

  if (target.includes("/rest/v1/applications")) {
    if (insertFails) {
      return new Response(JSON.stringify({
        code: "23502",
        message: "null value in column \"phone\" violates not-null constraint",
        details: `Failing row contains (1, ${ACCOUNT}, 000-11-2222, 2222, Testy McTestface).`
      }), { status: 400 });
    }
    const row = JSON.parse(init.body);
    inserted.push(row);
    return reply([{ id: "row-1", ...row }]);
  }

  if (target.includes("api.resend.com")) {
    const message = JSON.parse(init.body);
    if (failEmailTo && [].concat(message.to).includes(failEmailTo)) {
      return reply({ error: "delivery refused" }, 500);
    }
    sentEmails.push(message);
    return reply({ id: "email-1" });
  }

  return reply([]);
};

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  SUPABASE_ANON_KEY: "anon-key",
  APP_ENCRYPTION_KEY: KEY,
  RESEND_API_KEY: "resend-key"
};

function cookie() {
  const packed = JSON.stringify({ at: "access-token", rt: "refresh-token" });
  return btoa(String.fromCharCode(...new TextEncoder().encode(packed)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const waiting = [];
const ctx = { waitUntil(promise) { waiting.push(Promise.resolve(promise).catch(() => {})); } };

// Deliberately not a loopback host: on one, email.js prints instead of sending,
// and what these tests need to read is what would actually have gone out.
async function post(body, { contentType = "application/json", session = true, env = ENV } = {}) {
  const headers = {};
  if (contentType) headers["Content-Type"] = contentType;
  if (session) headers.Cookie = `star_portal=${cookie()}`;

  const request = new Request("https://star.example.com/api/apply", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  const response = await handleApplication(request, env, ctx);
  await Promise.all(waiting.splice(0));
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed, type: response.headers.get("Content-Type") || "" };
}

function application(overrides = {}) {
  return {
    listing_id: LISTING_ID,
    first_name: "Testy",
    last_name: "McTestface",
    dob: "04/02/1990",
    id_type: "ssn",
    id_number: TEST_SSN,
    phone: "(718) 555-0123",
    current_address: "1 Test Street, Queens, NY 11415",
    move_in: "11/01/2026",
    lease_term_months: 12,
    children_under_11: false,
    wants_window_guards: false,
    employment_status: "employed",
    income_note: "$120,000",
    current_employer: {
      employer: "Test Industries",
      position: "Analyst",
      start: "06/2021",
      supervisor_name: "Sue Pervisor",
      supervisor_phone: "(212) 555-0150",
      supervisor_email: "sue.pervisor@example.invalid"
    },
    employment_history: [],
    rental_history: [{
      landlord_name: "Lana Landlord",
      contact: "Lana Landlord",
      address: "9 Old Street, Brooklyn, NY 11201",
      landlord_phone: "(212) 555-0190",
      landlord_email: "lana@example.invalid",
      start: "08/2022",
      monthly_rent: "$2,500"
    }],
    reference_contacts: [
      { name: "Ada Tester", relationship: "Colleague", phone: "(212) 555-0100",
        email: "ada@example.invalid" },
      { name: "Ben Tester", relationship: "Previous landlord", phone: "(212) 555-0101",
        email: "ben@example.invalid" }
    ],
    roommates: [],
    pets: [],
    message: "",
    ...overrides
  };
}

function studentApplication(overrides = {}) {
  return application({
    employment_status: "student",
    income_note: undefined,
    current_employer: undefined,
    employment_history: undefined,
    student: {
      school_name: "Test University",
      major: "Economics",
      entry_year: "2024",
      graduation_year: "2026",
      country: "Testland"
    },
    ...overrides
  });
}

const reset = () => {
  inserted = []; sentEmails = []; logs.length = 0;
  insertFails = false; published = true; bedroomsValue = null; failEmailTo = null;
};

// ------------------------------------------------- a body that is not JSON
//
// This is the shape a browser sends when the page's JavaScript did not run,
// and the shape a cross-site form is limited to. Both are refused before a
// single field is read.

reset();
const urlencoded = await post("first_name=Testy&ssn=000112222", {
  contentType: "application/x-www-form-urlencoded"
});
check("a form-encoded body is refused", urlencoded.status === 415, String(urlencoded.status));
check("and is answered with a page, not a JSON blob",
  urlencoded.type.startsWith("text/html"), urlencoded.type);
check("the page says what to do about it",
  /JavaScript/i.test(urlencoded.body.raw || ""), (urlencoded.body.raw || "").slice(0, 60));
check("and nothing was stored", inserted.length === 0, String(inserted.length));

// text/plain is the one enctype that can carry a body parsing as JSON, which
// is how a cross-site form would try to reach a JSON endpoint.
reset();
const plain = await post(application(), { contentType: "text/plain" });
check("a text/plain body is refused", plain.status === 415, String(plain.status));
check("nothing was stored for it", inserted.length === 0, String(inserted.length));

reset();
const noType = await post(application(), { contentType: null });
check("a body with no content type is refused", noType.status === 415, String(noType.status));

// ------------------------------------------------------------ who may apply

reset();
const anonymous = await post(application(), { session: false });
check("applying without an account is refused", anonymous.status === 401, String(anonymous.status));
check("and stores nothing", inserted.length === 0, String(inserted.length));

reset();
const noKey = await post(application(), { env: { ...ENV, APP_ENCRYPTION_KEY: "" } });
check("without the encryption key nothing is accepted", noKey.status === 503, String(noKey.status));
check("and no application is stored unencrypted", inserted.length === 0, String(inserted.length));

// ------------------------------------------------------------ the rules
//
// These are the rules the form enforces step by step. They are checked again
// here because the form is not what protects the database.

const refused = async (name, overrides, expect) => {
  reset();
  const result = await post(application(overrides));
  check(name, result.status === 422 && new RegExp(expect, "i").test(result.body.error || ""),
    `${result.status} ${result.body.error || ""}`);
  check(`${name} — nothing stored`, inserted.length === 0);
};

await refused("a repeated-digit SSN is refused", { id_number: "111111111" }, "SSN");
await refused("a short SSN is refused", { id_number: "12345" }, "SSN");
await refused("an applicant under 18 is refused", { dob: "04/02/2015" }, "date of birth");
await refused("a single reference is refused", {
  reference_contacts: [{ name: "Ada Tester", relationship: "Colleague",
    phone: "(212) 555-0100", email: "ada@example.invalid" }]
}, "references");
await refused("a reference without a relationship or email is refused", {
  reference_contacts: [{ name: "Ada Tester", relationship: "Colleague",
    phone: "(212) 555-0100", email: "ada@example.invalid" },
  { name: "Ben Tester", phone: "(212) 555-0101" }]
}, "references");
await refused("no rental history at all is refused", { rental_history: [] }, "rental history");
await refused("a landlord without a contact or rent is refused", {
  rental_history: [{ landlord_name: "Lana Landlord",
    address: "9 Old Street, Brooklyn, NY 11201", landlord_phone: "(212) 555-0190" }]
}, "rental history");
await refused("a landlord with no phone and no email is refused", {
  rental_history: [{ landlord_name: "Lana Landlord", contact: "Lana Landlord",
    address: "9 Old Street, Brooklyn, NY 11201", start: "08/2022", monthly_rent: "$2,500" }]
}, "a phone or an email");

// One way to reach the landlord is enough; the record below carries a phone
// and no email, and is accepted.
reset();
const phoneOnly = await post(application({
  rental_history: [{ landlord_name: "Lana Landlord", contact: "Lana Landlord",
    address: "9 Old Street, Brooklyn, NY 11201", landlord_phone: "(212) 555-0190",
    start: "08/2022", monthly_rent: "$2,500" }]
}));
check("a landlord with a phone and no email is accepted",
  phoneOnly.status === 201, `${phoneOnly.status} ${phoneOnly.body.error || ""}`);
check("and the contact person is stored",
  inserted[0]?.rental_history?.[0]?.contact === "Lana Landlord",
  JSON.stringify(inserted[0]?.rental_history?.[0] || null));
await refused("an employed applicant with no employer is refused",
  { current_employer: { employer: "" } }, "current employer");
await refused("an employed applicant with no supervisor is refused", {
  current_employer: { employer: "Test Industries", position: "Analyst", start: "06/2021" }
}, "supervisor");
await refused("an employed applicant with no income is refused",
  { income_note: "" }, "annual income");
await refused("a pet without a breed and weight is refused",
  { pets: [{ type: "dog" }] }, "pets");
await refused("a roommate without a phone or email is refused",
  { roommates: [{ first_name: "Roo", last_name: "Mate" }] }, "roommates");
await refused("a lease term of nought months is refused", { lease_term_months: 0 }, "lease term");
await refused("an unanswered children question is refused",
  { children_under_11: "no" }, "children 10 or younger");
await refused("an unanswered work-or-school question is refused",
  { employment_status: "" }, "working or student");

// -------------------------------------------------- the work-or-school branch
//
// A student has no employer to name, so the form asks about their school
// instead — and the Worker holds each answer to its own branch's rules.

const refusedStudent = async (name, overrides, expect) => {
  reset();
  const result = await post(studentApplication(overrides));
  check(name, result.status === 422 && new RegExp(expect, "i").test(result.body.error || ""),
    `${result.status} ${result.body.error || ""}`);
  check(`${name} — nothing stored`, inserted.length === 0);
};

await refusedStudent("a student without a school name is refused", {
  student: { school_name: "", major: "Economics", entry_year: "2024",
    graduation_year: "2026", country: "Testland" }
}, "school name");
await refusedStudent("a student with a wordy entry year is refused", {
  student: { school_name: "Test University", major: "Economics", entry_year: "last fall",
    graduation_year: "2026", country: "Testland" }
}, "entry year");

reset();
const asStudent = await post(studentApplication());
check("a student application is accepted with no employer at all",
  asStudent.status === 201, `${asStudent.status} ${asStudent.body.error || ""}`);
const studentRow = inserted[0] || {};
check("and stores the school record",
  studentRow.student?.school_name === "Test University", JSON.stringify(studentRow.student));
check("is marked a student", studentRow.employment_status === "student");
check("and invents no employer", studentRow.current_employer === null,
  JSON.stringify(studentRow.current_employer));

// ---------------------------------------------------- a passport instead
//
// International students rarely have an SSN; the same field takes a passport
// number, encrypted the same way, with `id_type` saying which it holds.

reset();
const withPassport = await post(application({ id_type: "passport", id_number: "e 1234 5678" }));
check("a passport number is accepted in place of an SSN",
  withPassport.status === 201, `${withPassport.status} ${withPassport.body.error || ""}`);
const passportRow = inserted[0] || {};
check("cleaned to letters and digits, encrypted, never stored readable",
  JSON.stringify(passportRow).includes("E12345678") === false
  && await decryptSsn(ENV, passportRow.ssn_encrypted) === "E12345678");
check("with its own last four for the console",
  passportRow.ssn_last4 === "5678", String(passportRow.ssn_last4));
check("and marked a passport", passportRow.id_type === "passport", String(passportRow.id_type));

await refused("a malformed passport number is refused",
  { id_type: "passport", id_number: "e1" }, "passport");

// ------------------------------------------------ window guards and roommates

reset();
const withExtras = await post(application({
  wants_window_guards: true,
  roommates: [{ first_name: "Roo", last_name: "Mate", phone: "(212) 555-0160",
    email: "roo.mate@example.invalid" }]
}));
check("window guards and a roommate are accepted",
  withExtras.status === 201, `${withExtras.status} ${withExtras.body.error || ""}`);
const extrasRow = inserted[0] || {};
check("the window guard request is stored",
  extrasRow.wants_window_guards === true, String(extrasRow.wants_window_guards));
check("and the roommate with it",
  extrasRow.roommates?.[0]?.first_name === "Roo", JSON.stringify(extrasRow.roommates));

reset();
published = false;
const unlisted = await post(application());
check("a property no longer listed cannot be applied for", unlisted.status === 404, String(unlisted.status));
published = true;

// ------------------------------------------------------ the number itself

reset();
const good = await post(application());
check("a complete application is accepted", good.status === 201, `${good.status} ${good.body.error || ""}`);

const row = inserted[0] || {};
check("the digits never reach the database",
  JSON.stringify(row).includes(TEST_SSN) === false);
check("what is stored is ciphertext",
  typeof row.ssn_encrypted === "string" && row.ssn_encrypted !== TEST_SSN && row.ssn_encrypted.length > 20,
  String(row.ssn_encrypted).slice(0, 12));
check("which the key, and only the key, turns back",
  await decryptSsn(ENV, row.ssn_encrypted) === TEST_SSN);
check("a wrong key gets nothing",
  await decryptSsn({ APP_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32))) },
    row.ssn_encrypted) === null);
check("the last four are stored on their own for the console",
  row.ssn_last4 === "2222", String(row.ssn_last4));
check("the application is filed under the session's email, not the form's",
  row.email === ACCOUNT, String(row.email));

check("two emails go out", sentEmails.length === 2, String(sentEmails.length));
const mail = JSON.stringify(sentEmails);
check("neither carries the number", mail.includes(TEST_SSN) === false);
check("nor the last four", mail.includes("2222") === false);
check("nor the applicant's address", mail.includes("1 Test Street") === false);
check("nor a reference", mail.includes("Ada Tester") === false);
check("nothing was logged at all", logs.length === 0, logs.join(" | "));

// --------------------------------------------------- what a failure says

reset();
insertFails = true;
const broke = await post(application());
check("a failed insert is a plain apology", broke.status === 500
  && /could not be saved/i.test(broke.body.error || ""), JSON.stringify(broke.body));
check("which leaks no internals",
  /23502|not-null|constraint|Supabase/i.test(broke.body.error || "") === false, broke.body.error);
const logged = logs.join(" | ");
check("and the log carries no row values", logged.includes("2222") === false, logged);
check("nor the applicant's name", logged.includes("McTestface") === false, logged);
check("but still says what failed", /Application insert failed/.test(logged), logged);
insertFails = false;

// ------------------------------------------------------------- the honeypot

reset();
const bot = await post(application({ website: "https://buy-followers.example" }));
check("a filled honeypot is told nothing", bot.status === 200 && bot.body.ok === true);
check("and stores nothing", inserted.length === 0, String(inserted.length));

// ------------------------------------------------------ roommate invitations
//
// Sent from the roommate step before any application exists, so the route
// stands on its own: it needs a signed-in applicant, a real published
// listing, addresses that parse, and no more roommates than the bedrooms
// allow.

async function postInvite(body, { session = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (session) headers.Cookie = `star_portal=${cookie()}`;
  const request = new Request("https://star.example.com/api/apply/invite", {
    method: "POST", headers, body: JSON.stringify(body)
  });
  const response = await handleRoommateInvites(request, ENV);
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}

reset();
const inviteAnon = await postInvite({ listing_id: LISTING_ID,
  roommates: [{ first_name: "Roo", last_name: "Mate", email: "roo@example.invalid" }] },
{ session: false });
check("inviting without an account is refused", inviteAnon.status === 401, String(inviteAnon.status));
check("and no invitation goes out", sentEmails.length === 0, String(sentEmails.length));

reset();
bedroomsValue = "3";
const invited = await postInvite({ listing_id: LISTING_ID, roommates: [
  { first_name: "Roo", last_name: "Mate", email: "roo@example.invalid" },
  { first_name: "Coo", last_name: "Mate", email: "coo@example.invalid" }
] });
check("two roommates are invited",
  invited.status === 200 && invited.body.sent?.length === 2 && invited.body.failed?.length === 0,
  `${invited.status} ${JSON.stringify(invited.body)}`);
check("one email per roommate goes out", sentEmails.length === 2, String(sentEmails.length));
check("addressed to the roommate", sentEmails[0]?.to?.[0] === "roo@example.invalid",
  JSON.stringify(sentEmails[0]?.to));
check("naming the inviter's account", (sentEmails[0]?.text || "").includes(ACCOUNT),
  (sentEmails[0]?.text || "").slice(0, 80));
check("and pointing at the apply page",
  (sentEmails[0]?.text || "").includes(`/apply/?id=${LISTING_ID}`),
  (sentEmails[0]?.text || "").slice(0, 200));

reset();
bedroomsValue = "3";
const doubled = await postInvite({ listing_id: LISTING_ID, roommates: [
  { first_name: "Roo", last_name: "Mate", email: "roo@example.invalid" },
  { first_name: "Roo", last_name: "Again", email: "ROO@example.invalid" }
] });
check("the same address is invited once", doubled.status === 200 && sentEmails.length === 1,
  `${doubled.status} ${sentEmails.length}`);

reset();
bedroomsValue = "3";
failEmailTo = "coo@example.invalid";
const partial = await postInvite({ listing_id: LISTING_ID, roommates: [
  { first_name: "Roo", last_name: "Mate", email: "roo@example.invalid" },
  { first_name: "Coo", last_name: "Mate", email: "coo@example.invalid" }
] });
check("a partial failure names who was reached",
  partial.status === 200 && partial.body.sent?.[0] === "roo@example.invalid"
    && partial.body.failed?.[0] === "coo@example.invalid" && partial.body.ok === false,
  `${partial.status} ${JSON.stringify(partial.body)}`);
check("and only the delivered one went out", sentEmails.length === 1, String(sentEmails.length));

reset();
bedroomsValue = "0";
const studio = await postInvite({ listing_id: LISTING_ID,
  roommates: [{ first_name: "Roo", last_name: "Mate", email: "roo@example.invalid" }] });
check("a studio has no room for a roommate", studio.status === 422, String(studio.status));

reset();
const badEmail = await postInvite({ listing_id: LISTING_ID,
  roommates: [{ first_name: "Roo", last_name: "Mate", email: "not-an-email" }] });
check("a bad roommate email is refused", badEmail.status === 422, String(badEmail.status));
check("and nothing goes out for it", sentEmails.length === 0, String(sentEmails.length));

reset();
bedroomsValue = "2";
const tooMany = await postInvite({ listing_id: LISTING_ID, roommates: [
  { first_name: "Roo", last_name: "Mate", email: "roo@example.invalid" },
  { first_name: "Coo", last_name: "Mate", email: "coo@example.invalid" }
] });
check("more roommates than the bedrooms allow is refused", tooMany.status === 422, String(tooMany.status));
check("and no invitation is delivered", sentEmails.length === 0, String(sentEmails.length));

reset();
published = false;
const inviteGone = await postInvite({ listing_id: LISTING_ID,
  roommates: [{ first_name: "Roo", last_name: "Mate", email: "roo@example.invalid" }] });
check("an unpublished listing invites nobody", inviteGone.status === 404, String(inviteGone.status));

// ---------------------------------------------------------------- reporting

console.error = realError;
console.log(`PASS ${passed.length}`);
for (const name of passed) console.log(`  ok   ${name}`);
if (failed.length > 0) {
  console.log(`\nFAIL ${failed.length}`);
  for (const name of failed) console.log(`  FAIL ${name}`);
  process.exit(1);
}
