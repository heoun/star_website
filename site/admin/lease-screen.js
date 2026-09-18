// The lease screen: the document on the left, the fields that fill it on the
// right, on one screen.
//
// It shows two things, and they share every line of this file except which
// fields go in the right half. A lease is one tenancy, filled in by an agent.
// Property defaults are the landlord's standing terms, filled in by a manager
// (mode "defaults", opened from the property page) — the same document, the
// same click-to-locate, the same keystroke patching the page, because the
// question both people are answering is "what will this say".
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
import { signingMarkup, bindSigning, signingPreview, prepareSigningPackage, sendSigningPackage, invalidateSigningReview } from './rental-signing.js';
import {signingFields,SIGNING_DOCUMENTS,signingFieldLabel} from '../shared/lease-signing-layout.js';
import { mapDocuments, verifyDocuments } from "../shared/lease-documents.js";
import { ADDRESS_FIELD, ADDRESS_PARTS, composeAddress } from "../shared/lease-address.js";
import { applicationWrite } from "../shared/lease-application.js";
import { agentMayWriteField } from "../shared/lease-permissions.js";
import {
  defaultsMarkup, handleDefaultsClick, rememberDefaultsNavigation, syncDefaultsNavigation, layerOf, loadLayer, managerFields,
  mayLeaveEditor, newDefaultsUi, propertyOf, resolve
} from "./property-defaults.js";

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
// The property editor's own state, in "defaults" mode: which panel is open,
// which dialog is up. One property is open at a time, so one of these.
let defaultsUi = newDefaultsUi();
let formHost = null;
let docHost = null;
let mounted = false;

export function initLeaseScreen(deps) {
  ({ api, escapeHtml } = deps);
  setStatus = (message, tone) => {
    const feedback = screen.querySelector('#lease-review-feedback');
    if (!feedback || screen.hidden || state?.mode === 'defaults') return deps.setStatus(message, tone);
    feedback.hidden = !message;
    feedback.textContent = message || '';
    feedback.dataset.tone = tone || '';
  };
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

// An agent edits the terms of the tenancy — the whitelist in
// site/shared/lease-permissions.js — and sees everything else. Refusing the
// change here as well as in the Worker keeps a disabled input from being
// edited round — applyChange consults this before recording anything, so a
// field that is not editable cannot even become dirty.
function canEdit(field) {
  if(state?.readOnly)return false;
  if(state?.mode==='lease' && (field.id.startsWith('tenant.') || field.id.startsWith('property.') || field.template===false))return false;
  return isManager() || agentMayWriteField(field.id);
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
  const home = [listing.property_name, listing.unit ? `Unit ${listing.unit}` : ""].filter(Boolean).join(" ");
  const where = listing.location || "";
  return [home, where].filter(Boolean).join(" — ") || listing.title || "";
}

function targetLabelFor() {
  return unitLabel(listingsOf().find((l) => l.id === state.listingId)) || "this unit";
}

// ------------------------------------------------------------------ loading

async function fetchValues() {
  if (state.mode === "lease") {
    const {case:caseRow}=await api(`/cases/${encodeURIComponent(state.application.id)}`);
    state.caseRow=caseRow;
    state.signing=await api(`/cases/${encodeURIComponent(state.application.id)}/signing`).catch(()=>({configuration:{enabled:false}}));
    const phase=caseRow.workspace?.signing?.phase;
    state.readOnly=state.requestedReadOnly || ['lease_sent','lease_signed','declined'].includes(caseRow.status) || !!(phase && !['voided','declined'].includes(phase));
    state.landlordEmail=state.signing?.signing?.signers?.find(s=>s.role==='landlord')?.email || caseRow.workspace?.recommendation?.landlord_email || '';
    if(!state.landlordEmail){
      const {landlords=[]}=await api(`/cases/${encodeURIComponent(state.application.id)}/participants`).catch(()=>({}));
      const building=buildings.find(b=>b.id===caseRow.listings?.building_id);
      state.landlordEmail=landlords.find(l=>l.email===building?.landlord_signer_email)?.email || (landlords.length===1?landlords[0].email:'');
    }
    const payload = await api(`/lease/document/${encodeURIComponent(state.application.id)}`, {
      method: "POST",
      body: JSON.stringify({ mode: "values" })
    });
    state.values = payload.values;
    state.frozen=payload.frozen;
    state.baseValues=structuredClone(payload.values);
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
  clearSigningDocument();
  await loadRegistry();
  ({ buildings } = await api("/buildings").catch(() => ({ buildings: [] })));

  state = blankState();
  state.mode = options.mode === "defaults" ? "defaults"
    : options.application ? "lease" : "setup";
  state.application = options.application || null;
  state.listingId = options.application?.listing_id || options.listingId || "";
  state.buildingId = options.buildingId || "";
  // One layer for what this screen saves as a lease: the specific apartment.
  // The property layer is written too, but only in "defaults" mode and only
  // through the property editor, which names its own scope.
  state.scope = "unit";
  // Opened to be read rather than filled in. The property screen uses this to
  // show where a property's settings land on the page: everything it writes
  // goes to the property layer, so a stray edit here — which would land on one
  // apartment instead — must not be possible at all.
  state.readOnly = options.readOnly === true || state.mode === "defaults";
  state.requestedReadOnly=state.readOnly;
  // Where "back" goes. The workspace covers the console, so leaving it is a
  // route change rather than a hide — otherwise the address bar still names a
  // lease nobody is looking at.
  returnTo = options.returnTo || "";
  // An agent settles the terms of the tenancy — the whitelist in
  // site/shared/lease-permissions.js — and reads everything else: the
  // tenant's identity, the premises, the landlord's standing terms are a
  // manager's, on this screen as everywhere else.
  //
  // Filling in the defaults is the mirror image: the landlord's own values are
  // the only ones a keystroke may move, and only a manager's keystroke. The
  // panel decides who may open an editor at all; this decides what a value
  // typed into one is allowed to do to the document.
  state.editable = state.mode === "defaults"
    ? (field) => isManager() && field.source === "manager"
    : state.readOnly ? () => false : canEdit;

  if (state.mode === "defaults") {
    defaultsUi = newDefaultsUi();
    await loadLayer(state.buildingId);
  }

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
    // Filling in a property's defaults reads them on one of its own
    // apartments; a lease reads the one it is for.
    state.listings = state.mode === "defaults"
      ? listingsOf().filter((row) => row.building_id === state.buildingId)
      : listingsOf();
    // Which apartment the document is read for. Fixed to the application's in
    // a lease; free in the other two, where the document is a sample.
    state.canPickUnit = state.mode !== "lease" && !options.readOnly;
    for (const field of state.fields) state.occurrences[field.id] = doc.occurrenceCount(field.id);
    state.targetLabel = targetLabelFor();

    await fetchValues();
    syncChecked();
    recomputeMissing();
    doc.patchValues(state.values, state.missingLabels);
    // Every document, unless the caller named one — the property screen opens
    // a single document from its package list, and landing on the whole
    // package would make that button look broken.
    showDocument(options.document || (state.mode==='lease'?'lease':''));
    if (options.document) state.tab = "documents";
    renderFormPane();
    // Again, now that the values are in: the header states the status, and a
    // status must never read "Ready to send" over a set of gaps nobody has
    // counted yet.
    renderBar();
    updateActions();
    setStatus("");
    if(state.caseRow && signingPreview(signingContext()))await reviewSigningDocument(signingPreview(signingContext()));
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
  // Contact details and settings that feed other fields need no placeholder.
  const absent = registry.fields
    .filter((field) => field.template !== false && !found.has(field.id) && !composed.has(field.id))
    .map((field) => field.id);
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
  clearSigningDocument();
  screen.hidden = true;
  if (mainEl) mainEl.hidden = false;
  document.body.classList.remove("lease-open");
  doc.clearHighlight();
  // Settings may have been saved here, and the overview caches them.
  onClosed();
}

// -------------------------------------------------------------------- shell

let shellRendered = false;

// The right half. Which editor it holds is the whole difference between the
// two things this screen shows; everything around it — the document, the
// locating, the patching — does not know which one is in there.
function renderFormPane() {
  if (state.mode !== "defaults") {
    workspace.renderWorkspace(formHost, state);
    renderSigningPanel();
    return;
  }

  rememberDefaultsNavigation(formHost, defaultsUi);
  formHost.innerHTML = `<div class="ws-body ws-defaults" id="ws-body">${defaultsMarkup({
    fields: managerFields(registry),
    values: layerOf(state.buildingId),
    buildingId: state.buildingId,
    ui: defaultsUi,
    docLinked: true
  })}</div>`;
  syncDefaultsNavigation(formHost, defaultsUi);
}

// The property being filled in, and what is still short. No status chip and no
// rent: nothing here belongs to one tenancy, and a "Draft" over a property
// would be a lease that does not exist.
function renderDefaultsBar() {
  const building = propertyOf(state.buildingId);
  const values = layerOf(state.buildingId);
  const short = managerFields(registry)
    .filter((field) => field.required && !resolve(field, values).answered).length;

  screen.querySelector("#lease-bar").innerHTML = `
    <button type="button" id="lease-back">← Back to the property</button>
    <div class="lease-head">
      <h2>${escapeHtml(building?.name || "Property defaults")}</h2>
      <p>The landlord's own values, and the lease they fill in</p>
    </div>
    <dl class="lease-facts">
      <div><dt>Required</dt><dd><span class="lease-status is-${short === 0 ? "good" : "off"}">${
        short === 0 ? "All answered" : `${short} still needed`}</span></dd></div>
    </dl>
    <select id="lease-listing" aria-label="Apartment this document is read for">
      ${state.listings.map((row) => `<option value="${escapeHtml(row.id)}"${
        row.id === state.listingId ? " selected" : ""}>${escapeHtml(unitLabel(row))}</option>`).join("")}
    </select>`;

  screen.querySelector("#lease-actions").hidden = true;
}

function renderBar() {
  if (state.mode === "defaults") return renderDefaultsBar();

  const listing = listingsOf().find((l) => l.id === state.listingId);
  const tenants = state.values["tenant.names"] || (state.application?.name ?? "");
  const status = leaseStatus();

  screen.querySelector("#lease-bar").innerHTML = `
    <button type="button" id="lease-back">← ${state.mode==='lease'?'Back to Rental':state.readOnly ? "Back to Property" : "Back to Leases"}</button>
    <div class="lease-head">
      <h2>${escapeHtml(state.readOnly && state.mode!=='lease'
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
  const applicationStatus = state.caseRow?.status || state.application?.status;
  if (applicationStatus === "declined") return { label: "Cancelled", tone: "off" };
  if (applicationStatus === "lease_signed") return { label: "Fully signed", tone: "good" };
  if (applicationStatus === "lease_sent") return { label: "Sent for signature", tone: "busy" };
  if (state.missing.size > 0) return { label: "Draft", tone: "off" };
  if(state.dirty.size)return {label:'Unsaved Corrections',tone:'off'};
  if(state.mode==='lease' && !['landlord_approved','lease_sent','lease_signed'].includes(applicationStatus))return {label:'Awaiting Approval',tone:'off'};
  return { label: "Ready for Review", tone: "good" };
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
          <button type="button" id="lease-all-documents" aria-pressed="false">View All Documents</button>
          <span class="lease-tools">
            <button type="button" data-lease-zoom="-1" aria-label="Zoom out">−</button>
            <span id="lease-zoom-label">100%</span>
            <button type="button" data-lease-zoom="1" aria-label="Zoom in">+</button>
            <label><input type="checkbox" id="lease-show-slots"> Show Fields</label>
          </span>
        </div>
        <div id="lease-match-nav" class="lease-match-nav" hidden>
          <span id="lease-match-label"></span>
          <span id="lease-match-count" role="status" aria-live="polite"></span>
          <button type="button" data-lease-match="-1" aria-label="Previous Match">← Previous</button>
          <button type="button" data-lease-match="1" aria-label="Next Match">Next →</button>
        </div>
        <div class="lease-doc-scroll" id="lease-doc-scroll"><div id="lease-doc"></div></div>
      </div>
      <div class="lease-split" id="lease-split" role="separator" aria-label="Resize panes"></div>
      <div class="lease-pane lease-pane-form">
        <div id="lease-fields"></div>
        <div class="lease-actions" id="lease-actions">
          <p id="lease-review-feedback" role="status" hidden></p>
          <div class="lease-warnings" id="lease-warnings"></div>
          <button type="button" id="lease-save" disabled>Save settings</button>
          <button type="button" id="lease-draft" hidden>Preview package</button>
          <button type="button" class="primary" id="lease-final" hidden disabled>Generate lease package</button>
        </div>
      </div>
    </div>
    <div class="lease-tabs">
      <button type="button" class="chip is-on" data-lease-tab="doc">Document</button>
      <button type="button" class="chip" data-lease-tab="form">Lease Information</button>
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
let locatedField=null;
function resetMatches(){
  locatedField=null;
  const nav=screen.querySelector('#lease-match-nav');if(nav)nav.hidden=true;
  doc.clearHighlight();
}
function renderMatches(fieldId,index,total){
  locatedField={fieldId,index,total};
  screen.querySelector('#lease-match-nav').hidden=false;
  screen.querySelector('#lease-match-label').textContent=state.byId.get(fieldId)?.label || 'Matches';
  screen.querySelector('#lease-match-count').textContent=`${index+1} of ${total}`;
  for(const button of screen.querySelectorAll('[data-lease-match]'))button.disabled=total<2;
}
function showDocument(id, keepMatches=false, notifyFrame=true) {
  if(!keepMatches)resetMatches();
  state.activeDocument = id || "";
  const found = state.documents.find((row) => row.id === state.activeDocument);
  if (found) doc.showSections(found.from, found.to);
  else doc.showSections(null);
  if(notifyFrame)signingFrame?.contentWindow?.postMessage({type:'signing-document-view',packageId:signingEntry.preview.id,document:id},location.origin);

  const label = screen.querySelector("#lease-doc-name");
  if (label) label.textContent = found ? found.name : "All Documents";
  const allDocuments = screen.querySelector('#lease-all-documents');
  if (allDocuments) {
    allDocuments.setAttribute('aria-pressed',String(!found));
    allDocuments.disabled = !found;
  }

  const scroller = screen.querySelector("#lease-doc-scroll");
  if (scroller) scroller.scrollTop = 0;
  updatePosition();
}

// A value can print in a document the preview is not showing. Opening the one
// it is in first is the difference between "Show on the document" working and
// appearing to do nothing.
function showFieldInDocument(fieldId, reveal = false, index = 0) {
  if(reveal){
    screen.dataset.tab='doc';
    for(const chip of screen.querySelectorAll('[data-lease-tab]'))chip.classList.toggle('is-on',chip.dataset.leaseTab==='doc');
  }
  if(signingFrame) {
    if(signingLoading){setStatus('The signing document is still loading. Please try again.');return;}
    // Reveal the mobile document pane before asking its frame to scroll.
    // Opening an editor alone must not take the user away from their input.
    if(!reveal && !signingFrame.getClientRects().length)return;
    const frame=signingFrame,packageId=signingEntry.preview.id;
    requestAnimationFrame(()=>{
      if(signingFrame!==frame)return;
      frame.contentWindow.postMessage({type:'signing-document-locate',packageId,fieldId,index,contexts:doc.contextsForField(fieldId)},location.origin);
    });
    return;
  }
  const section = doc.sectionOfField(fieldId,index);
  if (section !== null && state.activeDocument) {
    const current = state.documents.find((row) => row.id === state.activeDocument);
    if (current && (section < current.from || section > current.to)) {
      const owner = state.documents.find((row) => section >= row.from && section <= row.to);
      showDocument(owner ? owner.id : "",true);
    }
  }
  const match=doc.scrollToOccurrence(fieldId,index);
  if(match)renderMatches(fieldId,index,match.total);
  else resetMatches();
}

function updatePosition() {
  if(signingFrame){screen.querySelector('#lease-position').textContent='Signing Package';return;}
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
  if(state.mode!=='defaults' && state.tab!=='information') {state.tab='information';workspace.renderTab(formHost,state);}
  const input = formHost.querySelector(`[data-lease-input="${CSS.escape(fieldId)}"]`);

  // In the property editor a value has an input only while its panel is open
  // for editing, and clicking the document is how a person asks "which value
  // is this". The row is always there, so the row is what answers.
  if (!input && state.mode === "defaults") {
    return locateRow(formHost.querySelector(`[data-setting-row="${CSS.escape(fieldId)}"]`));
  }

  if (!input) return locateRow(formHost.querySelector(`[data-ws-row="${CSS.escape(fieldId)}"]`));
  // The value may be on a tab that is not open; the information tab is the one
  // that holds every editable value.
  if (!input.offsetParent && state.mode !== "defaults" && state.tab !== "information") {
    state.tab = "information";
    workspace.renderTab(formHost, state);
    return focusField(fieldId);
  }
  // …or inside a section somebody has left shut.
  for(let parent=input.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
  input.scrollIntoView({ block: "center", behavior: "smooth" });
  input.focus();
  locateRow(input.closest("[data-lease-row], [data-setting-row]"), false);
}

// Says "this one", for as long as it takes to look at it.
function locateRow(row, scroll = true) {
  if (!row) return;
  if (scroll) row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add("is-located");
  setTimeout(() => row.classList.remove("is-located"), 1600);
}

function onInput(fieldId, rawValue, isCheckbox) {
  const field = state.byId.get(fieldId);
  if (!field || !state.editable(field)) return;
  if(state.application){invalidateSigningReview(state.application.id);clearSigningDocument();}

  if (isCheckbox) {
    if (rawValue) state.checked.add(fieldId);
    else state.checked.delete(fieldId);
    state.values[fieldId] = rawValue ? field.marks.checked : field.marks.unchecked;
  } else {
    state.values[fieldId] = rawValue;
  }

  state.dirty.add(fieldId);
  if(state.baseValues && state.values[fieldId]===state.baseValues[fieldId])state.dirty.delete(fieldId);
  if(isCheckbox && ['dhcr.mark_vacancy','dhcr.mark_renewal'].includes(fieldId)){
    const otherId=fieldId==='dhcr.mark_vacancy'?'dhcr.mark_renewal':'dhcr.mark_vacancy',other=state.byId.get(otherId);
    if(other){
      if(rawValue)state.checked.delete(otherId);else state.checked.add(otherId);
      state.values[otherId]=rawValue?other.marks.unchecked:other.marks.checked;
      state.dirty.add(otherId);
      if(state.baseValues && state.values[otherId]===state.baseValues[otherId])state.dirty.delete(otherId);
      doc.patchField(otherId,state.values[otherId]);
    }
  }

  // The end date is half move-in, half term; a new move-in moves it now, the
  // same way a new term does.
  if (fieldId === "lease.commencement_date") applyEndDate();

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

  if (state.mode !== "defaults") workspace.annotateWorkspace(formHost, state);
  // The header facts — the rent, the tenant's name, the status chip — quote
  // the values being edited, so they move on the same keystroke.
  renderBar();
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
  // Lease corrections are saved together, with approval invalidation and audit.
  if(state.caseRow?.workspace?.rental_flow==='automatic')return;
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
  if(next===state.baseValues?.['lease.end_date'])state.dirty.delete('lease.end_date');
  recomputeMissing();
  doc.patchField("lease.end_date", next,
    state.missing.has("lease.end_date") ? state.byId.get("lease.end_date").label : null);
  workspace.annotateWorkspace(formHost, state);
  renderBar();
  updateActions();
}

function updateActions() {
  // Nothing here belongs to the property editor: it saves through its own
  // panels, and no lease is produced from it.
  if (state.mode === "defaults") {
    screen.querySelector("#lease-actions").hidden = true;
    return;
  }

  screen.querySelector("#lease-actions").hidden = false;
  if(state.mode==='lease' && state.caseRow?.workspace?.rental_flow==='automatic') {
    const save=screen.querySelector('#lease-save'),review=screen.querySelector('#lease-final'),draft=screen.querySelector('#lease-draft');
    const problems=workspace.reviewIssues(state).length;
    save.hidden=state.readOnly || !state.dirty.size;save.textContent='Save & Request Approval';save.disabled=problems>0;
    draft.hidden=state.readOnly || !!signingEntry?.reviewed;draft.textContent='Review Signing Package';
    review.hidden=false;review.textContent=state.readOnly?'View Signing Status':'Send With DocuSign';
    review.disabled=!!state.dirty.size || !state.signing?.configuration?.enabled || !screen.querySelector('#lease-alarm').hidden || (!state.readOnly && (problems>0 || state.caseRow.status!=='landlord_approved'));
    draft.disabled=review.disabled || signingLoading || signingBusy;
    if(signingLoading || signingBusy || (!state.readOnly && !state.signing?.configuration?.canSend))review.disabled=true;
    if(state.signing?.configuration?.placementReviewRequired && !state.readOnly)review.disabled=true;
    screen.querySelector('#lease-warnings').textContent=state.dirty.size?`${state.dirty.size} unsaved correction${state.dirty.size===1?'':'s'} · This lease only`:state.caseRow.status==='sent_to_landlord'?'Waiting for landlord approval':'';
    return;
  }

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
  if(state.mode==='lease' && state.caseRow?.workspace?.rental_flow==='automatic')return saveLeaseCorrections();
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

async function saveLeaseCorrections() {
  const overrides={};
  for(const id of state.dirty){const field=state.byId.get(id);overrides[id]=field.type==='checkbox'?state.checked.has(id):state.values[id];}
  if(!Object.keys(overrides).length)return;
  if(!window.confirm('Save these corrections for this lease and request landlord approval? The previous approval and signing previews will no longer be valid. Property defaults will stay unchanged.'))return;
  const button=screen.querySelector('#lease-save');button.disabled=true;
  try {
    await api(`/lease/document/${encodeURIComponent(state.application.id)}`,{method:'POST',body:JSON.stringify({mode:'corrections',version:state.caseRow.workspace_version,overrides})});
    state.dirty.clear();await refreshReview();setStatus('Corrections saved. A new landlord approval is required.','ok');
  }catch(error){setStatus(error.message,'error');updateActions();}
}

async function refreshReview() {
  clearSigningDocument();
  await fetchValues();syncChecked();recomputeMissing();doc.patchValues(state.values,state.missingLabels);renderFormPane();renderBar();updateActions();
}
let signingPreviewLayout='lease';
let signingPreviewTenant='';
function renderSigningPanel() {
  const host=formHost?.querySelector('[data-workspace-signing]');if(!host)return;
  if(!state.caseRow){host.innerHTML='<p class="ws-hint">Open a rental to review and send its lease.</p>';return;}
  if(state.dirty.size){host.innerHTML='<p role="status">Save your corrections and obtain approval before preparing a signing package.</p>';return;}
  const ctx={...signingContext(),workspaceReview:true};
  const recipients=formHost.querySelector('[data-workspace-recipients]');
  const record=ctx.signing?.signing,active=record && !['voided','declined'].includes(record.phase);
  if(recipients)recipients.innerHTML=workspace.signingRecipients(state,active?record.signers:signingPreview(ctx)?.preview.signers);
  host.innerHTML=signingMarkup(ctx);bindSigning(host,ctx,refreshReview);
  if(!active){
    const signers=signingPreview(ctx)?.preview.signers || [...workspace.tenantSigners(state).map((s,i)=>({...s,recipientId:String(i+1),role:'tenant'})),{recipientId:String(workspace.tenantSigners(state).length+1),role:'landlord',name:state.values['landlord.print_name'],email:state.landlordEmail}];
    const preview=document.createElement('section');preview.className='ws-signing-preview';
    try{
      const layout=SIGNING_DOCUMENTS.find(d=>d.id===signingPreviewLayout),tenants=signers.filter(s=>s.role==='tenant');
      if(!tenants.some(s=>s.recipientId===signingPreviewTenant))signingPreviewTenant=tenants[0]?.recipientId || '';
      const people=layout.individual?signers.filter(s=>s.role==='landlord' || s.recipientId===signingPreviewTenant):signers;
      const fields=signingFields(people,signingPreviewLayout,signingPreview(ctx)?.preview.values || state.values);
      preview.innerHTML=`<h3>Signing Field Preview</h3><label class="ws-preview-document">Document<select data-signing-layout>${SIGNING_DOCUMENTS.map(d=>`<option value="${d.id}"${d.id===signingPreviewLayout?' selected':''}>${escapeHtml(d.name)}</option>`).join('')}</select></label>${layout.individual?`<label class="ws-preview-document">Tenant Copy<select data-signing-tenant>${tenants.map(s=>`<option value="${escapeHtml(s.recipientId)}"${s.recipientId===signingPreviewTenant?' selected':''}>${escapeHtml(s.name)}</option>`).join('')}</select></label><p class="ws-hint">Each tenant signs a separate copy on the original signature line.</p>`:''}<p class="ws-hint">Blue: tenants. Purple: landlord. Date Signed is filled when that person signs.${state.signing?.configuration?.placementReviewRequired?' Sending is paused while you confirm these positions.':''}</p>${fields.length?`<button type="button" class="signing-action" data-preview-signing-fields="${escapeHtml(fields[0].id)}">Preview Signing Fields</button>`:'<p class="ws-hint" role="status">No rent concession is specified. This rider does not require signatures.</p>'}`;
      const rows=recipients?.querySelectorAll('.ws-signer');
      signers.forEach((s,i)=>{
        const controls=document.createElement('div');controls.className='ws-signing-targets';
        controls.innerHTML=fields.filter(f=>f.recipientId===s.recipientId).map(f=>`<button type="button" data-preview-signing-fields="${escapeHtml(f.id)}">${f.section?`§${f.section} · `:''}${signingFieldLabel(f.kind)}</button>`).join('');
        rows?.[i]?.querySelector('div').append(controls);
      });
    }catch(error){preview.textContent=error.message;}
    (recipients || host).before(preview);
    // Rendering status again must not duplicate the field-preview controls.
    for(const old of formHost.querySelectorAll('.ws-signing-preview'))if(old!==preview)old.remove();
  }
  if(!ctx.signing?.signing){
    const status=document.createElement('p');status.className='ws-hint';
    status.textContent=signingEntry?.reviewed?'Signing package opened for review · Not sent.':'Draft preview · Not sent. Sending without opening the signing package requires confirmation.';
    host.querySelector('.signing-panel-heading').after(status);
  }
}

let signingFrame=null,signingEntry=null,signingLoading=false,signingCancel=null,signingBusy=false;
window.addEventListener('message',event=>{
  if(event.origin!==location.origin || !signingFrame || event.source!==signingFrame.contentWindow || event.data?.packageId!==signingEntry?.preview.id)return;
  if(event.data.type==='signing-fields-error'){setStatus(event.data.message,'error');return;}
  if(event.data.type==='signing-fields-ready'){
    for(const b of formHost.querySelectorAll('[data-preview-signing-fields]'))b.setAttribute('aria-pressed',String(b.dataset.previewSigningFields===event.data.selected));
    setStatus(`${SIGNING_DOCUMENTS.find(d=>d.id===signingPreviewLayout)?.name} · Signing field preview only. Nothing has been sent.`);return;
  }
  if(event.data.type!=='signing-document-located')return;
  const field=state.byId.get(event.data.fieldId);
  if(!event.data.found){resetMatches();setStatus(`Could not locate ${field?.label || 'this field'} in the signing document. Check it under Documents.`,'error');return;}
  renderMatches(event.data.fieldId,event.data.index,event.data.total);
  state.activeDocument=event.data.document || '';
  const found=state.documents.find(row=>row.id===state.activeDocument);
  screen.querySelector('#lease-doc-name').textContent=found?.name || 'All Documents';
  const all=screen.querySelector('#lease-all-documents');all.disabled=!found;all.setAttribute('aria-pressed',String(!found));
  if(state.tab==='documents')workspace.renderTab(formHost,state);
  setStatus(`${field?.label || 'Field'} located and highlighted in the signing document.`);
});
function signingContext(){return {id:state.application.id,row:state.caseRow,w:state.caseRow.workspace || {},signing:state.signing,api,openReview:reviewSigningDocument};}
function clearSigningDocument(){
  resetMatches();
  signingCancel?.();signingCancel=null;
  signingFrame?.remove();signingFrame=null;signingEntry=null;signingLoading=false;
  const scroll=screen.querySelector('#lease-doc-scroll');if(scroll)scroll.hidden=false;
  const slots=screen.querySelector('#lease-show-slots');
  if(slots){slots.disabled=false;slots.closest('label').hidden=false;}
}
async function reviewSigningDocument(entry){
  if(state.dirty.size || signingPreview(signingContext())!==entry)throw new Error('The lease changed. Prepare a new signing package.');
  clearSigningDocument();signingEntry=entry;signingLoading=true;entry.reviewed=false;updateActions();
  const frame=document.createElement('iframe');signingFrame=frame;
  frame.title='Lease for Signing';frame.style.cssText='width:100%;flex:1;min-height:0;border:0;background:#f1efe8';
  frame.src=`/admin/signing-document.html?rental=${encodeURIComponent(state.application.id)}&package=${encodeURIComponent(entry.preview.id)}&sha=${encodeURIComponent(entry.preview.source_sha256)}`;
  screen.querySelector('#lease-doc-scroll').hidden=true;
  screen.querySelector('.lease-pane-doc').append(frame);
  screen.querySelector('#lease-show-slots').disabled=true;
  screen.querySelector('#lease-show-slots').closest('label').hidden=true;
  setStatus('Loading the saved signing package…');
  try {
    await new Promise((resolve,reject)=>{
      const done=error=>{clearTimeout(timer);window.removeEventListener('message',receive);signingCancel=null;error?reject(error):resolve();};
      const receive=event=>{
        if(event.origin!==location.origin || event.source!==frame.contentWindow || event.data?.packageId!==entry.preview.id)return;
        if(event.data.type==='signing-document-ready')done();
        if(event.data.type==='signing-document-error')done(new Error(event.data.message));
      };
      const timer=setTimeout(()=>done(new Error('The signing document did not load. Try reviewing it again.')),45000);
      signingCancel=()=>done(new Error('Review closed.'));window.addEventListener('message',receive);
    });
    if(signingEntry!==entry)return;
    entry.reviewed=true;signingLoading=false;showDocument('');
    frame.contentWindow.postMessage({type:'signing-document-zoom',packageId:entry.preview.id,zoom},location.origin);
    screen.querySelector('#lease-position').textContent='Signing Package';
    setStatus('Review the lease and signer details, then send with DocuSign.');
    renderSigningPanel();updateActions();
  } catch(error){
    if(signingEntry!==entry)return;
    clearSigningDocument();entry.reviewed=false;updateActions();throw error;
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

// What the property editor needs from its host: where it is drawn, which
// property it is editing, and the two things only this screen can do — redraw
// the pane, and put what was just saved onto the document beside it.
function defaultsContext() {
  return {
    host: formHost,
    buildingId: state.buildingId,
    fields: managerFields(registry),
    ui: defaultsUi,
    rerender: async () => {
      renderFormPane();
      renderBar();
    },
    onSaved: async () => {
      // The saved value is now what a lease for this property prints, and the
      // lease is on the left of the screen.
      await fetchValues();
      syncChecked();
      recomputeMissing();
      doc.patchValues(state.values, state.missingLabels);
      renderFormPane();
      renderBar();
    }
  };
}

function bindOnce() {
  if (bound) return;
  bound = true;

  screen.addEventListener("input", (event) => {
    if(event.target.matches('[data-ws-lease-type]'))onInput('dhcr.mark_vacancy',event.target.value==='new',true);
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
    if(event.target.matches('[data-signing-layout],[data-signing-tenant]')){
      if(event.target.matches('[data-signing-layout]'))signingPreviewLayout=event.target.value;
      else signingPreviewTenant=event.target.value;
      renderSigningPanel();
      const first=formHost.querySelector('[data-preview-signing-fields]');
      if(first)first.click();else showDocument(SIGNING_DOCUMENTS.find(d=>d.id===signingPreviewLayout).document);
      return;
    }
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
    if(state?.mode==='lease' && state.dirty.size && event.target.closest('a[href^="#"]') && !window.confirm('Leave without saving these lease corrections?')){event.preventDefault();return;}
    // The property editor owns its panels, its two dialogs and its writes.
    // Asked first, because a dialog's backdrop is not a button.
    if (state?.mode === "defaults") {
      if (await handleDefaultsClick(event, defaultsContext())) return;

      // Anywhere else on a value's row: show where it prints. The whole point
      // of this screen is that a value and its sentence are one click apart.
      const row = event.target.closest("[data-setting-row]");
      if (row && !event.target.closest("button, input, select, textarea, label, a")) {
        showFieldInDocument(row.dataset.settingRow);
        return;
      }
    }

    const button = event.target.closest("button");
    if (!button) return;

    if (button.id === "lease-back") {
      if(state.mode==='lease' && state.dirty.size && !window.confirm('Leave without saving these lease corrections?'))return;
      if (state.mode === "defaults" && !mayLeaveEditor(formHost, defaultsUi)) return;
      // Both ways of opening this screen from the property page leave the hash
      // already naming the property, so assigning it fires no hashchange and
      // the button does nothing at all. Ask for the route again instead: goto
      // puts this screen away and redraws the page underneath, which has to
      // happen anyway — a value saved here is a value that page is showing.
      if (returnTo && location.hash !== returnTo) location.hash = returnTo;
      else if (returnTo) window.dispatchEvent(new HashChangeEvent("hashchange"));
      else closeLeaseScreen();
      return;
    }
    if (button.id === "lease-save") return saveSettings();
    if(button.dataset.previewSigningFields){
      if(signingBusy || state.dirty.size)return;
      signingBusy=true;updateActions();
      try{
        const entry=await prepareSigningPackage(signingContext());
        if(!entry)throw new Error('This rental already has a signing request.');
        if(signingEntry!==entry || !signingFrame)await reviewSigningDocument(entry);
        const layout=SIGNING_DOCUMENTS.find(d=>d.id===signingPreviewLayout);
        const part=entry.preview.documents?.find(d=>d.layout===layout.id && (!layout.individual || d.tenantRecipientId===signingPreviewTenant));
        if(!part)throw new Error('Prepare a new signing package to preview this document.');
        showDocument(layout.document,false,false);screen.querySelector('#lease-doc-name').textContent=part.name || layout.name;
        screen.dataset.tab='doc';
        for(const chip of screen.querySelectorAll('[data-lease-tab]'))chip.classList.toggle('is-on',chip.dataset.leaseTab==='doc');
        const selected=button.dataset.previewSigningFields;
        requestAnimationFrame(()=>signingFrame?.contentWindow.postMessage({type:'signing-fields-preview',packageId:entry.preview.id,signers:entry.preview.signers,selected,layout:layout.id,document:part,values:entry.preview.values},location.origin));
      }catch(error){setStatus(error.message,'error');}finally{signingBusy=false;updateActions();}
      return;
    }
    if (button.id === "lease-draft" && !(state.mode==='lease' && state.caseRow?.workspace?.rental_flow==='automatic')) return produce("draft");
    if (button.id === "lease-final" || button.id === 'lease-draft') {
      if(state.mode==='lease' && state.caseRow?.workspace?.rental_flow==='automatic') {
        if(state.dirty.size || signingBusy)return;
        if(state.readOnly){state.tab='recipients';workspace.renderTab(formHost,state);renderSigningPanel();return;}
        signingBusy=true;updateActions();
        try {
          const ctx=signingContext();
          const entry=await prepareSigningPackage(ctx);
          if(!entry)await refreshReview();
          else if(button.id==='lease-draft')await reviewSigningDocument(entry);
          else if(await sendSigningPackage(ctx,entry))await refreshReview();
        } catch(error){setStatus(error.message,'error');}finally{signingBusy=false;renderSigningPanel();updateActions();}
        return;
      }
      return produce("final");
    }
    if(button.dataset.leaseMatch && locatedField){
      const {fieldId,index,total}=locatedField;
      showFieldInDocument(fieldId,true,(index+Number(button.dataset.leaseMatch)+total)%total);
      return;
    }
    if(button.id==='lease-all-documents'){showDocument('');if(state.tab==='documents')workspace.renderTab(formHost,state);return;}
    if(button.dataset.wsIssue){focusField(button.dataset.wsIssue);showFieldInDocument(button.dataset.wsIssue);return;}
    if(button.dataset.wsDone){button.closest('details').open=false;return;}

    if (button.dataset.leaseLocate) {
      // The value may print inside a document that is filtered out of view.
      // Showing it means showing the document it is in.
      showFieldInDocument(button.dataset.leaseLocate, true);
      return;
    }

    if (button.dataset.leaseZoom) {
      zoom = Math.min(1.5, Math.max(0.5, zoom + Number(button.dataset.leaseZoom) * 0.1));
      docHost.style.zoom = String(zoom);
      signingFrame?.contentWindow?.postMessage({type:'signing-document-zoom',packageId:signingEntry.preview.id,zoom},location.origin);
      screen.querySelector("#lease-zoom-label").textContent = `${Math.round(zoom * 100)}%`;
      return;
    }

    if (button.dataset.wsTab) {
      state.tab = button.dataset.wsTab;
      workspace.renderTab(formHost, state);
      renderSigningPanel();
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

  // Reading and filling in are the same gesture here: the field you are in is
  // the sentence you are shown.
  screen.addEventListener("focusin", (event) => {
    const input = event.target.closest("[data-lease-input]");
    if (input) showFieldInDocument(input.dataset.leaseInput);
  });
  screen.addEventListener('toggle',event=>{
    if(event.target.matches?.('details.ws-review-field') && event.target.open)showFieldInDocument(event.target.dataset.wsRow);
  },true);

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
    renderFormPane();
    renderBar();
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
