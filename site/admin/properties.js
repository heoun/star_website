// Property-level lease configuration.
//
// A landlord value is not a property of one apartment. It is a property of the
// company ("our returned payment fee is $25") or of the building ("this one has
// no sprinkler system"), and the registry says which of the two every one of
// them is: 32 carry scope "company", 93 carry scope "building". This screen is
// where each is set, at the layer it belongs to.
//
// That matters because the same values could always be typed on a single
// apartment's lease screen, where they land in the unit layer and quietly stop
// tracking the building. Setting a building disclosure once, here, is the
// difference between one answer and one answer per apartment.
//
// Nothing on this screen writes a per-lease value, and nothing on the lease
// screen writes a building layer. One value, one place it is written.

import { DOCUMENTS } from "../shared/lease-documents.js";
import { formatSettingValue, isAnswered } from "../shared/lease-values.js";
import { isOptionalSection, readiness, sectionsFor } from "./property-sections.js";

let api;
let setStatus;
let escapeHtml;
let isManager = () => false;
let listingsOf = () => [];
let openDocument = () => {};

let registry = null;
let buildings = [];

// The company layer is read by every building page, so it is fetched once and
// re-read only after something writes to it.
let companyLayer = null;
const buildingLayers = new Map();

export function initProperties(deps) {
  ({ api, setStatus, escapeHtml } = deps);
  isManager = deps.isManager || (() => false);
  listingsOf = deps.listings;
  openDocument = deps.openDocument || (() => {});
}

// ------------------------------------------------------------------- data

async function loadRegistry() {
  if (!registry) ({ registry } = await api("/lease/fields"));
  return registry;
}

async function loadBuildings(force) {
  if (!buildings.length || force) ({ buildings } = await api("/buildings"));
  return buildings;
}

async function loadCompanyLayer(force) {
  if (!companyLayer || force) {
    const payload = await api("/lease/settings?scope=company");
    companyLayer = payload.field_values || {};
  }
  return companyLayer;
}

async function loadBuildingLayer(buildingId, force) {
  if (!buildingLayers.has(buildingId) || force) {
    const payload = await api(`/lease/settings?scope=building&building_id=${encodeURIComponent(buildingId)}`);
    buildingLayers.set(buildingId, payload.field_values || {});
  }
  return buildingLayers.get(buildingId);
}

// Settings may also have been written from the lease screen, which edits the
// unit layer but shares the same cache-invalidating moment.
export function forgetLayers() {
  companyLayer = null;
  buildingLayers.clear();
}

// ------------------------------------------------------------- field model

function fieldsForScope(scope) {
  return registry.fields.filter((field) => field.source === "manager" && field.scope === scope);
}

// Which layer answered, and with what. `null` in a layer is how the database
// records "this layer no longer answers that field", so it is not an answer.
function resolve(field, layers) {
  for (const [name, values] of layers) {
    const value = values?.[field.id];
    if (isAnswered(field, value)) return { value, layer: name };
  }
  return { value: field.type === "checkbox" ? false : "", layer: "" };
}

// ----------------------------------------------------------------- markup

function valueCell(field, resolved) {
  if (!resolved.layer) {
    return `<span class="empty${field.required ? " is-needed" : ""}">${
      field.required ? "Needed — no answer in any layer" : "Not answered"}</span>`;
  }
  return `<b>${escapeHtml(formatSettingValue(field, resolved.value))}</b>`;
}

// Only when it is worth saying. A value set on this layer is the ordinary
// case, and marking ninety-three rows "Set here" is ninety-three chips that
// carry no information — the noise this screen exists to remove. What a reader
// needs flagged is the exception: an answer that came from somewhere else, or
// no answer at all.
function provenanceChip(resolved, here) {
  if (!resolved.layer) return '<span class="src src-computed">Unanswered</span>';
  if (resolved.layer === here) return "";
  return `<span class="src src-computed">From ${escapeHtml(resolved.layer)}</span>`;
}

function control(field, resolved) {
  const id = `set-${field.id}`;
  const attrs = `id="${escapeHtml(id)}" data-setting="${escapeHtml(field.id)}"`;

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

function settingRow(field, layers, here, editing) {
  const resolved = resolve(field, layers);
  const needed = field.required && !resolved.layer;

  return `<div class="line${needed && !editing ? " is-needed" : ""}" data-setting-row="${escapeHtml(field.id)}">
    <span class="lbl">${escapeHtml(field.label)}</span>
    <div>
      ${editing ? control(field, resolved) : valueCell(field, resolved)}
      ${field.note ? `<span class="panel-hint">${escapeHtml(field.note)}</span>` : ""}
      ${editing && resolved.layer && resolved.layer !== here
        ? `<span class="panel-hint">Inherited from ${escapeHtml(resolved.layer)} settings. Typing here overrides it for this building only.</span>`
        : ""}
    </div>
    ${editing ? "" : provenanceChip(resolved, here)}
  </div>`;
}

// ------------------------------------------------------------------ list

// What a manager needs to see about a property before opening it: who the
// landlord is, who signs, and whether an agent can send a lease for it today.
// Not a count of blanks — 27 unanswered values with no priority between them
// tells nobody what to do next.
export async function renderPropertyList(host) {
  host.innerHTML = '<p class="status">Loading properties…</p>';

  try {
    await loadRegistry();
    const [rows] = await Promise.all([loadBuildings(true), loadCompanyLayer()]);

    // One request per building. The layer is small and buildings are few; if
    // that ever stops being true this is the loop to replace with one call.
    const layers = await Promise.all(rows.map((building) => loadBuildingLayer(building.id)));

    const buildingFields = fieldsForScope("building");
    const companyReady = readinessFor({ fields: fieldsForScope("company"),
      layers: [["company", companyLayer]], signerApplies: false });

    const units = new Map();
    for (const listing of listingsOf()) {
      if (!listing.building_id) continue;
      units.set(listing.building_id, (units.get(listing.building_id) || 0) + 1);
    }
    const unlinked = listingsOf().filter((listing) => !listing.building_id).length;

    const rowsMarkup = rows.map((building, index) => {
      const scoped = [["building", layers[index]], ["company", companyLayer]];
      const ready = readinessFor({ fields: buildingFields, layers: scoped, building });
      const entity = resolve(byId("landlord.entity_name"), scoped);
      const signer = resolve(byId("landlord.print_name"), scoped);
      const count = units.get(building.id) || 0;

      return `<a class="prop-row" href="#/properties/${escapeHtml(building.id)}">
        <span>
          <b>${escapeHtml(building.name)}</b>
          <small>${escapeHtml([building.street, building.city, building.state_abbr, building.zip]
            .filter(Boolean).join(", ")) || "No address recorded"}</small>
        </span>
        <span class="num">${count}</span>
        <span>${entity.layer ? escapeHtml(entity.value) : '<span class="soft">Not set</span>'}</span>
        <span>${signer.layer
          ? escapeHtml(signer.value)
          : '<span class="prop-need">Not set</span>'}</span>
        <span><span class="pill is-${ready.state === "ready" ? "good" : ready.state === "one" ? "warn" : "bad"}">${
          escapeHtml(ready.label)}</span></span>
        <span class="prop-go">Manage →</span>
      </a>`;
    }).join("");

    host.innerHTML = `
      <div class="pagehead">
        <div>
          <span class="k">Configuration</span>
          <h1>Properties</h1>
          <p>The landlord's own terms, set once per property. Every lease an agent produces for
             an apartment reads them.</p>
        </div>
        <div class="actions">
          <a href="#/properties/company"><button type="button">Company defaults</button></a>
        </div>
      </div>

      ${companyReady.state !== "ready" ? `<p class="status" data-tone="error">${
        escapeHtml(companyReady.detail)} They apply to every property —
        <a href="#/properties/company">open company defaults</a>.</p>` : ""}

      ${rows.length === 0
        ? `<div class="empty">
             <h2>No properties yet</h2>
             <p>A property is what lets several apartments share one set of landlord terms.
                Add one from any listing's Property field, then set its address here.</p>
           </div>`
        : `<div class="rows">
             <div class="prop-row is-head">
               <span>Property</span><span>Apartments</span><span>Landlord entity</span>
               <span>Landlord signer</span><span>Lease readiness</span><span></span>
             </div>
             ${rowsMarkup}
           </div>`}

      ${unlinked > 0
        ? `<p class="note">${unlinked} apartment${unlinked === 1 ? " is" : "s are"} under no
             property, so ${unlinked === 1 ? "its lease reads" : "their leases read"} the company
             defaults and the address off the listing itself. Put
             ${unlinked === 1 ? "it" : "them"} under one in the listing's Property field.</p>`
        : ""}`;

    setStatus("");
  } catch (error) {
    host.innerHTML = "";
    setStatus(error.message, "error");
  }
}

// -------------------------------------------------------------- one property

// Which panel is open for editing. One at a time: a page with 93 inputs open
// is a page where nobody can say what they changed.
let editingGroup = "";
let currentTarget = "";
let currentTab = "defaults";
// The uncommon terms stay folded away until somebody asks for them. A blank
// one never blocks a lease, so it never earns space above the fold.
let showOptional = false;
let signerOpen = false;
let addressOpen = false;

// `keepStatus` is for the one caller that has something to say afterwards: a
// save re-renders the page and then reports what it wrote, and clearing the
// line on the way out would wipe the report before anyone read it.
export async function renderProperty(host, target, { keepStatus = false } = {}) {
  if (target !== currentTarget) {
    currentTarget = target;
    currentTab = "defaults";
    editingGroup = "";
    showOptional = false;
    signerOpen = false;
    addressOpen = false;
  }

  host.innerHTML = '<p class="status">Loading…</p>';

  try {
    await loadRegistry();
    await loadBuildings();
    await loadCompanyLayer();

    const company = target === "company";
    const building = company ? null : buildings.find((row) => row.id === target);
    if (!company && !building) {
      host.innerHTML = `<p class="status" data-tone="error">That property no longer exists.
        <a href="#/properties">Back to properties</a>.</p>`;
      return;
    }

    if (!company) await loadBuildingLayer(target);

    const here = company ? "company" : "building";
    const layers = company
      ? [["company", companyLayer]]
      : [["building", buildingLayers.get(target)], ["company", companyLayer]];
    const fields = fieldsForScope(here);

    host.innerHTML = renderPropertyShell({ company, building, fields, layers, here, target });
    if (!keepStatus) setStatus("");
  } catch (error) {
    host.innerHTML = "";
    setStatus(error.message, "error");
  }
}

function byId(id) {
  return registry.fields.find((field) => field.id === id);
}

// The screens ask this file for readiness so the list and the page cannot
// disagree about whether a property is ready.
// PostgREST leaves a column it does not have out of the row entirely, which is
// how the screen tells "nobody has set a signature address" apart from "this
// database cannot record one". The difference matters: blocking every property
// on a value a manager has no way to supply would stop every agent sending,
// and the fix is a migration, not a click.
function signerEmailKnown(building) {
  return Boolean(building) && Object.prototype.hasOwnProperty.call(building, "landlord_signer_email");
}

function readinessFor({ fields, layers, building = null, signerApplies = true }) {
  return readiness({
    fields,
    answered: (field) => Boolean(resolve(field, layers).layer),
    hasSigner: signerEmailKnown(building) ? Boolean(building.landlord_signer_email) : true,
    signerApplies
  });
}

function renderPropertyShell({ company, building, fields, layers, here, target }) {
  const name = company ? "Company defaults" : building.name;
  const address = company
    ? "Applies to every property and every apartment."
    : [building.street, building.city, building.state, building.zip].filter(Boolean).join(", ")
      || "No address recorded";

  const units = company ? [] : listingsOf().filter((listing) => listing.building_id === target);
  const ready = readinessFor({ fields, layers, building, signerApplies: !company });
  const entity = resolve(byId("landlord.entity_name"), layers);
  const signer = resolve(byId("landlord.print_name"), layers);
  const signerEmail = building?.landlord_signer_email || "";
  const emailKnown = signerEmailKnown(building);

  const tabs = [
    ["defaults", company ? "Company defaults" : "Property defaults"],
    ["setup", "Lease setup"],
    ["preview", "Document preview"]
  ];

  return `
    <button type="button" class="link back" data-property-back>← All properties</button>

    <div class="pagehead">
      <div>
        <span class="k">${company ? "Company-wide configuration" : "Property configuration"}</span>
        <h1>${escapeHtml(name)}</h1>
        <p>${escapeHtml(address)}${company ? "" : ` · ${units.length} apartment${units.length === 1 ? "" : "s"}`}</p>
      </div>
      <div class="actions">
        ${company || !isManager() ? "" :
          `<button type="button" id="property-address">${
            building.street ? "Edit address" : "Set address"}</button>`}
        ${company || units.length === 0 ? "" :
          '<button type="button" id="property-test-lease">Generate test lease</button>'}
      </div>
    </div>

    <section class="statbar is-wide">
      <div class="stat is-lead">
        <span class="dot${ready.state === "ready" ? "" : ready.state === "one" ? " is-warn" : " is-bad"}"></span>
        <div>
          <b>${escapeHtml(ready.label)}</b>
          <small>${escapeHtml(ready.detail)}</small>
        </div>
      </div>
      <div class="stat">
        <span class="k">Landlord entity</span>
        <b>${entity.layer ? escapeHtml(entity.value) : '<span class="soft">Not set</span>'}</b>
      </div>
      <div class="stat">
        <span class="k">Landlord signer</span>
        ${company
          ? '<b class="soft">Set per property</b>'
          : `<b${signer.layer && (signerEmail || !emailKnown) ? "" : ' class="prop-need"'}>${
              signer.layer ? escapeHtml(signer.value) : "Not set"}</b>
             <small>${signerEmail ? escapeHtml(signerEmail)
               : emailKnown ? "No signature address"
                 : "Signature address not recorded on this database"}</small>`}
      </div>
      <div class="stat">
        <span class="k">${company ? "Properties" : "Apartment coverage"}</span>
        <b>${company ? buildings.length : `${units.length} of ${units.length}`}</b>
      </div>
    </section>

    <div class="tabs" role="tablist">
      ${tabs.map(([id, label]) =>
        `<button type="button" class="tab" role="tab" data-property-tab="${id}"
                 aria-selected="${currentTab === id}">${label}</button>`).join("")}
    </div>

    ${currentTab === "defaults" ? defaultsTab({ fields, layers, here, ready, building, signer, signerEmail, emailKnown, company }) : ""}
    ${currentTab === "setup" ? setupTab() : ""}
    ${currentTab === "preview" ? previewTab(company, units, target) : ""}

    ${signerOpen ? signerDialog(signer, signerEmail, emailKnown) : ""}
    ${addressOpen ? addressDialog(building) : ""}`;
}

// ------------------------------------------------------------ tab: defaults

function defaultsTab({ fields, layers, here, ready, building, signer, signerEmail, emailKnown, company }) {
  const sections = sectionsFor(fields);
  const visible = sections.filter((section) => !isOptionalSection(section));
  const optional = sections.filter((section) => isOptionalSection(section));
  const optionalCount = optional.reduce((total, section) => total + section.fields.length, 0);

  return `
    ${isManager()
      ? ""
      : `<p class="status">These are a manager's to set. You can read every one of them, and
           they are what a lease you produce will print.</p>`}

    <div class="toolbar">
      <div>
        <h2 class="section-title">Defaults used on every lease</h2>
        <p class="note" style="margin:2px 0 0">Agents can see these values. Only a manager can change them.</p>
      </div>
      ${optionalCount > 0
        ? `<button type="button" class="small" id="property-optional">${
            showOptional ? "Hide" : "Show"} ${optionalCount} optional field${optionalCount === 1 ? "" : "s"}</button>`
        : ""}
    </div>

    <div class="prop-cols">
      <div>
        ${visible.map((section) => (section.id === "signing" && !company
          ? signingPanel(section, signer, signerEmail, emailKnown, layers, here)
          : sectionPanel(section, layers, here))).join("")}
        ${showOptional ? optional.map((section) => sectionPanel(section, layers, here)).join("") : ""}
      </div>
      <aside>
        <article class="panel decide">
          <div class="decide-head">
            <h2>Lease readiness</h2>
            <p>Only what genuinely stops a lease from being sent.</p>
          </div>
          <div class="decide-body">
            <div class="checklist">
              ${ready.checks.map((check) => `<div class="check${check.complete ? "" : " is-short"}">
                <span class="check-mark">${check.complete ? "✓" : "!"}</span>
                <div>
                  <b>${escapeHtml(check.label)}</b>
                  <span>${check.complete ? "Complete"
                    : check.missing === 1 ? "1 value needed" : `${check.missing} values needed`}</span>
                </div>
              </div>`).join("")}
            </div>
            <p class="note">Agents do not submit each lease for approval. Once these are complete
               they create and send leases on their own.</p>
          </div>
        </article>
      </aside>
    </div>`;
}

// The one panel that is not simply a list of registry fields. The signer is
// half a lease value — the printed name, which the document carries — and half
// an operational one: the address the signature request goes to, which appears
// nowhere in the lease. It is also the single thing whose absence stops an
// agent sending, so it gets its own affordance rather than being row 47 of a
// table of ninety-three.
function signingPanel(section, signer, signerEmail, emailKnown, layers, here) {
  const editing = editingGroup === section.id;
  const set = Boolean(signer.layer) && (Boolean(signerEmail) || !emailKnown);
  // The printed name is the dialog's to write. Everything else in the section
  // edits inline, through the same save path as every other panel.
  const inline = section.fields.filter((field) => field.id !== "landlord.print_name");

  return `<article class="panel" data-group-panel="${escapeHtml(section.id)}">
    <div class="phead">
      <div>
        <h2>${escapeHtml(section.label)}</h2>
        <p>${escapeHtml(section.note)}</p>
      </div>
      <div class="phead-tools">
        ${set ? '<span class="pill is-good">Complete</span>' : '<span class="pill is-bad">1 required</span>'}
        ${isManager() ? (editing
          ? `<button type="button" data-settings-cancel>Cancel</button>
             <button type="button" class="primary" data-settings-save="${escapeHtml(section.id)}">Save</button>`
          : `<button type="button" class="link" data-settings-edit="${escapeHtml(section.id)}">Edit</button>`)
        : ""}
      </div>
    </div>
    <div class="pbody">
      <div class="lines">
        <div class="line${set ? "" : " is-needed"}">
          <span class="lbl">Landlord signer</span>
          <div>
            ${signer.layer
              ? `<b>${escapeHtml(signer.value)}</b>`
              : '<span class="empty is-needed">Required — choose a signer</span>'}
            <span class="panel-hint">${signerEmail ? escapeHtml(signerEmail)
              : emailKnown ? "Receives and signs every lease for this property"
                : "This database has no column for a signature address. Run supabase/schema.sql "
                  + "on it to record one."}</span>
          </div>
          ${isManager()
            ? `<button type="button" class="small${set ? "" : " primary"}" id="property-signer">${
                set ? "Change signer" : "Set signer"}</button>`
            : '<span class="locked">Manager only</span>'}
        </div>
        ${inline.map((field) => settingRow(field, layers, here, editing)).join("")}
      </div>
    </div>
  </article>`;
}

function sectionPanel(section, layers, here) {
  const editing = editingGroup === section.id
    || (section.id === "signing" && editingGroup === "signing-fields");
  const short = section.fields.filter((field) => field.required && !resolve(field, layers).layer).length;
  const optional = isOptionalSection(section);

  return `<article class="panel" data-group-panel="${escapeHtml(section.id)}">
    <div class="phead">
      <div>
        <h2>${escapeHtml(section.label)}</h2>
        <p>${escapeHtml(section.note)}</p>
      </div>
      <div class="phead-tools">
        ${optional
          ? `<span class="pill is-off">${section.fields.length} optional</span>`
          : short > 0
            ? `<span class="pill is-bad">${short} required</span>`
            : '<span class="pill is-good">Complete</span>'}
        ${isManager() ? (editing
          ? `<button type="button" data-settings-cancel>Cancel</button>
             <button type="button" class="primary" data-settings-save="${escapeHtml(section.id)}">Save</button>`
          : `<button type="button" class="link" data-settings-edit="${escapeHtml(section.id)}">Edit</button>`)
        : ""}
      </div>
    </div>
    <div class="pbody">
      <div class="lines">
        ${section.fields.map((field) => settingRow(field, layers, here, editing)).join("")}
      </div>
    </div>
  </article>`;
}

function signerDialog(signer, signerEmail, emailKnown) {
  return `<div class="sheet" data-signer-sheet>
    <div class="sheet-box" role="dialog" aria-modal="true" aria-labelledby="signer-title">
      <div class="sheet-head">
        <h2 id="signer-title">Set landlord signer</h2>
        <button type="button" class="small" data-signer-close aria-label="Close">Close</button>
      </div>
      <div class="sheet-body">
        <label for="signer-name">Authorised signer</label>
        <input type="text" id="signer-name" value="${escapeHtml(signer.value || "")}"
               placeholder="The name printed above the signature line">
        <label for="signer-email" style="margin-top:12px">Signature address</label>
        <input type="email" id="signer-email" value="${escapeHtml(signerEmail)}"
               placeholder="where the signature request is sent"${emailKnown ? "" : " disabled"}>
        ${emailKnown ? "" : `<p class="note" style="color:var(--warn)">This database cannot store a
          signature address yet. Run supabase/schema.sql on it and the field opens.</p>`}
        <p class="note">The name is printed on every lease for this property. The address never
           appears in the document — it is where the request goes. Both are fixed here: an agent
           can read them and cannot change them.</p>
      </div>
      <div class="sheet-foot">
        <button type="button" data-signer-close>Cancel</button>
        <button type="button" class="primary" id="signer-save">Save signer</button>
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

// --------------------------------------------------------------- tab: setup

// What goes into a lease and who decides it. Four owners, in the order the
// values arrive — not a field map, not a table of database columns, and not a
// statement of which Worker route refuses what.
const OWNERS = [
  {
    id: "application", label: "From the application", who: "Applicant",
    note: "The approved application starts the lease off: who the tenant is, how to reach "
      + "them, when they asked to move in, and the household answers the statutory notices need.",
    items: ["Tenant name", "Tenant email", "Desired move-in date", "Whether a child of 10 or "
      + "younger will live there"]
  },
  {
    id: "agent", label: "Confirmed by the agent", who: "Agent",
    note: "Everything particular to this tenancy. The agent confirms or changes each one when "
      + "the lease is made, and does not submit it for approval afterwards.",
    items: ["Apartment", "Monthly rent", "Security deposit", "Lease start date", "Lease term",
      "Rent concession"]
  },
  {
    id: "manager", label: "Fixed by the manager", who: "Manager",
    note: "This property's standing terms. They are the same on every lease produced here "
      + "until a manager changes them, and an agent cannot.",
    items: ["Landlord entity", "Landlord signer", "Management and notice contacts",
      "Deposit bank and payment address", "Standing fees", "Property disclosures"]
  },
  {
    id: "system", label: "Worked out by the system", who: "Automatic",
    note: "Nobody types these. They follow from the values above, so they cannot disagree with "
      + "them.",
    items: ["Lease end date", "The full premises address", "Which riders are included",
      "What the document package contains"]
  }
];

function setupTab() {
  return `
    <div class="toolbar">
      <div>
        <h2 class="section-title">How this property produces a lease</h2>
        <p class="note" style="margin:2px 0 0">Four sets of values, and who each belongs to.</p>
      </div>
    </div>

    <div class="owners">
      ${OWNERS.map((owner) => `<article class="owner">
        <div class="owner-head">
          <h3>${escapeHtml(owner.label)}</h3>
          <span class="owner-who is-${owner.id}">${escapeHtml(owner.who)}</span>
        </div>
        <p>${escapeHtml(owner.note)}</p>
        <ul>${owner.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </article>`).join("")}
    </div>

    <article class="panel" style="margin-top:14px">
      <div class="phead">
        <div>
          <h2>Documents generated</h2>
          <p>Every lease produced for this property is this package. Open any of them to see
             where this property's values land.</p>
        </div>
        <span class="pill is-good">${DOCUMENTS.length} documents</span>
      </div>
      <div class="pbody">
        <div class="ws-docs">
          ${DOCUMENTS.map((document) => `<button type="button" class="ws-doc"
              data-property-doc="${escapeHtml(document.id)}">
            <span class="ws-doc-name">${escapeHtml(document.name)}</span>
            <span class="ws-doc-why">${escapeHtml(document.conditionalOn
              ? `${document.note} Included only when it applies.`
              : document.note)}</span>
          </button>`).join("")}
        </div>
      </div>
    </article>`;
}

// ------------------------------------------------------------- tab: preview

function previewTab(company, units, target) {
  if (company) {
    return `<article class="panel">
      <div class="phead"><div>
        <h2>The document</h2>
        <p>Company values print on every lease, so the document is read through a property.</p>
      </div></div>
      <div class="pbody"><p class="note">Open a property and use its Document preview tab to see
        where each of these values lands on the page.</p></div>
    </article>`;
  }

  if (units.length === 0) {
    return `<div class="empty">
      <h2>No apartment to read it for</h2>
      <p>A lease is rendered for one apartment, because the address and the rent come from one.
         Put an apartment under this property in the listing's Property field.</p>
    </div>`;
  }

  return `
    <div class="toolbar">
      <div>
        <h2 class="section-title">A sample lease using this property's defaults</h2>
        <p class="note" style="margin:2px 0 0">The landlord side is real — it is what this page
          sets. The tenant and the transaction are sample values an agent would confirm.</p>
      </div>
      <div class="toolbar-actions">
        <select id="property-doc-unit" aria-label="Apartment">
          ${units.map((listing) => `<option value="${escapeHtml(listing.id)}">${
            escapeHtml([listing.unit ? `Unit ${listing.unit}` : "", listing.title]
              .filter(Boolean).join(" · "))}</option>`).join("")}
        </select>
        <button type="button" class="primary" id="property-doc-open">Open full document</button>
      </div>
    </div>

    <div class="prop-cols">
      <article class="panel">
        <div class="phead"><div>
          <h2>Generated package</h2>
          <p>Each document opens in the same reader the lease workspace uses, filled with this
             property's values.</p>
        </div></div>
        <div class="pbody">
          <div class="ws-docs">
            ${DOCUMENTS.map((document) => `<button type="button" class="ws-doc"
                data-property-doc="${escapeHtml(document.id)}">
              <span class="ws-doc-name">${escapeHtml(document.name)}</span>
              <span class="ws-doc-why">${escapeHtml(document.note)}</span>
            </button>`).join("")}
          </div>
        </div>
      </article>

      <aside>
        <article class="panel">
          <div class="phead"><div><h2>Where each value comes from</h2></div></div>
          <div class="pbody">
            <div class="lines">
              <div class="line"><span class="k">Landlord side</span>
                <div><b>This property</b><span class="panel-hint">Set on the defaults tab</span></div></div>
              <div class="line"><span class="k">Tenant side</span>
                <div><b>The application</b><span class="panel-hint">Sample values in this preview</span></div></div>
              <div class="line"><span class="k">The deal</span>
                <div><b>The agent</b><span class="panel-hint">Confirmed per lease</span></div></div>
              <div class="line"><span class="k">Dates and riders</span>
                <div><b>Worked out</b><span class="panel-hint">From the values above</span></div></div>
            </div>
            <p class="note">None of this marking appears in the document itself.</p>
          </div>
        </article>
      </aside>
    </div>`;
}

// ---------------------------------------------------------------- behaviour

// An editor left open holds typing nobody has saved. Leaving it by clicking a
// tab is easy to do by accident, so it asks — once, and only when something is
// actually open.
function mayLeaveEditor(host) {
  if (!editingGroup) return true;
  const panel = host.querySelector(`[data-group-panel="${CSS.escape(editingGroup)}"]`);
  if (!panel) return true;
  return confirm("Leave without saving the values you changed?");
}

// Delegated from the route host, so a re-render never leaves a listener behind.
export async function handlePropertyClick(event, host, target) {
  if (event.target.closest("[data-property-back]")) {
    if (!mayLeaveEditor(host)) return true;
    location.hash = "#/properties";
    return true;
  }

  const tab = event.target.closest("[data-property-tab]");
  if (tab) {
    if (!mayLeaveEditor(host)) return true;
    currentTab = tab.dataset.propertyTab;
    editingGroup = "";
    await renderProperty(host, target);
    return true;
  }

  if (event.target.closest("#property-optional")) {
    showOptional = !showOptional;
    await renderProperty(host, target);
    return true;
  }

  const edit = event.target.closest("[data-settings-edit]");
  if (edit) {
    editingGroup = edit.dataset.settingsEdit;
    await renderProperty(host, target);
    return true;
  }

  if (event.target.closest("[data-settings-cancel]")) {
    editingGroup = "";
    await renderProperty(host, target);
    return true;
  }

  const save = event.target.closest("[data-settings-save]");
  if (save) {
    await saveGroup(host, target, save.dataset.settingsSave);
    return true;
  }

  // ---- the signer

  if (event.target.closest("#property-signer")) {
    signerOpen = true;
    await renderProperty(host, target);
    host.querySelector("#signer-name")?.focus();
    return true;
  }

  if (event.target.closest("#property-address")) {
    addressOpen = true;
    await renderProperty(host, target);
    host.querySelector("#address-street")?.focus();
    return true;
  }

  if (event.target.closest("[data-address-close]")
      || (event.target.matches("[data-address-sheet]"))) {
    addressOpen = false;
    await renderProperty(host, target);
    return true;
  }

  if (event.target.closest("#address-save")) {
    await saveAddress(host, target);
    return true;
  }

  if (event.target.closest("[data-signer-close]")
      || (event.target.matches("[data-signer-sheet]"))) {
    signerOpen = false;
    await renderProperty(host, target);
    return true;
  }

  if (event.target.closest("#signer-save")) {
    await saveSigner(host, target);
    return true;
  }

  // ---- the document

  const openDoc = event.target.closest("[data-property-doc]");
  if (openDoc) {
    const units = listingsOf().filter((listing) => listing.building_id === target);
    const chosen = host.querySelector("#property-doc-unit")?.value || units[0]?.id || "";
    if (!chosen) {
      setStatus("Link an apartment to this property to read its lease.", "error");
      return true;
    }
    openDocument({
      listingId: chosen,
      readOnly: true,
      document: openDoc.dataset.propertyDoc,
      returnTo: `#/properties/${encodeURIComponent(target)}`
    });
    return true;
  }

  if (event.target.closest("#property-doc-open") || event.target.closest("#property-test-lease")) {
    const units = listingsOf().filter((listing) => listing.building_id === target);
    const chosen = host.querySelector("#property-doc-unit")?.value || units[0]?.id || "";
    if (!chosen) {
      setStatus("Link an apartment to this property to read its lease.", "error");
      return true;
    }
    openDocument({
      listingId: chosen,
      readOnly: true,
      returnTo: `#/properties/${encodeURIComponent(target)}`
    });
    return true;
  }

  return false;
}

// Two writes, because the signer is two things stored in two places for a
// reason: the printed name is a lease value and lives in the settings layer
// with the other 92; the address the request goes to is not in the document at
// all and lives on the property row. Both are refused for an agent by the
// Worker, not by this screen.
// The Worker refuses this for an agent; the screen never shows them the
// button in the first place.
async function saveAddress(host, target) {
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
    const { building } = await api(`/buildings/${encodeURIComponent(target)}`, {
      method: "PATCH",
      body: JSON.stringify(values)
    });
    const index = buildings.findIndex((row) => row.id === target);
    if (index !== -1 && building) buildings[index] = building;

    addressOpen = false;
    await renderProperty(host, target, { keepStatus: true });
    setStatus("Address saved. Every lease for this property prints it.");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function saveSigner(host, target) {
  const name = host.querySelector("#signer-name")?.value.trim() || "";
  const email = host.querySelector("#signer-email")?.value.trim() || "";

  if (!name) {
    setStatus("The signer needs the name that is printed above the signature line.", "error");
    return;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
        building_id: target,
        field_values: { "landlord.print_name": name }
      })
    });
    const { building } = canStoreEmail
      ? await api(`/buildings/${encodeURIComponent(target)}`, {
        method: "PATCH",
        body: JSON.stringify({ landlord_signer_email: email })
      })
      : { building: null };

    // Both caches: the layer holds the name, the building row holds the address.
    await loadBuildingLayer(target, true);
    const index = buildings.findIndex((row) => row.id === target);
    if (index !== -1 && building) buildings[index] = building;

    signerOpen = false;
    await renderProperty(host, target, { keepStatus: true });
    setStatus(!canStoreEmail
      ? `Signer set to ${name}. This database cannot record a signature address yet.`
      : email
        ? `Signer set. ${name} will receive every landlord signature request for this property.`
        : "Signer name saved. Add a signature address before agents can send leases.");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function saveGroup(host, target, group) {
  const company = target === "company";
  const here = company ? "company" : "building";
  const layers = company
    ? [["company", companyLayer]]
    : [["building", buildingLayers.get(target)], ["company", companyLayer]];

  const panel = host.querySelector(`[data-group-panel="${CSS.escape(group)}"]`);
  if (!panel) return;

  // Only what actually changed. Sending the whole group would copy every
  // inherited company answer down into the building layer, and this building
  // would then stop tracking the company.
  const patch = {};
  for (const input of panel.querySelectorAll("[data-setting]")) {
    const field = byId(input.dataset.setting);
    if (!field) continue;
    const resolved = resolve(field, layers);
    const before = resolved.layer === here ? resolved.value : undefined;

    if (field.type === "checkbox") {
      if (input.checked !== Boolean(before)) patch[field.id] = input.checked;
      continue;
    }

    const value = input.value.trim();
    // An emptied box means "this layer no longer answers it"; the Worker stores
    // that as the key being absent, so it only needs sending if it was set here.
    if (value === "" && before === undefined) continue;
    if (value === before) continue;
    patch[field.id] = value;
  }

  if (Object.keys(patch).length === 0) {
    editingGroup = "";
    await renderProperty(host, target, { keepStatus: true });
    setStatus("Nothing changed.");
    return;
  }

  setStatus("Saving…");
  try {
    await api("/lease/settings", {
      method: "PUT",
      body: JSON.stringify(company
        ? { scope: "company", field_values: patch }
        : { scope: "building", building_id: target, field_values: patch })
    });

    editingGroup = "";
    if (company) await loadCompanyLayer(true);
    else await loadBuildingLayer(target, true);

    const count = Object.keys(patch).length;
    // After the re-render, not before: renderProperty clears the line on its
    // way out, so a message set here first was written and then wiped.
    await renderProperty(host, target, { keepStatus: true });
    setStatus(`Saved ${count} value${count === 1 ? "" : "s"} to ${company ? "the company" : "this property"}.`);
  } catch (error) {
    setStatus(error.message, "error");
  }
}
