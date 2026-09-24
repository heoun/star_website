const escapeHtml = (value) => {
  const text = String(value ?? "");
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const safeText = (value, fallback = "-") => {
  const cleaned = String(value ?? "").trim();
  return cleaned || fallback;
};

const normalizeCategory = (value) => {
  const lowered = String(value ?? "").toLowerCase();
  if (lowered.includes("comm")) return "commercial";
  if (lowered.includes("res")) return "residential";
  return "";
};

const normalizeTransactionGroup = (value) => {
  const lowered = String(value ?? "").toLowerCase().trim();
  if (!lowered) return "";
  if (lowered.includes("sale") || lowered.includes("sell")) return "sale";
  if (lowered.includes("occup") || lowered.includes("rent") || lowered.includes("lease") || lowered.includes("rental")) return "rental";
  return "";
};

const deriveStatusLabel = (transactionGroup, fallback = "Available") => {
  if (transactionGroup === "sale") return "For Sale";
  if (transactionGroup === "rental") return "For Rent";
  return fallback;
};

const resolveStatusLabel = (transactionGroup, config, fallback = "Available") => {
  const override = config?.statusLabels && typeof config.statusLabels === "object"
    ? String(config.statusLabels[transactionGroup] ?? "").trim()
    : "";
  return override || deriveStatusLabel(transactionGroup, fallback);
};

const toSafeHttpUrl = (value) => {
  try {
    const parsed = new URL(String(value ?? "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
};

// Listing photos are served same-origin from /media/, so root-relative
// paths are allowed in addition to absolute http(s) URLs.
const toSafeImageUrl = (value) => {
  const text = String(value ?? "").trim();
  if (text.startsWith("/") && !text.startsWith("//")) return text;
  return toSafeHttpUrl(text);
};

const normalizeListingsPayload = (payload) => {
  const rawListings = Array.isArray(payload?.listings) ? payload.listings : Array.isArray(payload) ? payload : [];
  return rawListings
    .map((item) => {
      const category = normalizeCategory(item.category || item.group || item.type || item.listing_type);
      const transactionGroup = normalizeTransactionGroup(
        item.transaction_group || item.transaction_type || item.deal_type || item.status || item.listing_status
      );

      return {
        id: item.id || "",
        category,
        transaction_group: transactionGroup,
        status: deriveStatusLabel(transactionGroup, item.status || item.listing_status || "Available"),
        title: item.title || item.name || item.property_name || "",
        price: item.price || item.list_price || item.rent || "",
        property_type: item.property_type || item.propertyType || "",
        use_type: item.use_type || item.useType || item.asset_class || "",
        size: item.size || item.square_feet || item.squareFeet || item.sf || "",
        term_label: item.term_label || item.term || item.lease_term || "",
        location: item.location || item.address || "",
        bedrooms: item.bedrooms || item.beds || "",
        bathroom: item.bathroom || item.bathrooms || "",
        details_url: item.details_url || item.url || item.link || "",
        image_label: item.image_label || item.photo_label || "",
        image_url: item.image_url || item.photo_url || item.image || ""
      };
    })
    .filter((item) => item.category && item.title && item.transaction_group);
};

const buildFacts = (listing) => {
  const facts = [];
  const propertyType = safeText(listing.property_type, "");
  const useType = safeText(listing.use_type, "");
  const size = safeText(listing.size, "");
  const termLabel = safeText(listing.term_label, "");
  const bedrooms = safeText(listing.bedrooms, "");
  const bathrooms = safeText(listing.bathroom, "");

  if (propertyType) facts.push(propertyType);
  if (useType && useType.toLowerCase() !== propertyType.toLowerCase()) facts.push(useType);
  if (bedrooms) facts.push(`${bedrooms} bd`);
  if (bathrooms) facts.push(`${bathrooms} bath`);
  if (size) facts.push(size);
  if (termLabel) facts.push(termLabel);

  return facts.slice(0, 4);
};

const listingMetaMarkup = (kindText, statusText, config) => {
  const showKindBadge = config.showKindBadge !== false;
  const showStatusBadge = config.showStatusBadge !== false;
  const badges = [];

  if (showKindBadge) {
    badges.push(`<span class="listing-kind">${escapeHtml(kindText)}</span>`);
  }

  if (showStatusBadge) {
    badges.push(`<span class="listing-status">${escapeHtml(statusText)}</span>`);
  }

  return badges.length > 0
    ? `<div class="listing-meta">${badges.join("")}</div>`
    : "";
};

const listingPhotoCopyMarkup = (headlineText, config) => {
  if (config.showPhotoCopy === false) return "";

  return `
    <div class="listing-photo-copy">
      <span class="listing-photo-kicker">${escapeHtml(config.photoKicker || "Listing Preview")}</span>
      <strong>${escapeHtml(headlineText)}</strong>
    </div>
  `;
};

const listingCardMarkup = (listing, config, index) => {
  // An external listing system wins when one is configured; otherwise the
  // card opens the property page built from our own data.
  const externalUrl = toSafeHttpUrl(listing.details_url);
  const propertyPath = listing.id
    ? `${config.propertyPath || "../property/"}?id=${encodeURIComponent(listing.id)}`
    : "";

  let linkAttributes = 'href="#" aria-disabled="true"';
  let linkText = "Details unavailable";

  if (externalUrl) {
    linkAttributes = `href="${escapeHtml(externalUrl)}" target="_blank" rel="noopener noreferrer"`;
    linkText = "Property Details";
  } else if (propertyPath) {
    linkAttributes = `href="${escapeHtml(propertyPath)}"`;
    linkText = "Property Details";
  }
  const defaultKind = safeText(config.defaultKind, "Residential Listing");
  const photoLabel = safeText(listing.image_label, config.emptyPhotoLabel || "Listing preview");
  const addressParts = [safeText(listing.location, "")].filter(Boolean);
  const addressLine = addressParts.join(" · ");
  const statusLabel = resolveStatusLabel(listing.transaction_group, config, config.emptyStatusLabel);
  const kindLabel = safeText(listing.property_type, defaultKind);
  const factsMarkup = buildFacts(listing)
    .map((fact) => `<span class="listing-fact">${escapeHtml(fact)}</span>`)
    .join("");

  const photoUrl = toSafeImageUrl(listing.image_url);
  const photoMarkup = photoUrl
    ? `<img class="listing-photo" src="${escapeHtml(photoUrl)}" alt="${escapeHtml(photoLabel)}" loading="${index < 3 ? "eager" : "lazy"}" fetchpriority="${index === 0 ? "high" : "auto"}" decoding="async">`
    : listingPhotoCopyMarkup(photoLabel, config);

  return `
    <article class="listing-card">
      <div class="listing-media" role="img" aria-label="${escapeHtml(photoLabel)}">
        ${photoMarkup}
        ${listingMetaMarkup(kindLabel, statusLabel, config)}
      </div>
      <div class="listing-body">
        <p class="listing-price">${escapeHtml(safeText(listing.price))}</p>
        <h5>${escapeHtml(safeText(listing.title, "Untitled Listing"))}</h5>
        <p class="listing-address">${escapeHtml(addressLine || "Address details coming soon")}</p>
        <div class="listing-facts">${factsMarkup || '<span class="listing-fact">Details coming soon</span>'}</div>
      </div>
      <a ${linkAttributes} class="listing-link">${escapeHtml(linkText)}</a>
    </article>
  `;
};

export function listingStateMarkup(config, state = "empty") {
  const title = state === "error" ? "Listings are temporarily unavailable" : state === "search" ? "No listings match your search" : config.emptyTitle;
  return `<div class="listing-state" role="status"><p>${escapeHtml(title)}</p><a href="${escapeHtml(config.emptyCtaHref)}">${escapeHtml(config.emptyCtaText)}</a></div>`;
}

export function selectListingCollection(payload, config, query = "") {
  const term = query.trim().toLowerCase();
  return normalizeListingsPayload(payload)
    .filter(item => item.transaction_group === config.transactionGroup && item.category === config.category)
    .filter(item => !term || [item.title, item.location].some(value => String(value).toLowerCase().includes(term)))
    .slice(0, config.maxVisibleListings);
}

export function listingImagePreloads(payload, config, query = "") {
  return selectListingCollection(payload, config, query).slice(0, 3).map(item => toSafeImageUrl(item.image_url)).filter(Boolean);
}

export function listingCollectionMarkup(payload, config, query = "") {
  const listings = selectListingCollection(payload, config, query);
  return listings.length ? listings.map((item, index) => listingCardMarkup(item, config, index)).join("") : listingStateMarkup(config, query.trim() ? "search" : "empty");
}
