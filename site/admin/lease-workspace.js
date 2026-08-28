// The right half of the lease workspace.
//
// It replaces the field browser that listed all 147 template values in one
// column. That list answered "what placeholders exist"; the person sending a
// lease needs to know what the lease will say, who decided it, and what they
// may change — so this groups by ownership instead:
//
//   Tenant information     came from the approved application
//   Transaction terms      this tenancy, and the agent's to set
//   Landlord defaults      the manager's, read-only here, collapsed
//   Filled in for you      derived; nobody types these
//
// Editing goes through the same `data-lease-input` attribute the old form used,
// so lease-screen.js patches the document on the keystroke, writes tenant
// corrections back to the application on blur, and recounts what is missing —
// all unchanged. This module decides what to show, never how a value is stored.
// There is exactly one editor.
//
// Two values are not lease placeholders at all — the tenant's phone and the
// length of the term — but both belong on this screen: the phone is who the
// signing request goes to, and the term is what the end date is computed from.
// They carry `data-ws-app` and are written straight to the application row.

import { endDateFor } from "../shared/lease-dates.js";
import { DOCUMENTS } from "../shared/lease-documents.js";

let escapeHtml = (value) => String(value ?? "");

export function initWorkspace(deps) {
  escapeHtml = deps.escapeHtml;
}

// ------------------------------------------------------------ what goes where

// The application answers these. They are the tenant's identity, so a manager
// corrects them and an agent reads them — the same rule as the application
// page. Anything the application collected for screening — date of birth,
// social security number, income, employment, references, rental history,
// emergency contacts — is deliberately absent: it is not on the lease and
// this is not the screen for deciding on a tenant.
const TENANT_FIELDS = [
  { id: "tenant.names", hint: "As they will be printed and as they will sign." },
  { id: "tenant.email", hint: "Where the signing request goes." },
  { app: "phone", label: "Phone", manager: true,
    hint: "Contact only — the lease does not print a phone number." },
  { id: "tenant.mailing_address", hint: "Starts as the applicant's current address. Clear it when notices go to the unit." }
];

// The terms of this one tenancy — the values an agent settles.
const TRANSACTION_FIELDS = [
  { id: "lease.effective_date", hint: "The date on page one. Defaults to the day the lease goes out." },
  { id: "lease.commencement_date", hint: "The day the tenancy starts." },
  { app: "lease_term_months", label: "Lease term", hint: "Months. The end date follows from this.", type: "number" },
  { id: "lease.end_date", derived: true, hint: "The last day of the term — the day before the same date, a term later." },
  { id: "rent.monthly", hint: "Starts from the listing's asking rent." },
  { id: "rent.due_day", hint: "The day of the month the rent falls due. Starts from the company default." },
  { id: "deposit.amount", hint: "One month is the New York maximum." },
  { id: "concession.terms", hint: "Fills the Rent Concession Rider." }
];

// The landlord's own terms, as they will print. Grouped so the section can stay
// shut: an agent checking a lease needs to be able to see them, not to read all
// 125 of them every time.
const MANAGER_GROUPS = [
  {
    title: "Landlord and signer",
    ids: ["landlord.entity_name", "landlord.print_name", "landlord.address"]
  },
  {
    title: "Management and notices",
    ids: ["manager.name", "manager.address", "manager.phone",
      "legal_notice.name", "legal_notice.address", "legal_notice.phone",
      "emergency.phone"]
  },
  {
    title: "Rent payment",
    ids: ["payee.name", "payee.address", "payee.phone",
      "deposit.bank_name", "deposit.bank_address"]
  },
  {
    title: "Fees and insurance",
    ids: ["fee.returned_payment", "fee.lock_change_admin", "insurance.min_liability",
      "fee.lptli_monthly", "fee.lptli_admin_monthly", "fee.animal_liability_cap"]
  }
];

// Filled in when the lease is generated, shown so a wrong one is noticed
// before it is signed. The marks and the vacancy date are a manager's to
// correct; the address follows the apartment.
const SYSTEM_FIELDS = [
  { id: "property.address_full", derived: true, hint: "Composed from the apartment you selected." },
  { id: "lease.vacancy_lease_date", hint: "The bedbug disclosure's date. Defaults to the day the listing went on the website." },
  { id: "dhcr.mark_vacancy", hint: "Ticked for a new tenancy." },
  { id: "dhcr.mark_renewal", hint: "The renewal half of the same answer." }
];

const UTILITY_PREFIX = "utility.";

// ----------------------------------------------------------------- rendering

export function renderWorkspace(host, state) {
  host.innerHTML = `
    <div class="ws-tabs" role="tablist">
      ${[["information", "Lease information"], ["documents", "Documents"], ["recipients", "E-sign recipients"]]
        .map(([id, label]) => `<button type="button" class="ws-tab" role="tab" data-ws-tab="${id}"
          aria-selected="${state.tab === id}">${label}</button>`).join("")}
    </div>
    <div class="ws-body" id="ws-body">${panelFor(state)}</div>`;
  annotateWorkspace(host, state);
}

function panelFor(state) {
  if (state.tab === "documents") return documentsPanel(state);
  if (state.tab === "recipients") return recipientsPanel(state);
  return informationPanel(state);
}

// Re-renders only the tab body, so switching tabs does not disturb the preview.
export function renderTab(host, state) {
  const body = host.querySelector("#ws-body");
  if (body) body.innerHTML = panelFor(state);
  for (const tab of host.querySelectorAll("[data-ws-tab]")) {
    tab.setAttribute("aria-selected", String(tab.dataset.wsTab === state.tab));
  }
  annotateWorkspace(host, state);
}

// ------------------------------------------------------------- lease information

function informationPanel(state) {
  return `
    ${section("Tenant", "From the approved application",
      TENANT_FIELDS.map((entry) => row(entry, state)).join(""))}

    ${section("Transaction terms", "This tenancy. Yours to set.",
      `${unitRow(state)}${TRANSACTION_FIELDS.map((entry) => row(entry, state)).join("")}`)}

    ${managerSection(state)}

    ${systemSection(state)}`;
}

function section(title, note, body, extra = "") {
  return `<section class="ws-section">
    <header class="ws-section-head">
      <h3>${escapeHtml(title)}</h3>
      ${note ? `<p>${escapeHtml(note)}</p>` : ""}
      ${extra}
    </header>
    ${body}
  </section>`;
}

// The apartment decides the address, the rent it starts from, and which
// building's settings the lease reads. It is the one selection that moves
// everything else, so it sits at the top of the terms.
function unitRow(state) {
  const listing = state.listings.find((row) => row.id === state.listingId);
  const address = state.values["property.address_full"] || "";

  return `<div class="ws-row" data-ws-row="listing">
    <label class="ws-label" for="lease-listing">Apartment</label>
    <div class="ws-value">
      <select id="lease-listing"${state.canPickUnit ? "" : " disabled"}>
        <option value="">— choose an apartment —</option>
        ${state.listings.map((row) => `<option value="${escapeHtml(row.id)}"${
          row.id === state.listingId ? " selected" : ""}>${escapeHtml(unitLabel(row))}</option>`).join("")}
      </select>
      <p class="ws-hint">${address
        ? `Address on the lease: <b>${escapeHtml(address)}</b>`
        : "Choose an apartment and its address fills the lease."}</p>
      ${state.canPickUnit ? "" : `<p class="ws-hint">${state.application
        ? "Fixed to the apartment this application was made for. Starting a lease for a different one means an application for it."
        : "Set by the property this document is being read for."}</p>`}
      ${listing && !listing.building_id
        ? '<p class="ws-hint is-warn">This apartment is not linked to a building, so it reads company settings only.</p>'
        : ""}
    </div>
  </div>`;
}

function unitLabel(listing) {
  return [listing.property_name, listing.unit ? `Unit ${listing.unit}` : ""].filter(Boolean).join(" · ")
    || listing.title || "Untitled";
}

function row(entry, state) {
  if (entry.app) return applicationRow(entry, state);

  const field = state.byId.get(entry.id);
  if (!field) return "";

  const missing = state.missing.has(entry.id);
  const editable = state.editable(field) && !entry.derived;

  return `<div class="ws-row${missing ? " is-missing" : ""}" data-lease-row="${escapeHtml(entry.id)}"
               data-ws-row="${escapeHtml(entry.id)}">
    <label class="ws-label" for="lease-input-${escapeHtml(entry.id)}">${escapeHtml(field.label)}</label>
    <div class="ws-value">
      ${entry.derived
        ? `<output class="ws-derived" data-ws-derived="${escapeHtml(entry.id)}">${
            escapeHtml(state.values[entry.id] || "—")}</output>`
        : control(field, state, editable)}
      <p class="ws-status" data-lease-status="${escapeHtml(entry.id)}"></p>
      ${entry.hint || field.note
        ? `<p class="ws-hint">${escapeHtml(entry.hint || field.note)}</p>` : ""}
      ${!editable && !entry.derived && !state.readOnly
        ? '<p class="ws-hint is-locked">A manager sets this.</p>' : ""}
      ${state.occurrences[entry.id] > 0
        ? `<button type="button" class="ws-find" data-lease-locate="${escapeHtml(entry.id)}">Show on the document</button>`
        : ""}
    </div>
  </div>`;
}

// A value that lives on the application rather than in the template. One
// marked `manager` follows the same rule as the tenant's other identity
// fields: an agent reads it, a manager corrects it.
function applicationRow(entry, state) {
  const value = state.application ? (state.application[entry.app] ?? "") : "";
  const locked = entry.manager && !state.isManager();
  return `<div class="ws-row" data-ws-row="${escapeHtml(entry.app)}">
    <label class="ws-label" for="ws-app-${escapeHtml(entry.app)}">${escapeHtml(entry.label)}</label>
    <div class="ws-value">
      <input id="ws-app-${escapeHtml(entry.app)}" data-ws-app="${escapeHtml(entry.app)}"
             type="${entry.type || "text"}"${entry.type === "number" ? ' min="1" max="120"' : ""}
             value="${escapeHtml(value)}"${
               state.application && !locked && !state.readOnly ? "" : " disabled"}>
      ${entry.hint ? `<p class="ws-hint">${escapeHtml(entry.hint)}</p>` : ""}
      ${locked ? '<p class="ws-hint is-locked">A manager sets this.</p>' : ""}
      ${state.application ? "" : '<p class="ws-hint">No application behind this lease.</p>'}
    </div>
  </div>`;
}

function control(field, state, editable) {
  const value = state.values[field.id] ?? "";
  const attrs = `id="lease-input-${escapeHtml(field.id)}" data-lease-input="${escapeHtml(field.id)}"${
    editable ? "" : " disabled"}`;

  if (field.type === "checkbox") {
    return `<label class="ws-check"><input type="checkbox" ${attrs}${
      state.checked.has(field.id) ? " checked" : ""}><span>Marked on the lease</span></label>`;
  }
  if (field.type === "choice") {
    return `<select ${attrs}>${["", ...field.options].map((option) =>
      `<option value="${escapeHtml(option)}"${option === value ? " selected" : ""}>${
        escapeHtml(option || "— not answered —")}</option>`).join("")}</select>`;
  }
  if (field.type === "multiline") {
    return `<textarea ${attrs} rows="2">${escapeHtml(value)}</textarea>`;
  }
  if (field.type === "integer") {
    return `<input type="number" ${attrs} min="1" value="${escapeHtml(value)}">`;
  }
  return `<input type="text" ${attrs} value="${escapeHtml(value)}">`;
}

// ------------------------------------------------------------ landlord defaults

function managerSection(state) {
  const utilities = utilitySummary(state);

  return `<section class="ws-section">
    <details class="ws-fold">
      <summary>
        <span class="ws-fold-title">Landlord defaults</span>
        <span class="ws-fold-note">${state.isManager()
          ? "Set on Property lease settings, not here."
          : "Set by a manager. Read-only."}</span>
      </summary>
      <div class="ws-fold-body">
        ${MANAGER_GROUPS.map((group) => `
          <h4 class="ws-subhead">${escapeHtml(group.title)}</h4>
          ${group.ids.map((id) => readOnlyRow(id, state)).join("")}`).join("")}

        <h4 class="ws-subhead">Utilities</h4>
        <div class="ws-row"><span class="ws-label">Landlord pays</span>
          <div class="ws-value"><b>${escapeHtml(utilities.landlord || "—")}</b></div></div>
        <div class="ws-row"><span class="ws-label">Tenant pays</span>
          <div class="ws-value"><b>${escapeHtml(utilities.tenant || "—")}</b></div></div>

        <p class="ws-hint">${state.isManager()
          ? 'Change any of these on <a href="#/properties">Property lease settings</a>, so every lease for the building gets them.'
          : "Ask a manager to change one of these rather than working round it."}</p>
      </div>
    </details>
  </section>`;
}

function readOnlyRow(id, state) {
  const field = state.byId.get(id);
  if (!field) return "";
  const value = state.values[id];
  const missing = state.missing.has(id);

  return `<div class="ws-row${missing ? " is-missing" : ""}" data-ws-row="${escapeHtml(id)}">
    <span class="ws-label">${escapeHtml(field.label)}</span>
    <div class="ws-value">
      ${value
        ? `<b>${escapeHtml(value)}</b>`
        : `<span class="ws-empty">${missing ? "Needed before this lease can be produced" : "Not answered"}</span>`}
    </div>
  </div>`;
}

// Twelve utilities as two sentences rather than twelve rows.
function utilitySummary(state) {
  const by = { Landlord: [], Tenant: [] };
  for (const field of state.fields) {
    if (!field.id.startsWith(UTILITY_PREFIX) || field.type !== "choice") continue;
    const who = state.values[field.id];
    if (!by[who]) continue;
    by[who].push(field.label.replace(/ — .*$/, "").toLowerCase());
  }
  return { landlord: by.Landlord.join(", "), tenant: by.Tenant.join(", ") };
}

// ----------------------------------------------------------- filled in for you

function systemSection(state) {
  return `<section class="ws-section">
    <details class="ws-fold">
      <summary>
        <span class="ws-fold-title">Filled in for you</span>
        <span class="ws-fold-note">Filled when the lease is generated. A manager corrects them.</span>
      </summary>
      <div class="ws-fold-body">
        ${SYSTEM_FIELDS.map((entry) => row(entry, state)).join("")}
        <p class="ws-hint">The address is written into every place the template asks for it —
          street, city, state, ZIP and the one-line form — from the apartment above.</p>
      </div>
    </details>
  </section>`;
}

// ------------------------------------------------------------------ documents

const WHY = {
  required: "Required",
  property: "Property default",
  condition: "Transaction condition"
};

function documentsPanel(state) {
  const answered = (doc) => {
    if (!doc.conditionalOn) return null;
    const field = state.byId.get(doc.conditionalOn);
    if (!field) return null;
    if (field.type === "checkbox") return state.checked.has(doc.conditionalOn);
    return (state.values[doc.conditionalOn] ?? "") !== "";
  };

  return `
    <section class="ws-section">
      <header class="ws-section-head">
        <h3>In this package</h3>
        <p>${state.documents.length} documents, generated as one Word file.
           Select one to read it on the left.</p>
      </header>
      <div class="ws-docs">
        <button type="button" class="ws-doc${state.activeDocument ? "" : " is-on"}" data-ws-doc="">
          <span class="ws-doc-name">The whole package</span>
          <span class="ws-doc-why">All ${state.documents.length} documents in order</span>
        </button>
        ${state.documents.map((doc) => {
          const on = state.activeDocument === doc.id;
          const has = answered(doc);
          const pages = doc.to - doc.from + 1;
          return `<button type="button" class="ws-doc${on ? " is-on" : ""}" data-ws-doc="${escapeHtml(doc.id)}"
                          aria-pressed="${on}">
            <span class="ws-doc-name">${escapeHtml(doc.name)}</span>
            <span class="ws-doc-why">${escapeHtml(WHY[doc.why] || doc.why)} · ${pages} section${pages === 1 ? "" : "s"}${
              has === false ? " · nothing entered yet" : ""}</span>
          </button>`;
        }).join("")}
      </div>
      <p class="ws-hint">Every document above is in every file this generates. A rider with
        nothing entered prints with its answer blank rather than being left out —
        the template is one Word file and is filled in place.</p>
    </section>`;
}

// ----------------------------------------------------------------- recipients

function recipientsPanel(state) {
  const tenants = tenantSigners(state);
  const signer = state.values["landlord.print_name"] || "";
  const entity = state.values["landlord.entity_name"] || "";

  return `
    <section class="ws-section">
      <header class="ws-section-head">
        <h3>Who signs</h3>
        <p>Everyone this package is for, in signing order.</p>
      </header>

      ${tenants.map((tenant, index) => `
        <div class="ws-signer">
          <span class="ws-signer-order">${index + 1}</span>
          <div>
            <b>${escapeHtml(tenant.name)}</b>
            <p class="ws-hint">${tenant.email
              ? escapeHtml(tenant.email)
              : '<span class="ws-empty">No email address — the request cannot reach them</span>'}</p>
          </div>
          <span class="ws-signer-role">Tenant</span>
        </div>`).join("")
        || '<p class="ws-empty">No tenant named yet. Add one under Lease information.</p>'}

      <div class="ws-signer is-fixed">
        <span class="ws-signer-order">${tenants.length + 1}</span>
        <div>
          <b>${signer ? escapeHtml(signer) : '<span class="ws-empty">No signer set for this property</span>'}</b>
          <p class="ws-hint">${entity ? `for ${escapeHtml(entity)}` : "Landlord"} ·
            fixed for the property by a manager</p>
        </div>
        <span class="ws-signer-role">Landlord</span>
      </div>

      <p class="ws-hint">${state.isManager()
        ? 'The landlord signer is set on <a href="#/properties">Property lease settings</a>.'
        : "The landlord signer cannot be changed from a lease."}</p>
    </section>

    <section class="ws-section">
      <header class="ws-section-head">
        <h3>Sending</h3>
      </header>
      <p class="ws-hint">This console generates the signed-ready Word file and names
        who it is for. It is not connected to an e-signature service, so the file is
        downloaded and sent by whoever produces it — there is no delivery or signing
        status to report yet.</p>
    </section>`;
}

// One lease, one or more tenants. The application holds them as one string,
// which is what the lease prints; splitting it is only for naming the signers.
function tenantSigners(state) {
  const names = String(state.values["tenant.names"] || "")
    .split(/\s*(?:;|\band\b|&)\s*/)
    .map((name) => name.trim())
    .filter(Boolean);
  const email = state.values["tenant.email"] || "";
  if (names.length === 0) return [];
  // Only the first signer has a known address: the application collects one.
  return names.map((name, index) => ({ name, email: index === 0 ? email : "" }));
}

// ------------------------------------------------------- cheap re-annotation

// Everything that changes as somebody types, written in place. The panel is
// never re-rendered on a keystroke: it holds the caret.
export function annotateWorkspace(host, state) {
  for (const [id] of state.byId) {
    const status = host.querySelector(`[data-lease-status="${CSS.escape(id)}"]`);
    if (status) {
      const missing = state.missing.has(id);
      status.textContent = missing ? "Needed before this lease can be produced" : "";
      status.className = `ws-status${missing ? " is-missing" : ""}`;
    }
    const row = host.querySelector(`[data-ws-row="${CSS.escape(id)}"]`);
    if (row) {
      row.classList.toggle("is-missing", state.missing.has(id));
      row.classList.toggle("is-dirty", state.dirty.has(id));
    }
  }

  // The end date is not typed, so it has to follow the two values it is
  // computed from the moment either of them changes.
  const derived = host.querySelector('[data-ws-derived="lease.end_date"]');
  if (derived) derived.textContent = state.values["lease.end_date"] || "—";
}

// What the end date should say, given what is on screen now. lease-screen calls
// this after a change to either half and writes the result into the values.
export function recomputeEndDate(state) {
  const months = state.application?.lease_term_months;
  return endDateFor(state.values["lease.commencement_date"], months);
}

export { DOCUMENTS };
