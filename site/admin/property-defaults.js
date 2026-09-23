import {syncPropertyPreview} from "./property-preview.js";
// The landlord's own values for one property, and the only editor for them.
//
// A landlord value is not a property of one apartment. It is a property of the
// building — "our returned payment fee is $25", "this one has no sprinkler
// system" — and all 125 of them are set here, at that layer. The same values
// could be typed on a single apartment's lease screen, where they land in the
// unit layer and quietly stop tracking the property; setting them once, here,
// is the difference between one answer and one answer per apartment.
//
// There used to be a layer above this one, holding the terms that are the same
// company-wide. It is gone: it let a lease assert a fine or a gas emergency
// number that no property page showed and nobody could point at. Every value a
// lease prints is now typed on the property it prints for.
//
// This file is the editor itself — the panels, the two dialogs, and the writes.
// Two screens host it: the property page, which shows it as a page, and the
// document view, which shows it beside the lease it fills in. They pass their
// own `ui` object and their own re-render, and share everything else, because
// two editors for one set of values is how two screens come to disagree about
// what a property says.

import { PROPERTY_LABELS, CHOICE_PAIRS, KEY_TYPES, GOOD_CAUSE_QUESTIONS } from "./property-form-layout.js";
import { propertySetupDefaults } from "../shared/property-setup.js";
import { formatSettingValue, isAnswered } from "../shared/lease-values.js";
import { isOptionalSection, sectionsFor } from "./property-sections.js";

// Each host owns its transport and caches. The collaboration instance can only
// write drafts; the standard instance continues to use Admin's live endpoints.
export function createPropertyDefaults(deps) {
let draftMode = false;
let api;
let setStatus;
let escapeHtml;
let isManager = () => false;
let buildingOf = () => null;
let onBuildingChanged = () => {};

function initPropertyDefaults(deps) {
  ({ api, setStatus, escapeHtml } = deps);
  isManager = deps.canEdit || deps.isManager || (() => false);
  draftMode = deps.draftMode === true;
  buildingOf = deps.buildingOf || (() => null);
  onBuildingChanged = deps.onBuildingChanged || (() => {});
}

// ------------------------------------------------------------------- data

// One layer per property, fetched once and re-read only after something writes
// to it. The lease screen writes the unit layer through the same settings
// route, which is the other moment these go stale — see forgetLayers.
const layers = new Map();

async function loadLayer(buildingId, force = false) {
  if (!layers.has(buildingId) || force) {
    const payload = await api(`/lease/settings?scope=building&building_id=${encodeURIComponent(buildingId)}`);
    layers.set(buildingId, payload.field_values || {});
  }
  return layers.get(buildingId);
}

function layerOf(buildingId) {
  return layers.get(buildingId) || {};
}

// The property row itself — its name, its address, the address its signature
// requests go to. Held by the properties screen, read through here so both
// hosts see the same row after either of them writes to it.
function propertyOf(buildingId) {
  return buildingOf(buildingId);
}

function forgetLayers() {
  layers.clear();
}

// ------------------------------------------------------------- field model

// Every manager field, in registry order. They all answer at this one layer,
// so there is nothing to filter by scope any more.
function managerFields(registry) {
  return registry.fields.filter((field) => field.source === "manager");
}

// `null` in the layer is how the database records "this property no longer
// answers that field", so it is not an answer.
function resolve(field, values) {
  const value = values?.[field.id];
  if (isAnswered(field, value)) return { value, answered: true };
  return { value: field.type === "checkbox" ? false : "", answered: false };
}

// What each host keeps for itself: which panel is open, whether the uncommon
// terms are unfolded, and which dialog is up. One panel at a time — a page with
// 125 inputs open is a page where nobody can say what they changed.
function newDefaultsUi() {
  return { editingGroup: "", activeSection: "property", signerOpen: false, addressOpen: false };
}

// ----------------------------------------------------------------- markup

function valueCell(field, resolved) {
  if (!resolved.answered) {
    return `<span class="property-field-empty${field.required ? " property-field-missing" : ""}">Not Entered</span>`;
  }
  return `<b>${escapeHtml(formatSettingValue(field, resolved.value))}</b>`;
}

// `docLinked` is the document view's: the same input, told apart so a keystroke
// can be patched into the page on screen. Nothing else about the editor moves.
function control(field, resolved, docLinked) {
  const id = `set-${field.id}`;
  const attrs = `id="${escapeHtml(id)}" data-setting="${escapeHtml(field.id)}"${
    docLinked ? ` data-lease-input="${escapeHtml(field.id)}"` : ""}`;

  if (field.type === "checkbox") {
    return `<label class="checkbox"><input type="checkbox" ${attrs}${resolved.value ? " checked" : ""}>
      <span class="hint">Marked on the lease</span></label>`;
  }

  if (field.type === "choice") {
    const options = ["", ...field.options].map((option) =>
      `<option value="${escapeHtml(option)}"${option === resolved.value ? " selected" : ""}>${
        escapeHtml(option || "— not answered —")}</option>`).join("");
    return `<select ${attrs}>${options}</select>`;
  }

  if (field.type === "multiline") {
    return `<textarea ${attrs} rows="2">${escapeHtml(resolved.value)}</textarea>`;
  }

  // Not type="date". Dates are stored the way the document writes them —
  // 10/01/2026 — and a date input can only show yyyy-mm-dd, so it rendered
  // blank over a value that was there. The document screen has always used a
  // text box for the same reason, and one format across the console is the
  // point: a date shown in a shape the lease does not use is a date somebody
  // "corrects".
  const type = field.type === "email" ? "email" : "text";
  return `<input type="${type}" ${attrs} value="${escapeHtml(resolved.value)}">`;
}

function settingRow(field, values, editing, docLinked) {
  const resolved = resolve(field, values);
  const needed = field.required && !resolved.answered;

  return `<div class="line${needed && !editing && docLinked ? " is-needed" : ""}"
    data-setting-row="${escapeHtml(field.id)}">
    <label class="lbl" for="set-${escapeHtml(field.id)}">${escapeHtml(PROPERTY_LABELS[field.id] || field.label)}${field.required?'<span class="required-mark" aria-hidden="true"></span>':''}</label>
    <div>
      ${editing ? control(field, resolved, docLinked) : valueCell(field, resolved)}
      ${field.note ? `<span class="panel-hint">${escapeHtml(field.note)}</span>` : ""}
    </div>
    ${!docLinked || editing || resolved.answered ? "" : '<span class="src src-computed">Unanswered</span>'}
  </div>`;
}

function editTools(sectionId, editing) {
  if (!isManager()) return "";
  return editing
    ? `<button type="button" data-settings-cancel>Cancel</button>
       <button type="button" class="primary" data-settings-save="${escapeHtml(sectionId)}">Save</button>`
    : `<button type="button" class="link" data-settings-edit="${escapeHtml(sectionId)}">Edit</button>`;
}

// The one panel that is not simply a list of registry fields. The signer is
// half a lease value — the printed name, which the document carries — and half
// an operational one: the address the signature request goes to, which appears
// nowhere in the lease. It is also the single thing whose absence stops an
// agent sending, so it gets its own affordance rather than being row 47 of a
// table of ninety-three.
function signingPanel(section, ctx) {
  const { ui, signerEmail, emailKnown, docLinked } = ctx;
  const values=ui.editingGroup ? propertySetupDefaults(ctx.values,signerEmail) : ctx.values;
  const signer = resolve(byId(ctx.fields, "landlord.print_name"), values);
  const editing = ui.editingGroup === section.id;
  const set = signer.answered && (Boolean(signerEmail) || !emailKnown);
  // The printed name is the dialog's to write. Everything else in the section
  // edits inline, through the same save path as every other panel.
  const inline = section.fields.filter((field) => field.id !== "landlord.print_name");

  return `<article class="panel" data-group-panel="${escapeHtml(section.id)}">
    <div class="phead">
      <div>
        <h2>${escapeHtml(section.title || section.label)}</h2>
        <p>${escapeHtml(section.note)}</p>
      </div>
      <div class="phead-tools">
        ${set ? '<span class="pill is-good">Complete</span>' : '<span class="pill is-bad">1 required</span>'}
        ${!editing || docLinked ? editTools(section.id, editing) : ""}
      </div>
    </div>
    <div class="pbody">
      <div class="lines">
        <div class="line" data-setting-row="landlord.print_name">
          <span class="lbl">Landlord signer’s name<span class="required-mark" aria-hidden="true"></span></span>
          <div>
            ${signer.answered
              ? `<b>${escapeHtml(signer.value)}</b>`
              : '<span class="property-field-missing">Not Entered</span>'}
          </div>
          ${isManager()
            ? `<button type="button" class="small${set ? "" : " primary"}" id="property-signer">${
                set ? "Change Signer" : "Set Signer"}</button>`
            : '<span class="locked">View Only</span>'}
        </div>
        <div class="line" data-setting-row="landlord_signer_email"><span class="lbl">Landlord signer’s email<span class="required-mark" aria-hidden="true"></span></span><div><b>${escapeHtml(signerEmail || "Not entered")}</b><span class="panel-hint">Receives the DocuSign invitation to sign the lease.</span></div></div>
        ${inline.map((field) => settingRow(field, values, editing, docLinked)).join("")}
      </div>
    </div>
    ${editing && !docLinked ? `<div class="property-edit-actions">${editTools(section.id, true).replace(">Cancel<", ">Discard Changes<")}<span data-edit-state role="status"></span></div>` : ""}
  </article>`;
}

function sectionPanel(section, ctx) {
  const { ui, docLinked } = ctx;
  const values=ui.editingGroup ? propertySetupDefaults(ctx.values,ctx.signerEmail) : ctx.values;
  const editing = ui.editingGroup === section.id;
  const short = section.fields.filter((field) => field.required && !resolve(field, values).answered).length;
  const optional = isOptionalSection(section);

  return `<article class="panel" data-group-panel="${escapeHtml(section.id)}">
    <div class="phead">
      <div>
        <h2>${escapeHtml(section.title || section.label)}</h2>
        <p>${escapeHtml(section.note)}</p>
      </div>
      <div class="phead-tools">
        ${optional
          ? ""
          : short > 0
            ? `<span class="pill is-bad">${short} required</span>`
            : '<span class="pill is-good">Complete</span>'}
        ${!editing || docLinked ? editTools(section.id, editing) : ""}
      </div>
    </div>
    <div class="pbody">
      ${!docLinked ? sectionContext(section.id, ctx) : ""}
      <div class="lines">
        ${sectionRows(section, values, editing, docLinked)}
      </div>
    </div>
    ${editing && !docLinked ? `<div class="property-edit-actions">${editTools(section.id, true).replace(">Cancel<", ">Discard Changes<")}<span data-edit-state role="status"></span></div>` : ""}
  </article>`;
}

function byId(fields, id) {
  return fields.find((field) => field.id === id);
}

// The editor, from the heading down. `ctx` is:
//
//   fields        every manager field, from the registry
//   values        this property's layer
//   buildingId    which property is being edited
//   ui            the host's own newDefaultsUi()
//   docLinked     true in the document view, where inputs also patch the page
//
// The host decides what surrounds it: a page with a readiness column, or the
// right half of the lease.
function pairedRow(pair, fields, values, editing) {
  const yes = values[pair.positive] === true, no = values[pair.negative] === true;
  const value = yes !== no ? (yes ? "yes" : "no") : "";
  const display = value === "yes" ? pair.yes : value === "no" ? pair.no : yes ? "Conflicting choices — select one" : "Not selected";
  return `<div class="line" data-setting-row="${pair.positive}"><label class="lbl" for="pair-${pair.positive}">${pair.label}</label><div>${editing ? `<select id="pair-${pair.positive}" data-setting-pair="${pair.positive}"><option value="" ${!value ? 'selected' : ''} disabled>Choose one…</option><option value="yes" ${value === "yes" ? 'selected' : ''}>${pair.yes}</option><option value="no" ${value === "no" ? 'selected' : ''}>${pair.no}</option></select><span class="panel-hint">Selecting one clears the other mark on the lease.</span>` : `<b>${display}</b>`}</div></div>`;
}

function sectionRows(section, values, editing, docLinked) {
  if (section.id === "keys") {
    const types = KEY_TYPES;
    const rows = types.map(([id,label]) => `<section class="property-key-item"><h3>${label}</h3><div class="property-key-pair">${["qty","charge"].map(suffix => {
      const field = section.fields.find(item => item.id === `key.${id}_${suffix}`);
      return field ? settingRow({...field,label:suffix === "qty" ? "Quantity issued" : "Replacement charge per key / FOB"},values,editing,docLinked) : "";
    }).join("")}</div></section>`).join("");
    return rows + section.fields.filter(field => field.id.endsWith("_label")).map(field => settingRow(field,values,editing,docLinked)).join("");
  }

  if (!docLinked && ["payments", "management"].includes(section.id)) {
    const groups = section.id === "payments"
      ? [["Lease Timing & Rent", f => /^(lease\.|rent\.)/.test(f.id)],
         ["Payments & Deposits", f => /^(payee\.|deposit\.)/.test(f.id)],
         ["Fees & Policies", f => !/^(lease\.|rent\.|payee\.|deposit\.)/.test(f.id)]]
      : [["Property Management", f => f.id.startsWith("manager.")],
         ["Legal Notices", f => f.id.startsWith("legal_notice.")],
         ["Emergency Contact", f => !/^(manager\.|legal_notice\.)/.test(f.id)]];
    return groups.map(([label, match]) => {
      const fields = section.fields.filter(match);
      return fields.length ? `<h3 class="property-question">${label}</h3>${sectionRows({...section, id:"group", fields}, values, editing, docLinked)}` : "";
    }).join("");
  }

  if (section.id !== "good_cause") return section.fields.map(field => {
    const pair = CHOICE_PAIRS.find(item => [item.positive,item.negative].includes(field.id) && section.fields.some(other => other.id === item.positive) && section.fields.some(other => other.id === item.negative));
    if (pair) return field.id === section.fields.find(other => [pair.positive,pair.negative].includes(other.id)).id ? pairedRow(pair, section.fields, values, editing) : "";
    return settingRow(field, values, editing, docLinked);
  }).join("");
  const questions = GOOD_CAUSE_QUESTIONS;
  return questions.map(([label, matches]) => `<h3 class="property-question">${label}</h3>${section.fields.filter(matches).map(field => settingRow(field, values, editing, docLinked)).join("")}`).join("");
}

function sectionContext(id, ctx, building) {
  if (id === "bedbug") return `<div class="property-context"><b>Date of vacancy lease</b><p>Defaults to the listing release date when preparing each lease. The infestation history below is saved for this property.</p></div>`;
  if (id === "smoking") return `<div class="property-context"><b>Complaint procedure</b><p>Property manager: ${escapeHtml(ctx.values["manager.name"] || "Not entered")} · ${escapeHtml(ctx.values["manager.phone"] || "Phone not entered")}</p><button type="button" class="link" data-property-step="management">Edit management contact →</button></div>`;
  if (id === "sprinkler") return `<div class="property-context"><b>Last Date Maintained</b><p>If a maintained system is selected and no date is entered, the listing release date is used when preparing the lease. Otherwise the date stays blank.</p></div>`;
  if (id === "dhcr") return `<div class="property-context"><b>Owner Consent Contact</b><p>New entries default to the landlord signer’s name, email and mailing address. You can enter a different consent contact.</p></div>`;
  return "";
}

function defaultsMarkup(ctx) {
  const { fields, ui, buildingId } = ctx;
  const building = buildingOf(buildingId);
  const sections = sectionsFor(fields);
  let index = sections.findIndex(section => section.id === ui.activeSection);
  if (index < 0) index = 0;
  const section = sections[index];
  ui.activeSection = section.id;
  ui.directEditing = !ctx.docLinked;
  if (ui.directEditing) ui.editingGroup = isManager() && section.id !== "property" ? section.id : "";
  ui.previewContext={fields,values:ctx.values,building,section:section.id,ids:section.id==='property'?['property.address_full','property.street','property.city','property.state','property.state_abbr','property.zip']:section.fields.map(f=>f.id)};
  const signerEmail = building?.landlord_signer_email || "";
  const emailKnown = signerEmailKnown(building);
  const inner = { ...ctx, signerEmail, emailKnown };
  let panel;
  if (section.id === "property") {
    const address = [building?.street, building?.city, building?.state_abbr, building?.zip].filter(Boolean).join(", ");
    panel = `<article class="panel"><div class="phead"><div><h2>Properties</h2><p>${section.note}</p></div>${isManager() ? '<button type="button" class="link" id="property-address">Edit address</button>' : ''}</div><div class="pbody"><div class="line"><span class="lbl">Property address</span><b>${escapeHtml(address || "No address recorded")}</b></div><p class="note">The apartment number is added from the listing when preparing a lease.</p></div></article>`;
  } else panel = (ctx.docLinked ? sectionContext(section.id, ctx, building) : "") + (section.id === "signing" ? signingPanel(section, inner) : sectionPanel(section, inner));
  return `
    <div class="property-flow-intro"><h2 class="section-title">Lease Information</h2><p class="note">Follow the lease from property details through its riders. ${isManager() ? "Save each section as you go." : draftMode ? "Submitted draft · awaiting Admin review." : "View only · Admin maintains property values."}</p></div>
    <div class="property-flow${ctx.docLinked ? " is-document" : ""}">
      <nav class="property-steps" aria-label="Lease Information Sections">
        ${sections.map((item, n) => {
          const missing = item.fields.filter(field => field.required && !resolve(field, ctx.values).answered).length;
          return `<button type="button" data-property-step="${item.id}" ${item.id === section.id ? 'aria-current="step"' : ''}><span class="property-step-number">${String(n + 1).padStart(2, "0")}</span><span>${escapeHtml(item.label)}</span>${missing ? `<span class="property-step-missing" aria-label="${missing} required values missing">${missing}</span>` : ''}</button>`;
        }).join("")}
      </nav>
      <div class="property-step-content"><div class="property-step-position" tabindex="-1">Step ${index + 1} of ${sections.length}<span>${ui.editingGroup ? "Editing · changes not saved" : "Property lease information"}</span></div>
        ${ctx.docLinked ? panel : `<div class="property-edit-preview"><div class="property-edit-pane">${panel}</div><iframe data-property-preview title="Property Lease Preview" src="./property-preview.html"></iframe></div>`}
        <div class="property-step-footer"><button type="button" data-property-step="${sections[index - 1]?.id || ''}" ${index === 0 ? "disabled" : ""}>← Previous</button><span>${index + 1} / ${sections.length}</span>${index < sections.length - 1 ? `<button type="button" data-property-step="${sections[index + 1].id}">Next: ${escapeHtml(sections[index + 1].label)} →</button>` : '<span class="soft">End of lease information</span>'}</div>
      </div>
    </div>
    ${ui.signerOpen ? signerDialog(resolve(byId(fields, "landlord.print_name"), ctx.values), signerEmail, emailKnown) : ""}
    ${ui.addressOpen ? addressDialog(building) : ""}`;
}

// PostgREST leaves a column it does not have out of the row entirely, which is
// how the screen tells "nobody has set a signature address" apart from "this
// database cannot record one". The difference matters: blocking every property
// on a value a manager has no way to supply would stop every agent sending,
// and the fix is a migration, not a click.
function signerEmailKnown(building) {
  return Boolean(building) && Object.prototype.hasOwnProperty.call(building, "landlord_signer_email");
}

function signerDialog(signer, signerEmail, emailKnown) {
  return `<div class="sheet" data-signer-sheet>
    <div class="sheet-box" role="dialog" aria-modal="true" aria-labelledby="signer-title">
      <div class="sheet-head">
        <h2 id="signer-title">Set Landlord Signer</h2>
        <button type="button" class="small" data-signer-close aria-label="Close">Close</button>
      </div>
      <div class="sheet-body">
        <label for="signer-name">Signer Name</label>
        <input type="text" required id="signer-name" value="${escapeHtml(signer.value || "")}"
               placeholder="The name printed above the signature line">
        <label for="signer-email" style="margin-top:12px">Signer Email</label>
        <input type="email" required id="signer-email" value="${escapeHtml(signerEmail)}"
               placeholder="name@example.com"${emailKnown ? "" : " disabled"}>
        ${emailKnown ? "" : `<p class="note" style="color:var(--warn)">This database cannot store a
          signature address yet. Run supabase/schema.sql on it and the field opens.</p>`}
        <p class="note">The name appears on the lease. The email receives the DocuSign signing invitation.</p>
        <p class="note">${draftMode ? "Changes are saved to your draft and require Admin approval." : "Saving updates the property's landlord signer for future lease preparation."}</p>
      </div>
      <div class="sheet-foot">
        <button type="button" data-signer-close>Cancel</button>
        <button type="button" class="primary" id="signer-save">Save Signer</button>
      </div>
    </div>
  </div>`;
}

// The premises address, on the building row. Every lease for the property
// prints it, and while it is blank each unit's lease falls back to whatever
// its listing's location text says — which is why setting it is the point of
// linking listings to a property at all.
function addressDialog(building) {
  const field = (id, label, value, hint = "") => `
    <label for="${id}"${id === "address-street" ? "" : ' style="margin-top:12px"'}>${label}</label>
    <input type="text" id="${id}" value="${escapeHtml(value || "")}"${hint ? ` placeholder="${escapeHtml(hint)}"` : ""}>`;

  return `<div class="sheet" data-address-sheet>
    <div class="sheet-box" role="dialog" aria-modal="true" aria-labelledby="address-title">
      <div class="sheet-head">
        <h2 id="address-title">Property address</h2>
        <button type="button" class="small" data-address-close aria-label="Close">Close</button>
      </div>
      <div class="sheet-body">
        ${field("address-street", "Street", building.street, "81-07 Kew Gardens Road")}
        ${field("address-city", "City", building.city, "Kew Gardens")}
        ${field("address-state", "State, spelled out", building.state, "New York")}
        ${field("address-abbr", "State, abbreviated", building.state_abbr || "NY")}
        ${field("address-zip", "ZIP", building.zip, "11415")}
        <p class="note">Printed on every lease for this property. Until it is set, each lease
           reads the address off its listing instead.</p>
      </div>
      <div class="sheet-foot">
        <button type="button" data-address-close>Cancel</button>
        <button type="button" class="primary" id="address-save">Save address</button>
      </div>
    </div>
  </div>`;
}

// --------------------------------------------------------------- behaviour

// An editor left open holds typing nobody has saved. Leaving it by clicking a
// tab or the back button is easy to do by accident, so it asks — once, and
// only when something is actually open.
function mayLeaveEditor(host, ui) {
  if (!ui.editingGroup || (ui.directEditing && !ui.dirty)) return true;
  if (!host.querySelector(`[data-group-panel="${CSS.escape(ui.editingGroup)}"]`)) return true;
  return confirm("Leave without saving the values you changed?");
}

async function movePropertyStep(ctx, target) {
  const {host,ui,rerender} = ctx;
  if (!target || !sectionsFor(ctx.fields).some(section=>section.id===target)) return;
  if (target === ui.activeSection) { syncDefaultsNavigation(host, ui); return; }
  if (ui.editingGroup && (!ui.directEditing || ui.dirty)) {
    if (!ui.directEditing) {
      setStatus("Save or cancel this section before moving to another step.", "error");
      return;
    }
    const choice = await confirmSectionChange(host);
    if (choice === "stay") return;
    if (choice === "save" && !await saveGroup(ctx, ui.editingGroup)) return;
  }
  ui.dirty = false; ui.inputDraft = null; ui.saved = false;
  ui.activeSection = target;
  setStatus("");
  await rerender();
  host.querySelector(".property-step-position")?.focus({preventScroll:true});
}

// Keep the selected horizontal step at the leading edge without scrolling the page.
function rememberDefaultsNavigation(host, ui) {
  const nav = host.querySelector(".property-steps");
  if (nav) ui.navigationScroll = {left:nav.scrollLeft, top:nav.scrollTop};
}
function confirmSectionChange(host) {
  return new Promise(resolve => {
    const sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.innerHTML = `<div class="sheet-box" role="dialog" aria-modal="true" aria-labelledby="unsaved-title"><div class="sheet-head"><h2 id="unsaved-title">Unsaved Changes</h2></div><div class="sheet-body">Save your changes before moving to another section?</div><div class="sheet-foot"><button data-choice="stay">Continue Editing</button><button data-choice="discard">Discard Changes</button><button class="primary" data-choice="save">Save & Continue</button></div></div>`;
    const finish = choice => { sheet.remove(); resolve(choice); };
    sheet.addEventListener("click", event => { const button=event.target.closest("[data-choice]"); if(button) finish(button.dataset.choice); });
    sheet.addEventListener("keydown", event => { if(event.key === "Escape") finish("stay"); });
    host.append(sheet); sheet.querySelector("button").focus();
  });
}
const editBindings = new WeakMap();
function syncDirectEditing(host, ui) {
  if (!ui.directEditing) return;
  const inputs = [...host.querySelectorAll("[data-setting], [data-setting-pair]")];
  const key = el => el.dataset.setting || el.dataset.settingPair;
  const read = el => el.type === "checkbox" ? el.checked : el.value;
  const baseline = Object.fromEntries(inputs.map(el => [key(el), read(el)]));
  ui.inputBaseline = baseline;
  if (ui.inputDraft) for (const el of inputs) {
    if (Object.hasOwn(ui.inputDraft, key(el))) {
      if(el.type === "checkbox") el.checked=ui.inputDraft[key(el)]; else el.value=ui.inputDraft[key(el)];
    }
  }
  const update = () => {
    const current=Object.fromEntries(inputs.map(el=>[key(el),read(el)]));
    ui.dirty=inputs.some(el=>read(el)!==baseline[key(el)]);
    ui.inputDraft=ui.dirty ? current : null;
    host.querySelectorAll("[data-settings-save], [data-settings-cancel]").forEach(el=>el.disabled=!ui.dirty);
    const state=host.querySelector("[data-edit-state]");
    if(state) state.textContent=ui.dirty ? "Unsaved Changes" : ui.saved ? "Saved" : "";
    const position=host.querySelector(".property-step-position > span");
    if(position) position.textContent=ui.dirty ? "Unsaved Changes" : "Property lease information";
  };
  const old=editBindings.get(host);
  if(old) {host.removeEventListener("input",old);host.removeEventListener("change",old);}
  host.addEventListener("input",update);host.addEventListener("change",update);editBindings.set(host,update);
  update();
}
function syncDefaultsNavigation(host, ui) {
  syncDirectEditing(host,ui);
  syncPropertyPreview(host,ui);
  const nav = host.querySelector(".property-steps");
  const active = nav?.querySelector('[aria-current="step"]');
  if (!active) return;
  nav.scrollLeft = ui.navigationScroll?.left || 0;
  nav.scrollTop = ui.navigationScroll?.top || 0;
  const box = nav.getBoundingClientRect(), item = active.getBoundingClientRect(), padding = 12;
  if (nav.scrollWidth > nav.clientWidth) {
    const inset = nav.clientLeft + parseFloat(getComputedStyle(nav).paddingLeft || "0");
    nav.scrollLeft += item.left - box.left - inset;
  }
  if (nav.scrollHeight > nav.clientHeight) {
    if (item.top < box.top + padding) nav.scrollTop += item.top - box.top - padding;
    else if (item.bottom > box.bottom - padding) nav.scrollTop += item.bottom - box.bottom + padding;
  }
  rememberDefaultsNavigation(host, ui);
}

// Every click the editor owns. `ctx` carries the host's container, the id of
// the property being edited, every manager field, its `ui`, and:
//
//   rerender()   redraw the host, however it draws itself
//   onSaved()    optional — a write landed, so anything downstream of these
//                values (a document on screen) is now out of date
//
// Returns true when it handled the event, so a host can go on to its own.
async function handleDefaultsClick(event, ctx) {
  const { host, ui, rerender } = ctx;

  const step = event.target.closest("[data-property-step]");
  if (step) {
    const fromFooter = !!step.closest(".property-step-footer"), previous = ui.activeSection;
    await movePropertyStep(ctx, step.dataset.propertyStep);
    if (fromFooter && previous !== ui.activeSection) host.querySelector(".property-flow-intro")?.scrollIntoView({block:"start", behavior:"instant"});
    return true;
  }

  const edit = event.target.closest("[data-settings-edit]");
  if (edit) {
    ui.editingGroup = edit.dataset.settingsEdit;
    setStatus("");
    await rerender();
    return true;
  }

  if (event.target.closest("[data-settings-cancel]")) {
    ui.editingGroup = "";
    ui.dirty=false; ui.inputDraft=null; ui.saved=false;
    setStatus("");
    await rerender();
    return true;
  }

  const save = event.target.closest("[data-settings-save]");
  if (save) {
    await saveGroup(ctx, save.dataset.settingsSave);
    return true;
  }

  if (event.target.closest("#property-signer")) {
    ui.signerOpen = true;
    await rerender();
    host.querySelector("#signer-name")?.focus();
    return true;
  }

  if (event.target.closest("#property-address")) {
    ui.addressOpen = true;
    await rerender();
    host.querySelector("#address-street")?.focus();
    return true;
  }

  if (event.target.closest("[data-address-close]") || event.target.matches("[data-address-sheet]")) {
    ui.addressOpen = false;
    await rerender();
    return true;
  }

  if (event.target.closest("#address-save")) {
    await saveAddress(ctx);
    return true;
  }

  if (event.target.closest("[data-signer-close]") || event.target.matches("[data-signer-sheet]")) {
    ui.signerOpen = false;
    await rerender();
    return true;
  }

  if (event.target.closest("#signer-save")) {
    await saveSigner(ctx);
    return true;
  }

  return false;
}

// ------------------------------------------------------------------ writes

// The Worker refuses every one of these for an agent; the screens never show
// them the buttons in the first place.

async function saveGroup(ctx, group) {
  const { host, buildingId, ui, rerender, onSaved = () => {} } = ctx;
  const values = layerOf(buildingId);
  const panel = host.querySelector(`[data-group-panel="${CSS.escape(group)}"]`);
  if (!panel) return;

  // Only what actually changed, so a save writes what a person typed and
  // nothing else.
  const patch = {};
  for (const input of panel.querySelectorAll("[data-setting]")) {
    const field = byId(ctx.fields, input.dataset.setting);
    if (!field) continue;
    if (ui.directEditing && ui.inputBaseline && Object.hasOwn(ui.inputBaseline, field.id) && ui.inputBaseline[field.id] === (input.type === "checkbox" ? input.checked : input.value)) continue;
    const resolved = resolve(field, values);
    const before = resolved.answered ? resolved.value : undefined;

    if (field.type === "checkbox") {
      if (input.checked !== Boolean(before)) patch[field.id] = input.checked;
      continue;
    }

    const value = input.value.trim();
    // An emptied box means "this property no longer answers it"; the Worker
    // stores that as the key being absent, so it only needs sending if it was
    // set here.
    if (value === "" && before === undefined) continue;
    if (value === before) continue;
    patch[field.id] = value;
  }

  for (const input of panel.querySelectorAll("[data-setting-pair]")) {
    if (ui.directEditing && ui.inputBaseline && ui.inputBaseline[input.dataset.settingPair] === input.value) continue;
    const pair = CHOICE_PAIRS.find(item => item.positive === input.dataset.settingPair);
    if (!pair || !["yes", "no"].includes(input.value)) continue;
    for (const [id, value] of [[pair.positive,input.value === "yes"],[pair.negative,input.value === "no"]]) {
      if (values[id] !== value) patch[id] = value;
    }
  }

  if (Object.keys(patch).length === 0) {
    ui.editingGroup = "";
    await rerender();
    setStatus("Nothing changed.");
    return true;
  }

  setStatus("Saving…");
  try {
    await api("/lease/settings", {
      method: "PUT",
      body: JSON.stringify({ scope: "building", building_id: buildingId, field_values: patch })
    });

    ui.editingGroup = "";
    ui.dirty=false; ui.inputDraft=null; ui.saved=true;
    await loadLayer(buildingId, true);

    const count = Object.keys(patch).length;
    await rerender();
    await onSaved();
    setStatus(draftMode ? `Saved ${count} value${count === 1 ? "" : "s"} to the draft. Admin approval is required.` : `Saved ${count} value${count === 1 ? "" : "s"} to this property.`);
    return true;
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function saveAddress(ctx) {
  const { host, buildingId, ui, rerender, onSaved = () => {} } = ctx;
  const read = (id) => host.querySelector(id)?.value.trim() || "";
  const values = {
    street: read("#address-street"),
    city: read("#address-city"),
    state: read("#address-state"),
    state_abbr: read("#address-abbr"),
    zip: read("#address-zip")
  };

  if (!values.street || !values.city || !values.zip) {
    setStatus("A lease address needs at least the street, the city and the ZIP.", "error");
    return;
  }

  setStatus("Saving the address…");
  try {
    const { building } = await api(`/buildings/${encodeURIComponent(buildingId)}`, {
      method: "PATCH",
      body: JSON.stringify(values)
    });
    if (building) onBuildingChanged(building);

    ui.addressOpen = false;
    await rerender();
    await onSaved();
    setStatus(draftMode ? "Address saved to draft. Admin approval is required." : "Address saved. Every lease for this property prints it.");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

// Two writes, because the signer is two things stored in two places for a
// reason: the printed name is a lease value and lives in the settings layer
// with the other 124; the address the request goes to is not in the document
// at all and lives on the property row.
async function saveSigner(ctx) {
  const { host, buildingId, ui, rerender, onSaved = () => {} } = ctx;
  const name = host.querySelector("#signer-name")?.value.trim() || "";
  const email = host.querySelector("#signer-email")?.value.trim() || "";

  if (!name) {
    setStatus("The signer needs the name that is printed above the signature line.", "error");
    return;
  }
  if (!host.querySelector("#signer-email")?.disabled && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    setStatus("That signature address does not look like an email address.", "error");
    return;
  }

  // Two writes, or one on a database that has no column for the second. The
  // name is the half the document prints, so it is saved either way.
  const canStoreEmail = !host.querySelector("#signer-email")?.disabled;

  setStatus("Saving the signer…");
  try {
    await api("/lease/settings", {
      method: "PUT",
      body: JSON.stringify({
        scope: "building",
        building_id: buildingId,
        field_values: { "landlord.print_name": name }
      })
    });
    const { building } = canStoreEmail
      ? await api(`/buildings/${encodeURIComponent(buildingId)}`, {
        method: "PATCH",
        body: JSON.stringify({ landlord_signer_email: email })
      })
      : { building: null };

    // Both caches: the layer holds the name, the building row holds the address.
    await loadLayer(buildingId, true);
    if (building) onBuildingChanged(building);

    ui.signerOpen = false;
    await rerender();
    await onSaved();
    setStatus(draftMode ? "Signer saved to draft. Admin approval is required." : !canStoreEmail
      ? `Signer set to ${name}. This database cannot record a signature address yet.`
      : email
        ? `Signer set. ${name} will receive every landlord signature request for this property.`
        : "Signer name saved. Add a signature address before agents can send leases.");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

if(deps) initPropertyDefaults(deps);
return {initPropertyDefaults, loadLayer, layerOf, propertyOf, forgetLayers, managerFields, resolve, newDefaultsUi, defaultsMarkup, signerEmailKnown, mayLeaveEditor, rememberDefaultsNavigation, syncDefaultsNavigation, handleDefaultsClick};
}

const standardEditor = createPropertyDefaults();
export const initPropertyDefaults = (...args) => standardEditor.initPropertyDefaults(...args);
export const loadLayer = (...args) => standardEditor.loadLayer(...args);
export const layerOf = (...args) => standardEditor.layerOf(...args);
export const propertyOf = (...args) => standardEditor.propertyOf(...args);
export const forgetLayers = (...args) => standardEditor.forgetLayers(...args);
export const managerFields = (...args) => standardEditor.managerFields(...args);
export const resolve = (...args) => standardEditor.resolve(...args);
export const newDefaultsUi = (...args) => standardEditor.newDefaultsUi(...args);
export const defaultsMarkup = (...args) => standardEditor.defaultsMarkup(...args);
export const signerEmailKnown = (...args) => standardEditor.signerEmailKnown(...args);
export const mayLeaveEditor = (...args) => standardEditor.mayLeaveEditor(...args);
export const rememberDefaultsNavigation = (...args) => standardEditor.rememberDefaultsNavigation(...args);
export const syncDefaultsNavigation = (...args) => standardEditor.syncDefaultsNavigation(...args);
export const handleDefaultsClick = (...args) => standardEditor.handleDefaultsClick(...args);
