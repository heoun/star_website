// The applicant's side of "request information": what the portal shows them,
// and that a database without the workspace column still lists applications.
// No network, no database: the one read is answered by a stub.
import assert from "node:assert/strict";
import { toPortalApplication } from "../../worker/portal.js";
import { fetchApplicationsByEmail } from "../../worker/supabase.js";

let checks = 0;
const ok = (value, label) => { assert(value, label); checks++; };
const row = {
  id: "app-1", name: "Casey Morgan", email: "casey@example.test", status: "needs_info", created_at: "2026-09-09T00:00:00Z",
  move_in: "10/01/2026", lease_term_months: 12, employment_status: "employed",
  listings: { title: "Parkside 2A", property_name: "Parkside Residences", unit: "2A", location: "100 Example Avenue" },
  application_documents: [{ id: "d1", doc_type: "government_id_front", file_name: "id.pdf", size_bytes: 12, created_at: "2026-09-08T00:00:00Z", path: "app-1/id.pdf" }],
  notes: "TEAM-ONLY",
  workspace: { info_request: { message: "Please upload the back of your ID.", at: "2026-09-09T01:00:00Z", by: "agent-a@example.test" },
    admin_note: "ADMIN-ONLY", checks: { reference: "REF-SECRET" } }
};

const shown = toPortalApplication(row);
ok(shown.request.message === "Please upload the back of your ID." && shown.request.at === "2026-09-09T01:00:00Z", "the request reaches the applicant while it stands");
ok(!("workspace" in shown) && !("notes" in shown), "nothing else from the workspace does");
const text = JSON.stringify(shown);
for (const secret of ["TEAM-ONLY", "ADMIN-ONLY", "REF-SECRET", "agent-a@example.test", "app-1/id.pdf"]) ok(!text.includes(secret), `${secret} stays inside`);
ok(toPortalApplication({ ...row, status: "review" }).request === null, "a request that has moved on is no longer shown");
ok(toPortalApplication({ ...row, workspace: {} }).request === null, "no request, nothing shown");

// The column is asked for once. A database that lacks it is read without it
// from then on, and the applicant still sees their applications.
const selects = [];
globalThis.fetch = async (url) => {
  const select = new URL(url).searchParams.get("select");
  selects.push(select);
  if (select.includes("workspace")) {
    return new Response(JSON.stringify({ code: "42703", message: "column applications.workspace does not exist" }), { status: 400 });
  }
  return new Response(JSON.stringify([row]), { status: 200, headers: { "Content-Type": "application/json" } });
};
const env = { SUPABASE_URL: "https://portal-fixture.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" };
const rows = await fetchApplicationsByEmail(env, "casey@example.test");
ok(rows.length === 1, "the list still arrives");
ok(selects[0].includes("workspace") && !selects[1].includes("workspace"), "the missing column is dropped and the read retried");
await fetchApplicationsByEmail(env, "casey@example.test");
ok(selects.length === 3 && !selects[2].includes("workspace"), "and is not asked for again");
console.log(`PASS ${checks} portal request visibility and column fallback checks`);
