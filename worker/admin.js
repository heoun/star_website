import { propertyAddress } from "../site/shared/property-address.js";
import { handleAdministration } from "./administration.js";
import { verifyAccessRequest } from "./access.js";
import { handleLandlordRead, handleChangeRequests, handleCaseWorkspace, requireCaseAccess, caseWorkspace } from "./backoffice.js";
import { projectCase } from "../backend/app/workspace.ts";
import { describeEnvironment, devIdentity } from "./env.js";
import { purgeListingsCache } from "./listings.js";
import {
  AGENT_APPLICATION_COLUMNS,
  isManager, isManagerControlled, resolveStaff
} from "./staff.js";
import {
  applyLeaseSettings,
  deleteApplication,
  deleteApplicationDocument,
  deleteListing,
  deleteMediaRow,
  requireConfig,
  isMissingTable,
  fetchApplicationDocument,
  fetchApplicationForLease,
  fetchApplication,
  keepsSubmitted,
  fetchApplicationSsn,
  fetchBuilding,
  fetchBuildings,
  fetchLeaseLayers,
  fetchLeaseSettingsLayer,
  fetchListing,
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
  DOCUMENT_TYPES,
  deleteDocumentsByPrefix,
  requireDocsBucket,
  serveDocumentFile
} from "./portal.js";
import {
  LEASE_REGISTRY,
  dealValues,
  describeMissing,
  fieldProvenance,
  fillTemplate,
  formatOverrides,
  isManagerField,
  leaseFilename,
  missingIn,
  resolveValues
} from "./lease.js";
import { normalizeApplicationEdit } from "./apply.js";
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
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SINGLE_LINE_FIELDS = [
  "property_name",
  "unit",
  "property_type",
  "use_type",
  "size",
  "term_label",
  "location",
  "details_url",
  "video_url"
];

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

// Enough to catch a typo before it becomes an account nobody can sign in as.
// Cloudflare Access is what actually decides an address is real.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

// The building name and address a listing displays are the property's, whenever it is
// under one. Two places to type the same building's name is two names that
// drift, and the pair a reader compares is the website's label against the
// address a lease prints. So the label is copied from the property here and
// whatever the form sent is discarded; a listing under no property — a house
// for sale — keeps its typed name.
//
// Returns a Response when the link cannot be honoured, null when all is well.
async function nameFromProperty(env, values, currentId = null) {
  const propertyId = values.building_id === undefined ? currentId : values.building_id;
  if (!propertyId) return null;
  const building = await fetchBuilding(env, propertyId);
  if (!building) return json({ error: "That property no longer exists." }, 422);
  values.property_name = building.name;
  values.location = propertyAddress(building) || null;
  return null;
}

function normalizeListingInput(body, { partial = false, identity = null, current = null } = {}) {
  const values = {};
  const errors = [];
  const refused = [];

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
  if (!partial || body.published !== undefined) values.published = Boolean(body.published);

  // Which property's lease settings this unit inherits. Empty unlinks it,
  // which costs the unit its whole building settings layer.
  //
  // An agent may put a new apartment under a property that already exists —
  // that is the ordinary job, and it is what makes the unit's lease read a
  // manager's address instead of the listing's own text. What an agent may
  // not do is MOVE an apartment already under one: re-pointing swaps all 93
  // per-building values at once, the same write PUT /lease/settings refuses,
  // reached by another door. `current` is the link as stored; sending it back
  // unchanged is not a move, so an ordinary edit of a linked listing saves.
  //
  // No `identity &&` guard: a call that arrives without one must refuse, not
  // fall through and write the value.
  if (body.building_id !== undefined) {
    const buildingId = cleanLine(body.building_id, 40);
    const moves = (buildingId || null) !== (current || null);
    if (moves && !isManager(identity) && current) {
      refused.push("the property this apartment belongs to");
    } else if (moves && !isManager(identity) && buildingId === "") {
      refused.push("the property this apartment belongs to");
    } else if (buildingId === "") {
      values.building_id = null;
    } else if (!UUID_PATTERN.test(buildingId)) {
      errors.push("building_id");
    } else {
      values.building_id = buildingId;
    }
  }

  return { values, errors, refused };
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
  const authenticated = (await verifyAccessRequest(request, env)) || devIdentity(request, env);
  if (!authenticated) {
    return json({ error: "Not authorized." }, 403);
  }

  // Access proved who this is. public.staff says what they may do, and refuses
  // an email it does not know rather than assuming the narrower role — see
  // worker/staff.js for why there is no default.
  let identity;
  try {
    const resolved = await resolveStaff(env, authenticated);
    if (!resolved.identity) return json({ error: resolved.error }, resolved.status || 403);
    identity = resolved.identity;
  } catch (error) {
    return json({ error: error.message }, 500);
  }

  const segments = pathname.replace(/^\/api\/admin\/?/, "").split("/").filter(Boolean);
  const [resource, id, subresource] = segments;

  try {
    if (resource === "me") {
      return json({
        email: identity.email,
        role: identity.role,
        owner: identity.owner === true,
        demo: identity.development === true && Boolean(env.LOCAL_EMAIL_SINK),
        name: identity.name || "",
        property_ids: identity.property_ids || [],
        ...describeEnvironment(request, env)
      });
    }

    // Owner governs access only, including when following an old business URL.
    if (identity.owner === true) {
      if (resource === "staff" && segments.length <= 3) return await handleAdministration(request, env, identity, resource, id, subresource);
      if (resource === "buildings" && segments.length === 1 && request.method === "GET") {
        return json({ buildings: (await fetchBuildings(env)).map(({ id, name }) => ({ id, name })) });
      }
      return json({ error: "Platform Owner manages accounts and permissions only. Business operations require an Admin account." }, 403);
    }

    if (resource === "requests" && !subresource) {
      return await handleChangeRequests(request, env, identity, id);
    }
    if (resource === "cases" && segments.length <= 3) {
      return await handleCaseWorkspace(request, env, identity, id, subresource);
    }

    // Fail closed before dispatching any legacy staff endpoint, including media,
    // lease generation and SSN reveal. A hidden button is not authorization.
    if (identity.role === "landlord") {
      return await handleLandlordRead(request, env, identity, resource, id, subresource);
    }

    if (["staff", "onboarding"].includes(resource) && segments.length <= 3) {
      return await handleAdministration(request, env, identity, resource, id, subresource);
    }

    if (resource === "media" && id) {
      if (!isManager(identity)) {
        const media = await fetchMediaRow(env, id);
        const listing = media && await fetchListing(env, media.listing_id, { publishedOnly: false });
        if (!listing || !(identity.property_ids || []).includes(listing.building_id)) return json({ error: "You cannot edit this property's marketing content." }, 403);
      }
      return await handleMediaItem(request, env, ctx, id);
    }

    if (resource === "documents" && id) {
      return await handleDocumentItem(request, env, ctx, identity, id);
    }

    if (resource === "applications") {
      return await handleApplications(request, env, ctx, identity, id, subresource);
    }

    if (resource === "buildings") {
      return await handleBuildings(request, env, identity, id);
    }

    if (resource === "lease") {
      return await handleLease(request, env, identity, id, subresource);
    }

    if (resource !== "listings") {
      return json({ error: "Unknown endpoint." }, 404);
    }

    if (!isManager(identity) && request.method !== "GET") {
      const listing = id ? await fetchListing(env, id, { publishedOnly: false }) : await request.clone().json().catch(() => null);
      const propertyId = listing?.building_id || (request.method === "PATCH" && id && listing ? (await request.clone().json().catch(() => null))?.building_id : null);
      if (!propertyId || !(identity.property_ids || []).includes(propertyId)) return json({ error: "An admin must assign you marketing access to this property first." }, 403);
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
      return json({ listings: rows.filter(row => isManager(identity) || row.published || (identity.property_ids || []).includes(row.building_id))
        .map(row => ({ ...toAdminListing(row), can_edit: isManager(identity) || (identity.property_ids || []).includes(row.building_id) })) });
    }

    if (!id && request.method === "POST") {
      const { values, errors, refused } = normalizeListingInput(
        await request.json(), { identity });
      if (errors.length > 0) return json({ error: `Invalid fields: ${errors.join(", ")}` }, 422);
      if (refused.length > 0) return listingRefusal(refused);
      const named = await nameFromProperty(env, values);
      if (named) return named;

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
      const body = await request.json();
      // What this apartment is linked to now, so the rule below can tell an
      // agent putting a new unit under a property from one moving it.
      const existing = await fetchListing(env, id, { publishedOnly: false });
      if (!existing) return json({ error: "Listing not found." }, 404);
      const current = existing.building_id || null;

      const { values, errors, refused } = normalizeListingInput(
        body, { partial: true, identity, current });
      if (errors.length > 0) return json({ error: `Invalid fields: ${errors.join(", ")}` }, 422);
      if (refused.length > 0) return listingRefusal(refused);
      if (Object.keys(values).length === 0) return json({ error: "Nothing to update." }, 400);
      const named = await nameFromProperty(env, values, current);
      if (named) return named;

      const row = await updateListing(env, id, values);
      if (!row) return json({ error: "Listing not found." }, 404);
      ctx.waitUntil(purgeListingsCache(request, id));
      return json({ listing: row });
    }

    if (request.method === "DELETE") {
      // An agent edits listings; removing one outright is a manager's.
      if (!isManager(identity)) {
        return json({ error: "Only a manager can delete a listing." }, 403);
      }
      await deleteListing(env, id);
      ctx.waitUntil(deleteObjectsByPrefix(env, `${id.toLowerCase()}/`));
      ctx.waitUntil(purgeListingsCache(request, id));
      return json({ deleted: true });
    }

    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    if (!error.status || error.status >= 500) console.error("Admin request failed", error);
    return json({ error: error.status ? error.message : "The request could not be completed." }, error.status || 500);
  }
}

// A document the applicant uploaded through the portal: staff read it, and
// can remove one that is wrong or was uploaded twice. Uploading stays on the
// portal side — the paperwork is the applicant's to provide.
async function handleDocumentItem(request, env, ctx, identity, documentId) {
  if (!UUID_PATTERN.test(documentId)) {
    return json({ error: "Document not found." }, 404);
  }

  const row = await fetchApplicationDocument(env, documentId);
  if (!row) return json({ error: "Document not found." }, 404);
  const application = await requireCaseAccess(env, identity, row.application_id);

  if (request.method === "GET") {
    return serveDocumentFile(env, row);
  }

  if (request.method === "DELETE") {
    if (["landlord_approved", "lease_sent", "lease_signed"].includes(application.status)) return json({ error: "Documents are locked after landlord confirmation." }, 409);
    await deleteApplicationDocument(env, documentId);
    ctx.waitUntil(requireDocsBucket(env).delete(row.path));
    return json({ deleted: true });
  }

  return json({ error: "Method not allowed." }, 405);
}

async function handleApplications(request, env, ctx, identity, id, subresource) {
  const scoped = id && UUID_PATTERN.test(id) ? await requireCaseAccess(env, identity, id) : null;
  // Reveal endpoint: decrypts one SSN on demand. The list payload never
  // carries more than the last four digits, and this is the only way to the
  // rest of them.
  //
  // A manager's, not an agent's. Nothing in the lease workflow reads an SSN —
  // it is screening material and it is not on the document — so the only
  // reason to ask for the whole number is to run a credit check, and that is
  // the manager's job. An agent still sees the last four, which is what
  // matching a report against an applicant needs.
  if (subresource === "ssn" && id && request.method === "GET") {
    if (!isManager(identity)) {
      return json({ error: "Only a manager can read a full Social Security number. "
        + "The last four digits are on the application." }, 403);
    }
    if (!UUID_PATTERN.test(id)) return json({ error: "Application not found." }, 404);

    const row = await fetchApplicationSsn(env, id);
    if (!row) return json({ error: "Application not found." }, 404);

    const value = await decryptSsn(env, row.ssn_encrypted);
    if (!value) return json({ error: "No identity number is stored for this application." }, 404);

    // The stored type decides the formatting, not the shape of the digits:
    // some passport numbers are nine digits too, and hyphenating one would
    // hand a manager an SSN that does not exist. Rows from before the choice
    // (id_type null) are all SSNs and keep their dashes.
    return json({ ssn: row.id_type === "passport" ? value : (formatSsn(value) || value) });
  }

  if (subresource) {
    return json({ error: "Unknown endpoint." }, 404);
  }

  if (!id) {
    if (request.method === "GET") {
      const summaries = await caseWorkspace(env).list(identity);
      const rows = summaries;
      // The checklist registry rides along so the admin page names document
      // types the same way the portal does, from the same list.
      return json({ applications: rows, document_types: DOCUMENT_TYPES });
    }
    return json({ error: "Method not allowed." }, 405);
  }

  if (!UUID_PATTERN.test(id)) {
    return json({ error: "Application not found." }, 404);
  }
  if (request.method === "GET") return json({ application: projectCase(identity, scoped, true), document_types: DOCUMENT_TYPES });

  if (request.method === "PATCH") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "The request body must be a JSON object." }, 400);
    }
    const values = {};

    if (body.status !== undefined) return json({ error: "Use the case's available actions to change its stage." }, 409);
    const changingFacts = Object.keys(body).some(key => !["notes", "decision_reason"].includes(key));
    if (changingFacts && ["landlord_approved", "lease_sent", "lease_signed"].includes(scoped.status)) return json({ error: "Confirmed lease details are locked. Start a reviewed revision before changing them." }, 409);
    if (changingFacts) {
      const workspace = { ...scoped.workspace };
      delete workspace.review; delete workspace.recommendation; delete workspace.landlord_decision;
      if (workspace.checks) workspace.checks = { ...workspace.checks, documents: "pending" };
      values.workspace = workspace; values.status = "review";
    }

    if (body.notes !== undefined) {
      values.notes = cleanMultiline(body.notes) || null;
    }

    // Correcting the application itself, rather than the screening notes an
    // agent keeps beside it. Needs the row first: what the applicant actually
    // submitted is kept, and a name is made of two halves only one of which
    // may have been sent.
    const correctionKeys = Object.keys(body)
      .filter((key) => key !== "status" && key !== "notes" && key !== "decision_reason");
    const corrections = correctionKeys.length > 0;
    if (corrections) {
      // An agent's corrections stop at the terms of the tenancy. The rest of
      // the application — the tenant's identity, the screening answers — is a
      // manager's, the same split the lease overrides enforce.
      if (!isManager(identity)) {
        const blocked = correctionKeys.filter((key) => !AGENT_APPLICATION_COLUMNS.has(key));
        if (blocked.length > 0) {
          return json({
            error: `Only a manager can change ${blocked.join(", ")} on an application.`
          }, 403);
        }
      }
      if (!keepsSubmitted()) {
        return json({
          error: "This database cannot record what the applicant originally wrote yet. "
            + "Run supabase/schema.sql on it, then try again."
        }, 409);
      }
      const current = await fetchApplication(env, id);
      if (!current) return json({ error: "Application not found." }, 404);

      const edit = normalizeApplicationEdit(body, current);
      if (edit.errors.length > 0) {
        return json({ error: `Please check ${edit.errors.join(", ")}.` }, 422);
      }
      Object.assign(values, edit.values, submittedRecord(current, edit.values));
    }

    if (Object.keys(values).length === 0) return json({ error: "Nothing to update." }, 400);

    let row;
    try {
      row = await updateApplication(env, id, values, { version: scoped.workspace_version });
    } catch (error) {
      // A status this Worker knows and the table does not. It means the
      // database has not had supabase/schema.sql run on it since "needs
      // information" was added, and the person clicking the button deserves to
      // be told that rather than "the request could not be completed".
      if (values.status && /applications_status_check|23514/.test(String(error.message))) {
        return json({
          error: `This database does not accept the status "${values.status}" yet. `
            + "Run supabase/schema.sql on it, then try again."
        }, 409);
      }
      throw error;
    }
    if (!row) return json({ error: "This application changed. Refresh before saving." }, 409);
    return json({ application: await caseWorkspace(env).get(identity, id) });
  }

  if (request.method === "DELETE") {
    // An agent works the application; removing it — answers, documents, the
    // record the tenant warrant relies on — is a manager's.
    if (!isManager(identity)) {
      return json({ error: "Only a manager can delete an application." }, 403);
    }
    await deleteApplication(env, id);
    // The database cascade removes the document rows; the bytes in R2 are
    // this Worker's to clean up.
    ctx.waitUntil(deleteDocumentsByPrefix(env, `${id.toLowerCase()}/`));
    return json({ deleted: true });
  }

  return json({ error: "Method not allowed." }, 405);
}

// What the applicant wrote, kept the first time an agent changes it.
//
// The lease has the tenant warrant that everything in the application is
// accurate, so the version they warranted has to survive being corrected. Only
// the first correction of a field records anything: after that the stored value
// is already the submitted one, and overwriting it would lose the very thing
// this is for.
function submittedRecord(current, corrections) {
  const submitted = { ...(current.submitted || {}) };
  let added = false;
  for (const [key, value] of Object.entries(corrections)) {
    if (key in submitted) continue;
    if (JSON.stringify(current[key] ?? null) === JSON.stringify(value ?? null)) continue;
    submitted[key] = current[key] ?? null;
    added = true;
  }
  return added ? { submitted } : {};
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

// Account governance routes live in worker/administration.js.

// The page itself, not the API behind it. Somebody who passes Access but has no
// staff row would otherwise get the console shell and watch every request in it
// fail — so they are told here, once, in words that say what to do.
export async function guardAdminPage(request, env) {
  const authenticated = (await verifyAccessRequest(request, env)) || devIdentity(request, env);
  if (!authenticated) return deniedPage("Not authorized.");

  try {
    const resolved = await resolveStaff(env, authenticated);
    if (resolved.identity) return null;
    return deniedPage(resolved.error, resolved.status || 403);
  } catch (error) {
    // Fail closed. The console cannot do anything useful without this database
    // anyway, and guessing at a role because a query failed is the one outcome
    // worth avoiding.
    return deniedPage(`The admin console could not check your account: ${error.message}`, 503);
  }
}

function deniedPage(message, status = 403) {
  return new Response(`${message}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
  });
}

// ---- Lease generation ----

// Two layers. A lease value belongs to a property, or to one apartment of it.
// The company layer that used to sit above both is gone — see
// supabase/drop-company-layer.sql for what happened to what it held.
const LEASE_SCOPES = ["building", "unit"];
const BUILDING_FIELDS = [
  "name", "street", "city", "state", "state_abbr", "zip", "landlord_signer_email"
];

// A building is not just a label. worker/lease.js reads its street, city, state
// and ZIP as the premises address printed on the lease, so renaming one or
// moving it to another street rewrites what every lease for it says the tenant
// is renting. That is a landlord value by any other name, and it was the one
// door into them that had no lock: this handler used to be dispatched without
// an identity at all. Reading stays open to both roles — the lease screens need
// the list — and every write is a manager's.
async function handleBuildings(request, env, identity, id) {
  const readOnly = request.method === "GET";
  if (!readOnly && !isManager(identity)) {
    return json({
      error: "Only a manager can change a building. Its address is printed on "
        + "every lease for the apartments in it."
    }, 403);
  }

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
      ? await handleLeaseDocument(request, env, identity, subresource)
      : await handleLeaseFromScratch(request, env, identity);
  }

  return json({ error: "Unknown endpoint." }, 404);
}

async function handleLeaseSettings(request, env, identity) {
  const url = new URL(request.url);

  if (request.method === "GET") {
    const listingId = url.searchParams.get("listing_id");

    // A unit view needs both layers: the screen shows which one answered each
    // field, because inherited and set-here are different to a person deciding
    // whether a lease is safe to send.
    if (listingId) {
      if (!UUID_PATTERN.test(listingId)) return json({ error: "Listing not found." }, 404);
      const layers = await fetchLeaseLayers(env, listingId);
      return json({ layers, provenance: fieldProvenance(layers) });
    }

    // Without a listing there is one layer left to ask for, and it needs a
    // property to be a layer at all.
    const scope = cleanLine(url.searchParams.get("scope"), 20) || "building";
    if (scope !== "building") return json({ error: "Unknown settings scope." }, 422);

    const buildingId = url.searchParams.get("building_id");
    if (!UUID_PATTERN.test(buildingId || "")) {
      return json({ error: "A building is required for building settings." }, 422);
    }

    const row = await fetchLeaseSettingsLayer(env, { scope, buildingId });
    return json({ scope, field_values: row?.field_values || {}, updated_at: row?.updated_at || null });
  }

  if (request.method === "PUT") {
    // Every value a settings layer can carry is a manager field — see
    // normalizeSettingsPatch, which refuses anything else — so this one check
    // covers all 125 of them, whichever screen sent them.
    if (!isManager(identity)) {
      return json({
        error: "Only a manager can change the landlord settings. "
          + "You can still read them, and they are what this lease will print."
      }, 403);
    }

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
async function handleLeaseFromScratch(request, env, identity) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const body = await request.json().catch(() => ({}));
  if (body.mode === "final") return json({ error: "Create the final lease from a landlord-confirmed case." }, 409);
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

  const { patch: overrides, errors, refused } = normalizeOverrides(body.overrides, identity);
  if (errors.length > 0) return json({ error: `Invalid fields: ${errors.join(", ")}` }, 422);
  if (refused.length > 0) return overrideRefusal(refused);

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

const EMPTY_LAYERS = { building: {}, unit: {} };

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
async function handleLeaseDocument(request, env, identity, applicationId) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!UUID_PATTERN.test(applicationId)) return json({ error: "Application not found." }, 404);

  const body = await request.json().catch(() => ({}));
  const scoped = await requireCaseAccess(env, identity, applicationId);
  if (body.mode === "final" && (!scoped.workspace?.landlord_decision || scoped.workspace.landlord_decision.outcome !== "accepted")) return json({ error: "Landlord confirmation is required before producing the final lease." }, 409);
  if (["landlord_approved", "lease_sent", "lease_signed"].includes(scoped.status) && Object.keys(body.overrides || {}).length) return json({ error: "These terms were confirmed by the landlord. Use the saved version." }, 409);
  const application = await fetchApplicationForLease(env, applicationId);
  if (!application) return json({ error: "Application not found." }, 404);

  const listing = application.listings;
  if (!listing) return json({ error: "This application's listing has been removed." }, 422);

  const building = listing.building_id ? await fetchBuilding(env, listing.building_id) : null;
  const layers = await fetchLeaseLayers(env, listing.id);

  const { patch: overrides, errors, refused } = normalizeOverrides(body.overrides, identity);
  if (errors.length > 0) return json({ error: `Invalid fields: ${errors.join(", ")}` }, 422);
  if (refused.length > 0) return overrideRefusal(refused);

  const today = todayParts(body.today);
  const deal = dealValues({ application, listing, building, today });
  const savedTerms = scoped.workspace?.recommendation?.terms || scoped.workspace?.terms || {};
  const live = resolveValues({ layers, deal, overrides: { ...savedTerms, ...overrides } });

  // A lease that has gone out is no longer a view of the settings screen. It
  // was generated from particular values, somebody has it in front of them,
  // and a manager correcting a payee address next week must not change what it
  // says. So once a snapshot exists it is what the document is filled from —
  // and what the screen shows, because a preview that disagrees with the file
  // is worse than no preview.
  const frozen = application.lease_snapshot && typeof application.lease_snapshot === "object"
    ? application.lease_snapshot
    : null;
  const values = frozen ? { ...frozen } : live.values;
  const missing = frozen ? missingIn(values) : live.missing;

  const response = await respondWithLease(request, env, {
    mode: cleanLine(body.mode, 10) || "values",
    values,
    missing,
    extras: {
      deal,
      provenance: fieldProvenance(layers),
      building_linked: Boolean(building),
      // The screen says so out loud rather than quietly showing older values
      // than the settings page it links to.
      frozen: Boolean(frozen)
    },
    filename: leaseFilename({ application, listing })
  });
  // Final downloads and later signatures must use the same immutable values.
  // Produce the file before persisting; a failed template does not lock a lease.
  if (body.mode === "final" && response.ok && !frozen) {
    await caseWorkspace(env).execute(identity, applicationId, {
      action: "prepare_lease", version: scoped.workspace_version || 0, lease_snapshot: values
    });
  }
  return response;
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
// What this one lease says, without disturbing what the next one will.
//
// The role check here matters more than the one on the settings layers. An
// override never touches stored settings and leaves no audit row: an agent who
// could send one would be altering the fine schedule or the insurance clause on
// a document somebody signs, and nothing afterwards would show it happened.
function normalizeOverrides(body, identity) {
  const patch = {};
  const errors = [];
  const refused = [];
  const mayWriteManagerFields = isManager(identity);

  for (const [id, raw] of Object.entries(body || {})) {
    const field = LEASE_REGISTRY.fields.find((candidate) => candidate.id === id);
    if (!field) {
      errors.push(id);
      continue;
    }
    if (!mayWriteManagerFields && isManagerControlled(id)) {
      refused.push(field.label || id);
      continue;
    }
    if (field.type === "checkbox") {
      patch[id] = Boolean(raw);
      continue;
    }
    // A multiline field keeps its line breaks and its length — the concession
    // rider is a paragraph, and flattening it here would print a lease that
    // disagrees with the same text saved on the application.
    const text = field.type === "multiline" ? cleanMultiline(raw) : cleanLine(raw, 400);
    if (field.type === "choice" && text !== "" && !field.options.includes(text)) {
      errors.push(id);
      continue;
    }
    if (field.type === "integer" && text !== "" && !/^\d+$/.test(text)) {
      errors.push(id);
      continue;
    }
    patch[id] = text;
  }

  return { patch, errors, refused };
}

// Both lease endpoints answer a refused override the same way, so the rule
// cannot come apart between "from an application" and "from scratch".
function listingRefusal(refused) {
  return json({
    error: `Only a manager can change ${refused.join(", ")}. `
      + "It decides which building's landlord settings every lease for this apartment reads."
  }, 403);
}

function overrideRefusal(refused) {
  return json({
    error: `Only a manager can change ${refused.length === 1 ? "this value" : "these values"} `
      + `on a lease: ${refused.join(", ")}. They are the landlord's standing terms, `
      + "the same on every lease for this apartment."
  }, 403);
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
