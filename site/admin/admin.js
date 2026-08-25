import { readDocxText } from "./docx.js";
import {
  handleApplicationChange,
  handleApplicationClick,
  initApplicationScreen,
  renderApplicationScreen,
  resetApplicationScreen
} from "./application-screen.js";
import {
  STAGES,
  documentSummary,
  documentsFact,
  homeLabel,
  incomeSummary,
  money,
  plainDate,
  shortDay,
  stageOf
} from "./application-view.js";
import { initDocViewer } from "./doc-viewer.js";
import { closeLeaseScreen, initLeaseScreen, openLeaseScreen } from "./lease-screen.js";
import {
  forgetLayers,
  handlePropertyClick,
  initProperties,
  renderProperty,
  renderPropertyList
} from "./properties.js";
import { endDateFor } from "../shared/lease-dates.js";
import {
  captionFromFilename,
  classifyFiles,
  parseFolderName,
  parseListingCopy
} from "../shared/listing-parse.js";

const API = "/api/admin";

// Who is signed in, and as what. The role is only ever read from the server;
// nothing here decides it, and nothing here enforces it — the Worker refuses a
// write an agent should not make whatever this page renders. It exists so an
// agent is shown a value rather than an input that will fail on Save.
const session = { email: "", role: "", name: "" };

function isManager() {
  return session.role === "manager";
}

const rowsEl = document.getElementById("rows");
const statusEl = document.getElementById("status");
const whoEl = document.getElementById("who");
const whoRoleEl = document.getElementById("who-role");
const roleBadgeEl = document.getElementById("role-badge");
const avatarEl = document.getElementById("avatar");
const crumbEl = document.getElementById("crumb");
const environmentEl = document.getElementById("environment");
const environmentDatabaseEl = document.getElementById("environment-database");

// One section per screen, shown one at a time. The three list screens share
// #rows between them, because they are the same list wearing three filters.
const ROUTE_HOSTS = {
  listings: document.getElementById("route-listings"),
  applications: document.getElementById("route-applications"),
  application: document.getElementById("route-application"),
  leases: document.getElementById("route-leases"),
  properties: document.getElementById("route-properties"),
  lease: document.getElementById("route-lease")
};
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
let applications = [];
let applicationsLoaded = false;
// The portal's document checklist, sent with the applications list so this
// screen names document types exactly the way the portal does.
let documentTypes = [];
// Which screen is open, and — for the two screens that show one thing — which
// thing. Held here rather than read back out of location.hash so a re-render
// never depends on the address bar having been updated first.
let route = "listings";
let routeId = "";
// The listings screen's own filter. It is not part of the route: which chip is
// pressed is not worth an address of its own.
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
  if (route === "applications") {
    if (!routeId) return renderApplications();
    const app = applications.find((item) => item.id === routeId);
    if (app) renderApplicationScreen(ROUTE_HOSTS.application, app);
    return;
  }
  if (route === "leases") return renderLeases();
  if (route === "listings") return renderListings();
}

function renderListings() {
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

// ---- Routing ----

// Screens are addresses, so a property or a lease can be linked to, reloaded
// and gone back from. The hash carries at most two parts: the screen, and the
// one thing it is showing.
const ROUTES = new Set(["listings", "applications", "leases", "properties"]);

function readHash() {
  const parts = (location.hash || "").replace(/^#\/?/, "").split("/").filter(Boolean);
  const name = ROUTES.has(parts[0]) ? parts[0] : "listings";
  return { name, id: decodeURIComponent(parts[1] || "") };
}

function crumbs(parts) {
  crumbEl.innerHTML = parts.map((part, index) => {
    const last = index === parts.length - 1;
    const label = escapeHtml(part.label);
    const cell = last ? `<b>${label}</b>` : `<a href="${escapeHtml(part.href)}">${label}</a>`;
    return index === 0 ? cell : `<i>/</i>${cell}`;
  }).join("");
}

// The screen a route wants, with the shared list shown only for the three that
// use it. Every host is hidden first so no two are ever on screen together.
// A screen that shows one thing keeps its list's nav item lit: reading one
// application is still being in Applications.
const NAV_OF = { lease: "leases", application: "applications" };

function showRoute(name, { rows }) {
  for (const [key, host] of Object.entries(ROUTE_HOSTS)) host.hidden = key !== name;
  rowsEl.hidden = !rows;
  if (!rows) rowsEl.innerHTML = "";
  for (const link of document.querySelectorAll(".nav a[data-route]")) {
    const active = link.dataset.route === (NAV_OF[name] || name);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

async function goto({ name, id }) {
  route = name;
  routeId = id;
  setStatus("");

  // The workspace covers the whole console. Any route that is not one lease
  // has to put it away first, or it stays on top of whatever loads behind it.
  if (name !== "leases" || !id) closeLeaseScreen();

  if (name === "listings") {
    showRoute("listings", { rows: true });
    dropzone.hidden = false;
    crumbs([{ label: "Listings", href: "#/listings" }]);
    render();
    return;
  }

  // Applications are a list and, one at a time, a page. The list never draws
  // a whole application into itself: the row is a link to the address of the
  // one thing it names.
  if (name === "applications") {
    showRoute(id ? "application" : "applications", { rows: !id });

    if (id) {
      ROUTE_HOSTS.application.innerHTML = '<p class="status">Loading…</p>';
      crumbs([{ label: "Applications", href: "#/applications" }, { label: "Application", href: "" }]);
    } else {
      resetApplicationScreen();
      crumbs([{ label: "Applications", href: "#/applications" }]);
    }

    if (!applicationsLoaded) await refreshApplications();

    if (id) {
      const app = applications.find((item) => item.id === id);
      if (!app) {
        crumbs([{ label: "Applications", href: "#/applications" }, { label: "Not found", href: "" }]);
        ROUTE_HOSTS.application.innerHTML = `<p class="status" data-tone="error">That application no
          longer exists. <a href="#/applications">Back to applications</a>.</p>`;
        return;
      }
      crumbs([{ label: "Applications", href: "#/applications" }, { label: app.name, href: "" }]);
    }

    render();
    return;
  }

  if (name === "leases") {
    if (!applicationsLoaded) await refreshApplications();

    // One lease is the workspace — the document beside what it will say. It
    // covers the console rather than drawing into it, so the route opens it
    // and leaving the route is what closes it.
    if (id) {
      const app = applications.find((item) => item.id === id);
      if (!app) {
        showRoute("lease", { rows: false });
        crumbs([{ label: "Leases", href: "#/leases" }, { label: "Not found", href: "" }]);
        ROUTE_HOSTS.lease.innerHTML = `<p class="status" data-tone="error">That application no longer
          exists. <a href="#/leases">Back to leases</a>.</p>`;
        return;
      }
      showRoute("lease", { rows: false });
      crumbs([{ label: "Leases", href: "#/leases" }, { label: app.name, href: "" }]);
      await openLeaseScreen({ application: app, returnTo: "#/leases" });
      return;
    }

    closeLeaseScreen();
    showRoute("leases", { rows: true });
    crumbs([{ label: "Leases", href: "#/leases" }]);
    render();
    return;
  }

  if (name === "properties") {
    // The Worker refuses these routes for an agent; this keeps the browser from
    // asking in the first place.
    if (!isManager()) {
      showRoute("properties", { rows: false });
      crumbs([{ label: "Properties", href: "#/properties" }]);
      ROUTE_HOSTS.properties.innerHTML = `<p class="status">Landlord settings are a manager's.
        You can read every one of them on a lease.</p>`;
      return;
    }

    showRoute("properties", { rows: false });
    if (id) {
      await renderProperty(ROUTE_HOSTS.properties, id);
      const heading = ROUTE_HOSTS.properties.querySelector("h1");
      crumbs([
        { label: "Properties", href: "#/properties" },
        { label: heading ? heading.textContent : "Property", href: "" }
      ]);
      return;
    }
    crumbs([{ label: "Properties", href: "#/properties" }]);
    await renderPropertyList(ROUTE_HOSTS.properties);
  }
}

window.addEventListener("hashchange", () => goto(readHash()));

// ---- Leases ----

// A lease's life, as far as this system can honestly know it.
//
// There is no leases table. The only record that a lease happened is the
// application it came from, through the statuses lease_sent and lease_signed —
// which is what lease/README.md chose deliberately rather than adding a table
// for a flow that had nowhere else to land. So the list reports what the
// application says, and the workspace refines "Draft" to "Ready to send" once
// it has loaded the values and counted what is missing.
//
// "Partially signed" is absent on purpose: nothing here talks to a signing
// service, so nothing could ever set it.
const LEASE_STATES = [
  ["all", "All"],
  ["draft", "Draft"],
  ["sent", "Sent for signature"],
  ["signed", "Fully signed"],
  ["cancelled", "Cancelled"]
];

const LEASE_READY = new Set(["approved", "lease_sent", "lease_signed", "declined"]);

function leaseState(app) {
  if (app.status === "declined") return { key: "cancelled", label: "Cancelled", tone: "off" };
  if (app.status === "lease_signed") return { key: "signed", label: "Fully signed", tone: "good" };
  if (app.status === "lease_sent") return { key: "sent", label: "Sent for signature", tone: "busy" };
  return { key: "draft", label: "Draft", tone: "off" };
}

let leaseFilter = "all";
let leaseSearch = "";

function leaseTerm(app) {
  if (!app.move_in) return "—";
  const end = endDateFor(app.move_in, app.lease_term_months);
  return end ? `${app.move_in} – ${end}` : app.move_in;
}

function leaseRent(app) {
  const amount = app.listings?.price_amount;
  return amount === null || amount === undefined
    ? "—"
    : Number(amount).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function renderLeases() {
  if (!applicationsLoaded) {
    rowsEl.innerHTML = '<p class="status">Loading…</p>';
    return;
  }

  const all = applications.filter((app) => LEASE_READY.has(app.status));
  const needle = leaseSearch.trim().toLowerCase();

  const visible = all.filter((app) => {
    if (leaseFilter !== "all" && leaseState(app).key !== leaseFilter) return false;
    if (!needle) return true;
    return [app.name, app.email, app.listings?.title, app.listings?.building_name, app.listings?.unit]
      .filter(Boolean).join(" ").toLowerCase().includes(needle);
  });

  if (all.length === 0) {
    rowsEl.innerHTML = `<div class="empty">
      <h2>No leases yet</h2>
      <p>A lease starts from an approved application. Approve one and it appears here.</p>
      <a href="#/applications"><button type="button" class="primary">View approved applications</button></a>
    </div>`;
    return;
  }

  if (visible.length === 0) {
    rowsEl.innerHTML = '<p class="status">No lease matches that search.</p>';
    return;
  }

  rowsEl.innerHTML = `
    <div class="lease-row is-head">
      <span>Property</span><span>Tenant</span><span>Rent</span>
      <span>Term</span><span>Status</span><span>Updated</span><span></span>
    </div>
    ${visible.map((app) => {
      const state = leaseState(app);
      const home = [app.listings?.building_name, app.listings?.unit ? `Unit ${app.listings.unit}` : ""]
        .filter(Boolean).join(" · ") || app.listings?.title || "Listing removed";
      return `<a class="lease-row" href="#/leases/${escapeHtml(app.id)}">
        <span class="lease-cell-strong">${escapeHtml(home)}</span>
        <span>${escapeHtml(app.name)}</span>
        <span class="num">${escapeHtml(leaseRent(app))}</span>
        <span class="num">${escapeHtml(leaseTerm(app))}</span>
        <span><span class="lease-pill is-${state.tone}">${escapeHtml(state.label)}</span></span>
        <span class="lease-cell-soft">${escapeHtml(new Date(app.updated_at || app.created_at)
          .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))}</span>
        <span class="lease-cell-go">${state.key === "draft" ? "Open lease" : "View"} →</span>
      </a>`;
    }).join("")}`;
}

// ---- Applications ----

// The list is a list. Each row answers one question per column — who, where,
// when, how much, and whether it is ready to be decided — and opens the
// application's own page for everything else. It used to expand the whole
// application inline, which meant a screen of forty applicants was also forty
// full applications, and finding the next name meant scrolling past a
// stranger's employment history.

let appFilter = "all";
let appProperty = "all";
let appDocs = "all";
let appSearch = "";

const APP_DOC_FILTERS = [
  ["all", "Documents: any"],
  ["complete", "Documents: complete"],
  ["incomplete", "Documents: outstanding"]
];

function appMatches(app) {
  if (appFilter !== "all" && stageOf(app).key !== appFilter) return false;
  if (appProperty !== "all" && String(app.listing_id) !== appProperty) return false;

  if (appDocs !== "all") {
    const summary = documentSummary(app, documentTypes);
    // A database with no checklist cannot answer this filter, so it is left
    // out of the answer rather than counted as complete.
    if (!summary) return false;
    if (appDocs === "complete" && !summary.complete) return false;
    if (appDocs === "incomplete" && summary.complete) return false;
  }

  const needle = appSearch.trim().toLowerCase();
  if (!needle) return true;
  return [app.name, app.email, app.phone, app.listings?.title,
    app.listings?.building_name, app.listings?.unit]
    .filter(Boolean).join(" ").toLowerCase().includes(needle);
}

// One action per row, and it depends on where the application has got to. A
// lease can only start once somebody has approved it, and once one exists the
// action is to open that one rather than to make a second.
function appAction(app) {
  const stage = stageOf(app);
  if (stage.key === "lease") return "Open lease →";
  if (stage.key === "approved") return "Create lease →";
  return "Open →";
}

function appIncome(app) {
  const income = incomeSummary(app);
  return income.annual === null ? (income.written || "—") : money(income.annual);
}

// Rebuilt from whatever is in the list, keeping whatever was chosen. A
// property that no longer has an application on it stops being offered.
function renderPropertyFilter() {
  const select = document.getElementById("app-property");
  const seen = new Map();
  for (const app of applications) {
    if (!app.listing_id || seen.has(app.listing_id)) continue;
    seen.set(app.listing_id, homeLabel(app));
  }
  if (appProperty !== "all" && !seen.has(appProperty)) appProperty = "all";

  select.innerHTML = `<option value="all">Every property</option>${
    [...seen.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, label]) => `<option value="${escapeHtml(id)}"${
        id === appProperty ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}`;
}

function renderApplications() {
  if (!applicationsLoaded) {
    rowsEl.innerHTML = '<p class="status">Loading applications…</p>';
    return;
  }

  renderPropertyFilter();

  if (applications.length === 0) {
    rowsEl.innerHTML = `<div class="empty">
      <h2>No applications yet</h2>
      <p>They appear here the moment somebody applies from a property page.</p>
      <a href="#/listings"><button type="button">Go to listings</button></a>
    </div>`;
    return;
  }

  const visible = applications.filter(appMatches);

  if (visible.length === 0) {
    rowsEl.innerHTML = `<div class="empty">
      <h2>Nothing matches</h2>
      <p>No application matches this search and these filters. Clear them to see all
         ${applications.length}.</p>
      <button type="button" id="app-clear">Clear filters</button>
    </div>`;
    return;
  }

  rowsEl.innerHTML = `
    <div class="app-row is-head">
      <span>Applicant</span><span>Property / unit</span><span>Applied</span><span>Move-in</span>
      <span>Income</span><span>Documents</span><span>Status</span><span></span>
    </div>
    ${visible.map((app) => {
      const stage = stageOf(app);
      const docs = documentsFact(app, documentTypes);
      return `<a class="app-row" href="#/applications/${escapeHtml(app.id)}">
        <span>
          <b>${escapeHtml(app.name || "Applicant")}</b>
          <small>${escapeHtml(app.email || "")}</small>
        </span>
        <span class="app-cell-soft">${escapeHtml(homeLabel(app))}</span>
        <span class="num">${escapeHtml(shortDay(app.created_at))}</span>
        <span class="num">${escapeHtml(plainDate(app.move_in))}</span>
        <span class="num">${escapeHtml(appIncome(app))}</span>
        <span><span class="pill is-${docs.tone}">${escapeHtml(docs.text)}</span></span>
        <span><span class="pill is-${stage.tone}">${escapeHtml(stage.label)}</span></span>
        <span class="app-cell-go">${escapeHtml(appAction(app))}</span>
      </a>`;
    }).join("")}`;
}

// A row that came back from the server, written into the list in place. It is
// mutated rather than replaced because the open application screen is holding
// this very object: swapping in a copy would leave it editing a row nothing
// else can see.
function remember(row) {
  const found = applications.find((item) => item.id === row.id);
  if (found) Object.assign(found, row);
  else applications.unshift(row);
}

async function refreshApplications() {
  try {
    const { applications: rows, document_types } = await api("/applications");
    applications = rows;
    if (Array.isArray(document_types)) documentTypes = document_types;
    applicationsLoaded = true;
    if (route === "applications" || (route === "leases" && !routeId)) render();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

// The role, in three places: the rail says who you are, the badge says it again
// beside every screen, and the body attribute is what hides a manager-only nav
// item. None of the three decides anything — the Worker does — but an agent who
// can see that they are an agent stops wondering why a box will not open.
function showSession() {
  whoEl.textContent = session.email;
  whoRoleEl.textContent = session.name || session.role || "—";
  document.body.dataset.role = session.role;

  roleBadgeEl.hidden = !session.role;
  roleBadgeEl.textContent = session.role;

  const source = session.name || session.email;
  avatarEl.textContent = source
    ? source.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).slice(0, 2)
        .map((part) => part[0].toUpperCase()).join("")
    : "";
}

// The banner names the Supabase project, not just the environment. Running
// locally is obvious; being pointed at the production database while doing so
// is not, and that is the mistake worth catching before something is deleted.
//
// The label is whatever DEV_SUPABASE_LABEL says and is only a convenience; the
// ref comes from the URL in use, so it is the half to trust when they disagree.
function showEnvironment(me) {
  const local = me?.environment === "development";
  environmentDatabaseEl.textContent = local
    ? `database: ${me.database_label ? `${me.database_label} · ` : ""}${me.database}`
    : "";
  environmentEl.toggleAttribute("data-shown", local);
  document.title = local ? "DEV — Star Admin" : "Star Admin";
}

async function load() {
  setStatus("Loading listings…");
  try {
    const [{ listings: rows }, me] = await Promise.all([api("/listings"), api("/me").catch(() => null)]);
    listings = rows;
    if (me?.email) {
      session.email = me.email;
      session.role = me.role || "";
      session.name = me.name || "";
      showSession();
    }
    showEnvironment(me);
    setStatus("");
    await goto(readHash());
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
    renderListings();
  });
}

// A lease with no application behind it: the workspace, opened empty. Behind a
// menu and manager-only, because it is the exception rather than the workflow.
document.getElementById("lease-blank").addEventListener("click", (event) => {
  event.target.closest("details")?.removeAttribute("open");
  openLeaseScreen({ returnTo: "#/leases" });
});

// The status filters, built from the one list that defines them.
document.getElementById("lease-filters").innerHTML = LEASE_STATES.map(([key, label]) =>
  `<button type="button" class="chip" data-lease-state="${key}"
           aria-pressed="${key === "all"}">${label}</button>`).join("");

document.getElementById("lease-filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-lease-state]");
  if (!button) return;
  leaseFilter = button.dataset.leaseState;
  for (const chip of document.querySelectorAll("[data-lease-state]")) {
    chip.setAttribute("aria-pressed", String(chip === button));
  }
  renderLeases();
});

document.getElementById("lease-search").addEventListener("input", (event) => {
  leaseSearch = event.target.value;
  renderLeases();
});

// A menu left open behind a click elsewhere is a menu nobody closed.
document.addEventListener("click", (event) => {
  for (const menu of document.querySelectorAll("details.menu[open]")) {
    if (!menu.contains(event.target)) menu.removeAttribute("open");
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const menu of document.querySelectorAll("details.menu[open]")) menu.removeAttribute("open");
});

// The two new screens draw themselves into their own host and are re-rendered
// whole, so their events are delegated from that host rather than bound to
// controls a re-render would replace.
ROUTE_HOSTS.properties.addEventListener("click", async (event) => {
  await handlePropertyClick(event, ROUTE_HOSTS.properties, routeId);
});


// One application draws into its own host and is re-rendered whole, so its
// events are delegated from that host rather than bound to controls a
// re-render replaces.
ROUTE_HOSTS.application.addEventListener("click", async (event) => {
  const app = applications.find((item) => item.id === routeId);
  if (!app) return;
  await handleApplicationClick(event, ROUTE_HOSTS.application, app);
});

ROUTE_HOSTS.application.addEventListener("change", async (event) => {
  const app = applications.find((item) => item.id === routeId);
  if (!app) return;
  await handleApplicationChange(event, ROUTE_HOSTS.application, app);
});

// ---- the applications list's own controls ----

// The stage chips, built from the one list that defines them.
document.getElementById("app-filters").innerHTML = [["all", "All"]]
  .concat(STAGES.map((stage) => [stage.key, stage.label]))
  .map(([key, label]) => `<button type="button" class="chip" data-app-stage="${key}"
    aria-pressed="${key === "all"}">${escapeHtml(label)}</button>`).join("");

document.getElementById("app-filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-app-stage]");
  if (!button) return;
  appFilter = button.dataset.appStage;
  for (const chip of document.querySelectorAll("[data-app-stage]")) {
    chip.setAttribute("aria-pressed", String(chip === button));
  }
  renderApplications();
});

document.getElementById("app-docs").innerHTML = APP_DOC_FILTERS
  .map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`).join("");

document.getElementById("app-docs").addEventListener("change", (event) => {
  appDocs = event.target.value;
  renderApplications();
});

document.getElementById("app-property").addEventListener("change", (event) => {
  appProperty = event.target.value;
  renderApplications();
});

document.getElementById("app-search").addEventListener("input", (event) => {
  appSearch = event.target.value;
  renderApplications();
});

// The empty state's own way back out of a filter nobody meant to leave on.
rowsEl.addEventListener("click", (event) => {
  if (!event.target.closest("#app-clear")) return;
  appFilter = "all";
  appProperty = "all";
  appDocs = "all";
  appSearch = "";
  document.getElementById("app-search").value = "";
  document.getElementById("app-docs").value = "all";
  document.getElementById("app-property").value = "all";
  for (const chip of document.querySelectorAll("[data-app-stage]")) {
    chip.setAttribute("aria-pressed", String(chip.dataset.appStage === "all"));
  }
  renderApplications();
});

initLeaseScreen({
  api,
  setStatus,
  escapeHtml,
  isManager,
  listings: () => listings,
  onApplicationChanged: (row) => {
    remember(row);
    if (route === "applications") render();
  },
  onClosed: () => {
    // The workspace can write a unit layer, and the properties screen caches
    // what the layers said. It may not answer from a stale copy afterwards.
    //
    // It does NOT navigate: goto() is what closes the workspace, so calling it
    // back from here would call itself.
    forgetLayers();
  }
});
initApplicationScreen({
  api,
  setStatus,
  escapeHtml,
  isManager,
  documentTypes: () => documentTypes,
  onSaved: remember,
  onDeleted: (id) => {
    applications = applications.filter((item) => item.id !== id);
    location.hash = "#/applications";
  },
  // The lease's own screen, not the document: what is wrong with a lease is
  // nearly always one of twenty-two values, not one of a hundred and forty.
  openLease: (app) => { location.hash = `#/leases/${encodeURIComponent(app.id)}`; }
});
initDocViewer({ escapeHtml });
initProperties({
  api,
  setStatus,
  escapeHtml,
  isManager,
  listings: () => listings,
  openDocument: openLeaseScreen
});

load();
