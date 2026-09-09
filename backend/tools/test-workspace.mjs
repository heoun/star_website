import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleAdminRequest } from "../../worker/admin.js";
import { resolveStaff } from "../../worker/staff.js";
import { createWorkspaceFixtures, ids } from "./workspace-fixtures.mjs";
import { LEASE_REGISTRY } from "../../worker/lease.js";

const fixture = createWorkspaceFixtures();
const realFetch = globalThis.fetch;
globalThis.fetch = fixture.fetch;
// Every email the workspace sends lands here instead of a mailbox.
const sent = [];
fixture.env.LOCAL_EMAIL_SINK = { send: async message => { sent.push(message); } };
const actors = { admin: ["manager", "admin@example.test"], a: ["agent", "agent-a@example.test"], b: ["agent", "agent-b@example.test"], owner: ["landlord", "owner@example.test"], other: ["landlord", "other-owner@example.test"] };
let checks = 0;
const equal = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
async function call(actor, path, method = "GET", body) {
  const [role, email] = actors[actor];
  const req = new Request(`http://localhost/api/admin${path}`, { method, ...(body === undefined ? {} : body instanceof FormData ? { body } : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) });
  const response = await handleAdminRequest(req, { ...fixture.env, DEV_ADMIN_ROLE: role, DEV_ADMIN_EMAIL: email,
    ASSETS: { fetch: async () => new Response(readFileSync(new URL("../../lease/template/lease-template.docx", import.meta.url))) }
  }, { waitUntil: p => p.catch(() => {}) }, new URL(req.url).pathname);
  const payload = response.headers.get("Content-Type")?.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body: payload };
}
async function expected(actor, path, status, method = "GET", body) {
  const result = await call(actor, path, method, body);
  equal(result.status, status, `${actor} ${method} ${path}: ${JSON.stringify(result.body)}`); return result.body;
}
const row = id => fixture.state.applications.find(row => row.id === id);
const action = (actor, id, action, data = {}) => call(actor, `/cases/${id}/actions`, "POST", { action, version: row(id).workspace_version, ...data });
try {
  equal((await expected("admin", "/cases", 200)).cases.length, 4);
  equal((await expected("a", "/cases", 200)).cases.map(row => row.id).sort(), [ids.a, ids.shared].sort());
  equal((await expected("b", "/cases", 200)).cases.map(row => row.id), [ids.b]);

  // What a queue row says without being opened: the next step as an
  // instruction, who holds the case, since when, and what has arrived.
  const queue = await expected("a", "/cases", 200);
  equal(queue.document_types.length > 0, true, "the document checklist rides along for staff");
  const first = queue.cases.find(item => item.id === ids.a);
  equal(first.next_step.label, "Verify Payment, Screening and Documents");
  equal([first.next_step.bucket, first.next_step.owner], ["attention", "you"]);
  equal(typeof first.next_step.since, "string");
  equal([first.move_in, first.lease_term_months, first.email], ["10/01/2026", 12, "casey.morgan@example.test"]);
  equal(first.application_documents.length, 1); equal("path" in first.application_documents[0], false);
  equal((await expected("admin", "/cases", 200)).cases.find(item => item.id === ids.unassigned).next_step.label, "Assign a Responsible Agent");
  const landlordQueue = await expected("owner", "/cases", 200);
  equal(landlordQueue.document_types, [], "landlords get no checklist");
  equal(landlordQueue.cases[0].next_step.label, "Confirm Rental Terms");
  for (const key of ["email", "phone", "move_in", "application_documents"]) equal(key in landlordQueue.cases[0], false, `${key} must not reach landlord rows`);

  // Asking the applicant for something, and noticing when they answer: the
  // request is kept verbatim, and a file uploaded after it turns the case back
  // into the agent's work without anyone touching the workspace.
  const asked = await action("b", ids.b, "request_info", { reason: "Please upload the back of your ID." });
  equal(asked.status, 200, JSON.stringify(asked.body));
  equal(row(ids.b).status, "needs_info");
  equal(row(ids.b).workspace.info_request.message, "Please upload the back of your ID.");
  const waiting = (await expected("b", `/cases/${ids.b}`, 200)).case.next_step;
  equal([waiting.label, waiting.bucket, waiting.owner], ["Waiting for the Applicant", "waiting", "applicant"]);
  const arrived = new Date(Date.now() + 1000).toISOString();
  fixture.state.documents.push({ id: crypto.randomUUID(), application_id: ids.b, path: `${ids.b}/id-back.pdf`, file_name: "id-back.pdf",
    doc_type: "government_id_back", content_type: "application/pdf", size_bytes: 12, created_at: arrived });
  const answered = (await expected("b", `/cases/${ids.b}`, 200)).case.next_step;
  equal([answered.label, answered.bucket, answered.since], ["Review New Documents", "attention", arrived]);
  for (const path of [`/cases/${ids.a}`, `/applications/${ids.a}`, `/documents/${ids.doc}`, `/applications/${ids.a}/ssn`]) await expected("b", path, 404);
  await expected("b", `/lease/document/${ids.a}`, 404, "POST", { mode: "values" });
  await expected("b", `/applications/${ids.a}`, 404, "PATCH", { notes: "intrusion" });
  await expected("b", `/documents/${ids.doc}`, 404, "DELETE");
  await expected("a", `/documents/${ids.doc}`, 200);
  await expected("a", `/applications/${ids.a}/ssn`, 403);
  await expected("a", `/applications/${ids.a}`, 409, "PATCH", { status: "approved" });
  equal((await action("a", ids.a, "assign", { responsible_email: actors.b[1], collaborator_emails: [] })).status, 403);
  equal((await action("a", ids.a, "admin_note", { reason: "forged" })).status, 403);
  equal((await action("admin", ids.a, "admin_note", { reason: "ADMIN-SECRET" })).status, 200);
  const agentDetail = await expected("a", `/cases/${ids.a}`, 200);
  assert(!JSON.stringify(agentDetail).includes("ADMIN-SECRET")); checks++;
  for (const key of ["ssn_encrypted", "submitted", "lease_snapshot"]) equal(key in agentDetail.case, false);
  equal("path" in agentDetail.case.application_documents[0], false);
  equal((await expected("admin", `/cases/${ids.a}`, 200)).case.workspace.admin_note, "ADMIN-SECRET");
  equal((await action("admin", ids.a, "assign", { responsible_email: actors.a[1], collaborator_emails: [actors.b[1]] })).status, 200);
  await expected("b", `/cases/${ids.a}`, 200);
  equal((await action("admin", ids.a, "assign", { responsible_email: actors.a[1], collaborator_emails: [] })).status, 200);
  await expected("b", `/cases/${ids.a}`, 404);
  equal((await action("admin", ids.a, "assign", { responsible_email: actors.owner[1], collaborator_emails: [] })).status, 422);

  equal((await expected("owner", "/cases", 200)).cases.map(row => row.id), [ids.shared]);
  equal((await expected("other", "/cases", 200)).cases, []);
  const ownedProperties = (await expected("owner", "/buildings", 200)).buildings;
  equal(ownedProperties.map(b => b.id), [ids.property]);
  for (const key of ["landlord_signer_email", "onboarding_id", "onboarding_notes", "landlord_email"]) equal(key in ownedProperties[0], false);
  await expected("owner", `/buildings/${ids.otherProperty}`, 404);
  await expected("owner", `/buildings/${ids.property}`, 403, "PATCH", { name: "Not allowed" });
  await expected("owner", `/cases/${ids.a}`, 404);
  for (const path of [`/documents/${ids.doc}`, `/cases/${ids.a}/signed-lease`]) await expected("owner", path, 404);
  await expected("owner", `/applications/${ids.shared}/ssn`, 403);
  const landlord = (await expected("owner", `/cases/${ids.shared}`, 200)).case;
  for (const key of ["email", "phone", "dob", "ssn_last4", "income_note", "application_documents", "workspace", "notes", "decision", "submitted"]) equal(key in landlord, false, `${key} must not reach landlord`);
  equal((await action("other", ids.shared, "landlord_accept")).status, 404);
  equal((await action("owner", ids.shared, "approve")).status, 403);
  // A landlord counters on the rent, the dates or the deposit, and nothing
  // else; the agent then starts from the figures they proposed.
  equal((await action("owner", ids.shared, "landlord_changes", { reason: "Change the due day.", terms: { "rent.due_day": "5" } })).status, 422, "a landlord cannot counter on the due day");
  equal((await action("owner", ids.shared, "landlord_changes", { reason: "Change the entity.", terms: { "landlord.entity_name": "x" } })).status, 403, "nor on a property value");
  equal((await action("owner", ids.shared, "landlord_changes", { reason: "Please use an October 15 start.", terms: { "lease.commencement_date": "2026-10-15", "rent.monthly": "2900", "deposit.amount": "" } })).status, 200);
  equal(row(ids.shared).status, "review");
  equal(row(ids.shared).workspace.landlord_decision.proposed_terms, { "lease.commencement_date": "2026-10-15", "rent.monthly": "2900" }, "blank figures are not proposals");
  await expected("owner", `/cases/${ids.shared}`, 404);
  const countered = (await expected("a", `/cases/${ids.shared}`, 200)).case;
  equal([countered.next_step.label, countered.workspace.landlord_decision.proposed_terms["rent.monthly"]], ["Review the Landlord's Requested Changes", "2900"]);
  equal((await action("a", ids.a, "recommend", { landlord_email: actors.owner[1] })).status, 403);
  equal((await action("a", ids.a, "approve")).status, 403);
  equal((await action("a", ids.a, "checks", { fee: "paid", screening: "received", documents: "verified", credit_score: "900", reason: "out of range" })).status, 422, "a credit score outside 300 to 850 is refused");
  equal((await action("a", ids.a, "checks", { fee: "paid", screening: "received", documents: "verified", credit_score: "720", reason: "Provider X report REF-001; fee receipt F-001, all supporting documents reviewed." })).status, 200);
  equal((await action("a", ids.a, "terms", { terms: { "landlord.entity_name": "Forged entity" } })).status, 403);
  equal((await action("a", ids.a, "terms", { terms: { "lease.commencement_date": "2026-02-30" } })).status, 422);
  const defaultPrice = fixture.state.listings[0].price_amount;
  equal((await action("a", ids.a, "terms", { terms: { "rent.monthly": "2950" } })).status, 200);
  equal(fixture.state.listings[0].price_amount, defaultPrice, "Deal changes cannot modify property defaults");
  equal((await action("a", ids.a, "approve")).status, 200);
  equal((await action("a", ids.a, "recommend", { landlord_email: "not-assigned@example.test" })).status, 422);
  equal((await action("a", ids.a, "recommend", { landlord_email: actors.owner[1] })).status, 200);
  // What the landlord gets to know is fixed when the recommendation goes out,
  // and they hear about it by email: the terms and a link, nothing else.
  const recommendation = row(ids.a).workspace.recommendation;
  equal([recommendation.summary.credit_score, recommendation.summary.annual_income, recommendation.summary.employment_status], [720, "120000", "employed"], "the landlord summary is fixed at send time");
  equal(recommendation.summary.verified, { fee: true, screening: true, documents: true, at: row(ids.a).workspace.checks.at });
  equal(sent.length, 1, "the landlord is emailed once");
  equal([sent[0].to, sent[0].reply_to], [[actors.owner[1]], actors.a[1]], "to the chosen landlord, replies to the agent");
  assert(sent[0].subject.startsWith("Rental recommendation for") && sent[0].text.includes(`/admin/#/applications/${ids.a}`), sent[0].text); checks++;
  for (const secret of ["1234", "212-555", "casey.morgan@example.test", "TEAM-ONLY", "ADMIN-ONLY", "REF-001"]) equal(sent[0].text.includes(secret), false, `${secret} stays out of the email`);
  const offered = (await expected("owner", `/cases/${ids.a}`, 200)).case;
  equal(offered.recommendation.terms["rent.monthly"], "2950");
  equal([offered.recommendation.summary.annual_income, offered.recommendation.sent_by, offered.progress.lease_prepared], ["120000", actors.a[1], false]);
  equal(offered.recommendation.summary.verified.documents, true);
  const oldVersion = row(ids.a).workspace_version;
  equal((await action("owner", ids.a, "landlord_accept")).status, 200);
  equal(row(ids.a).status, "landlord_approved");
  await expected("owner", `/cases/${ids.a}/actions`, 409, "POST", { action: "landlord_accept", version: oldVersion });
  equal((await action("a", ids.a, "terms", { terms: { "rent.monthly": "100" } })).status, 403);
  await expected("admin", `/applications/${ids.a}`, 409, "PATCH", { move_in: "11/01/2026" });
  await expected("a", `/lease/document/${ids.a}`, 409, "POST", { mode: "values", overrides: { "rent.monthly": "100" } });
  equal((await action("a", ids.a, "record_landlord_signature", { reason: "out of order" })).status, 403);
  equal((await action("a", ids.a, "record_tenant_signature", { reason: "SIGN-001" })).status, 403, "Must prepare a complete lease before recording signatures");
  equal((await action("a", ids.a, "prepare_lease", { lease_snapshot: { forged: true } })).status, 409, "Client cannot inject a prepared snapshot or bypass required fields");
  // Fully specified synthetic defaults, only in this isolated fixture.
  const defaults = Object.fromEntries(LEASE_REGISTRY.fields.filter(f => f.source === "manager").map(f => [f.id, f.type === "checkbox" ? false : f.options?.[0] || "Synthetic value"]));
  fixture.fetch = new Proxy(fixture.fetch, { apply(target, self, args) { return String(args[0]).includes("lease_settings_for_listing") ? Promise.resolve(new Response(JSON.stringify({ building: defaults, unit: {} }))) : Reflect.apply(target, self, args); } });
  globalThis.fetch = fixture.fetch;
  await expected("a", `/lease/document/${ids.a}`, 200, "POST", { mode: "final" });
  const prepared = structuredClone(row(ids.a).lease_snapshot);
  assert(row(ids.a).workspace.lease_preparation); checks++;
  defaults["landlord.entity_name"] = "Changed after final download";
  const downloadedValues = await expected("a", `/lease/document/${ids.a}`, 200, "POST", { mode: "values" });
  equal(downloadedValues.values, prepared, "Property changes cannot alter the downloaded final lease");
  const signature = await action("a", ids.a, "record_tenant_signature", { reason: "External signing receipt SIGN-001 confirms all tenants." });
  equal(signature.status, 200, JSON.stringify(signature.body));
  assert(row(ids.a).lease_snapshot); checks++;
  equal(row(ids.a).lease_snapshot, prepared, "Signatures attach to the prepared version");
  const awaiting = (await expected("owner", `/cases/${ids.a}`, 200)).case;
  equal([awaiting.next_step.label, awaiting.next_step.bucket, awaiting.progress.tenants_signed], ["Your Signature Is Next", "attention", true], "the landlord is told their signature is next");
  equal((await action("a", ids.a, "record_landlord_signature", { reason: "External signing receipt SIGN-002 confirms landlord." })).status, 200);
  await expected("a", `/cases/${ids.a}/actions`, 422, "POST", { action: "archive_lease", version: row(ids.a).workspace_version, file: { path: `${ids.a}/executed/forged.pdf` } });
  const form = new FormData(); form.set("version", String(row(ids.a).workspace_version)); form.set("file", new File(["%PDF-1.4 synthetic fully signed lease"], "executed.pdf", { type: "application/pdf" }));
  await expected("a", `/cases/${ids.a}/signed-lease`, 200, "POST", form);
  equal(row(ids.a).status, "lease_signed");
  await expected("owner", `/cases/${ids.a}/signed-lease`, 200);
  await expected("other", `/cases/${ids.a}/signed-lease`, 404);
  await expected("b", `/cases/${ids.a}/signed-lease`, 404);
  const ownerMember = fixture.state.staff.find(s => s.email === actors.owner[1]); ownerMember.property_ids = [];
  equal((await expected("owner", "/buildings", 200)).buildings, [], "Revoked property assignments take effect immediately");
  await expected("owner", `/cases/${ids.a}/signed-lease`, 404);
  ownerMember.property_ids = [ids.property]; ownerMember.active = false;
  await expected("owner", `/cases/${ids.a}`, 404);
  const realIdentity = await resolveStaff(fixture.env, { email: actors.owner[1] }); equal(realIdentity.status, 403, "Inactive real identity denied"); ownerMember.active = true;
  const version = row(ids.b).workspace_version;
  const simultaneous = await Promise.all([1, 2].map(i => call("b", `/cases/${ids.b}/actions`, "POST", { action: "note", version, reason: `Concurrent note ${i}` })));
  equal(simultaneous.map(r => r.status).sort(), [200, 409]);
  await expected("a", `/listings/${ids.otherListing}`, 403, "PATCH", { title: "forged" });
  await expected("a", "/staff", 403);
  const request = await expected("owner", "/requests", 201, "POST", { listing_id: ids.listing, message: "Please change the rent payment day.", field_id: "rent.due_day", proposed_value: "5" });
  equal(request.request.proposal.value, "5");
  await expected("a", `/requests/${request.request.id}`, 403, "PATCH", { publish: true });
  equal((await expected("other", "/requests", 200)).requests, []);
  await expected("owner", "/requests", 404, "POST", { listing_id: ids.otherListing, message: "Please change this other property." });
  console.log(`PASS ${checks} role isolation, field projection, assignments, ordered workflow, stale writes, private files and requests checks`);
} finally { globalThis.fetch = realFetch; }
