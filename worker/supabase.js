const LISTING_COLUMNS = [
  "id",
  "category",
  "transaction_type",
  "title",
  "building_name",
  "unit",
  "description",
  "price_amount",
  "price_display",
  "property_type",
  "use_type",
  "size",
  "term_label",
  "location",
  "neighborhood",
  "bedrooms",
  "bathrooms",
  "video_url",
  "details_url",
  "kind_label",
  "published",
  "position",
  "building_id"
].join(",");

const MEDIA_COLUMNS = "id,listing_id,kind,path,caption,position";

export function requireConfig(env) {
  const url = (env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) {
    throw new Error("Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  return { url, key };
}

async function restRequest(env, path, init = {}) {
  const { url, key } = requireConfig(env);
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...init.headers
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase ${init.method || "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }

  return response;
}

export async function fetchListings(env, { publishedOnly = true } = {}) {
  const filters = [
    `select=${LISTING_COLUMNS},listing_media(${MEDIA_COLUMNS})`,
    "order=position.asc,created_at.desc",
    "listing_media.order=kind.asc,position.asc"
  ];
  if (publishedOnly) filters.push("published=eq.true");

  const response = await restRequest(env, `listings?${filters.join("&")}`);
  return response.json();
}

export async function fetchListing(env, id, { publishedOnly = true } = {}) {
  const filters = [
    `select=${LISTING_COLUMNS},listing_media(${MEDIA_COLUMNS})`,
    `id=eq.${encodeURIComponent(id)}`,
    "listing_media.order=kind.asc,position.asc"
  ];
  if (publishedOnly) filters.push("published=eq.true");

  const response = await restRequest(env, `listings?${filters.join("&")}`);
  const [row] = await response.json();
  return row || null;
}

export async function insertListing(env, values) {
  const response = await restRequest(env, "listings", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row;
}

export async function updateListing(env, id, values) {
  const response = await restRequest(env, `listings?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row;
}

export async function deleteListing(env, id) {
  await restRequest(env, `listings?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function insertMedia(env, values) {
  const response = await restRequest(env, "listing_media", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row;
}

export async function updateMedia(env, id, values) {
  const response = await restRequest(env, `listing_media?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row;
}

export async function fetchMediaRow(env, id) {
  const response = await restRequest(
    env,
    `listing_media?id=eq.${encodeURIComponent(id)}&select=${MEDIA_COLUMNS}`
  );
  const [row] = await response.json();
  return row || null;
}

export async function deleteMediaRow(env, id) {
  await restRequest(env, `listing_media?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ssn_encrypted is deliberately excluded: the ciphertext only leaves the
// database through fetchApplicationSsn for the admin reveal endpoint.
const APPLICATION_COLUMNS =
  "id,listing_id,name,first_name,last_name,email,phone,current_address,move_in," +
  "lease_term_months,dob,ssn_last4,household_size,children_under_11,income_note," +
  "current_employer,employment_history,rental_history,reference_contacts," +
  "emergency_contacts,pets,message,status,notes,created_at,updated_at";

export async function insertApplication(env, values) {
  const response = await restRequest(env, "applications", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row;
}

export async function fetchApplications(env) {
  const response = await restRequest(
    env,
    `applications?select=${APPLICATION_COLUMNS},listings(title,building_name,unit)&order=created_at.desc`
  );
  return response.json();
}

export async function updateApplication(env, id, values) {
  const response = await restRequest(env, `applications?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row;
}

export async function deleteApplication(env, id) {
  await restRequest(env, `applications?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function fetchApplicationSsn(env, id) {
  const response = await restRequest(
    env,
    `applications?id=eq.${encodeURIComponent(id)}&select=id,ssn_encrypted`
  );
  const [row] = await response.json();
  return row ?? null;
}

export function mediaUrl(path) {
  return path ? `/media/${path}` : "";
}

const priceFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

function formatPrice(row) {
  if (row.price_display) return row.price_display;
  if (row.price_amount === null || row.price_amount === undefined) return "";

  const amount = Number(row.price_amount);
  if (!Number.isFinite(amount)) return "";

  const formatted = priceFormatter.format(amount);
  return row.transaction_type === "rental" ? `${formatted}/mo` : formatted;
}

function numberToText(value) {
  if (value === null || value === undefined || value === "") return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : "";
}

function sortedPhotos(row) {
  return (row.listing_media || [])
    .filter((media) => media.kind === "photo")
    .sort((a, b) => a.position - b.position);
}

// Shapes a database row into the JSON the listing pages already consume, so the
// frontend contract stays unchanged. The cover image is the first photo.
export function toFeedListing(row) {
  const cover = sortedPhotos(row)[0];

  return {
    id: row.id,
    category: row.category,
    transaction_group: row.transaction_type,
    status: row.transaction_type === "rental" ? "For Rent" : "For Sale",
    title: row.title || "",
    price: formatPrice(row),
    property_type: row.property_type || "",
    use_type: row.use_type || "",
    size: row.size || "",
    term_label: row.term_label || "",
    location: row.location || "",
    neighborhood: row.neighborhood || "",
    bedrooms: numberToText(row.bedrooms),
    bathroom: numberToText(row.bathrooms),
    details_url: row.details_url || "",
    kind_label: row.kind_label || "",
    image_label: cover?.caption || "",
    image_url: mediaUrl(cover?.path)
  };
}

// Everything a property detail page needs: the feed fields plus the copy and
// media the cards have no room for.
export function toDetailListing(row) {
  const plan = (row.listing_media || []).find((item) => item.kind === "floor_plan");

  return {
    ...toFeedListing(row),
    building_name: row.building_name || "",
    unit: row.unit || "",
    description: row.description || "",
    video_url: row.video_url || "",
    photos: sortedPhotos(row).map((photo) => ({
      url: mediaUrl(photo.path),
      caption: photo.caption || ""
    })),
    floor_plan: plan ? { url: mediaUrl(plan.path), caption: plan.caption || "Floor plan" } : null
  };
}

// Admin representation: full row plus ready-to-use URLs for every media item.
export function toAdminListing(row) {
  const media = (row.listing_media || [])
    .sort((a, b) => (a.kind === b.kind ? a.position - b.position : a.kind.localeCompare(b.kind)))
    .map((item) => ({ ...item, url: mediaUrl(item.path) }));

  return { ...row, listing_media: media };
}

// ---------------------------------------------------------------- leases

const BUILDING_COLUMNS = "id,name,street,city,state,state_abbr,zip,created_at,updated_at";

export async function fetchBuildings(env) {
  const response = await restRequest(env, `buildings?select=${BUILDING_COLUMNS}&order=name.asc`);
  return response.json();
}

export async function fetchBuilding(env, id) {
  const response = await restRequest(
    env,
    `buildings?id=eq.${encodeURIComponent(id)}&select=${BUILDING_COLUMNS}`
  );
  const [row] = await response.json();
  return row || null;
}

export async function insertBuilding(env, values) {
  const response = await restRequest(env, "buildings", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row;
}

export async function updateBuilding(env, id, values) {
  const response = await restRequest(env, `buildings?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row;
}

// One application with everything a lease needs from its listing: the address
// line the parts are read from, the rent, the unit, and the building whose
// settings layer applies.
export async function fetchApplicationForLease(env, id) {
  const response = await restRequest(
    env,
    `applications?id=eq.${encodeURIComponent(id)}` +
      "&select=id,listing_id,name,email,phone,move_in,lease_term_months,children_under_11,status," +
      "listings(id,title,building_name,unit,location,price_amount,building_id)"
  );
  const [row] = await response.json();
  return row || null;
}

// One settings layer, or null when that layer has never been saved. An absent
// row and an empty row mean the same thing: this layer answers nothing.
export async function fetchLeaseSettingsLayer(env, { scope, buildingId = null, listingId = null }) {
  const filters = [`select=id,scope,building_id,listing_id,field_values,updated_at`, `scope=eq.${scope}`];
  filters.push(buildingId ? `building_id=eq.${encodeURIComponent(buildingId)}` : "building_id=is.null");
  filters.push(listingId ? `listing_id=eq.${encodeURIComponent(listingId)}` : "listing_id=is.null");

  const response = await restRequest(env, `lease_settings?${filters.join("&")}`);
  const [row] = await response.json();
  return row || null;
}

async function callRpc(env, name, args) {
  const response = await restRequest(env, `rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(args)
  });
  return response.json();
}

// The three layers that apply to one unit, unmerged. The caller merges them,
// because it also has to report which layer answered each field.
export async function fetchLeaseLayers(env, listingId) {
  return callRpc(env, "lease_settings_for_listing", { p_listing_id: listingId });
}

// PostgREST can only set a column to a literal, so saving part of a layer
// without overwriting the rest goes through a function. A null in the patch
// means "this layer no longer answers that field".
export async function applyLeaseSettings(env, { scope, buildingId = null, listingId = null, patch, actor }) {
  return callRpc(env, "lease_settings_apply", {
    p_scope: scope,
    p_building_id: buildingId,
    p_listing_id: listingId,
    p_patch: patch,
    p_actor: actor || null
  });
}
