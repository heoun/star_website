import { readDocxText } from "./docx.js";
import {
  captionFromFilename,
  classifyFiles,
  parseFolderName,
  parseListingCopy
} from "../shared/listing-parse.js";

const API = "/api/admin";

const rowsEl = document.getElementById("rows");
const statusEl = document.getElementById("status");
const whoEl = document.getElementById("who");
const editor = document.getElementById("editor");
const form = document.getElementById("listing-form");
const editorTitle = document.getElementById("editor-title");
const saveButton = document.getElementById("save");
const mediaSection = document.getElementById("media-section");
const photoGrid = document.getElementById("photo-grid");
const photoFiles = document.getElementById("photo-files");
const planFile = document.getElementById("plan-file");
const planPreview = document.getElementById("plan-preview");
const videoFile = document.getElementById("video-file");
const videoPreview = document.getElementById("video-preview");
const dropzone = document.getElementById("dropzone");
const folderInput = document.getElementById("folder-input");

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
// Files chosen before the listing exists; uploaded when it is saved.
let pendingMedia = [];
let pendingVideo = null;

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
  if (file.size < 400 * 1024 && scale === 1 && (file.type === "image/jpeg" || file.type === "image/webp")) {
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

  return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.webp`, { type: "image/webp" });
}

// ---- Media ----

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

function pendingPhotos() {
  return pendingMedia.filter((item) => item.kind === "photo");
}

function pendingPlan() {
  return pendingMedia.find((item) => item.kind === "floor_plan") || null;
}

function renderMedia() {
  const saved = photos();
  const queued = pendingPhotos();

  const savedMarkup = saved.map((item, index) => `
    <div class="photo-item" data-id="${escapeHtml(item.id)}">
      <img src="${escapeHtml(item.url)}" alt="">
      <div class="photo-tools">
        <input type="text" data-role="caption" placeholder="Caption (Living room)" maxlength="120"
               value="${escapeHtml(item.caption || "")}">
        <div class="photo-buttons">
          <button type="button" class="small" data-role="left" ${index === 0 ? "disabled" : ""}>←</button>
          <button type="button" class="small danger" data-role="remove">Delete</button>
          <button type="button" class="small" data-role="right" ${index === saved.length - 1 ? "disabled" : ""}>→</button>
        </div>
      </div>
    </div>
  `).join("");

  const queuedMarkup = queued.map((item, index) => `
    <div class="photo-item" data-pending="true" data-index="${index}">
      <img src="${escapeHtml(item.preview)}" alt="">
      <div class="photo-tools">
        <span class="pending-flag">Uploads on save</span>
        <input type="text" data-role="pending-caption" placeholder="Caption (Living room)" maxlength="120"
               value="${escapeHtml(item.caption || "")}">
        <div class="photo-buttons">
          <button type="button" class="small" data-role="pending-left" ${index === 0 ? "disabled" : ""}>←</button>
          <button type="button" class="small danger" data-role="pending-remove">Remove</button>
          <button type="button" class="small" data-role="pending-right" ${index === queued.length - 1 ? "disabled" : ""}>→</button>
        </div>
      </div>
    </div>
  `).join("");

  photoGrid.innerHTML = savedMarkup + queuedMarkup;

  const plan = floorPlan();
  const queuedPlan = pendingPlan();
  if (plan) {
    planPreview.innerHTML = `<img src="${escapeHtml(plan.url)}" alt="Floor plan">
      <button type="button" class="small danger" data-role="remove-plan" data-id="${escapeHtml(plan.id)}">Delete floor plan</button>`;
  } else if (queuedPlan) {
    planPreview.innerHTML = `<img src="${escapeHtml(queuedPlan.preview)}" alt="Floor plan">
      <span class="pending-flag">Uploads on save</span>`;
  } else {
    planPreview.innerHTML = "";
  }

  const videoUrl = form.elements.video_url.value.trim();
  if (pendingVideo) {
    videoPreview.innerHTML = `
      <video src="${escapeHtml(pendingVideo.preview)}" controls preload="metadata" playsinline></video>
      <p><span class="pending-flag">Uploads on save</span> ${escapeHtml(pendingVideo.file.name)}
         · ${(pendingVideo.file.size / 1024 / 1024).toFixed(1)} MB</p>`;
  } else if (videoUrl.startsWith("/media/")) {
    videoPreview.innerHTML = `<video src="${escapeHtml(videoUrl)}" controls preload="metadata" playsinline></video>`;
  } else if (videoUrl) {
    videoPreview.innerHTML = `<a href="${escapeHtml(videoUrl)}" target="_blank" rel="noopener">Open external video link</a>`;
  } else {
    videoPreview.innerHTML = "";
  }

  mediaSection.dataset.pending = String(pendingMedia.length > 0 || Boolean(pendingVideo));
}

function queuePhotos(files) {
  for (const file of files) {
    pendingMedia.push({
      file,
      kind: "photo",
      caption: captionFromFilename(file.name),
      preview: URL.createObjectURL(file)
    });
  }
  renderMedia();
}

function queuePlan(file) {
  pendingMedia = pendingMedia.filter((item) => item.kind !== "floor_plan");
  pendingMedia.push({ file, kind: "floor_plan", caption: "Floor plan", preview: URL.createObjectURL(file) });
  renderMedia();
}

function queueVideo(file) {
  clearPendingVideo();
  pendingVideo = { file, preview: URL.createObjectURL(file) };
  renderMedia();
}

function clearPendingVideo() {
  if (pendingVideo) URL.revokeObjectURL(pendingVideo.preview);
  pendingVideo = null;
}

// Uploads everything that was queued while the listing did not exist yet.
async function flushPendingMedia() {
  const queued = pendingPhotos();
  let position = photos().length;

  for (const [index, item] of queued.entries()) {
    setStatus(`Uploading photo ${index + 1} of ${queued.length}…`);
    const upload = await uploadFile(await compressImage(item.file, 1600));
    const { media } = await api(`/listings/${encodeURIComponent(editingId)}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: upload.path, kind: "photo", caption: item.caption, position })
    });
    currentMedia.push(media);
    position += 1;
  }

  const plan = pendingPlan();
  if (plan) {
    setStatus("Uploading floor plan…");
    const existing = floorPlan();
    const upload = await uploadFile(await compressImage(plan.file, 2000));
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
  }

  for (const item of pendingMedia) URL.revokeObjectURL(item.preview);
  pendingMedia = [];

  if (pendingVideo) {
    setStatus("Uploading video… this can take a minute.");
    const upload = await uploadFile(pendingVideo.file);
    clearPendingVideo();
    form.elements.video_url.value = upload.url;
    await api(`/listings/${encodeURIComponent(editingId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_url: upload.url })
    });
  }
}

// ---- Folder import ----

async function readFolder(files) {
  const named = files.map((file) => ({ file, name: file.name }));
  const { document, photos: photoNames, floorPlan: planName, video } = classifyFiles(named.map((item) => item.name));
  const find = (name) => named.find((item) => item.name === name)?.file;

  if (!document) {
    throw new Error("No Word document found in that folder — expected one .docx with the listing copy.");
  }

  const parsed = parseListingCopy(await readDocxText(find(document)));
  const folderName = files[0]?.webkitRelativePath?.split("/")[0] || "";
  const { building_name, unit } = parseFolderName(folderName);

  return {
    fields: { ...parsed, building_name, unit, kind_label: parsed.title },
    photoFiles: photoNames.map(find).filter(Boolean),
    planFile: planName ? find(planName) : null,
    videoFile: video ? find(video) : null,
    summary: `${photoNames.length} photo${photoNames.length === 1 ? "" : "s"}${planName ? ", floor plan" : ""}${video ? ", video" : ""}`
  };
}

async function importFolder(files) {
  setStatus("Reading folder…");
  try {
    const result = await readFolder(files);

    openEditor(null);
    for (const [field, value] of Object.entries(result.fields)) {
      if (form.elements[field] && value !== null && value !== "") {
        form.elements[field].value = value;
      }
    }
    form.elements.category.value = "residential";
    form.elements.transaction_type.value = result.fields.transaction_type || "sale";

    queuePhotos(result.photoFiles);
    if (result.planFile) queuePlan(result.planFile);
    if (result.videoFile) queueVideo(result.videoFile);
    renderMedia();

    setStatus(`Read ${result.summary}. Check the details, then save.`);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

// Drag-and-drop hands over directory entries rather than a file list.
async function filesFromDataTransfer(dataTransfer) {
  const entries = [...dataTransfer.items]
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (entries.length === 0) return [...dataTransfer.files];

  const collected = [];

  const readDirectory = (directory) => new Promise((resolve, reject) => {
    const reader = directory.createReader();
    const batch = [];
    const readMore = () => reader.readEntries((results) => {
      if (results.length === 0) return resolve(batch);
      batch.push(...results);
      readMore();
    }, reject);
    readMore();
  });

  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      // Mirror the shape webkitdirectory produces so both paths agree.
      Object.defineProperty(file, "webkitRelativePath", { value: `${prefix}${entry.name}`, configurable: true });
      collected.push(file);
      return;
    }
    for (const child of await readDirectory(entry)) {
      await walk(child, `${prefix}${entry.name}/`);
    }
  };

  for (const entry of entries) await walk(entry, "");
  return collected;
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

function openEditor(listing) {
  editingId = listing?.id || null;
  currentMedia = (listing?.listing_media || []).slice();
  for (const item of pendingMedia) URL.revokeObjectURL(item.preview);
  pendingMedia = [];
  clearPendingVideo();
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

  renderMedia();
  if (!editor.open) editor.showModal();
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
    } else {
      const { listing } = await api("/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values)
      });
      editingId = listing.id;
      editorTitle.textContent = "Edit listing";
    }

    await flushPendingMedia();
    renderMedia();

    editor.close();
    setStatus("Saved. The website updates within a minute.");
    await load();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    saveButton.disabled = false;
  }
});

photoFiles.addEventListener("change", async () => {
  const files = [...(photoFiles.files || [])];
  photoFiles.value = "";
  if (files.length === 0) return;

  if (!editingId) {
    queuePhotos(files);
    setStatus(`${files.length} photo${files.length === 1 ? "" : "s"} ready — they upload when you save.`);
    return;
  }

  try {
    queuePhotos(files);
    await flushPendingMedia();
    renderMedia();
    setStatus("Photos uploaded.");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

planFile.addEventListener("change", async () => {
  const file = planFile.files?.[0];
  planFile.value = "";
  if (!file) return;

  queuePlan(file);
  if (!editingId) return setStatus("Floor plan ready — it uploads when you save.");

  try {
    await flushPendingMedia();
    renderMedia();
    setStatus("Floor plan uploaded.");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

videoFile.addEventListener("change", async () => {
  const file = videoFile.files?.[0];
  videoFile.value = "";
  if (!file) return;

  queueVideo(file);
  if (!editingId) return setStatus("Video ready — it uploads when you save.");

  try {
    await flushPendingMedia();
    renderMedia();
    setStatus("Video uploaded.");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

photoGrid.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-role]");
  if (!button) return;

  const card = button.closest(".photo-item");
  const role = button.dataset.role;

  if (role.startsWith("pending-")) {
    const queued = pendingPhotos();
    const index = Number(card.dataset.index);
    const item = queued[index];
    if (!item) return;

    if (role === "pending-remove") {
      URL.revokeObjectURL(item.preview);
      pendingMedia = pendingMedia.filter((entry) => entry !== item);
    } else {
      const target = role === "pending-left" ? index - 1 : index + 1;
      if (target < 0 || target >= queued.length) return;
      const a = pendingMedia.indexOf(queued[index]);
      const b = pendingMedia.indexOf(queued[target]);
      [pendingMedia[a], pendingMedia[b]] = [pendingMedia[b], pendingMedia[a]];
    }
    renderMedia();
    return;
  }

  const id = card.dataset.id;
  const ordered = photos();
  const index = ordered.findIndex((item) => item.id === id);
  if (index === -1) return;

  try {
    if (role === "remove") {
      await api(`/media/${encodeURIComponent(id)}`, { method: "DELETE" });
      currentMedia = currentMedia.filter((item) => item.id !== id);
    } else {
      const target = role === "left" ? index - 1 : index + 1;
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
  const input = event.target.closest("input[data-role]");
  if (!input) return;

  const card = input.closest(".photo-item");

  if (input.dataset.role === "pending-caption") {
    const item = pendingPhotos()[Number(card.dataset.index)];
    if (item) item.caption = input.value;
    return;
  }

  const id = card.dataset.id;
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
document.getElementById("import-folder").addEventListener("click", () => folderInput.click());

dropzone.addEventListener("click", () => folderInput.click());
folderInput.addEventListener("change", () => {
  const files = [...(folderInput.files || [])];
  folderInput.value = "";
  if (files.length > 0) importFolder(files);
});

for (const type of ["dragenter", "dragover"]) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.dataset.active = "true";
  });
}

for (const type of ["dragleave", "drop"]) {
  dropzone.addEventListener(type, () => delete dropzone.dataset.active);
}

dropzone.addEventListener("drop", async (event) => {
  event.preventDefault();
  try {
    const files = await filesFromDataTransfer(event.dataTransfer);
    if (files.length > 0) await importFolder(files);
  } catch (error) {
    setStatus(error.message, "error");
  }
});

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

for (const button of document.querySelectorAll("button[data-filter]")) {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    for (const other of document.querySelectorAll("button[data-filter]")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
    render();
  });
}

load();
