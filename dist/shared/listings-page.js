(function () {
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

  const normalizeListingsPayload = (payload) => {
    const rawListings = Array.isArray(payload?.listings) ? payload.listings : Array.isArray(payload) ? payload : [];
    return rawListings
      .map((item) => {
        const category = normalizeCategory(item.category || item.group || item.type || item.listing_type);
        const transactionGroup = normalizeTransactionGroup(
          item.transaction_group || item.transaction_type || item.deal_type || item.status || item.listing_status
        );

        return {
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
          neighborhood: item.neighborhood || item.area || "",
          bedrooms: item.bedrooms || item.beds || "",
          bathroom: item.bathroom || item.bathrooms || "",
          details_url: item.details_url || item.url || item.link || "",
          kind_label: item.kind_label || item.project_kind || item.kind || "",
          image_label: item.image_label || item.photo_label || ""
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
    const neighborhood = safeText(listing.neighborhood, "");

    if (propertyType) facts.push(propertyType);
    if (useType && useType.toLowerCase() !== propertyType.toLowerCase()) facts.push(useType);
    if (bedrooms === "0") facts.push("Studio");
    else if (bedrooms) facts.push(`${bedrooms} bd`);
    if (bathrooms) facts.push(`${bathrooms} bath`);
    if (size) facts.push(size);
    if (termLabel) facts.push(termLabel);
    if (neighborhood) facts.push(neighborhood);

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

  const listingCardMarkup = (listing, config) => {
    const detailsUrl = toSafeHttpUrl(listing.details_url);
    const linkAttributes = detailsUrl
      ? `href="${escapeHtml(detailsUrl)}" target="_blank" rel="noopener noreferrer"`
      : 'href="#" aria-disabled="true"';
    const linkText = detailsUrl ? "Property Details" : "Details unavailable";
    const defaultKind = safeText(config.defaultKind, "Residential Listing");
    const photoLabel = safeText(listing.image_label, config.emptyPhotoLabel || "Listing preview");
    const addressParts = [safeText(listing.neighborhood, ""), safeText(listing.location, "")].filter(Boolean);
    const addressLine = addressParts.join(" · ");
    const statusLabel = resolveStatusLabel(listing.transaction_group, config, config.emptyStatusLabel);
    const kindLabel = safeText(listing.kind_label, defaultKind);
    const factsMarkup = buildFacts(listing)
      .map((fact) => `<span class="listing-fact">${escapeHtml(fact)}</span>`)
      .join("");

    return `
      <article class="listing-card">
        <div class="listing-media" role="img" aria-label="${escapeHtml(photoLabel)}">
          ${listingMetaMarkup(kindLabel, statusLabel, config)}
          ${listingPhotoCopyMarkup(photoLabel, config)}
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

  const emptyCardMarkup = (config) => {
    const kindLabel = safeText(config.collectionLabel);
    const statusLabel = safeText(config.emptyStatusLabel);
    return `
      <article class="listing-card">
        <div class="listing-media" role="img" aria-label="${escapeHtml(config.emptyPhotoLabel || "No listing preview available")}">
          ${listingMetaMarkup(kindLabel, statusLabel, config)}
          ${listingPhotoCopyMarkup(config.emptyPhotoLabel || "No preview available", config)}
        </div>
        <div class="listing-body">
          <p class="listing-price">Placeholder feed pending</p>
          <h5>${escapeHtml(config.emptyTitle)}</h5>
          <p class="listing-address">Inventory will appear here after the next successful sync.</p>
          <div class="listing-facts">
            <span class="listing-fact">Ask about current availability</span>
          </div>
        </div>
        <a href="${escapeHtml(config.emptyCtaHref)}" class="listing-link">${escapeHtml(config.emptyCtaText)}</a>
      </article>
    `;
  };

  const renderListingsCollection = (config) => {
    const grid = document.querySelector(config.gridSelector || '[data-grid="residential"]');
    if (!grid) return;
    const targetCategory = normalizeCategory(config.category || "residential") || "residential";

    const maxVisibleListings = Number.isFinite(config.maxVisibleListings) ? config.maxVisibleListings : 9;

    const renderListings = (listings) => {
      const filteredListings = listings
        .filter((item) => item.transaction_group === config.transactionGroup && item.category === targetCategory)
        .slice(0, maxVisibleListings);

      grid.innerHTML = filteredListings.length > 0
        ? filteredListings.map((item) => listingCardMarkup(item, config)).join("")
        : emptyCardMarkup(config);
    };

    const hydrateListingsFromJson = async () => {
      try {
        const response = await fetch(config.dataPath, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        renderListings(normalizeListingsPayload(payload));
      } catch (error) {
        console.warn(config.fetchErrorMessage || "Listings sync fetch failed. Rendering placeholders.", error);
        renderListings([]);
      }
    };

    renderListings([]);
    hydrateListingsFromJson();
  };

  window.renderListingsCollection = renderListingsCollection;

  window.renderResidentialListingsPage = function renderResidentialListingsPage(config) {
    renderListingsCollection({
      ...config,
      category: "residential"
    });
  };
})();
