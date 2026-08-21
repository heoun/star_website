// The lease screen: the document on the left, the fields that fill it on the
// right, on one screen.
//
// It replaces both of the things it grew out of — the settings form that had no
// document, and the generate dialog whose preview was behind a button. Those
// were two write paths to the same 146 values, which is how someone ends up
// editing a building's legal disclosures without realising it.
//
// The document is rendered once (see lease-doc.js for why that is a hard rule)
// and patched as you type. Nothing here re-fetches or re-renders it.

import * as doc from "./lease-doc.js";
import * as form from "./lease-form.js";
import { ADDRESS_FIELD, ADDRESS_PARTS, composeAddress } from "../shared/lease-address.js";

let api;
let setStatus;
let escapeHtml;

let registry = null;
let buildings = [];
let listingsOf = () => [];

const screen = document.getElementById("lease-screen");
const mainEl = document.querySelector("main");

let state = null;
let formHost = null;
let docHost = null;
let mounted = false;

export function initLeaseScreen(deps) {
  ({ api, setStatus, escapeHtml } = deps);
  listingsOf = deps.listings;
  form.initForm({ escapeHtml });
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
    targetLabel: "",
    editable: () => true
  };
}

// The one rule the browser is allowed to decide for itself. Everything else —
// which layer answered, what a default means, whether a lease may be produced —
// stays on the server, so there is a single authority for "unanswered".
function recomputeMissing() {
  state.missing = new Set();
  for (const field of state.fields) {
    if (field.type === "checkbox") continue;
    if (!field.required) continue;
    if (!state.editable(field) && (state.values[field.id] ?? "") === "") continue;
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
  // Every field is fillable in both modes. An agent may correct what the
  // application said, and may type a whole lease when there is no application
  // at all — which is the only way to produce one until credit reporting is
  // wired up.
  state.editable = () => true;

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
      state.documentOrder = summary.fields;
    }
    for (const field of state.fields) state.occurrences[field.id] = doc.occurrenceCount(field.id);
    state.targetLabel = targetLabelFor();

    await fetchValues();
    syncChecked();
    recomputeMissing();
    doc.patchValues(state.values, state.missingLabels);
    form.renderForm(formHost, state);
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
  screen.hidden = true;
  if (mainEl) mainEl.hidden = false;
  document.body.classList.remove("lease-open");
  doc.clearHighlight();
}

// -------------------------------------------------------------------- shell

let shellRendered = false;

function renderBar() {
  const listing = listingsOf().find((l) => l.id === state.listingId);
  const title = state.mode === "lease"
    ? `Lease · ${escapeHtml(state.application.name)}`
    : "New lease";

  screen.querySelector("#lease-bar").innerHTML = `
    <button type="button" id="lease-back">← Back</button>
    <h2>${title}</h2>
    <div class="lease-scope">
      <span>${state.mode === "lease" ? "Defaults from" : "Apartment"}</span>
      ${state.mode === "lease"
        ? `<b>${escapeHtml(unitLabel(listing) || "this unit")}</b>`
        : `<select id="lease-listing">
             <option value="">— choose an apartment —</option>
             ${listingsOf().map((l) => `<option value="${escapeHtml(l.id)}"${l.id === state.listingId ? " selected" : ""}>${escapeHtml(unitLabel(l))}</option>`).join("")}
           </select>`}
    </div>`;

  screen.querySelector("#lease-draft").hidden = false;
  screen.querySelector("#lease-final").hidden = false;
  screen.querySelector("#lease-save").textContent = "Save these as the unit's defaults";
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
          <span class="lease-tools">
            <button type="button" data-lease-zoom="-1">−</button>
            <span id="lease-zoom-label">100%</span>
            <button type="button" data-lease-zoom="1">+</button>
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
          <button type="button" id="lease-draft" hidden>Download draft</button>
          <button type="button" class="primary" id="lease-final" hidden disabled>Produce lease</button>
        </div>
      </div>
    </div>
    <div class="lease-tabs">
      <button type="button" class="chip is-on" data-lease-tab="doc">Document</button>
      <button type="button" class="chip" data-lease-tab="form">Fields</button>
    </div>`;

  const saved = Number(localStorage.getItem("lease-split") || 0);
  if (saved > 20 && saved < 80) {
    screen.querySelector("#lease-panes").style.gridTemplateColumns = `${saved}fr 6px ${100 - saved}fr`;
  }
}

// ---------------------------------------------------------------- behaviour

let bound = false;
let zoom = 1;

function focusField(fieldId) {
  const input = formHost.querySelector(`[data-lease-input="${CSS.escape(fieldId)}"]`);
  if (!input) return;
  const row = input.closest("[data-lease-row]");
  if (row?.hidden) {
    // The field is filtered out; showing everything is better than doing nothing.
    screen.querySelector('[data-lease-filter="all"]')?.click();
  }
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

  form.annotate(formHost, state);
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
  if (save) save.disabled = dirtyManager.length === 0 || !state.listingId;
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
    form.annotate(formHost, state);
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

const stepIndex = new Map();

function bindOnce() {
  if (bound) return;
  bound = true;

  screen.addEventListener("input", (event) => {
    const target = event.target.closest("[data-lease-input]");
    if (target) onInput(target.dataset.leaseInput, target.type === "checkbox" ? target.checked : target.value, target.type === "checkbox");

    if (event.target.id === "lease-search") {
      form.applyFilter(formHost, { filter: currentFilter, search: event.target.value, state });
    }
  });

  screen.addEventListener("change", (event) => {
    if (event.target.id === "lease-listing") {
      state.listingId = event.target.value;
      reloadLayer();
    }
    if (event.target.id === "lease-show-slots") doc.setShowSlots(event.target.checked);
  });

  screen.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    if (button.id === "lease-back") return closeLeaseScreen();
    if (button.id === "lease-save") return saveSettings();
    if (button.id === "lease-draft") return produce("draft");
    if (button.id === "lease-final") return produce("final");

    if (button.dataset.leaseLocate) {
      const id = button.dataset.leaseLocate;
      const found = doc.scrollToOccurrence(id, stepIndex.get(id) || 0);
      if (found) form.setStepLabel(formHost, id, found.occurrence, found.total);
      return;
    }

    if (button.dataset.leaseStepDelta) {
      const wrap = button.closest("[data-lease-step]");
      const id = wrap.dataset.leaseStep;
      const total = state.occurrences[id] || 1;
      const next = ((stepIndex.get(id) || 0) + Number(button.dataset.leaseStepDelta) + total) % total;
      stepIndex.set(id, next);
      const found = doc.scrollToOccurrence(id, next);
      if (found) form.setStepLabel(formHost, id, found.occurrence, found.total);
      return;
    }

    if (button.dataset.leaseAccept) {
      const id = button.dataset.leaseAccept;
      const input = formHost.querySelector(`[data-lease-input="${CSS.escape(id)}"]`);
      if (input) {
        input.value = state.byId.get(id).source_value;
        onInput(id, input.value, false);
      }
      return;
    }

    if (button.dataset.leaseZoom) {
      zoom = Math.min(1.5, Math.max(0.5, zoom + Number(button.dataset.leaseZoom) * 0.1));
      docHost.style.zoom = String(zoom);
      screen.querySelector("#lease-zoom-label").textContent = `${Math.round(zoom * 100)}%`;
      return;
    }

    if (button.dataset.leaseFilter) {
      currentFilter = button.dataset.leaseFilter;
      for (const chip of screen.querySelectorAll("[data-lease-filter]")) {
        chip.classList.toggle("is-on", chip === button);
      }
      form.applyFilter(formHost, { filter: currentFilter, search: screen.querySelector("#lease-search").value, state });
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
      const position = doc.describePosition(scroller);
      screen.querySelector("#lease-position").textContent =
        `Section ${position.section}/${position.total}${position.heading ? ` · ${position.heading}` : ""}`;
      ticking = false;
    });
  });

  bindSplitter();
}

let currentFilter = "all";
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
    form.renderForm(formHost, state);
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
