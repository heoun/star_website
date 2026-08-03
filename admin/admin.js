(function () {
  const API = "/api/admin";

  const rowsEl = document.getElementById("rows");
  const statusEl = document.getElementById("status");
  const whoEl = document.getElementById("who");
  const editor = document.getElementById("editor");
  const form = document.getElementById("listing-form");
  const editorTitle = document.getElementById("editor-title");
  const saveButton = document.getElementById("save");
  const mediaSection = document.getElementById("media-section");
  const mediaLocked = document.getElementById("media-locked");
  const photoGrid = document.getElementById("photo-grid");
  const photoFiles = document.getElementById("photo-files");
  const planFile = document.getElementById("plan-file");
  const planPreview = document.getElementById("plan-preview");
  const videoFile = document.getElementById("video-file");
  const videoPreview = document.getElementById("video-preview");

  const TEXT_FIELDS = [
    "title", "building_name", "unit", "description", "price_display", "property_type",
    "use_type", "size", "term_label", "location", "neighborhood", "details_url",
    "kind_label", "video_url"
  ];
  const NUMBER_FIELDS = ["price_amount", "bedrooms", "bathrooms", "position"];

  let listings = [];
  let filter = "all";
  let editingId = null;
  let currentMedia = [];

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  function setStatus(message, tone) {
    statusEl.hidden = !message;
    statusEl.textContent = message || "";
    if (tone) statusEl.dataset.tone = tone;
    else delete statusEl.dataset.tone;
  }

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, { credentials: "same-origin", ...options });
    const isJson = (response.headers.get("Content-Type") || "").includes("application/json");
    const payload = isJson ? await response.json() : null;

    if (!response.ok) {
      throw new Error(payload?.error || `Request failed (${response.status})`);
    }

    return payload;
  }

  // ---- Image compression (runs in the browser before upload) ----

  async function compressImage(file, maxDimension) {
    if (!file.type.startsWith("image/")) return file;

    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) return file;

    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const alreadySmall = file.size < 400 * 1024 && scale === 1;
    if (alreadySmall && (file.type === "image/jpeg" || file.type === "image/webp")) {
      bitmap.close();
      return file;
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
    if (!blob) return file;

    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".webp", { type: "image/webp" });
  }

  // ---- Media helpers ----

  async function uploadFile(file) {
    const body = new FormData();
    body.append("file", file);
    return api(`/listings/${encodeURIComponent(editingId)}/uploads`, { method: "POST", body });
  }

  function photos() {
    return currentMedia.filter((item) => item.kind === "photo").sort((a, b) => a.position - b.position);
  }

  function floorPlan() {
    return currentMedia.find((item) => item.kind === "floor_plan") || null;
  }

  function renderMedia() {
    const items = photos();
    photoGrid.innerHTML = items.map((item, index) => `
      <div class="photo-item" data-id="${escapeHtml(item.id)}">
        <img src="${escapeHtml(item.url)}" alt="">
        <div class="photo-tools">
          <input type="text" data-role="caption" placeholder="Caption (Living room)" maxlength="120"
                 value="${escapeHtml(item.caption || "")}">
          <div class="photo-buttons">
            <button type="button" class="small" data-role="left" ${index === 0 ? "disabled" : ""}>←</button>
            <button type="button" class="small danger" data-role="remove">Delete</button>
            <button type="button" class="small" data-role="right" ${index === items.length - 1 ? "disabled" : ""}>→</button>
          </div>
        </div>
      </div>
    `).join("");

    const plan = floorPlan();
    planPreview.innerHTML = plan
      ? `<img src="${escapeHtml(plan.url)}" alt="Floor plan">
         <button type="button" class="small danger" data-role="remove-plan" data-id="${escapeHtml(plan.id)}">Delete floor plan</button>`
      : "";

    const videoUrl = form.elements.video_url.value.trim();
    videoPreview.innerHTML = videoUrl && videoUrl.startsWith("/media/")
      ? `<a href="${escapeHtml(videoUrl)}" target="_blank" rel="noopener">Preview uploaded video</a>`
      : "";
  }

  async function addPhotos(files) {
    const startPosition = photos().length;
    let added = 0;

    for (const file of files) {
      setStatus(`Uploading photo ${added + 1} of ${files.length}…`);
      const compressed = await compressImage(file, 1600);
      const upload = await uploadFile(compressed);
      const caption = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
      const { media } = await api(`/listings/${encodeURIComponent(editingId)}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: upload.path, kind: "photo", caption, position: startPosition + added })
      });
      currentMedia.push(media);
      added += 1;
    }

    renderMedia();
    setStatus(`${added} photo${added === 1 ? "" : "s"} uploaded.`);
  }

  async function setFloorPlan(file) {
    setStatus("Uploading floor plan…");
    const existing = floorPlan();
    const compressed = await compressImage(file, 2000);
    const upload = await uploadFile(compressed);
    const { media } = await api(`/listings/${encodeURIComponent(editingId)}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: upload.path, kind: "floor_plan", caption: "Floor plan", position: 0 })
    });

    if (existing) {
      await api(`/media/${encodeURIComponent(existing.id)}`, { method: "DELETE" });
      currentMedia = currentMedia.filter((item) => item.id !== existing.id);
    }

    currentMedia.push(media);
    renderMedia();
    setStatus("Floor plan uploaded.");
  }

  async function setVideo(file) {
    setStatus("Uploading video… this can take a minute.");
    const upload = await uploadFile(file);
    form.elements.video_url.value = upload.url;
    await api(`/listings/${encodeURIComponent(editingId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_url: upload.url })
    });
    renderMedia();
    setStatus("Video uploaded and attached.");
  }

  // ---- Listing list ----

  function describe(listing) {
    const parts = [];
    if (listing.price_display) parts.push(listing.price_display);
    else if (listing.price_amount !== null && listing.price_amount !== undefined) {
      const amount = Number(listing.price_amount).toLocaleString("en-US", {
        style: "currency", currency: "USD", maximumFractionDigits: 0
      });
      parts.push(listing.transaction_type === "rental" ? `${amount}/mo` : amount);
    }
    const home = [listing.building_name, listing.unit].filter(Boolean).join(" ");
    if (home) parts.push(home);
    if (listing.neighborhood) parts.push(listing.neighborhood);
    return parts.join(" · ") || "No price or address yet";
  }

  function coverUrl(listing) {
    const cover = (listing.listing_media || [])
      .filter((item) => item.kind === "photo")
      .sort((a, b) => a.position - b.position)[0];
    return cover ? cover.url : "";
  }

  function render() {
    const visible = listings.filter((listing) => {
      if (filter === "all") return true;
      if (filter === "draft") return !listing.published;
      return listing.category === filter;
    });

    if (visible.length === 0) {
      rowsEl.innerHTML = '<p class="status">No listings match this filter.</p>';
      return;
    }

    rowsEl.innerHTML = visible.map((listing) => `
      <article class="row" data-id="${escapeHtml(listing.id)}">
        ${coverUrl(listing)
          ? `<img class="thumb" src="${escapeHtml(coverUrl(listing))}" alt="" loading="lazy">`
          : '<div class="thumb"></div>'}
        <div>
          <h2>${escapeHtml(listing.title || "Untitled listing")}</h2>
          <p>${escapeHtml(describe(listing))}</p>
          <div class="tags">
            <span class="tag">${escapeHtml(listing.category)}</span>
            <span class="tag">${listing.transaction_type === "rental" ? "For rent" : "For sale"}</span>
            ${listing.published ? "" : '<span class="tag draft">Unpublished</span>'}
          </div>
        </div>
        <div class="actions">
          <button type="button" data-action="edit">Edit</button>
          <button type="button" class="danger" data-action="delete">Delete</button>
        </div>
      </article>
    `).join("");
  }

  async function load() {
    setStatus("Loading listings…");
    try {
      const [{ listings: rows }, me] = await Promise.all([api("/listings"), api("/me").catch(() => null)]);
      listings = rows;
      if (me?.email) whoEl.textContent = me.email;
      setStatus("");
      render();
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  // ---- Editor ----

  function setMediaEnabled(enabled) {
    mediaSection.hidden = !enabled;
    mediaLocked.hidden = enabled;
  }

  function openEditor(listing) {
    editingId = listing?.id || null;
    currentMedia = (listing?.listing_media || []).slice();
    editorTitle.textContent = listing ? "Edit listing" : "New listing";

    form.reset();
    photoFiles.value = "";
    planFile.value = "";
    videoFile.value = "";

    for (const field of TEXT_FIELDS.concat(NUMBER_FIELDS)) {
      form.elements[field].value = listing?.[field] ?? (field === "position" ? 0 : "");
    }
    form.elements.category.value = listing?.category || "residential";
    form.elements.transaction_type.value = listing?.transaction_type || "sale";
    form.elements.published.checked = listing ? Boolean(listing.published) : true;

    setMediaEnabled(Boolean(editingId));
    renderMedia();
    editor.showModal();
  }

  function collectValues() {
    const values = {
      category: form.elements.category.value,
      transaction_type: form.elements.transaction_type.value,
      published: form.elements.published.checked
    };

    for (const field of TEXT_FIELDS) {
      values[field] = form.elements[field].value.trim();
    }

    for (const field of NUMBER_FIELDS) {
      const raw = form.elements[field].value.trim();
      values[field] = raw === "" ? null : Number(raw);
    }

    return values;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    saveButton.disabled = true;
    setStatus("Saving…");

    try {
      const values = collectValues();

      if (editingId) {
        await api(`/listings/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values)
        });
        editor.close();
        setStatus("Saved. The website updates within a minute.");
      } else {
        const { listing } = await api("/listings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values)
        });
        editingId = listing.id;
        currentMedia = [];
        editorTitle.textContent = "Edit listing";
        setMediaEnabled(true);
        renderMedia();
        setStatus("Listing saved — now add photos, a floor plan, or a video below.");
      }

      await load();
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      saveButton.disabled = false;
    }
  });

  photoFiles.addEventListener("change", async () => {
    const files = Array.from(photoFiles.files || []);
    photoFiles.value = "";
    if (files.length === 0 || !editingId) return;
    try {
      await addPhotos(files);
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  planFile.addEventListener("change", async () => {
    const file = planFile.files?.[0];
    planFile.value = "";
    if (!file || !editingId) return;
    try {
      await setFloorPlan(file);
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  videoFile.addEventListener("change", async () => {
    const file = videoFile.files?.[0];
    videoFile.value = "";
    if (!file || !editingId) return;
    try {
      await setVideo(file);
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  photoGrid.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-role]");
    if (!button) return;

    const id = button.closest(".photo-item").dataset.id;
    const ordered = photos();
    const index = ordered.findIndex((item) => item.id === id);
    if (index === -1) return;

    try {
      if (button.dataset.role === "remove") {
        await api(`/media/${encodeURIComponent(id)}`, { method: "DELETE" });
        currentMedia = currentMedia.filter((item) => item.id !== id);
      } else {
        const target = button.dataset.role === "left" ? index - 1 : index + 1;
        if (target < 0 || target >= ordered.length) return;
        const a = ordered[index];
        const b = ordered[target];
        await api(`/media/${encodeURIComponent(a.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ position: target })
        });
        await api(`/media/${encodeURIComponent(b.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ position: index })
        });
        a.position = target;
        b.position = index;
      }
      renderMedia();
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  photoGrid.addEventListener("change", async (event) => {
    const input = event.target.closest('input[data-role="caption"]');
    if (!input) return;

    const id = input.closest(".photo-item").dataset.id;
    try {
      await api(`/media/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption: input.value })
      });
      const item = currentMedia.find((media) => media.id === id);
      if (item) item.caption = input.value;
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  planPreview.addEventListener("click", async (event) => {
    const button = event.target.closest('button[data-role="remove-plan"]');
    if (!button) return;
    try {
      await api(`/media/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
      currentMedia = currentMedia.filter((item) => item.id !== button.dataset.id);
      renderMedia();
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  document.getElementById("cancel").addEventListener("click", () => {
    editor.close();
    load();
  });
  document.getElementById("new-listing").addEventListener("click", () => openEditor(null));

  rowsEl.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const id = button.closest(".row").dataset.id;
    const listing = listings.find((item) => item.id === id);
    if (!listing) return;

    if (button.dataset.action === "edit") {
      openEditor(listing);
      return;
    }

    if (!confirm(`Delete "${listing.title}" and all of its photos? This cannot be undone.`)) return;

    setStatus("Deleting…");
    try {
      await api(`/listings/${encodeURIComponent(id)}`, { method: "DELETE" });
      setStatus("Listing deleted.");
      await load();
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  document.querySelectorAll("button[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      filter = button.dataset.filter;
      document.querySelectorAll("button[data-filter]").forEach((other) => {
        other.setAttribute("aria-pressed", String(other === button));
      });
      render();
    });
  });

  load();
})();
