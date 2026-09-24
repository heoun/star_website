export function mediaUrl(path) {
  return path ? `/media/${path}` : "";
}

const priceFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

function formatPrice(row) {
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
    bedrooms: numberToText(row.bedrooms),
    bathroom: numberToText(row.bathrooms),
    details_url: row.details_url || "",
    image_label: cover?.caption || "",
    image_url: cover?.url || mediaUrl(cover?.path)
  };
}

// Everything a property detail page needs: the feed fields plus the copy and
// media the cards have no room for.
export function toDetailListing(row) {
  const plan = (row.listing_media || []).find((item) => item.kind === "floor_plan");

  return {
    ...toFeedListing(row),
    property_name: row.property_name || "",
    unit: row.unit || "",
    description: row.description || "",
    video_url: row.video_url || "",
    photos: sortedPhotos(row).map((photo) => ({
      url: photo.url || mediaUrl(photo.path),
      caption: photo.caption || ""
    })),
    floor_plan: plan ? { url: plan.url || mediaUrl(plan.path), caption: plan.caption || "Floor plan" } : null
  };
}
