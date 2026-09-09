// Property-level lease configuration.
//
// A landlord value is not a property of one apartment. It is a property of the
// building — "our returned payment fee is $25", "this one has no sprinkler
// system" — and all 125 of them are set here, on the property they print for.
//
// That matters because the same values could always be typed on a single
// apartment's lease screen, where they land in the unit layer and quietly stop
// tracking the property. Setting a disclosure once, here, is the difference
// between one answer and one answer per apartment.
//
// Nothing on this screen writes a per-lease value, and nothing on the lease
// screen writes a property layer. One value, one place it is written — and one
// editor, in property-defaults.js, which this page hosts as a page and the
// document view hosts beside the lease.

import { readiness } from "./property-sections.js";
import {
  defaultsMarkup,
  forgetLayers as forgetDefaults,
  handleDefaultsClick,
  rememberDefaultsNavigation,
  syncDefaultsNavigation,
  initPropertyDefaults,
  layerOf,
  loadLayer,
  managerFields,
  mayLeaveEditor,
  newDefaultsUi,
  resolve,
  signerEmailKnown
} from "./property-defaults.js";

let api;
let setStatus;
let escapeHtml;
let isManager = () => false;
let listingsOf = () => [];
let openDocument = () => {};

let registry = null;
let buildings = [];

export function initProperties(deps) {
  ({ api, setStatus, escapeHtml } = deps);
  isManager = deps.isManager || (() => false);
  listingsOf = deps.listings;
  openDocument = deps.openDocument || (() => {});

  initPropertyDefaults({
    api,
    setStatus,
    escapeHtml,
    isManager,
    buildingOf: (id) => buildings.find((row) => row.id === id) || null,
    onBuildingChanged: (row) => {
      const index = buildings.findIndex((building) => building.id === row.id);
      if (index !== -1) buildings[index] = row;
    }
  });
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

// Settings may also have been written from the lease screen, which edits the
// unit layer but shares the same cache-invalidating moment.
export function forgetLayers() {
  forgetDefaults();
}

function byId(id) {
  return registry.fields.find((field) => field.id === id);
}

// The screens ask this file for readiness so the list and the page cannot
// disagree about whether a property is ready.
function readinessFor({ fields, values, building }) {
  return readiness({
    fields,
    answered: (field) => resolve(field, values).answered,
    hasSigner: signerEmailKnown(building) ? Boolean(building.landlord_signer_email) : true
  });
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
    const rows = await loadBuildings(true);

    // One request per building. The layer is small and buildings are few; if
    // that ever stops being true this is the loop to replace with one call.
    await Promise.all(rows.map((building) => loadLayer(building.id)));

    const fields = managerFields(registry);

    const units = new Map();
    for (const listing of listingsOf()) {
      if (!listing.building_id) continue;
      units.set(listing.building_id, (units.get(listing.building_id) || 0) + 1);
    }
    const unlinked = listingsOf().filter((listing) => !listing.building_id).length;

    const rowsMarkup = rows.map((building) => {
      const values = layerOf(building.id);
      const ready = readinessFor({ fields, values, building });
      const entity = resolve(byId("landlord.entity_name"), values);
      const signer = resolve(byId("landlord.print_name"), values);
      const count = units.get(building.id) || 0;

      return `<a class="prop-row" href="#/properties/${escapeHtml(building.id)}">
        <span class="prop-identity">
          <b>${escapeHtml(building.name)}</b>
          <small>${escapeHtml([building.street, building.city, building.state_abbr, building.zip]
            .filter(Boolean).join(", ")) || "No address recorded"}</small>
          <span class="prop-listing-count">${count} linked listing${count === 1 ? "" : "s"}</span>
        </span>
        <span class="prop-landlord">
          <span class="prop-mobile-caption">Landlord</span>
          <span class="prop-entity">${entity.answered ? escapeHtml(entity.value) : '<span class="soft">Entity not set</span>'}</span>
          <small><span class="prop-signer-label">Signer</span> · ${signer.answered
            ? escapeHtml(signer.value)
            : '<span class="prop-need">Not set</span>'}</small>
        </span>
        <span class="prop-readiness"><span class="prop-mobile-caption">Lease status</span><span class="pill is-${ready.state === "ready" ? "good" : ready.state === "one" ? "warn" : "bad"}">${
          escapeHtml(ready.label)}</span></span>
        <span class="prop-go">${isManager() ? "Manage" : "View"} <span aria-hidden="true">↗</span></span>
      </a>`;
    }).join("");

    host.innerHTML = `
      <div class="pagehead">
        <div>
          <span class="k">Configuration</span>
          <h1>Properties</h1>
          <p>Manage property details and shared lease terms for every linked listing.</p>
        </div>
        ${isManager() ? '<button class="primary" type="button" data-desk-new-property>New property</button>' : '<span class="pill">View only · Admin maintains defaults</span>'}
      </div>

      ${rows.length === 0
        ? `<div class="empty">
             <h2>No properties yet</h2>
             <p>A property is what lets several apartments share one set of landlord terms.
                Add one from any listing's Property field, then set its address here.</p>
           </div>`
        : `<div class="rows prop-directory">
             <div class="prop-row is-head" aria-hidden="true">
               <span>Property</span><span>Landlord</span><span>Lease status</span><span></span>
             </div>
             ${rowsMarkup}
           </div>`}

      ${unlinked > 0
        ? `<p class="note">${unlinked} apartment${unlinked === 1 ? " is" : "s are"} under no
             property, so ${unlinked === 1 ? "its lease has" : "their leases have"} no landlord
             values at all and the address comes off the listing itself. Put
             ${unlinked === 1 ? "it" : "them"} under one in the listing's Property field.</p>`
        : ""}`;

    setStatus("");
  } catch (error) {
    host.innerHTML = "";
    setStatus(error.message, "error");
  }
}

// -------------------------------------------------------------- one property

let currentTarget = "";
// The editor's own state — which panel is open, whether the uncommon terms are
// unfolded, which dialog is up. Owned here because the document view keeps its
// own, and a panel left open on one screen is not open on the other.
let ui = newDefaultsUi();

// `keepStatus` is for the one caller that has something to say afterwards: a
// save re-renders the page and then reports what it wrote, and clearing the
// line on the way out would wipe the report before anyone read it.
export async function renderProperty(host, target, { keepStatus = false } = {}) {
  if (target !== currentTarget) {
    currentTarget = target;
    ui = newDefaultsUi();
  }

  host.innerHTML = '<p class="status">Loading…</p>';

  try {
    await loadRegistry();
    await loadBuildings(true);

    const building = buildings.find((row) => row.id === target);
    if (!building) {
      host.innerHTML = `<p class="status" data-tone="error">That property no longer exists.
        <a href="#/properties">Back to properties</a>.</p>`;
      return;
    }

    await loadLayer(target);
    host.innerHTML = renderPropertyShell({ building, target });
    syncDefaultsNavigation(host, ui);
    if (!keepStatus) setStatus("");
  } catch (error) {
    host.innerHTML = "";
    setStatus(error.message, "error");
  }
}

function renderPropertyShell({ building, target }) {
  const fields = managerFields(registry);
  const values = layerOf(target);
  const address = [building.street, building.city, building.state, building.zip]
    .filter(Boolean).join(", ") || "No address recorded";

  const units = listingsOf().filter((listing) => listing.building_id === target);
  const ready = readinessFor({ fields, values, building });
  return `
    <button type="button" class="link back" data-property-back>← All properties</button>

    <div class="pagehead">
      <div>
        <span class="k">Property configuration</span>
        <h1>${escapeHtml(building.name)}</h1>
        <p>${escapeHtml(address)}${building.declared_units ? ` · ${escapeHtml(building.declared_units)} rental units reported` : ""} · ${units.length} linked listing${units.length === 1 ? "" : "s"}</p>
      </div>
      <div class="actions">
        ${units.length === 0 ? "" :
          `<button type="button" id="property-test-lease">Generate test lease</button>
           <button type="button" class="primary" id="property-doc-edit">${
             isManager() ? "Fill these in on the document" : "Read these on the document"}</button>`}
      </div>
    </div>

    <div class="property-completion"><span class="pill is-${ready.state === "ready" ? "good" : "warn"}">${escapeHtml(ready.label)}</span><span>${escapeHtml(ready.detail)}</span></div>

    <div id="property-defaults">${defaultsMarkup({fields, values, ui, buildingId: building.id})}</div>`;
}

// ---------------------------------------------------------------- behaviour

// Which apartment the document is read for. A lease is rendered for one,
// because the address and the rent come from one.
function sampleUnit(target) {
  return listingsOf().find((listing) => listing.building_id === target)?.id || "";
}

// Delegated from the route host, so a re-render never leaves a listener behind.
export async function handlePropertyClick(event, host, target) {
  if (event.target.closest("[data-property-back]")) {
    if (!mayLeaveEditor(host, ui)) return true;
    location.hash = "#/properties";
    return true;
  }

  // ---- the editor: panels, both dialogs, and every write

  if (await handleDefaultsClick(event, {
    host,
    buildingId: target,
    fields: managerFields(registry),
    ui,
    rerender: async () => {
      rememberDefaultsNavigation(host, ui);
      const building = buildings.find(row => row.id === target);
      host.innerHTML = renderPropertyShell({building, target});
      syncDefaultsNavigation(host, ui);
    }
  })) return true;

  // ---- the document

  if (event.target.closest("#property-test-lease")) {
    const chosen = sampleUnit(target);
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

  // The same property editor, on the other side of the document it
  // fills in. A value is easier to answer with the sentence it belongs to in
  // front of you than with its label alone.
  if (event.target.closest("#property-doc-edit")) {
    if (!mayLeaveEditor(host, ui)) return true;
    const chosen = sampleUnit(target);
    if (!chosen) {
      setStatus("Link an apartment to this property to read its lease.", "error");
      return true;
    }
    openDocument({
      listingId: chosen,
      buildingId: target,
      mode: "defaults",
      returnTo: `#/properties/${encodeURIComponent(target)}`
    });
    return true;
  }

  return false;
}
