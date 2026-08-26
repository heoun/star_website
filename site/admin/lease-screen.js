// The lease screen: the document on the left, the fields that fill it on the
// right, on one screen.
//
// It replaces both of the things it grew out of — the settings form that had no
// document, and the generate dialog whose preview was behind a button. Those
// were two write paths to the same 147 values, which is how someone ends up
// editing a building's legal disclosures without realising it.
//
// The document is rendered once (see lease-doc.js for why that is a hard rule)
// and patched as you type. Nothing here re-fetches or re-renders it.

import * as doc from "./lease-doc.js";
import * as workspace from "./lease-workspace.js";
import { mapDocuments, verifyDocuments } from "../shared/lease-documents.js";
import { ADDRESS_FIELD, ADDRESS_PARTS, composeAddress } from "../shared/lease-address.js";
import { applicationWrite } from "../shared/lease-application.js";

let api;
let setStatus;
let escapeHtml;
let onApplicationChanged = () => {};
let onClosed = () => {};

let registry = null;
let buildings = [];
let listingsOf = () => [];
let isManager = () => false;

const screen = document.getElementById("lease-screen");
const mainEl = document.querySelector("main");

let state = null;
// The package, worked out once from the mounted render. Module-level for the
// same reason `mounted` is: the document is rendered once for the life of the
// page and so is everything derived from it.
let packageDocuments = [];
let returnTo = "";
let formHost = null;
let docHost = null;
let mounted = false;

export function initLeaseScreen(deps) {
  ({ api, setStatus, escapeHtml } = deps);
  isManager = deps.isManager || (() => false);
  listingsOf = deps.listings;
  onApplicationChanged = deps.onApplicationChanged || (() => {});
  onClosed = deps.onClosed || (() => {});
  workspace.initWorkspace({ escapeHtml });
}

async function loadRegistry() {
  if (!registry) ({ registry } = await api("/lease/fields"));
  return registry;
}

// ------------------------------------------------------------------- state

function blankState() {
  const byId = new Map(registry.fields.map((field) => [field.id, field]));
  return {
    fields: registry.fields,
    byId,
    values: {},
    missing: new Set(),
    dirty: new Set(),
    checked: new Set(),
    provenance: {},
    occurrences: {},
    documentOrder: [],
    missingLabels: {},
    mode: "setup",
    application: null,
    listingId: "",
    buildingId: "",
    scope: "unit",
    readOnly: false,
    targetLabel: "",
    editable: canEdit,
    // The workspace's own state: which of its three tabs is open, the documents
    // in the package, and which one the preview is filtered to.
    tab: "information",
    documents: [],
    activeDocument: "",
    listings: [],
    canPickUnit: true,
    isManager
  };
}

// A landlord value is a manager's, and an agent sees it rather than types it.
// Refusing the change here as well as in the Worker keeps a disabled input from
// being edited round — applyChange consults this before recording anything, so
// a field that is not editable cannot even become dirty.
function canEdit(field) {
  return field.source !== "manager" || isManager();
}

// The one rule the browser is allowed to decide for itself. Everything else —
// which layer answered, what a default means, whether a lease may be produced —
// stays on the server, so there is a single authority for "unanswered".
function recomputeMissing() {
  state.missing = new Set();
  for (const field of state.fields) {
    if (field.type === "checkbox") continue;
    if (!field.required) continue;
    // Every unanswered value counts, including the ones this person may not
    // fill in. An agent has to see that a lease is 17 values short so they can
    // ask a manager — hiding them would show a full progress bar over a
    // document the server will refuse to produce.
    if ((state.values[field.id] ?? "") === "") state.missing.add(field.id);
  }
  state.missingLabels = {};
  for (const id of state.missing) state.missingLabels[id] = state.byId.get(id).label;
}

// The full address, because "12B" is not enough to be sure which lease you are
// about to change the defaults for.
function unitLabel(listing) {
  if (!listing) return "";
  const home = [listing.building_name, listing.unit ? `Unit ${listing.unit}` : ""].filter(Boolean).join(" ");
  const where = listing.location || "";
  return [home, where].filter(Boolean).join(" — ") || listing.title || "";
}

function targetLabelFor() {
  return unitLabel(listingsOf().find((l) => l.id === state.listingId)) || "this unit";
}

// ------------------------------------------------------------------ loading

async function fetchValues() {
  if (state.mode === "lease") {
    const payload = await api(`/lease/document/${encodeURIComponent(state.application.id)}`, {
      method: "POST",
      body: JSON.stringify({ mode: "values" })
    });
    state.values = payload.values;
    state.provenance = payload.provenance || {};
    state.missingLabels = {};
    for (let i = 0; i < payload.missing.length; i += 1) {
      state.missingLabels[payload.missing[i]] = payload.missing_labels[i];
    }
    state.missing = new Set(payload.missing);
    return;
  }

  const payload = await api("/lease/document", {
    method: "POST",
    body: JSON.stringify({ mode: "values", listing_id: state.listingId || null })
  });
  state.values = payload.values;
  state.provenance = payload.provenance || {};
  state.missing = new Set(payload.missing);
  state.missingLabels = {};
  for (let i = 0; i < payload.missing.length; i += 1) {
    state.missingLabels[payload.missing[i]] = payload.missing_labels[i];
  }
}

// ------------------------------------------------------------------ opening

export async function openLeaseScreen(options = {}) {
  await loadRegistry();
  ({ buildings } = await api("/buildings").catch(() => ({ buildings: [] })));

  state = blankState();
  state.mode = options.application ? "lease" : "setup";
  state.application = options.application || null;
  state.listingId = options.application?.listing_id || options.listingId || "";
  state.buildingId = options.buildingId || "";
  // One layer for now: the specific apartment. Company and building settings
  // still exist in the database and are still inherited, but nothing here
  // writes to them — a value saved from this screen belongs to one address.
  state.scope = "unit";
  // Opened to be read rather than filled in. The property screen uses this to
  // show where a building's settings land on the page: everything it writes
  // goes to the building layer, so a stray edit here — which would land on one
  // apartment instead — must not be possible at all.
  state.readOnly = options.readOnly === true;
  // Where "back" goes. The workspace covers the console, so leaving it is a
  // route change rather than a hide — otherwise the address bar still names a
  // lease nobody is looking at.
  returnTo = options.returnTo || "";
  // An agent may correct what the application said, and may type a whole lease
  // when there is no application at all — which is the only way to produce one
  // until credit reporting is wired up. The landlord's own standing terms are
  // the exception: those are a manager's, on this screen as everywhere else.
  state.editable = state.readOnly ? () => false : canEdit;

  screen.hidden = false;
  if (mainEl) mainEl.hidden = true;
  document.body.classList.add("lease-open");

  if (!shellRendered) {
    renderShell();
    shellRendered = true;
  }
  renderBar();
  docHost = screen.querySelector("#lease-doc");
  formHost = screen.querySelector("#lease-fields");

  setStatus("Rendering the lease…");
  try {
    if (!mounted) {
      const summary = await doc.mountDocument(docHost, { onSlotClick: focusField });
      mounted = true;
      verifyTemplate(summary);
      // Which run of sections each document occupies. Worked out once, from the
      // render that just happened, and kept for the life of the page.
      packageDocuments = mapDocuments(summary.sectionTexts);
      verifyPackage(packageDocuments, summary.sections);
    }
    // Set on every open, not only the first: blankState() wipes it, and the
    // form used to fall back to registry order from the second open onwards.
    state.documentOrder = doc.fieldsInDocument();
    state.documents = packageDocuments;
    state.listings = listingsOf();
    state.canPickUnit = !state.readOnly && state.mode !== "lease";
    for (const field of state.fields) state.occurrences[field.id] = doc.occurrenceCount(field.id);
    state.targetLabel = targetLabelFor();

    await fetchValues();
    syncChecked();
    recomputeMissing();
    doc.patchValues(state.values, state.missingLabels);
    // Every document, unless the caller named one — the property screen opens
    // a single document from its package list, and landing on the whole
    // package would make that button look broken.
    showDocument(options.document || "");
    if (options.document) state.tab = "documents";
    workspace.renderWorkspace(formHost, state);
    // Again, now that the values are in: the header states the status, and a
    // status must never read "Ready to send" over a set of gaps nobody has
    // counted yet.
    renderBar();
    updateActions();
    setStatus("");
  } catch (error) {
    setStatus(error.message, "error");
  }

  bindOnce();
}

function syncChecked() {
  state.checked = new Set();
  for (const field of state.fields) {
    if (field.type !== "checkbox") continue;
    if (state.values[field.id] === field.marks.checked) state.checked.add(field.id);
  }
}

// A placeholder that Word split across two runs would simply not be found, and
// the lease would then carry a value this screen never showed. Never silent.
function verifyTemplate(summary) {
  const expected = new Set(registry.fields.map((field) => field.id));
  const found = new Set(summary.fields);
  // A part of the address that no longer prints on its own still composes the
  // one-line address the document does print — the state's abbreviation, since
  // the bedbug form stopped spelling the address out a second way.
  const composed = new Set(ADDRESS_PARTS);
  const absent = [...expected].filter((id) => !found.has(id) && !composed.has(id));
  const unknown = [...found].filter((id) => !expected.has(id));
  const boxes = summary.textBoxes || 0;
  if (absent.length === 0 && unknown.length === 0 && boxes === 0
      && summary.tablesIndented !== false && summary.pagesNumbered !== false
      && summary.tabOrigins > 0) return;

  const warning = screen.querySelector("#lease-alarm");
  warning.hidden = false;
  warning.innerHTML = `<b>This screen does not match the template.</b>
    ${absent.length ? `${absent.length} registered field(s) were not found in the document: ${absent.slice(0, 6).map(escapeHtml).join(", ")}.` : ""}
    ${unknown.length ? `${unknown.length} placeholder(s) in the document are not registered: ${unknown.slice(0, 6).map(escapeHtml).join(", ")}.` : ""}
    ${boxes ? `${boxes} text box(es) in the template cannot be shown here — the produced .docx contains them, but you are not reading them.` : ""}
    ${summary.tablesIndented === false ? "The tables on this screen could not be placed where the document places them, so their alignment here is not what gets signed." : ""}
    ${summary.pagesNumbered === false ? "The page numbers in the footers here were not counted, so they are the one Word last cached rather than this page's." : ""}
    ${summary.tabOrigins > 0 ? "" : "No indented paragraph could be given its tab origin back, so every tab on an indented line is drawn twice its indent too far right."}
    Do not send a lease produced here until this is fixed.`;
}

export function closeLeaseScreen() {
  // Called on every route change, so it has to be free the rest of the time.
  if (screen.hidden) return;
  screen.hidden = true;
  if (mainEl) mainEl.hidden = false;
  document.body.classList.remove("lease-open");
  doc.clearHighlight();
  // Settings may have been saved here, and the overview caches them.
  onClosed();
}

// -------------------------------------------------------------------- shell

let shellRendered = false;

function renderBar() {
  const listing = listingsOf().find((l) => l.id === state.listingId);
  const tenants = state.values["tenant.names"] || (state.application?.name ?? "");
  const status = leaseStatus();

  screen.querySelector("#lease-bar").innerHTML = `
    <button type="button" id="lease-back">← ${state.readOnly ? "Back to the property" : "Back to leases"}</button>
    <div class="lease-head">
      <h2>${escapeHtml(state.readOnly
        ? "The lease, as this apartment's settings fill it"
        : tenants || "New lease")}</h2>
      <p>${escapeHtml(unitLabel(listing) || "No apartment chosen yet")}</p>
    </div>
    <dl class="lease-facts">
      <div><dt>Status</dt><dd><span class="lease-status is-${status.tone}">${escapeHtml(status.label)}</span></dd></div>
      <div><dt>Rent</dt><dd>${escapeHtml(state.values["rent.monthly"] || "—")}</dd></div>
      <div><dt>Term</dt><dd>${escapeHtml(termLabel())}</dd></div>
    </dl>`;

  screen.querySelector("#lease-draft").hidden = state.readOnly;
  screen.querySelector("#lease-final").hidden = state.readOnly;
  // Saving a value as the apartment's default is a manager's act. Hidden here,
  // where the bar is built on every open, rather than only in updateActions —
  // that runs on a change, and a screen nobody has touched yet would show it.
  const save = screen.querySelector("#lease-save");
  save.textContent = "Save these as the unit's defaults";
  save.hidden = state.readOnly || !isManager();
}

// The lifecycle, as far as this system can honestly know it.
//
// There is no leases table: an application carries the only record that a lease
// happened, through the statuses lease_sent and lease_signed. So a lease is a
// draft until every required value is answered, ready when they are, and beyond
// that only what the application says. "Partially signed" is deliberately
// absent — nothing here talks to a signing service, so nothing could set it.
function leaseStatus() {
  const applicationStatus = state.application?.status;
  if (applicationStatus === "declined") return { label: "Cancelled", tone: "off" };
  if (applicationStatus === "lease_signed") return { label: "Fully signed", tone: "good" };
  if (applicationStatus === "lease_sent") return { label: "Sent for signature", tone: "busy" };
  if (state.missing.size > 0) return { label: "Draft", tone: "off" };
  return { label: "Ready to send", tone: "good" };
}

function termLabel() {
  const months = state.application?.lease_term_months;
  const start = state.values["lease.commencement_date"];
  const end = state.values["lease.end_date"];
  if (start && end) return `${start} – ${end}`;
  return months ? `${months} months` : "—";
}

// Built once. The rendered document lives in here and must survive every
// reopening of the screen — re-rendering it is the one thing this design
// forbids, because docx-preview strands 64 blob URLs each time.
function renderShell() {
  screen.innerHTML = `
    <div class="lease-bar" id="lease-bar"></div>
    <div class="lease-alarm" id="lease-alarm" hidden></div>
    <div class="lease-panes" id="lease-panes">
      <div class="lease-pane lease-pane-doc">
        <div class="lease-pane-head">
          <span id="lease-position">—</span>
          <span id="lease-doc-name" class="lease-doc-name"></span>
          <span class="lease-tools">
            <button type="button" data-lease-zoom="-1" aria-label="Zoom out">−</button>
            <span id="lease-zoom-label">100%</span>
            <button type="button" data-lease-zoom="1" aria-label="Zoom in">+</button>
            <label><input type="checkbox" id="lease-show-slots"> Show fields</label>
          </span>
        </div>
        <div class="lease-doc-scroll" id="lease-doc-scroll"><div id="lease-doc"></div></div>
      </div>
      <div class="lease-split" id="lease-split" role="separator" aria-label="Resize panes"></div>
      <div class="lease-pane lease-pane-form">
        <div id="lease-fields"></div>
        <div class="lease-actions" id="lease-actions">
          <div class="lease-warnings" id="lease-warnings"></div>
          <button type="button" id="lease-save" disabled>Save settings</button>
          <button type="button" id="lease-draft" hidden>Preview package</button>
          <button type="button" class="primary" id="lease-final" hidden disabled>Generate lease package</button>
        </div>
      </div>
    </div>
    <div class="lease-tabs">
      <button type="button" class="chip is-on" data-lease-tab="doc">Document</button>
      <button type="button" class="chip" data-lease-tab="form">Lease information</button>
    </div>`;

  const saved = Number(localStorage.getItem("lease-split") || 0);
  if (saved > 20 && saved < 80) {
    screen.querySelector("#lease-panes").style.gridTemplateColumns = `${saved}fr 6px ${100 - saved}fr`;
  }
}

// ----------------------------------------------------------- the document list

// A run of sections that the template has but no document claims would print
// in the .docx while being invisible here. Said out loud, like every other
// disagreement between this screen and the template.
function verifyPackage(mapped, sectionCount) {
  const problems = verifyDocuments(mapped, sectionCount);
  if (problems.length === 0) return;

  const warning = screen.querySelector("#lease-alarm");
  warning.hidden = false;
  warning.innerHTML = `<b>The document list does not match the template.</b>
    ${problems.map(escapeHtml).join(" ")}
    Every document listed still prints; one that is not listed cannot be read here.`;
}

// Filters the preview to one document, or to the whole package when `id` is
// empty. The sections outside it are collapsed, never unmounted — see
// lease-doc.js, which may not render twice.
function showDocument(id) {
  state.activeDocument = id || "";
  const found = state.documents.find((row) => row.id === state.activeDocument);
  if (found) doc.showSections(found.from, found.to);
  else doc.showSections(null);

  const label = screen.querySelector("#lease-doc-name");
  if (label) label.textContent = found ? found.name : "The whole package";

  const scroller = screen.querySelector("#lease-doc-scroll");
  if (scroller) scroller.scrollTop = 0;
  updatePosition();
}

// A value can print in a document the preview is not showing. Opening the one
// it is in first is the difference between "Show on the document" working and
// appearing to do nothing.
function showFieldInDocument(fieldId) {
  const section = doc.sectionOfField(fieldId);
  if (section !== null && state.activeDocument) {
    const current = state.documents.find((row) => row.id === state.activeDocument);
    if (current && (section < current.from || section > current.to)) {
      const owner = state.documents.find((row) => section >= row.from && section <= row.to);
      showDocument(owner ? owner.id : "");
    }
  }
  doc.scrollToOccurrence(fieldId, 0);
}

function updatePosition() {
  const scroller = screen.querySelector("#lease-doc-scroll");
  if (!scroller) return;
  const position = doc.describePosition(scroller);
  const readout = screen.querySelector("#lease-position");
  if (readout) {
    readout.textContent =
      `Section ${position.section}/${position.total}${position.heading ? ` · ${position.heading}` : ""}`;
  }
}

// ---------------------------------------------------------------- behaviour

let bound = false;
let zoom = 1;

function focusField(fieldId) {
  const input = formHost.querySelector(`[data-lease-input="${CSS.escape(fieldId)}"]`);
  if (!input) return;
  // The value may be on a tab that is not open; the information tab is the one
  // that holds every editable value.
  if (!input.offsetParent && state.tab !== "information") {
    state.tab = "information";
    workspace.renderTab(formHost, state);
    return focusField(fieldId);
  }
  // …or inside a section somebody has left shut.
  input.closest("details")?.setAttribute("open", "");
  input.scrollIntoView({ block: "center", behavior: "smooth" });
  input.focus();
  input.closest("[data-lease-row]")?.classList.add("is-located");
  setTimeout(() => input.closest("[data-lease-row]")?.classList.remove("is-located"), 1600);
}

function onInput(fieldId, rawValue, isCheckbox) {
  const field = state.byId.get(fieldId);
  if (!field || !state.editable(field)) return;

  if (isCheckbox) {
    if (rawValue) state.checked.add(fieldId);
    else state.checked.delete(fieldId);
    state.values[fieldId] = rawValue ? field.marks.checked : field.marks.unchecked;
  } else {
    state.values[fieldId] = rawValue;
  }

  state.dirty.add(fieldId);

  // The one-line address is derived, so correcting a part has to move it here
  // too — otherwise the preview shows one address and the produced .docx
  // another. Both sides compose it with the same shared function.
  if (ADDRESS_PARTS.includes(fieldId) && !state.dirty.has(ADDRESS_FIELD)) {
    state.values[ADDRESS_FIELD] = composeAddress(state.values);
  }

  recomputeMissing();

  // The document changes on this keystroke, not on a timer.
  doc.patchField(fieldId, state.values[fieldId],
    state.missing.has(fieldId) ? field.label : null);

  if (ADDRESS_PARTS.includes(fieldId) && !state.dirty.has(ADDRESS_FIELD)) {
    doc.patchField(ADDRESS_FIELD, state.values[ADDRESS_FIELD],
      state.missing.has(ADDRESS_FIELD) ? state.byId.get(ADDRESS_FIELD).label : null);
    const input = formHost.querySelector(`[data-lease-input="${CSS.escape(ADDRESS_FIELD)}"]`);
    if (input && document.activeElement !== input) input.value = state.values[ADDRESS_FIELD];
  }

  workspace.annotateWorkspace(formHost, state);
  updateActions();
}

// -------------------------------------------------- back to the application
//
// The overview and this screen edit the same tenant values. They are never on
// screen together — this one covers the list — so "in step" means each shows
// what the other left, which is what writing straight through to the
// application row gives. site/shared/lease-application.js says which values
// those are, read off the registry so neither side can hold a different list.

async function writeBack(fieldId) {
  if (state.mode !== "lease" || !state.application) return;
  if (!state.dirty.has(fieldId)) return;

  const field = state.byId.get(fieldId);
  const raw = field.type === "checkbox" ? state.checked.has(fieldId) : state.values[fieldId];
  const write = applicationWrite(state.fields, fieldId, raw);
  if (!write) return;
  const { column, value } = write;
  if (state.application[column] === value) return;

  try {
    const { application } = await api(`/applications/${encodeURIComponent(state.application.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ [column]: value })
    });
    state.application = application;
    onApplicationChanged(application);
    setStatus(`Saved ${field.label.toLowerCase()} to the application.`);
  } catch (error) {
    // Loud, because the alternative is a lease screen and an application that
    // quietly say different things about the same tenant.
    setStatus(`${field.label} was not saved to the application: ${error.message}`, "error");
  }
}


// The two values on this screen that belong to the application row rather than
// to the template: the tenant's phone, and how many months the term runs. Both
// are written straight through, the same way a corrected tenant name is.
async function writeApplicationValue(column, raw) {
  if (!state.application) return;
  const value = column === "lease_term_months" ? (Number(raw) || null) : String(raw).trim();
  if (state.application[column] === value) return;

  try {
    const { application } = await api(`/applications/${encodeURIComponent(state.application.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ [column]: value })
    });
    state.application = application;
    onApplicationChanged(application);
    applyEndDate();
    setStatus("Saved to the application.");
  } catch (error) {
    setStatus(`That was not saved to the application: ${error.message}`, "error");
  }
}

// The end date is computed, never typed, so it has to move the moment either
// half of the sum changes — and it has to move in the document too, or the
// preview and the .docx disagree about when the tenancy ends.
function applyEndDate() {
  const next = workspace.recomputeEndDate(state);
  if (next === state.values["lease.end_date"]) return;

  state.values["lease.end_date"] = next;
  state.dirty.add("lease.end_date");
  recomputeMissing();
  doc.patchField("lease.end_date", next,
    state.missing.has("lease.end_date") ? state.byId.get("lease.end_date").label : null);
  workspace.annotateWorkspace(formHost, state);
  renderBar();
  updateActions();
}

function updateActions() {
  const warnings = screen.querySelector("#lease-warnings");
  const dirtyManager = [...state.dirty].filter((id) => state.byId.get(id)?.source === "manager");
  const parts = [];
  if (state.missing.size > 0) parts.push(`${state.missing.size} still needed`);
  if (dirtyManager.length > 0) {
    parts.push(state.mode === "lease"
      ? `${dirtyManager.length} change${dirtyManager.length === 1 ? "" : "s"} for this lease only`
      : `${dirtyManager.length} unsaved`);
  }
  warnings.textContent = parts.join(" · ");

  // A per-lease change is a legitimate way to produce a lease, so it does not
  // block one. Only an unanswered required value does.
  const final = screen.querySelector("#lease-final");
  if (final) final.disabled = state.missing.size > 0;
  const save = screen.querySelector("#lease-save");
  if (save) {
    save.hidden = state.readOnly || !isManager();
    save.disabled = dirtyManager.length === 0 || !state.listingId;
  }
}

async function saveSettings() {
  const dirtyManager = [...state.dirty].filter((id) => state.byId.get(id)?.source === "manager");
  if (dirtyManager.length === 0) return;

  if (!state.listingId) {
    setStatus("Choose which apartment these settings belong to first.", "error");
    return;
  }

  if (state.mode === "lease" && !window.confirm(
    `Save ${dirtyManager.length} value(s) as the defaults for ${targetLabelFor()}?\n\n` +
    "Every later lease for this apartment starts from them. Leave them unsaved to " +
    "change this lease only.")) return;

  const fieldValues = {};
  for (const id of dirtyManager) {
    const field = state.byId.get(id);
    fieldValues[id] = field.type === "checkbox" ? state.checked.has(id) : state.values[id];
  }

  setStatus("Saving…");
  try {
    await api("/lease/settings", {
      method: "PUT",
      body: JSON.stringify({ scope: "unit", listing_id: state.listingId, field_values: fieldValues })
    });
    state.dirty = new Set();
    await fetchValues();
    syncChecked();
    recomputeMissing();
    doc.patchValues(state.values, state.missingLabels);
    workspace.annotateWorkspace(formHost, state);
    updateActions();
    setStatus("Saved.", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function produce(mode) {
  // Everything changed on screen and not saved goes with this one document.
  // That is the point of the distinction: the apartment's stored defaults are
  // what the next lease starts from, and a one-off here must not disturb them.
  const overrides = {};
  for (const id of state.dirty) {
    const field = state.byId.get(id);
    overrides[id] = field.type === "checkbox" ? state.checked.has(id) : state.values[id];
  }

  setStatus(mode === "final" ? "Producing the lease…" : "Building a draft…");
  try {
    const path = state.application
      ? `/api/admin/lease/document/${encodeURIComponent(state.application.id)}`
      : "/api/admin/lease/document";
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, overrides, listing_id: state.listingId || null })
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Failed (${response.status}).`);

    const blob = await response.blob();
    const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "")?.[1] || "lease.docx";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
    setStatus("Downloaded.", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function bindOnce() {
  if (bound) return;
  bound = true;

  screen.addEventListener("input", (event) => {
    const target = event.target.closest("[data-lease-input]");
    if (target) onInput(target.dataset.leaseInput, target.type === "checkbox" ? target.checked : target.value, target.type === "checkbox");

    // Typing a term should move the end date on the screen and in the document
    // at once, the same way typing a start date does.
    const appInput = event.target.closest("[data-ws-app]");
    if (appInput && appInput.dataset.wsApp === "lease_term_months") {
      if (state.application) state.application.lease_term_months = Number(appInput.value) || null;
      applyEndDate();
    }

  });

  screen.addEventListener("change", (event) => {
    if (event.target.id === "lease-listing") {
      state.listingId = event.target.value;
      reloadLayer();
    }

    const appInput = event.target.closest("[data-ws-app]");
    if (appInput) writeApplicationValue(appInput.dataset.wsApp, appInput.value);
    if (event.target.id === "lease-show-slots") doc.setShowSlots(event.target.checked);

    // A value the application owns is corrected here as often as it is
    // corrected on the overview, and an agent who fixes a misspelled name
    // while reading the lease should not have to fix it again afterwards.
    // On the field being left, not on every keystroke.
    const input = event.target.closest("[data-lease-input]");
    if (input) writeBack(input.dataset.leaseInput);
  });

  screen.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    if (button.id === "lease-back") {
      if (returnTo) location.hash = returnTo;
      else closeLeaseScreen();
      return;
    }
    if (button.id === "lease-save") return saveSettings();
    if (button.id === "lease-draft") return produce("draft");
    if (button.id === "lease-final") return produce("final");

    if (button.dataset.leaseLocate) {
      // The value may print inside a document that is filtered out of view.
      // Showing it means showing the document it is in.
      showFieldInDocument(button.dataset.leaseLocate);
      return;
    }

    if (button.dataset.leaseZoom) {
      zoom = Math.min(1.5, Math.max(0.5, zoom + Number(button.dataset.leaseZoom) * 0.1));
      docHost.style.zoom = String(zoom);
      screen.querySelector("#lease-zoom-label").textContent = `${Math.round(zoom * 100)}%`;
      return;
    }

    if (button.dataset.wsTab) {
      state.tab = button.dataset.wsTab;
      workspace.renderTab(formHost, state);
      return;
    }

    if (button.dataset.wsDoc !== undefined) {
      showDocument(button.dataset.wsDoc);
      workspace.renderTab(formHost, state);
      return;
    }

    if (button.dataset.leaseTab) {
      screen.dataset.tab = button.dataset.leaseTab;
      for (const chip of screen.querySelectorAll("[data-lease-tab]")) {
        chip.classList.toggle("is-on", chip === button);
      }
      return;
    }

    if (button.id === "lease-next-missing" || button.id === "lease-prev-missing") {
      const gaps = state.fields.filter((field) => state.missing.has(field.id)).map((field) => field.id);
      if (gaps.length === 0) return;
      gapIndex = (gapIndex + (button.id === "lease-next-missing" ? 1 : -1) + gaps.length) % gaps.length;
      const id = gaps[gapIndex];
      doc.scrollToOccurrence(id, 0);
      focusField(id);
    }
  });

  const scroller = screen.querySelector("#lease-doc-scroll");
  let ticking = false;
  scroller.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      updatePosition();
      ticking = false;
    });
  });

  bindSplitter();
}

let gapIndex = -1;

async function reloadLayer() {
  state.dirty = new Set();
  state.targetLabel = targetLabelFor();
  setStatus("Loading settings…");
  try {
    await fetchValues();
    syncChecked();
    recomputeMissing();
    doc.patchValues(state.values, state.missingLabels);
    workspace.renderWorkspace(formHost, state);
    updateActions();
    setStatus("");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function bindSplitter() {
  const panes = screen.querySelector("#lease-panes");
  const handle = screen.querySelector("#lease-split");
  let dragging = false;

  handle.addEventListener("pointerdown", (event) => {
    dragging = true;
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const rect = panes.getBoundingClientRect();
    const ratio = Math.round(((event.clientX - rect.left) / rect.width) * 100);
    if (ratio < 25 || ratio > 75) return;
    panes.style.gridTemplateColumns = `${ratio}fr 6px ${100 - ratio}fr`;
    localStorage.setItem("lease-split", String(ratio));
  });
  handle.addEventListener("pointerup", () => { dragging = false; });
}
