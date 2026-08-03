(function () {
  const container = document.getElementById("property");
  if (!container) return;

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  // Same rule the listing cards use: same-origin media paths are allowed,
  // anything else must be a real http(s) URL.
  const safeUrl = (value) => {
    const text = String(value ?? "").trim();
    if (text.startsWith("/") && !text.startsWith("//")) return text;
    try {
      const parsed = new URL(text);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
    } catch {
      return "";
    }
  };

  const showState = (message) => {
    container.innerHTML = `<p class="state">${escapeHtml(message)}</p>`;
  };

  const buildFacts = (property) => {
    const facts = [];
    if (property.property_type) facts.push(property.property_type);
    if (property.use_type && property.use_type !== property.property_type) facts.push(property.use_type);
    if (property.bedrooms === "0") facts.push("Studio");
    else if (property.bedrooms) facts.push(`${property.bedrooms} bd`);
    if (property.bathroom) facts.push(`${property.bathroom} bath`);
    if (property.size) facts.push(property.size);
    if (property.term_label) facts.push(property.term_label);
    return facts;
  };

  const detailRows = (property) => {
    const rows = [
      ["Building", [property.building_name, property.unit].filter(Boolean).join(" ")],
      ["Neighborhood", property.neighborhood],
      ["Property type", property.property_type],
      ["Bedrooms", property.bedrooms === "0" ? "Studio" : property.bedrooms],
      ["Bathrooms", property.bathroom],
      ["Size", property.size],
      ["Availability", property.status]
    ];

    return rows
      .filter(([, value]) => value)
      .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
      .join("");
  };

  const galleryMarkup = (photos) => {
    if (photos.length === 0) {
      return '<div class="stage"><div class="caption">Photos coming soon</div></div>';
    }

    const first = photos[0];
    const arrows = photos.length > 1
      ? `<button type="button" class="prev" data-step="-1" aria-label="Previous photo">‹</button>
         <button type="button" class="next" data-step="1" aria-label="Next photo">›</button>`
      : "";

    const thumbs = photos.length > 1
      ? `<div class="thumbs">${photos.map((photo, index) => `
          <img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.caption || `Photo ${index + 1}`)}"
               data-index="${index}" loading="lazy" ${index === 0 ? 'aria-current="true"' : ""}>
        `).join("")}</div>`
      : "";

    return `
      <div class="stage">
        <img id="stage-image" src="${escapeHtml(first.url)}" alt="${escapeHtml(first.caption || "Property photo")}">
        ${arrows}
        <span class="caption" id="stage-caption">${escapeHtml(first.caption || "")}</span>
      </div>
      ${thumbs}
    `;
  };

  const render = (property) => {
    const photos = (property.photos || []).map((photo) => ({ ...photo, url: safeUrl(photo.url) })).filter((photo) => photo.url);
    const floorPlan = property.floor_plan && safeUrl(property.floor_plan.url)
      ? { ...property.floor_plan, url: safeUrl(property.floor_plan.url) }
      : null;
    const videoUrl = safeUrl(property.video_url);
    const isHostedVideo = videoUrl.startsWith("/media/");
    const externalDetails = safeUrl(property.details_url);
    const addressLine = [property.neighborhood, property.location].filter(Boolean).join(" · ");

    container.innerHTML = `
      ${galleryMarkup(photos)}
      <div class="content">
        <div>
          <p class="price">${escapeHtml(property.price || "Price on request")}</p>
          <h1>${escapeHtml(property.title || "Property")}</h1>
          <p class="address">${escapeHtml(addressLine || "Address available on request")}</p>
          <div class="facts">${buildFacts(property).map((fact) => `<span class="fact">${escapeHtml(fact)}</span>`).join("")}</div>

          ${property.description ? `<h2>About this home</h2><p class="description">${escapeHtml(property.description)}</p>` : ""}

          ${floorPlan ? `<h2>Floor plan</h2><div class="media-block">
            <img src="${escapeHtml(floorPlan.url)}" alt="${escapeHtml(floorPlan.caption)}" loading="lazy">
          </div>` : ""}

          ${videoUrl ? `<h2>Video tour</h2><div class="media-block">${isHostedVideo
            ? `<video src="${escapeHtml(videoUrl)}" controls preload="metadata" playsinline></video>`
            : `<a href="${escapeHtml(videoUrl)}" target="_blank" rel="noopener noreferrer">Watch the video tour</a>`
          }</div>` : ""}
        </div>

        <aside class="aside">
          <h2>Details</h2>
          <dl>${detailRows(property)}</dl>
          <a class="cta" href="../contact-us/?intent=inquiry">Ask about this property</a>
          ${externalDetails ? `<a class="cta secondary" href="${escapeHtml(externalDetails)}" target="_blank" rel="noopener noreferrer">External listing</a>` : ""}
        </aside>
      </div>
    `;

    document.title = `${property.title || "Property"} | Star Real Estate`;

    if (photos.length > 1) wireGallery(photos);
  };

  const wireGallery = (photos) => {
    const image = document.getElementById("stage-image");
    const caption = document.getElementById("stage-caption");
    const thumbs = [...container.querySelectorAll(".thumbs img")];
    let index = 0;

    const show = (next) => {
      index = (next + photos.length) % photos.length;
      image.src = photos[index].url;
      image.alt = photos[index].caption || `Photo ${index + 1}`;
      caption.textContent = photos[index].caption || "";
      thumbs.forEach((thumb, position) => {
        if (position === index) thumb.setAttribute("aria-current", "true");
        else thumb.removeAttribute("aria-current");
      });
    };

    for (const button of container.querySelectorAll(".stage button")) {
      button.addEventListener("click", () => show(index + Number(button.dataset.step)));
    }

    for (const thumb of thumbs) {
      thumb.addEventListener("click", () => show(Number(thumb.dataset.index)));
    }

    document.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") show(index - 1);
      if (event.key === "ArrowRight") show(index + 1);
    });
  };

  const id = new URLSearchParams(window.location.search).get("id") || "";

  if (!id) {
    showState("No property was requested. Browse the listings to pick one.");
    return;
  }

  fetch(`../data/property.json?id=${encodeURIComponent(id)}`, { cache: "no-store" })
    .then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "This property could not be loaded.");
      return payload;
    })
    .then(render)
    .catch((error) => showState(error.message));
})();
