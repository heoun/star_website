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
  "position"
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
