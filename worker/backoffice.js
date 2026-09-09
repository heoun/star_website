// Landlords use an explicit read allowlist; new staff endpoints are denied
// automatically. Ownership is resolved from current staff assignments each request.
import { fetchListings, fetchListing, toAdminListing, requireConfig, fetchStaff, fetchApplicationForLease, fetchBuilding, fetchBuildings, fetchLeaseLayers, fetchLeaseSettingsLayer } from "./supabase.js";
import { dealValues, resolveValues, LEASE_REGISTRY } from "./lease.js";
import { parseDate } from "../site/shared/lease-dates.js";
import { DOCUMENT_TYPES, requireDocsBucket } from "./portal.js";
import { sendEmail } from "./email.js";

const FROM_ADDRESS = "Star Real Estate Website <no-reply@starreusa.com>";
import { workspaceFor, projectCase, projectLandlordProperty } from "../backend/app/workspace.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});
export const propertyIdsOf = (identity) => (identity.property_ids || []).filter(id => UUID.test(id));
export const caseWorkspace = env => workspaceFor(requireConfig(env));

export async function handleCaseWorkspace(request, env, identity, id, subresource) {
  const workspace = caseWorkspace(env);
  if (id && !UUID.test(id)) return json({ error: "Application not found." }, 404);
  try {
    // The document checklist rides along for staff, so a queue row can say
    // "2 documents missing" with the same list the portal shows applicants.
    const types = identity.role === "landlord" ? [] : DOCUMENT_TYPES;
    if (!id && request.method === "GET") return json({ cases: await workspace.list(identity), document_types: types });
    if (!id) return json({ error: "Case required." }, 400);
    if (!subresource && request.method === "GET") return json({ case: await workspace.get(identity, id), document_types: types });
    if (subresource === "participants" && request.method === "GET") {
      const row = await workspace.load(identity, id);
      if (identity.role === "landlord") return json({ error: "Staff only." }, 403);
      const people = (await fetchStaff(env)).filter(member => member.active);
      return json({ landlords: people.filter(member => member.role === "landlord" && propertyIdsOf(member).includes(row.listings?.building_id))
        .map(member => ({ email: member.email, name: member.name })),
      team: identity.role === "manager" ? people.filter(member => ["agent", "manager"].includes(member.role)).map(member => ({ email: member.email, name: member.name })) : [] });
    }
    if (subresource === "actions" && request.method === "POST") {
      const command = await request.json();
      if (!command || typeof command !== "object" || Array.isArray(command)) return json({ error: "Invalid action." }, 422);
      if (command.action === "archive_lease") return json({ error: "Upload a signed lease using the file form." }, 422);
      delete command.lease_snapshot;
      if (command.action === "prepare_lease") {
        const row = await workspace.load(identity, id);
        if (!projectCase(identity, row).allowed_actions.includes(command.action)) return json({ error: "Lease preparation is not available." }, 403);
        const application = await fetchApplicationForLease(env, id), listing = application?.listings;
        if (!listing) return json({ error: "The rental's listing is unavailable." }, 409);
        const building = listing.building_id ? await fetchBuilding(env, listing.building_id) : null;
        const layers = await fetchLeaseLayers(env, listing.id);
        const result = resolveValues({ layers, deal: dealValues({ application, listing, building, today: parseDate(new Date().toISOString().slice(0, 10)) }), overrides: row.workspace?.recommendation?.terms || {} });
        if (result.missing.length) return json({ error: "Complete the required lease fields before preparing the final lease." }, 409);
        command.lease_snapshot = result.values;
      }
      const saved = await workspace.execute(identity, id, command);
      // A recommendation is only sent once the landlord knows it is there.
      // The email carries the terms and a link, never the application, and
      // replies go to the agent who sent it.
      const notified = command.action === "recommend" ? await notifyLandlord(request, env, identity, saved) : undefined;
      return json({ case: saved, ...(notified === undefined ? {} : { notified }) });
    }
    if (subresource === "signed-lease" && request.method === "GET") {
      const row = await workspace.load(identity, id);
      const file = row.workspace?.signed_lease;
      if (!file || row.status !== "lease_signed") return json({ error: "Signed lease not available." }, 404);
      const object = await requireDocsBucket(env).get(file.path);
      if (!object) return json({ error: "Signed lease not available." }, 404);
      return new Response(object.body, { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="signed-lease-${id}.pdf"` } });
    }
    if (subresource === "signed-lease" && request.method === "POST") {
      const row = await workspace.load(identity, id);
      if (!projectCase(identity, row).allowed_actions.includes("archive_lease")) return json({ error: "Record tenant and landlord signature receipts first." }, 403);
      const form = await request.formData();
      const file = form.get("file"), version = Number(form.get("version"));
      if (!file || typeof file === "string" || file.type !== "application/pdf" || file.size > 15 * 1024 * 1024 || file.size < 5
        || (await file.slice(0, 5).text()) !== "%PDF-") return json({ error: "Upload a signed PDF up to 15 MB." }, 422);
      const path = `${id}/executed/${crypto.randomUUID()}.pdf`;
      const bucket = requireDocsBucket(env);
      await bucket.put(path, file.stream(), { httpMetadata: { contentType: "application/pdf" } });
      try {
        return json({ case: await workspace.execute(identity, id, { action: "archive_lease", version,
          file: { path, name: file.name.slice(0, 200), size: file.size, uploaded_at: new Date().toISOString() } }) });
      } catch (error) { await bucket.delete(path); throw error; }
    }
    return json({ error: "Unknown workspace endpoint." }, 404);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: "Invalid request body." }, 400);
    return json({ error: error.status ? error.message : "Unable to load the workspace." }, error.status || 500);
  }
}

const dollars = value => {
  const amount = Number(String(value ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? amount.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }) : String(value || "");
};
const calendar = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}` : String(value || "");

async function notifyLandlord(request, env, identity, saved) {
  const r = saved.workspace?.recommendation;
  if (!r?.landlord_email) return false;
  const place = [saved.listings?.property_name, saved.listings?.unit && `Unit ${saved.listings.unit}`].filter(Boolean).join(", ") || r.property_title || "your property";
  const link = new URL(`/admin/#/applications/${saved.id}`, request.url).toString();
  const terms = r.terms || {};
  const lease = terms["lease.commencement_date"] && terms["lease.end_date"]
    ? ` The lease would run from ${calendar(terms["lease.commencement_date"])} to ${calendar(terms["lease.end_date"])}.` : "";
  const deposit = terms["deposit.amount"] ? ` with a security deposit of ${dollars(terms["deposit.amount"])}` : "";
  const text = `Hello,\n\nStar has completed its review of an application for ${place} and recommends ${r.tenant_name} as the tenant.\n\n`
    + `The proposed monthly rent is ${dollars(terms["rent.monthly"])}${deposit}.${lease}\n\n`
    + `Please sign in to your workspace to agree to these terms, request a change, or decline.\n\n    ${link}\n\n`
    + `Reply to this email to reach ${identity.name || identity.email}, the agent handling this rental.\n\nStar Real Estate\n`;
  return sendEmail(request, env, { from: FROM_ADDRESS, to: [r.landlord_email], reply_to: identity.email, subject: `Rental recommendation for ${place}`, text });
}

export async function requireCaseAccess(env, identity, id) {
  return caseWorkspace(env).load(identity, id);
}

export async function handleLandlordRead(request, env, identity, resource, id, subresource) {
  if (request.method !== "GET" || subresource) return json({ error: "Use your rental recommendation to record a decision, or submit a property change request." }, 403);
  const propertyIds = propertyIdsOf(identity);
  if (resource === "buildings") {
    if (id && !propertyIds.includes(id)) return json({ error: "Property not found." }, 404);
    const rows = await fetchBuildings(env, { propertyIds: id ? [id] : propertyIds });
    const buildings = rows.map(row => projectLandlordProperty(identity, row)).filter(Boolean);
    return id ? buildings.length ? json({ building: buildings[0] }) : json({ error: "Property not found." }, 404) : json({ buildings });
  }
  if (resource === "listings" && !id) {
    const rows = await fetchListings(env, { publishedOnly: false, propertyIds });
    return json({ listings: rows.map(toAdminListing) });
  }
  if (resource === "applications" && !id) {
    return json({ applications: await caseWorkspace(env).list(identity), document_types: [] });
  }
  if (resource === "documents") return json({ error: "Document not found." }, 404);
  return json({ error: "This page is available to staff only." }, 403);
}

async function requestRows(env, query = "", init = {}) {
  const { url, key } = requireConfig(env);
  const response = await fetch(`${url}/rest/v1/listing_change_requests${query}`, {
    ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      Prefer: "return=representation", ...init.headers }
  });
  if (!response.ok) {
    const error = new Error("Change requests are unavailable. Apply supabase/backoffice.sql to enable them.");
    error.status = response.status === 404 ? 503 : 500;
    throw error;
  }
  return response.json();
}

export async function handleChangeRequests(request, env, identity, id) {
  const landlord = identity.role === "landlord";
  const proposalFields = LEASE_REGISTRY.fields.filter(field => field.source === "manager"
    && (["rent.due_day", "lease.end_time"].includes(field.id) || field.id.startsWith("utility.")));
  if (id === "options" && request.method === "GET") return json({ fields: proposalFields.map(field => ({ id: field.id, label: field.label, type: field.type, options: field.options })) });
  if (id && !UUID.test(id)) return json({ error: "Request not found." }, 404);
  try {
    if (request.method === "GET" && !id) {
      const filter = identity.role !== "manager" ? `&created_by=eq.${encodeURIComponent(identity.email)}` : "";
      let rows = await requestRows(env, `?select=*&order=created_at.desc${filter}`);
      if (landlord) rows = rows.filter(row => propertyIdsOf(identity).includes(row.building_id));
      return json({ requests: rows });
    }
    if (request.method === "POST" && !id) {
      const body = await request.json();
      if (!body || !UUID.test(body.listing_id || "") || typeof body.message !== "string"
        || body.message.trim().length < 10 || body.message.trim().length > 4000) {
        return json({ error: "Choose a listing and describe the change in 10–4,000 characters." }, 422);
      }
      const listing = await fetchListing(env, body.listing_id, { publishedOnly: false });
      if (!listing || (landlord && !propertyIdsOf(identity).includes(listing.building_id)) || (identity.role === "agent" && !listing.published && !propertyIdsOf(identity).includes(listing.building_id))) return json({ error: "Listing not found." }, 404);
      let proposal = null;
      if (body.field_id) {
        const field = proposalFields.find(field => field.id === body.field_id);
        const value = String(body.proposed_value ?? "").trim();
        if (!listing.building_id || !field || !value || value.length > 400
          || (field.type === "choice" && !field.options.includes(value))
          || (field.id === "rent.due_day" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 31))) return json({ error: "Choose a valid property default and proposed value." }, 422);
        const layer = await fetchLeaseSettingsLayer(env, { scope: "building", buildingId: listing.building_id });
        proposal = { scope: "building", field_id: field.id, label: field.label, previous_value: layer?.field_values?.[field.id] ?? null, value };
      }
      const [row] = await requestRows(env, "", { method: "POST", body: JSON.stringify({
        listing_id: listing.id, building_id: listing.building_id, listing_title: listing.title,
        message: body.message.trim(), created_by: identity.email, status: "open", proposal
      }) });
      return json({ request: row }, 201);
    }
    if (request.method === "PATCH" && id && identity.role === "manager") {
      const body = await request.json();
      if (body.publish === true) {
        const { url, key } = requireConfig(env);
        const response = await fetch(`${url}/rest/v1/rpc/publish_property_change_request`, { method: "POST",
          headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ p_id: id, p_actor: identity.email }) });
        if (!response.ok) return json({ error: "The default or request changed. Refresh and review the latest values before publishing." }, 409);
        return json({ request: await response.json() });
      }
      if (!body || !["open", "in_progress", "resolved", "declined"].includes(body.status)
        || typeof body.response !== "string" || body.response.length > 4000
        || (["resolved", "declined"].includes(body.status) && !body.response.trim())) {
        return json({ error: "Choose a status and add a response before closing a request." }, 422);
      }
      const [row] = await requestRows(env, `?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({
        status: body.status, response: body.response.trim(), updated_by: identity.email,
        updated_at: new Date().toISOString()
      }) });
      return row ? json({ request: row }) : json({ error: "Request not found." }, 404);
    }
    return json({ error: "You cannot perform this action." }, 403);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: "Invalid request body." }, 400);
    return json({ error: error.status ? error.message : "Unable to save the request. Please try again." }, error.status || 500);
  }
}
