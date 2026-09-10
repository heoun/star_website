import { administrationFixture } from "./administration-fixtures.mjs";
// Synthetic records for isolated HTTP tests and the optional local role demo.
// Never imported by the deployed Worker, never reads .dev.vars or a real database.
export const ids = { property: "11111111-1111-4111-8111-111111111111", otherProperty: "22222222-2222-4222-8222-222222222222",
  listing: "33333333-3333-4333-8333-333333333333", otherListing: "44444444-4444-4444-8444-444444444444",
  a: "55555555-5555-4555-8555-555555555555", b: "66666666-6666-4666-8666-666666666666",
  doc: "77777777-7777-4777-8777-777777777777", unassigned: "88888888-8888-4888-8888-888888888888",
  shared: "99999999-9999-4999-8999-999999999999" };
const today = "2026-09-08T10:00:00Z";
const terms = { "lease.commencement_date": "2026-10-01", "lease.end_date": "2027-09-30", "rent.monthly": "3000", "deposit.amount": "3000", "rent.due_day": "1" };
export function createWorkspaceFixtures(saved) {
  const staff = [
    { email: "admin@example.test", name: "Morgan · Admin", role: "manager", active: true, property_ids: [] },
    { email: "agent-a@example.test", name: "Alex · Agent A", role: "agent", active: true, property_ids: [ids.property] },
    { email: "agent-b@example.test", name: "Jordan · Agent B", role: "agent", active: true, property_ids: [ids.otherProperty] },
    { email: "owner@example.test", name: "Taylor · Landlord", role: "landlord", active: true, property_ids: [ids.property] },
    { email: "other-owner@example.test", name: "Other Landlord", role: "landlord", active: true, property_ids: [ids.property] }
  ];
  const buildings = [{ id: ids.property, name: "Parkside Residences", street: "100 Example Avenue", city: "New York", state: "New York", state_abbr: "NY", zip: "10001", landlord_signer_email: "owner@example.test" },
    { id: ids.otherProperty, name: "Riverside House", street: "200 Example Avenue", city: "New York", state: "New York", state_abbr: "NY", zip: "10001" }];
  const listings = buildings.map((b, i) => ({ id: i ? ids.otherListing : ids.listing, building_id: b.id, title: `${b.name} · ${i ? "4B" : "2A"}`, property_name: b.name, unit: i ? "4B" : "2A", price_amount: 3000, location: b.street, category: "residential", transaction_type: "rental", published: true, description: "Synthetic property for role and workflow verification.", listing_media: [], created_at: today, bedrooms: 2, bathrooms: 1 }));
  const application = (id, name, responsible, listing = listings[0]) => ({ id, name, first_name: name.split(" ")[0], last_name: name.split(" ")[1], listing_id: listing.id,
    listings: listing, email: `${name.replace(" ", ".").toLowerCase()}@example.test`, phone: "212-555-0100", current_address: "10 Example Street", move_in: "10/01/2026", lease_term_months: 12, dob: "01/01/1990", income_note: "120000", employment_status: "employed", current_employer: {}, employment_history: [], rental_history: [], reference_contacts: [], emergency_contacts: [], pets: [], roommates: [], ssn_last4: "1234", ssn_encrypted: "TEST-ONLY-SECRET", submitted: { internal: "ORIGINAL-PRIVATE" }, notes: "TEAM-ONLY", workspace_version: 0,
    responsible_email: responsible, collaborator_emails: [], status: "new", created_at: today, updated_at: today,
    workspace: { terms: { ...terms }, admin_note: "ADMIN-ONLY", activity: [] }, application_documents: [] });
  const applications = [application(ids.a, "Casey Morgan", staff[1].email), application(ids.b, "Robin Chen", staff[2].email, listings[1]), application(ids.unassigned, "Sam Rivera", null), application(ids.shared, "Jamie Brooks", staff[1].email)];
  const shared = applications[3]; shared.status = "sent_to_landlord";
  shared.workspace.review = { by: staff[1].email, at: today };
  shared.workspace.checks = { fee: "paid", screening: "received", documents: "verified", reference: "Synthetic verification example", by: staff[1].email, at: today };
  shared.workspace.recommendation = { tenant_name: shared.name, terms: { ...terms }, property_title: listings[0].title, unit: "2A", landlord_email: staff[3].email, revision: 1, sent_at: today, sent_by: staff[1].email };
  const documents = [{ id: ids.doc, application_id: ids.a, path: `${ids.a}/intake.pdf`, file_name: "identity-example.pdf", doc_type: "government_id_front", content_type: "application/pdf", size_bytes: 12, created_at: today }];
  applications[0].application_documents = documents;
  const state = saved || { staff, buildings, listings, applications, documents, requests: [], files: {}, settings: {} };
  state.onboarding ||= []; state.account_audit ||= []; state.emails ||= [];
  state.staff.forEach(s => s.account_version ??= 0);
  const writes = [];
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const embed = row => ({ ...row, listings: state.listings.find(l => l.id === row.listing_id), application_documents: state.documents.filter(doc => doc.application_id === row.id) });
  const match = (row, query, key) => {
    if (!query.has(key)) return true;
    const condition=query.get(key);
    return condition.startsWith("in.(") ? condition.slice(4,-1).split(",").includes(String(row[key])) : String(row[key]) === condition.replace(/^eq\./, "");
  };
  async function fetchFixture(url, init = {}) {
    const u = new URL(url);
    if (u.hostname !== "workspace-fixture.test") throw new Error("Network disabled in isolated workspace fixtures.");
    const table = u.pathname.split("/").at(-1), q = u.searchParams, method = init.method || "GET", id = q.get("id")?.replace(/^eq\./, "");
    const body = init.body ? JSON.parse(init.body) : {};
    if (method !== "GET") writes.push({ table, method, body });
    const adminResponse = administrationFixture(state, table, method, q, body, response);
    if (adminResponse) return adminResponse;
    if (table === "update_application_workspace") {
      const row = state.applications.find(a => a.id === body.p_id && a.workspace_version === body.p_version);
      if (!row) return response([]);
      Object.assign(row, body.p_patch); row.workspace_version++; row.updated_at = new Date().toISOString();
      return response([embed(row)]);
    }
    if (table === "applications") {
      let rows = state.applications.filter(row => match(row, q, "id") && match(row, q, "workspace_version"));
      if (q.has("or")) { const person = /responsible_email\.eq\."((?:\\.|[^"])*)"/.exec(q.get("or"))?.[1]?.replace(/\\([\\"])/g, "$1"); rows = rows.filter(row => row.responsible_email === person || row.collaborator_emails.includes(person)); }
      if (q.has("listings.building_id")) rows = rows.filter(row => q.get("listings.building_id").includes(embed(row).listings?.building_id));
      if (q.has("workspace->recommendation->>landlord_email")) rows = rows.filter(row => `eq."${row.workspace?.recommendation?.landlord_email}"` === q.get("workspace->recommendation->>landlord_email"));
      if (q.has("status")) rows = rows.filter(row => q.get("status").includes(row.status));
      if (method === "PATCH") rows.forEach(row => { Object.assign(row, body); row.workspace_version++; });
      if (method === "DELETE") state.applications = state.applications.filter(row => !rows.includes(row));
      return response(rows.slice(Number(q.get("offset") || 0), Number(q.get("offset") || 0) + Number(q.get("limit") || 1000)).map(embed));
    }
    if (table === "staff") {
      if (method === "POST") { const row = state.staff.find(r => r.email === body.email); if (row) Object.assign(row, body); else state.staff.push(body); return response([body]); }
      return response(state.staff.filter(row => match(row, q, "email")).slice(Number(q.get("offset") || 0), Number(q.get("offset") || 0) + Number(q.get("limit") || 1000)));
    }
    if (table === "listings") {
      if (method === "POST") {
        const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), listing_media: [], published: false, ...body };
        state.listings.push(row);
        return response([row]);
      }
      const rows = state.listings.filter(row => match(row, q, "id") && (!q.has("building_id") || q.get("building_id").includes(row.building_id)) && (!q.has("published") || row.published));
      if (method === "PATCH") rows.forEach(row => Object.assign(row, body));
      if (method === "DELETE") state.listings = state.listings.filter(row => !rows.includes(row));
      if (q.get("order") === "created_at.desc,id.desc") rows.sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id));
      return response(rows);
    }
    if (table === "create_property_with_defaults") {
      const requests = state.property_creation_requests ||= {};
      const payload = JSON.stringify({property:body.p_property,defaults:body.p_defaults});
      const prior = requests[body.p_token];
      if (prior) {
        if (prior.actor !== body.p_actor || prior.payload !== payload) return response({message:'This creation request was already submitted with different information'},409);
        return response(state.buildings.find(row=>row.id===prior.building_id));
      }
      const row = {id:crypto.randomUUID(),...body.p_property};
      state.buildings.push(row);
      if(Object.keys(body.p_defaults).length) state.settings[row.id] = {...body.p_defaults};
      requests[body.p_token] = {actor:body.p_actor,payload,building_id:row.id};
      return response(row);
    }
    if (table === "buildings") {
      if (method === "POST") { const row = {id:crypto.randomUUID(),...body}; state.buildings.push(row); return response([row]); }
      const rows = state.buildings.filter(row => match(row, q, "id"));
      if (method === "PATCH") rows.forEach(row => Object.assign(row,body));
      return response(rows);
    }
    if (table === "application_documents") {
      const rows = state.documents.filter(row => match(row, q, "id"));
      if (method === "DELETE") state.documents = state.documents.filter(row => !rows.includes(row));
      return response(rows);
    }
    if (table === "lease_settings_for_listing") {
      const listing = state.listings.find(row => row.id === body.p_listing_id);
      return response({ building: state.settings[listing?.building_id] || {}, unit: state.unit_settings?.[listing?.id] || {} });
    }
    if (table === "lease_settings_apply") {
      const store = body.p_scope === "unit" ? (state.unit_settings ||= {}) : state.settings;
      const key = body.p_scope === "unit" ? body.p_listing_id : body.p_building_id;
      store[key] = {...store[key],...body.p_patch};
      return response({ scope:body.p_scope,field_values:store[key] });
    }
    if (table === "lease_settings") {
      const buildingId = (q.get("building_id") || "").replace(/^eq\./, "");
      return response(state.settings[buildingId] ? [{ scope: "building", building_id: buildingId, field_values: state.settings[buildingId] }] : []);
    }
    if (table === "publish_property_change_request") {
      const row = state.requests.find(row => row.id === body.p_id);
      if (!row?.proposal || !["open", "in_progress"].includes(row.status)) return response({ error: "Not publishable" }, 409);
      const values = state.settings[row.building_id] || {};
      if ((values[row.proposal.field_id] ?? null) !== row.proposal.previous_value) return response({ error: "Default changed" }, 409);
      values[row.proposal.field_id] = row.proposal.value; state.settings[row.building_id] = values;
      Object.assign(row, { status: "resolved", response: "Approved and published to property defaults.", updated_by: body.p_actor });
      return response(row);
    }
    if (table === "listing_change_requests") {
      if (method === "POST") { const row = { id: crypto.randomUUID(), created_at: today, ...body }; state.requests.unshift(row); return response([row]); }
      const rows = state.requests.filter(row => match(row, q, "id") && match(row, q, "created_by"));
      if (method === "PATCH") rows.forEach(row => Object.assign(row, body));
      return response(rows);
    }
    throw new Error(`Unexpected fixture endpoint: ${table}`);
  }
  const bucket = {
    async get(path) { const file = state.files[path]; return file ? { body: Uint8Array.from(file), httpMetadata: { contentType: "application/pdf" } } : null; },
    async put(path, stream) { state.files[path] = [...new Uint8Array(await new Response(stream).arrayBuffer())]; },
    async delete(path) { delete state.files[path]; }
  };
  state.files[`${ids.a}/intake.pdf`] ||= [...new TextEncoder().encode("%PDF-1.4 synthetic")];
  return { state, writes, fetch: fetchFixture, env: { SUPABASE_URL: "https://workspace-fixture.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only", DEV_ADMIN_EMAIL: staff[0].email, DEV_ADMIN_ROLE: "manager", DEV_SUPABASE_LABEL: "Isolated demo · synthetic records", APPLICANT_DOCS: bucket } };
}
