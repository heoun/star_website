import { verifyAccessRequest } from "./access.js";
import { purgeListingsCache } from "./listings.js";
import {
  deleteListing,
  deleteMediaRow,
  fetchListings,
  fetchMediaRow,
  insertListing,
  insertMedia,
  toAdminListing,
  updateListing,
  updateMedia
} from "./supabase.js";
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
  const identity = await verifyAccessRequest(request, env);
  if (!identity) {
    return json({ error: "Not authorized." }, 403);
  }

  const segments = pathname.replace(/^\/api\/admin\/?/, "").split("/").filter(Boolean);
  const [resource, id, subresource] = segments;

  try {
    if (resource === "me") {
      return json({ email: identity.email });
    }

    if (resource === "media" && id) {
      return await handleMediaItem(request, env, ctx, id);
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
  const identity = await verifyAccessRequest(request, env);
  if (identity) return null;

  return new Response("Not authorized.", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
  });
}
