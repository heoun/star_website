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

import { formatSettingValue, isAnswered } from "../shared/lease-values.js";

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

function groupLabel(id) {
  const found = (registry.groups || []).find((group) => group.id === id);
  return found ? found.label : id.replace(/_/g, " ");
}

function groupNote(id) {
  const found = (registry.groups || []).find((group) => group.id === id);
  return found ? found.description : "";
}

// Groups in the order the registry lists them, carrying only the fields this
// page owns. A group with none of them does not appear at all.
function groupsOf(fields) {
  const byGroup = new Map();
  for (const field of fields) {
    if (!byGroup.has(field.group)) byGroup.set(field.group, []);
    byGroup.get(field.group).push(field);
  }
  const order = (registry.groups || []).map((group) => group.id);
  return [...byGroup.entries()].sort((a, b) => {
    const ai = order.indexOf(a[0]);
    const bi = order.indexOf(b[0]);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
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

function gapsIn(fields, layers) {
  return fields.filter((field) => field.required && !resolve(field, layers).layer);
}

// ----------------------------------------------------------------- markup

function valueCell(field, resolved) {
  if (!resolved.layer) {
    return `<span class="empty${field.required ? " is-needed" : ""}">${
      field.required ? "Needed — no answer in any layer" : "Not answered"}</span>`;
  }
  return `<b>${escapeHtml(formatSettingValue(field, resolved.value))}</b>`;
}

function provenanceChip(resolved, here) {
  if (!resolved.layer) return '<span class="src src-manager">Unanswered</span>';
  if (resolved.layer === here) return '<span class="src src-manager">Set here</span>';
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
    <span class="k">${escapeHtml(field.label)}</span>
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

function groupPanel(group, fields, layers, here, editingGroup) {
  const editing = editingGroup === group;
  const gaps = gapsIn(fields, layers).length;

  return `<article class="panel" data-group-panel="${escapeHtml(group)}">
    <div class="phead">
      <div>
        <h2>${escapeHtml(groupLabel(group))}</h2>
        <p>${escapeHtml(groupNote(group) || "")}${gaps > 0
          ? ` · <span style="color:var(--bad);font-weight:600">${gaps} still needed</span>` : ""}</p>
      </div>
      ${isManager() ? (editing
        ? `<span class="actions">
             <button type="button" data-settings-cancel>Cancel</button>
             <button type="button" class="primary" data-settings-save="${escapeHtml(group)}">Save</button>
           </span>`
        : `<button type="button" class="link" data-settings-edit="${escapeHtml(group)}">Edit</button>`)
      : '<span class="locked">Manager only</span>'}
    </div>
    <div class="pbody">
      <div class="lines">
        ${fields.map((field) => settingRow(field, layers, here, editing)).join("")}
      </div>
    </div>
  </article>`;
}

// ------------------------------------------------------------------ list

export async function renderPropertyList(host) {
  host.innerHTML = '<p class="status">Loading properties…</p>';

  try {
    await loadRegistry();
    const [rows] = await Promise.all([loadBuildings(true), loadCompanyLayer()]);

    // One request per building. The layer is small and buildings are few; if
    // that ever stops being true this is the loop to replace with one call.
    const layers = await Promise.all(rows.map((building) => loadBuildingLayer(building.id)));

    const companyFields = fieldsForScope("company");
    const buildingFields = fieldsForScope("building");
    const companyGaps = gapsIn(companyFields, [["company", companyLayer]]).length;

    const units = new Map();
    for (const listing of listingsOf()) {
      if (!listing.building_id) continue;
      units.set(listing.building_id, (units.get(listing.building_id) || 0) + 1);
    }
    const unlinked = listingsOf().filter((listing) => !listing.building_id).length;

    host.innerHTML = `
      <div class="pagehead">
        <div>
          <span class="k">Configuration</span>
          <h1>Properties</h1>
          <p>The landlord's own terms, set once at the layer they belong to. Every lease
             produced for an apartment reads them through its building, and through the company.</p>
        </div>
      </div>

      <article class="panel">
        <div class="phead">
          <div>
            <h2>Company defaults</h2>
            <p>${companyFields.length} values that are the same for every building.</p>
          </div>
          <a href="#/properties/company"><button type="button">Open</button></a>
        </div>
        <div class="pbody">
          <div class="line">
            <span class="k">Status</span>
            <div>${companyGaps > 0
              ? `<b style="color:var(--bad)">${companyGaps} required value${companyGaps === 1 ? "" : "s"} still needed</b>`
              : "<b>Every required value answered</b>"}</div>
            <span class="src ${companyGaps > 0 ? "src-computed" : "src-manager"}">Company</span>
          </div>
        </div>
      </article>

      <article class="panel">
        <div class="phead">
          <div>
            <h2>Buildings</h2>
            <p>${buildingFields.length} values differ per building. A lease cannot be produced
               until the ones marked required are answered.</p>
          </div>
        </div>
        <div class="pbody">
          ${rows.length === 0
            ? `<p class="panel-hint">No building has been created yet. Settings still work without
                 one — they land on the company layer, or on a single apartment — but a building
                 is what lets several apartments share one answer.</p>`
            : `<div class="lines">${rows.map((building, index) => {
                const gaps = gapsIn(buildingFields, [["building", layers[index]], ["company", companyLayer]]).length;
                const count = units.get(building.id) || 0;
                return `<div class="line">
                  <span class="k">${escapeHtml(building.name)}</span>
                  <div>
                    <b>${count} apartment${count === 1 ? "" : "s"}</b>
                    <span class="panel-hint">${escapeHtml([building.street, building.city, building.state_abbr, building.zip]
                      .filter(Boolean).join(", ")) || "No address recorded"}</span>
                  </div>
                  <span class="actions">
                    ${gaps > 0
                      ? `<span class="src src-computed">${gaps} needed</span>`
                      : '<span class="src src-manager">Complete</span>'}
                    <a href="#/properties/${escapeHtml(building.id)}"><button type="button" class="small">Open</button></a>
                  </span>
                </div>`;
              }).join("")}</div>`}
          ${unlinked > 0
            ? `<p class="panel-hint" style="margin-top:12px">${unlinked} apartment${unlinked === 1 ? " is" : "s are"}
                 not linked to a building, so ${unlinked === 1 ? "it reads" : "they read"} the company layer only.
                 Link ${unlinked === 1 ? "it" : "them"} on the listing to share this building's answers.</p>`
            : ""}
        </div>
      </article>`;

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

// `keepStatus` is for the one caller that has something to say afterwards: a
// save re-renders the page and then reports what it wrote, and clearing the
// line on the way out would wipe the report before anyone read it.
export async function renderProperty(host, target, { keepStatus = false } = {}) {
  if (target !== currentTarget) {
    currentTarget = target;
    currentTab = "defaults";
    editingGroup = "";
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

function renderPropertyShell({ company, building, fields, layers, here, target }) {
  const name = company ? "Company defaults" : building.name;
  const address = company
    ? "Applies to every building and every apartment."
    : [building.street, building.city, building.state, building.zip].filter(Boolean).join(", ")
      || "No address recorded";

  const units = company ? [] : listingsOf().filter((listing) => listing.building_id === target);
  const gaps = gapsIn(fields, layers);
  const companyGaps = company ? [] : gapsIn(fieldsForScope("company"), [["company", companyLayer]]);

  const entity = resolve(byId("landlord.entity_name"), layers);
  const signer = resolve(byId("landlord.print_name"), layers);

  const tabs = [
    ["defaults", "Landlord defaults"],
    ["document", "Document"],
    ["permissions", "Who may change what"],
    ["mapping", "Application → lease"]
  ];

  return `
    <div class="pagehead">
      <div>
        <span class="k">${company ? "Company-wide configuration" : "Property configuration"}</span>
        <h1>${escapeHtml(name)}</h1>
        <p>${escapeHtml(address)}</p>
      </div>
    </div>

    <section class="statbar">
      <div class="stat is-lead">
        <span class="dot${gaps.length === 0 ? "" : " is-bad"}"></span>
        <div>
          <b>${gaps.length === 0 ? "Ready for leases" : `${gaps.length} value${gaps.length === 1 ? "" : "s"} still needed`}</b>
          <small>${gaps.length === 0
            ? "Every required value at this layer is answered."
            : "Any apartment here that does not answer them itself cannot produce a lease."}${
            companyGaps.length > 0 ? ` ${companyGaps.length} more unanswered on the company layer.` : ""}</small>
        </div>
      </div>
      <div class="stat">
        <span class="k">${company ? "Buildings" : "Apartments"}</span>
        <b>${company ? buildings.length : units.length}</b>
      </div>
      <div class="stat">
        <span class="k">Landlord entity</span>
        <b>${entity.layer ? escapeHtml(entity.value) : "—"}</b>
        <small>${entity.layer ? `from ${escapeHtml(entity.layer)}` : "not answered"}</small>
      </div>
      <div class="stat">
        <span class="k">Signer</span>
        <b>${signer.layer ? escapeHtml(signer.value) : "—"}</b>
        <small>${signer.layer ? `from ${escapeHtml(signer.layer)}` : "not answered"}</small>
      </div>
    </section>

    <div class="tabs" role="tablist">
      ${tabs.map(([id, label]) =>
        `<button type="button" class="tab" role="tab" data-property-tab="${id}"
                 aria-selected="${currentTab === id}">${label}</button>`).join("")}
    </div>

    ${currentTab === "defaults" ? defaultsTab(fields, layers, here) : ""}
    ${currentTab === "document" ? documentTab(company, units) : ""}
    ${currentTab === "permissions" ? permissionsTab() : ""}
    ${currentTab === "mapping" ? mappingTab() : ""}`;
}

function byId(id) {
  return registry.fields.find((field) => field.id === id);
}

function defaultsTab(fields, layers, here) {
  return `
    <div class="legend">
      <span class="k">Where the answer comes from</span>
      <span class="src src-manager">Set here</span>
      <span class="src src-computed">From company</span>
      <span class="src src-manager">Unanswered</span>
    </div>
    ${isManager()
      ? ""
      : `<p class="status">These are a manager's to set. You can read every one of them, and
           they are what a lease you produce will print.</p>`}
    ${groupsOf(fields).map(([group, groupFields]) =>
      groupPanel(group, groupFields, layers, here, editingGroup)).join("")}`;
}

function documentTab(company, units) {
  if (company) {
    return `<article class="panel"><div class="phead"><div>
        <h2>The document</h2>
        <p>Company values print on every lease, so the document is read through a building.</p>
      </div></div>
      <div class="pbody"><p class="panel-hint">Open a building and use its Document tab to see
        where each of these values lands on the page.</p></div></article>`;
  }

  return `<article class="panel">
    <div class="phead">
      <div>
        <h2>The document</h2>
        <p>The lease as this building's settings fill it, page by page. Read-only —
           values are changed on the Landlord defaults tab, so they are written to the
           building rather than to one apartment.</p>
      </div>
    </div>
    <div class="pbody">
      ${units.length === 0
        ? `<p class="panel-hint">No apartment is linked to this building yet. The document is
             rendered for an apartment, because the address and the rent come from one.</p>`
        : `<div class="line">
             <span class="k">Read it for</span>
             <div><select id="property-doc-unit">
               ${units.map((listing) => `<option value="${escapeHtml(listing.id)}">${
                 escapeHtml([listing.building_name, listing.unit ? `Unit ${listing.unit}` : "", listing.title]
                   .filter(Boolean).join(" · "))}</option>`).join("")}
             </select></div>
             <button type="button" class="primary" id="property-doc-open">Open the document</button>
           </div>`}
    </div>
  </article>`;
}

// A statement of the rule the Worker actually enforces, read off the registry
// rather than written down again. It is not a set of switches: the split is in
// the code and in `worker/staff.js`, not in a per-property setting.
function permissionsTab() {
  const manager = registry.fields.filter((field) => field.source === "manager");
  const deal = registry.fields.filter((field) => field.source === "deal");
  const agent = registry.fields.filter((field) => field.source === "agent");

  return `
    <div class="cols">
      <article class="panel">
        <div class="phead"><div>
          <h2>What an agent sets on each lease</h2>
          <p>${deal.length + agent.length} values about this one tenancy.</p>
        </div><span class="src src-agent">Agent</span></div>
        <div class="pbody"><div class="lines">
          ${[...deal, ...agent].map((field) => `<div class="line">
            <span class="k">${escapeHtml(field.label)}</span>
            <div><span class="panel-hint">${escapeHtml(field.from || "Typed for this lease.")}</span></div>
            <span class="src ${field.from && field.from.startsWith("applications.") ? "src-application"
              : field.from && field.from.startsWith("listings") ? "src-listing"
              : field.from ? "src-computed" : "src-agent"}">${
              field.from && field.from.startsWith("applications.") ? "Application"
                : field.from && field.from.startsWith("listings") ? "Listing"
                : field.from ? "Computed" : "Agent"}</span>
          </div>`).join("")}
        </div></div>
      </article>

      <aside>
        <article class="panel">
          <div class="phead"><div>
            <h2>Never an agent's</h2>
            <p>${manager.length} landlord values.</p>
          </div><span class="src src-manager">Manager</span></div>
          <div class="pbody">
            <div class="lines">
              <div class="line"><span class="k">Read them</span><div><b>Manager and agent</b></div></div>
              <div class="line"><span class="k">Change a building default</span><div><b>Manager only</b></div></div>
              <div class="line"><span class="k">Change one for a single lease</span><div><b>Manager only</b></div></div>
              <div class="line"><span class="k">Move an apartment to another building</span><div><b>Manager only</b></div></div>
              <div class="line"><span class="k">Add or remove an account</span><div><b>Manager only</b></div></div>
            </div>
            <p class="panel-hint" style="margin-top:12px">The Worker refuses each of these for an
              agent whatever this screen shows. Roles come from the staff table, and an account with
              no row there is refused outright rather than treated as an agent.</p>
          </div>
        </article>
      </aside>
    </div>`;
}

// Not every application answer belongs in the lease. This reads the answer off
// the registry — a lease field's `from` is the only record of what is carried
// across — and names the screening material that deliberately is not.
function mappingTab() {
  const carried = registry.fields.filter((field) => field.from);

  const NEVER = [
    ["Date of birth", "Screening"],
    ["Social security number", "Screening — encrypted, revealed one at a time"],
    ["Current address", "Screening"],
    ["Household size", "Screening"],
    ["Income note", "Screening"],
    ["Current employer and employment history", "Screening"],
    ["Rental history", "Screening"],
    ["Reference contacts", "Screening"],
    ["Emergency contacts", "Application record"],
    ["Phone number", "Contact — the lease names an email, not a phone"],
    ["Pets", "Application record — this template has no pet clause"],
    ["Anything else you would like us to know", "Application record"]
  ];

  return `
    <article class="panel">
      <div class="phead"><div>
        <h2>What the application puts on the lease</h2>
        <p>${carried.length} of the lease's values are prefilled. An agent confirms or corrects
           each one before the lease is produced.</p>
      </div></div>
      <div class="pbody"><div class="lines">
        ${carried.map((field) => `<div class="line">
          <span class="k">${escapeHtml(field.label)}</span>
          <div><span class="panel-hint">${escapeHtml(field.from)}</span></div>
          <span class="src ${field.from.startsWith("applications.") ? "src-application"
            : field.from.startsWith("listings") ? "src-listing" : "src-computed"}">${
            field.from.startsWith("applications.") ? "Application"
              : field.from.startsWith("listings") ? "Listing" : "Computed"}</span>
        </div>`).join("")}
      </div></div>
    </article>

    <article class="panel">
      <div class="phead"><div>
        <h2>What it never puts on the lease</h2>
        <p>Collected to decide on a tenant, and not repeated in a document that gets signed
           and emailed.</p>
      </div></div>
      <div class="pbody"><div class="lines">
        ${NEVER.map(([label, why]) => `<div class="line">
          <span class="k">${escapeHtml(label)}</span>
          <div><span class="panel-hint">${escapeHtml(why)}</span></div>
          <span class="src src-manager">Not on the lease</span>
        </div>`).join("")}
      </div></div>
    </article>`;
}

// ---------------------------------------------------------------- behaviour

// Delegated from the route host, so a re-render never leaves a listener behind.
export async function handlePropertyClick(event, host, target) {
  const tab = event.target.closest("[data-property-tab]");
  if (tab) {
    currentTab = tab.dataset.propertyTab;
    editingGroup = "";
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

  if (event.target.closest("#property-doc-open")) {
    const select = host.querySelector("#property-doc-unit");
    if (select?.value) {
      openDocument({
        listingId: select.value,
        readOnly: true,
        returnTo: `#/properties/${encodeURIComponent(target)}`
      });
    }
    return true;
  }

  return false;
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
    setStatus(`Saved ${count} value${count === 1 ? "" : "s"} to ${company ? "the company" : "this building"}.`);
  } catch (error) {
    setStatus(error.message, "error");
  }
}
