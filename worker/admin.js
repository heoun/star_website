import { verifyAccessRequest } from "./access.js";
import { describeEnvironment, devIdentity } from "./env.js";
import { purgeListingsCache } from "./listings.js";
import {
  applyLeaseSettings,
  deleteApplication,
  deleteListing,
  deleteMediaRow,
  fetchApplicationForLease,
  fetchApplications,
  fetchApplicationSsn,
  fetchBuilding,
  fetchBuildings,
  fetchLeaseLayers,
  fetchLeaseSettingsLayer,
  fetchListings,
  fetchMediaRow,
  insertBuilding,
  insertListing,
  insertMedia,
  toAdminListing,
  updateApplication,
  updateBuilding,
  updateListing,
  updateMedia
} from "./supabase.js";
import {
  LEASE_REGISTRY,
  dealValues,
  describeMissing,
  fieldProvenance,
  fillTemplate,
  isManagerField,
  leaseFilename,
  resolveValues
} from "./lease.js";
import { decryptSsn, formatSsn } from "./ssn.js";
import {
  IMAGE_TYPES,
  VIDEO_TYPES,
  deleteObject,
  deleteObjectsByPrefix,
  isValidKey,
  putObject
} from "./media.js";

const CATEGORIES = ["residential", "commercial"];
const TRANSACTION_TYPES = ["sale", "rental"];
const MEDIA_KINDS = ["photo", "floor_plan"];
const APPLICATION_STATUSES = [
  "new", "contacted", "fee_pending", "screening", "review",
  "sent_to_landlord", "approved", "declined", "lease_sent", "lease_signed"
];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SINGLE_LINE_FIELDS = [
  "building_name",
  "unit",
  "price_display",
  "property_type",
  "use_type",
  "size",
  "term_label",
  "location",
  "neighborhood",
  "details_url",
  "kind_label",
  "video_url"
];

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function cleanLine(value, maxLength = 300) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maxLength);
}

function cleanMultiline(value, maxLength = 4000) {
  return String(value ?? "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function optionalNumber(value, { integer = false } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return integer ? Math.round(parsed) : parsed;
}

function normalizeListingInput(body, { partial = false } = {}) {
  const values = {};
  const errors = [];

  if (!partial || body.category !== undefined) {
    const category = cleanLine(body.category, 20).toLowerCase();
    if (!CATEGORIES.includes(category)) errors.push("category");
    else values.category = category;
  }

  if (!partial || body.transaction_type !== undefined) {
    const transactionType = cleanLine(body.transaction_type, 20).toLowerCase();
    if (!TRANSACTION_TYPES.includes(transactionType)) errors.push("transaction_type");
    else values.transaction_type = transactionType;
  }

  if (!partial || body.title !== undefined) {
    const title = cleanLine(body.title, 200);
    if (!title) errors.push("title");
    else values.title = title;
  }

  for (const field of SINGLE_LINE_FIELDS) {
    if (body[field] === undefined) continue;
    const maxLength = field === "details_url" || field === "video_url" ? 500 : 300;
    values[field] = cleanLine(body[field], maxLength) || null;
  }

  if (body.description !== undefined) {
    values.description = cleanMultiline(body.description) || null;
  }

  if (body.price_amount !== undefined) values.price_amount = optionalNumber(body.price_amount);
  if (body.bedrooms !== undefined) values.bedrooms = optionalNumber(body.bedrooms, { integer: true });
  if (body.bathrooms !== undefined) values.bathrooms = optionalNumber(body.bathrooms);
  if (body.position !== undefined) values.position = optionalNumber(body.position, { integer: true }) ?? 0;
  if (body.published !== undefined) values.published = Boolean(body.published);

  // Which building's lease settings this unit inherits. Empty unlinks it,
  // which costs the unit its whole building settings layer.
  if (body.building_id !== undefined) {
    const buildingId = cleanLine(body.building_id, 40);
    if (buildingId === "") values.building_id = null;
    else if (!UUID_PATTERN.test(buildingId)) errors.push("building_id");
    else values.building_id = buildingId;
  }

  return { values, errors };
}

// Uploads one file to R2 under the listing's prefix. The caller decides what
// the object becomes (photo row, floor plan row, or the listing's video).
async function handleUpload(request, env, listingId) {
  if (!UUID_PATTERN.test(listingId)) {
    return json({ error: "Invalid listing id." }, 400);
  }

  const form = await request.formData();
  const file = form.get("file");

  if (!file || typeof file === "string") {
    return json({ error: "No file was uploaded." }, 400);
  }

  const isImage = file.type in IMAGE_TYPES;
  const isVideo = file.type in VIDEO_TYPES;

  if (!isImage && !isVideo) {
    return json({ error: "Unsupported file type. Use JPEG, PNG, WebP, AVIF, MP4, MOV, or WebM." }, 415);
  }

  const limit = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (file.size > limit) {
    return json({ error: `Files of this type must be ${Math.round(limit / 1024 / 1024)} MB or smaller.` }, 413);
  }

  const extension = isImage ? IMAGE_TYPES[file.type] : VIDEO_TYPES[file.type];
  const key = `${listingId.toLowerCase()}/${crypto.randomUUID()}.${extension}`;

  await putObject(env, key, file.type, file.stream());

  return json({ path: key, url: `/media/${key}`, is_video: isVideo });
}

export async function handleAdminRequest(request, env, ctx, pathname) {
  // Access in production; on a developer's machine, the two-lock local
  // identity from env.js. Both return the same shape, so nothing below here
  // needs to know which one answered.
  const identity = (await verifyAccessRequest(request, env)) || devIdentity(request, env);
  if (!identity) {
    return json({ error: "Not authorized." }, 403);
  }

  const segments = pathname.replace(/^\/api\/admin\/?/, "").split("/").filter(Boolean);
  const [resource, id, subresource] = segments;

  try {
    if (resource === "me") {
      return json({ email: identity.email, ...describeEnvironment(request, env) });
    }

    if (resource === "media" && id) {
      return await handleMediaItem(request, env, ctx, id);
    }

    if (resource === "applications") {
      return await handleApplications(request, env, id, subresource);
    }

    if (resource === "buildings") {
      return await handleBuildings(request, env, id);
    }

    if (resource === "lease") {
      return await handleLease(request, env, identity, id, subresource);
    }

    if (resource !== "listings") {
      return json({ error: "Unknown endpoint." }, 404);
    }

    if (id && subresource === "uploads" && request.method === "POST") {
      return await handleUpload(request, env, id);
    }

    if (id && subresource === "media" && request.method === "POST") {
      return await handleMediaCreate(request, env, ctx, id);
    }

    if (subresource) {
      return json({ error: "Unknown endpoint." }, 404);
    }

    if (!id && request.method === "GET") {
      const rows = await fetchListings(env, { publishedOnly: false });
      return json({ listings: rows.map(toAdminListing) });
    }

    if (!id && request.method === "POST") {
      const { values, errors } = normalizeListingInput(await request.json());
      if (errors.length > 0) return json({ error: `Invalid fields: ${errors.join(", ")}` }, 422);

      const row = await insertListing(env, values);
      ctx.waitUntil(purgeListingsCache(request));
      return json({ listing: row }, 201);
    }

    if (!id) {
      return json({ error: "A listing id is required." }, 400);
    }

    if (!UUID_PATTERN.test(id)) {
      return json({ error: "Listing not found." }, 404);
    }

    if (request.method === "PATCH") {
      const { values, errors } = normalizeListingInput(await request.json(), { partial: true });
      if (errors.length > 0) return json({ error: `Invalid fields: ${errors.join(", ")}` }, 422);
      if (Object.keys(values).length === 0) return json({ error: "Nothing to update." }, 400);

      const row = await updateListing(env, id, values);
      if (!row) return json({ error: "Listing not found." }, 404);
      ctx.waitUntil(purgeListingsCache(request, id));
      return json({ listing: row });
    }

    if (request.method === "DELETE") {
      await deleteListing(env, id);
      ctx.waitUntil(deleteObjectsByPrefix(env, `${id.toLowerCase()}/`));
      ctx.waitUntil(purgeListingsCache(request, id));
      return json({ deleted: true });
    }

    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    console.error("Admin request failed", error);
    return json({ error: "The request could not be completed." }, 500);
  }
}

async function handleApplications(request, env, id, subresource) {
  // Reveal endpoint: decrypts one SSN on demand for an authenticated staff
  // member. The list payload never carries more than the last four digits.
  if (subresource === "ssn" && id && request.method === "GET") {
    if (!UUID_PATTERN.test(id)) return json({ error: "Application not found." }, 404);

    const row = await fetchApplicationSsn(env, id);
    if (!row) return json({ error: "Application not found." }, 404);

    const digits = await decryptSsn(env, row.ssn_encrypted);
    if (!digits) return json({ error: "No SSN is stored for this application." }, 404);

    return json({ ssn: formatSsn(digits) });
  }

  if (subresource) {
    return json({ error: "Unknown endpoint." }, 404);
  }

  if (!id) {
    if (request.method === "GET") {
      const rows = await fetchApplications(env);
      return json({ applications: rows });
    }
    return json({ error: "Method not allowed." }, 405);
  }

  if (!UUID_PATTERN.test(id)) {
    return json({ error: "Application not found." }, 404);
  }

  if (request.method === "PATCH") {
    const body = await request.json();
    const values = {};

    if (body.status !== undefined) {
      const status = cleanLine(body.status, 20).toLowerCase();
      if (!APPLICATION_STATUSES.includes(status)) return json({ error: "Invalid status." }, 422);
      values.status = status;
    }

    if (body.notes !== undefined) {
      values.notes = cleanMultiline(body.notes) || null;
    }

    if (Object.keys(values).length === 0) return json({ error: "Nothing to update." }, 400);

    const row = await updateApplication(env, id, values);
    if (!row) return json({ error: "Application not found." }, 404);
    return json({ application: row });
  }

  if (request.method === "DELETE") {
    await deleteApplication(env, id);
    return json({ deleted: true });
  }

  return json({ error: "Method not allowed." }, 405);
}

async function handleMediaCreate(request, env, ctx, listingId) {
  if (!UUID_PATTERN.test(listingId)) {
    return json({ error: "Listing not found." }, 404);
  }

  const body = await request.json();
  const kind = cleanLine(body.kind, 20) || "photo";
  const path = String(body.path ?? "").trim();

  if (!MEDIA_KINDS.includes(kind)) {
    return json({ error: "Invalid media kind." }, 422);
  }

  // Only accept well-formed keys that were uploaded for this listing —
  // isValidKey also rejects ".." segments that would resolve elsewhere.
  if (!isValidKey(path) || !path.startsWith(`${listingId.toLowerCase()}/`)) {
    return json({ error: "The uploaded file does not belong to this listing." }, 422);
  }

  const row = await insertMedia(env, {
    listing_id: listingId,
    kind,
    path,
    caption: cleanLine(body.caption, 120) || null,
    position: optionalNumber(body.position, { integer: true }) ?? 0
  });

  ctx.waitUntil(purgeListingsCache(request, listingId));
  return json({ media: { ...row, url: `/media/${row.path}` } }, 201);
}

async function handleMediaItem(request, env, ctx, mediaId) {
  if (!UUID_PATTERN.test(mediaId)) {
    return json({ error: "Media not found." }, 404);
  }

  if (request.method === "PATCH") {
    const body = await request.json();
    const values = {};
    if (body.caption !== undefined) values.caption = cleanLine(body.caption, 120) || null;
    if (body.position !== undefined) values.position = optionalNumber(body.position, { integer: true }) ?? 0;
    if (Object.keys(values).length === 0) return json({ error: "Nothing to update." }, 400);

    const row = await updateMedia(env, mediaId, values);
    if (!row) return json({ error: "Media not found." }, 404);
    ctx.waitUntil(purgeListingsCache(request, row.listing_id));
    return json({ media: { ...row, url: `/media/${row.path}` } });
  }

  if (request.method === "DELETE") {
    const row = await fetchMediaRow(env, mediaId);
    if (!row) return json({ error: "Media not found." }, 404);

    await deleteMediaRow(env, mediaId);
    ctx.waitUntil(deleteObject(env, row.path));
    ctx.waitUntil(purgeListingsCache(request, row.listing_id));
    return json({ deleted: true });
  }

  return json({ error: "Method not allowed." }, 405);
}

export async function guardAdminPage(request, env) {
  const identity = (await verifyAccessRequest(request, env)) || devIdentity(request, env);
  if (identity) return null;

  return new Response("Not authorized.", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
  });
}

// ---- Lease generation ----

const LEASE_SCOPES = ["company", "building", "unit"];
const BUILDING_FIELDS = ["name", "street", "city", "state", "state_abbr", "zip"];

async function handleBuildings(request, env, id) {
  if (!id) {
    if (request.method === "GET") {
      return json({ buildings: await fetchBuildings(env) });
    }

    if (request.method === "POST") {
      const body = await request.json();
      const values = {};
      for (const field of BUILDING_FIELDS) {
        if (body[field] !== undefined) values[field] = cleanLine(body[field], 200) || null;
      }
      if (!values.name) return json({ error: "A building needs a name." }, 422);
      return json({ building: await insertBuilding(env, values) }, 201);
    }

    return json({ error: "Method not allowed." }, 405);
  }

  if (!UUID_PATTERN.test(id)) return json({ error: "Building not found." }, 404);

  if (request.method === "PATCH") {
    const body = await request.json();
    const values = {};
    for (const field of BUILDING_FIELDS) {
      if (body[field] !== undefined) values[field] = cleanLine(body[field], 200) || null;
    }
    if (Object.keys(values).length === 0) return json({ error: "Nothing to update." }, 400);
    if (values.name === null) return json({ error: "A building needs a name." }, 422);

    const row = await updateBuilding(env, id, values);
    if (!row) return json({ error: "Building not found." }, 404);
    return json({ building: row });
  }

  return json({ error: "Method not allowed." }, 405);
}

// Only manager-owned fields may be stored, and only in the shape the registry
// describes. A settings layer carrying "rent.monthly" would let a stale number
// override the application on a signed lease.
function normalizeSettingsPatch(body) {
  const patch = {};
  const errors = [];

  for (const [id, raw] of Object.entries(body || {})) {
    if (!isManagerField(id)) {
      errors.push(id);
      continue;
    }

    const field = LEASE_REGISTRY.fields.find((candidate) => candidate.id === id);

    if (field.type === "checkbox") {
      patch[id] = Boolean(raw);
      continue;
    }

    const text = cleanLine(raw, 400);

    // Empty means "this layer no longer answers that field", which the
    // database stores as the key being absent rather than as a blank value.
    if (text === "") {
      patch[id] = null;
      continue;
    }

    if (field.type === "choice" && !field.options.includes(text)) {
      errors.push(id);
      continue;
    }

    patch[id] = text;
  }

  return { patch, errors };
}

async function handleLease(request, env, identity, id, subresource) {
  if (id === "fields" && request.method === "GET") {
    return json({ registry: LEASE_REGISTRY });
  }

  if (id === "settings") {
    return await handleLeaseSettings(request, env, identity);
  }

  if (id === "document") {
    return subresource
      ? await handleLeaseDocument(request, env, subresource)
      : await handleLeaseFromScratch(request, env);
  }

  return json({ error: "Unknown endpoint." }, 404);
}

async function handleLeaseSettings(request, env, identity) {
  const url = new URL(request.url);

  if (request.method === "GET") {
    const listingId = url.searchParams.get("listing_id");

    // A unit view needs all three layers: the screen shows which one answered
    // each field, because inherited and set-here are different to a person
    // deciding whether a lease is safe to send.
    if (listingId) {
      if (!UUID_PATTERN.test(listingId)) return json({ error: "Listing not found." }, 404);
      const layers = await fetchLeaseLayers(env, listingId);
      return json({ layers, provenance: fieldProvenance(layers) });
    }

    const scope = cleanLine(url.searchParams.get("scope"), 20) || "company";
    if (!LEASE_SCOPES.includes(scope)) return json({ error: "Unknown settings scope." }, 422);

    const buildingId = url.searchParams.get("building_id");
    if (scope === "building" && !UUID_PATTERN.test(buildingId || "")) {
      return json({ error: "A building is required for building settings." }, 422);
    }

    const row = await fetchLeaseSettingsLayer(env, {
      scope,
      buildingId: scope === "building" ? buildingId : null
    });
    return json({ scope, field_values: row?.field_values || {}, updated_at: row?.updated_at || null });
  }

  if (request.method === "PUT") {
    const body = await request.json();
    const scope = cleanLine(body.scope, 20);
    if (!LEASE_SCOPES.includes(scope)) return json({ error: "Unknown settings scope." }, 422);

    const buildingId = scope === "building" ? body.building_id : null;
    const listingId = scope === "unit" ? body.listing_id : null;

    if (scope === "building" && !UUID_PATTERN.test(buildingId || "")) {
      return json({ error: "A building is required for building settings." }, 422);
    }
    if (scope === "unit" && !UUID_PATTERN.test(listingId || "")) {
      return json({ error: "A listing is required for unit settings." }, 422);
    }

    const { patch, errors } = normalizeSettingsPatch(body.field_values);
    if (errors.length > 0) return json({ error: `Invalid fields: ${errors.join(", ")}` }, 422);
    if (Object.keys(patch).length === 0) return json({ error: "Nothing to update." }, 400);

    const row = await applyLeaseSettings(env, {
      scope,
      buildingId,
      listingId,
      patch,
      actor: identity.email
    });

    return json({ settings: row });
  }

  return json({ error: "Method not allowed." }, 405);
}

// A lease with no application behind it.
//
// The credit-reporting chain that produces applications is not finished, so an
// agent has to be able to start a lease from nothing and type all of it. The
// stored settings for the apartment still supply what they can; everything else
// arrives in `overrides`, deal fields included.
async function handleLeaseFromScratch(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const body = await request.json().catch(() => ({}));
  const listingId = body.listing_id || null;
  if (listingId && !UUID_PATTERN.test(listingId)) return json({ error: "Listing not found." }, 404);

  let listing = null;
  let layers = EMPTY_LAYERS;
  let building = null;

  if (listingId) {
    listing = (await fetchListings(env, { publishedOnly: false })).find((row) => row.id === listingId) || null;
    if (!listing) return json({ error: "Listing not found." }, 404);
    if (listing.building_id) building = await fetchBuilding(env, listing.building_id);
    layers = await fetchLeaseLayers(env, listingId);
  }

  const { patch: overrides, errors } = normalizeOverrides(body.overrides);
  if (errors.length > 0) return json({ error: `Invalid fields: ${errors.join(", ")}` }, 422);

  // The apartment answers what it can — its address, its rent — so an agent
  // starting from nothing is not retyping what the listing already knows.
  // Everything about the tenancy stays empty until somebody types it.
  const deal = dealValues({ application: null, listing, building, today: todayParts(body.today) });
  const { values, missing } = resolveValues({ layers, deal, overrides });

  return respondWithLease(request, env, {
    mode: cleanLine(body.mode, 10) || "values",
    values,
    missing,
    extras: { deal, provenance: fieldProvenance(layers), building_linked: Boolean(building) },
    filename: leaseFilename({
      application: { name: values["tenant.names"] || "" },
      listing: listing || { title: "Lease" }
    })
  });
}

const EMPTY_LAYERS = { company: {}, building: {}, unit: {} };

// The three modes every lease request answers in, in one place so the rule that
// a final lease may not carry an unanswered required value cannot drift apart
// between the two ways of asking for one.
async function respondWithLease(request, env, { mode, values, missing, extras = {}, filename }) {
  if (mode === "values") {
    return json({ values, missing, missing_labels: describeMissing(missing), ...extras });
  }

  if (mode !== "draft" && mode !== "final") {
    return json({ error: "Unknown lease mode." }, 422);
  }

  if (mode === "final" && missing.length > 0) {
    return json({
      error: `This lease is missing ${missing.length} required ${missing.length === 1 ? "value" : "values"}.`,
      missing,
      missing_labels: describeMissing(missing)
    }, 422);
  }

  // A draft marks its own gaps, so nobody reads a blank line as an answer.
  const marked = mode === "draft"
    ? { ...values, ...Object.fromEntries(missing.map((id) => [id, "[ TO BE COMPLETED ]"])) }
    : values;

  const docx = await fillTemplate(env, request, marked);

  return new Response(docx, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}

// Resolves every placeholder for one application and either reports what is
// still unanswered or hands back the finished .docx.
async function handleLeaseDocument(request, env, applicationId) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!UUID_PATTERN.test(applicationId)) return json({ error: "Application not found." }, 404);

  const body = await request.json().catch(() => ({}));
  const application = await fetchApplicationForLease(env, applicationId);
  if (!application) return json({ error: "Application not found." }, 404);

  const listing = application.listings;
  if (!listing) return json({ error: "This application's listing has been removed." }, 422);

  const building = listing.building_id ? await fetchBuilding(env, listing.building_id) : null;
  const layers = await fetchLeaseLayers(env, listing.id);

  const { patch: overrides, errors } = normalizeOverrides(body.overrides);
  if (errors.length > 0) return json({ error: `Invalid fields: ${errors.join(", ")}` }, 422);

  const today = todayParts(body.today);
  const deal = dealValues({ application, listing, building, today });
  const { values, missing } = resolveValues({ layers, deal, overrides });

  return respondWithLease(request, env, {
    mode: cleanLine(body.mode, 10) || "values",
    values,
    missing,
    extras: {
      deal,
      provenance: fieldProvenance(layers),
      building_linked: Boolean(building)
    },
    filename: leaseFilename({ application, listing })
  });
}

// What the lease screen changed but did not save. It may correct the deal — a
// tenant name, a date — and it may also change a manager value for this one
// lease, which is the case the screen calls "this lease only": the apartment's
// stored defaults are what the next lease starts from, and a one-off must not
// disturb them.
//
// The cost is that a manager value changed this way is not audited, because
// only the settings tables are. Storing the produced document together with the
// exact values behind it is what closes that, and it is not built yet — see
// lease/README.md. Until it is, a per-lease change to a legal assertion leaves
// no trace once the .docx is downloaded.
function normalizeOverrides(body) {
  const patch = {};
  const errors = [];

  for (const [id, raw] of Object.entries(body || {})) {
    const field = LEASE_REGISTRY.fields.find((candidate) => candidate.id === id);
    if (!field) {
      errors.push(id);
      continue;
    }
    if (field.type === "checkbox") {
      patch[id] = Boolean(raw);
      continue;
    }
    const text = cleanLine(raw, 400);
    if (field.type === "choice" && text !== "" && !field.options.includes(text)) {
      errors.push(id);
      continue;
    }
    patch[id] = text;
  }

  return { patch, errors };
}

function todayParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  const date = match
    ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
    : null;
  if (date) return date;

  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
}
