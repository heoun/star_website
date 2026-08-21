// The field half of the lease screen: all 146 values, beside the document they
// fill in.
//
// The form is rendered ONCE and then only annotated. Rebuilding it on input
// would take the caret with it, and this is a screen someone types a paragraph
// of address into.
//
// Two things it must never blur, because both are how a wrong lease gets sent:
//
//   - Where a value is written. A deal value belongs to this one lease; a
//     manager value is a stored setting shared by every lease for that building.
//     Every manager field says which layer it will be written to, on the field.
//   - Whether a value is answered. A registry default is a suggestion from one
//     sample building, never a fallback, so an unanswered field shows the sample
//     as a hint that must be accepted deliberately.

// Where a value came from, and whether changing it here is normal. Every field
// is editable now — an application can be wrong, and a lease often has to be
// produced before any application exists.
const SOURCE_NOTE = {
  deal: "",
  agent: "Typed for this lease only."
};

// fields.json groups fields by a slug; a person reading the form should see a
// name. Unknown slugs fall back to the slug itself rather than disappearing.
const GROUP_NAMES = {
  lease_terms: "Lease terms",
  parties: "Parties",
  property: "Property",
  fees: "Fees and thresholds",
  fines: "Fine schedule",
  utilities: "Utilities and services",
  keys: "Keys and access",
  contacts: "Contacts",
  building_disclosures: "Building disclosures",
  good_cause: "Good Cause Eviction",
  forms: "Forms and notices"
};

function groupName(group) {
  return GROUP_NAMES[group] || group.replace(/_/g, " ");
}

let escapeHtml = (value) => String(value ?? "");

export function initForm(deps) {
  escapeHtml = deps.escapeHtml;
}

// ------------------------------------------------------------------ markup

function badge(state) {
  if (state === "complete") return '<span class="lease-badge is-complete" title="Every field answered">✓</span>';
  if (state === "partial") return '<span class="lease-badge is-partial" title="Some fields answered">◐</span>';
  return '<span class="lease-badge" title="Nothing answered yet">○</span>';
}

function provenanceNote(field, state) {
  if (field.source !== "manager") return SOURCE_NOTE[field.source] || "";

  const layer = state.provenance[field.id];
  if (!layer) return "";
  if (layer === state.scope) return `Set here, on ${escapeHtml(state.targetLabel)}.`;
  return `Inherited from ${layer} settings.`;
}

function control(field, state) {
  const value = state.values[field.id] ?? "";
  // Genuinely disabled, not just dimmed: pointer-events alone stops the mouse
  // and lets the keyboard through, so a tabbed-in value sat in the box while
  // the document stayed blank.
  const locked = state.editable(field) ? "" : " disabled";
  const attrs = `id="lease-input-${escapeHtml(field.id)}" data-lease-input="${escapeHtml(field.id)}"${locked}`;

  if (field.type === "checkbox") {
    return `<label class="lease-check">
      <input type="checkbox" ${attrs}${state.checked.has(field.id) ? " checked" : ""}>
      <span>${escapeHtml(field.label)}</span>
    </label>`;
  }

  if (field.type === "choice") {
    const options = ["", ...field.options].map((option) =>
      `<option value="${escapeHtml(option)}"${option === value ? " selected" : ""}>${escapeHtml(option || "— not answered —")}</option>`
    ).join("");
    return `<select ${attrs}>${options}</select>`;
  }

  if (field.type === "multiline") {
    return `<textarea ${attrs} rows="2">${escapeHtml(value)}</textarea>`;
  }

  return `<input type="text" ${attrs} value="${escapeHtml(value)}">`;
}

function fieldMarkup(field, state) {
  const count = state.occurrences[field.id] || 0;
  const editable = state.editable(field);
  const missing = state.missing.has(field.id);

  const stepper = count > 1
    ? `<span class="lease-step" data-lease-step="${escapeHtml(field.id)}">
         <button type="button" data-lease-step-delta="-1" aria-label="Previous place">‹</button>
         <span data-lease-step-label="${escapeHtml(field.id)}">1/${count}</span>
         <button type="button" data-lease-step-delta="1" aria-label="Next place">›</button>
       </span>`
    : "";

  const hint = missing && field.source_value
    ? `<span class="lease-hint">Sample lease had <b>${escapeHtml(field.source_value)}</b>
         <button type="button" data-lease-accept="${escapeHtml(field.id)}">Use it</button></span>`
    : "";

  const target = field.source === "manager" && editable
    ? (state.mode === "lease"
      ? '<span class="lease-once">this lease only — not saved to the unit</span>'
      : `<span class="lease-target">saved to ${escapeHtml(state.targetLabel)}</span>`)
    : "";

  return `<div class="lease-field${editable ? "" : " is-readonly"}" data-lease-row="${escapeHtml(field.id)}"
               data-group="${escapeHtml(field.group)}" data-source="${escapeHtml(field.source)}">
    <div class="lease-field-head">
      <label for="lease-input-${escapeHtml(field.id)}">${escapeHtml(field.label)}</label>
      ${count > 1 ? `<span class="lease-count" title="Printed in ${count} places">×${count}</span>` : ""}
      ${stepper}
      ${count > 0 ? `<button type="button" class="lease-locate" data-lease-locate="${escapeHtml(field.id)}">Find</button>` : ""}
    </div>
    ${field.type === "checkbox" ? "" : `<div class="lease-status" data-lease-status="${escapeHtml(field.id)}"></div>`}
    ${control(field, state)}
    <div class="lease-note">
      ${field.source === "deal"
        ? `<span class="lease-pending">${state.mode === "lease" ? "From the application — correct it here if it is wrong." : "About this tenancy; type it for this lease."}</span>`
        : ""}
      ${target}
      <span data-lease-provenance="${escapeHtml(field.id)}">${provenanceNote(field, state)}</span>
      ${field.note ? `<span class="lease-caution">${escapeHtml(field.note)}</span>` : ""}
      ${hint}
    </div>
  </div>`;
}

// Groups run in the order their first field appears in the document, so
// scrolling the form roughly tracks reading the lease.
function orderedGroups(state) {
  const seen = new Map();
  for (const id of state.documentOrder) {
    const field = state.byId.get(id);
    if (field && !seen.has(field.group)) seen.set(field.group, []);
  }
  for (const field of state.fields) {
    if (!seen.has(field.group)) seen.set(field.group, []);
    seen.get(field.group).push(field);
  }
  return [...seen.entries()];
}

export function renderForm(host, state) {
  const groups = orderedGroups(state);

  host.innerHTML = `
    <div class="lease-form-head">
      <div class="lease-progress" id="lease-progress"></div>
      <div class="lease-jump">
        <button type="button" id="lease-prev-missing">‹ Previous gap</button>
        <button type="button" id="lease-next-missing">Next gap ›</button>
      </div>
    </div>
    <input type="search" id="lease-search" placeholder="Search ${state.fields.length} fields…" autocomplete="off">
    <div class="filters lease-filters">
      <button type="button" class="chip is-on" data-lease-filter="all">All</button>
      <button type="button" class="chip" data-lease-filter="missing">Needs an answer</button>
      <button type="button" class="chip" data-lease-filter="unit">This unit</button>
      <button type="button" class="chip" data-lease-filter="building">Building</button>
      <button type="button" class="chip" data-lease-filter="company">Company</button>
    </div>
    <div class="lease-groups">
      ${groups.map(([group, fields]) => `
        <section class="lease-group" data-lease-group="${escapeHtml(group)}">
          <h3>
            <span>${escapeHtml(groupName(group))}</span>
            <span class="lease-group-count" data-lease-group-count="${escapeHtml(group)}"></span>
          </h3>
          ${fields.map((field) => fieldMarkup(field, state)).join("")}
        </section>`).join("")}
    </div>`;

  annotate(host, state);
}

// ------------------------------------------------------- cheap re-annotation

// Everything that changes as someone types is written here, never by
// re-rendering: counts, the per-field status line, the group badges.
export function annotate(host, state) {
  const answered = state.fields.filter((field) => !state.missing.has(field.id)).length;

  const progress = host.querySelector("#lease-progress");
  if (progress) {
    const gaps = state.missing.size;
    progress.innerHTML = `
      <b>${answered}/${state.fields.length}</b> answered
      ${gaps > 0 ? `<span class="lease-gap-count">${gaps} still needed</span>` : '<span class="lease-ok">nothing missing</span>'}
      `;
  }

  for (const field of state.fields) {
    const status = host.querySelector(`[data-lease-status="${CSS.escape(field.id)}"]`);
    if (status) {
      const missing = state.missing.has(field.id);
      status.textContent = missing ? "Not answered" : "";
      status.className = `lease-status${missing ? " is-missing" : ""}`;
    }
    const row = host.querySelector(`[data-lease-row="${CSS.escape(field.id)}"]`);
    if (row) {
      row.classList.toggle("is-missing", state.missing.has(field.id));
      row.classList.toggle("is-dirty", state.dirty.has(field.id));
    }
    const note = host.querySelector(`[data-lease-provenance="${CSS.escape(field.id)}"]`);
    if (note) note.innerHTML = provenanceNote(field, state);
  }

  for (const [group, fields] of orderedGroups(state)) {
    const total = fields.length;
    const done = fields.filter((field) => !state.missing.has(field.id)).length;
    const label = host.querySelector(`[data-lease-group-count="${CSS.escape(group)}"]`);
    if (label) {
      label.innerHTML = `${done}/${total} ${badge(done === total ? "complete" : done === 0 ? "empty" : "partial")}`;
    }
  }
}

export function setStepLabel(host, fieldId, index, total) {
  const label = host.querySelector(`[data-lease-step-label="${CSS.escape(fieldId)}"]`);
  if (label) label.textContent = `${index + 1}/${total}`;
}

// ------------------------------------------------------------- filtering

export function applyFilter(host, { filter, search, state }) {
  const needle = search.trim().toLowerCase();

  for (const row of host.querySelectorAll("[data-lease-row]")) {
    const id = row.dataset.leaseRow;
    const field = state.byId.get(id);
    if (!field) continue;

    const matchesSearch = needle === ""
      || field.label.toLowerCase().includes(needle)
      || id.includes(needle)
      || groupName(field.group).toLowerCase().includes(needle);

    const matchesFilter = filter === "all"
      || (filter === "missing" && state.missing.has(id))
      || (filter === "unit" && field.source !== "manager")
      || (filter === "building" && field.scope === "building")
      || (filter === "company" && field.scope === "company");

    row.hidden = !(matchesSearch && matchesFilter);
  }

  // A group with nothing left to show is noise.
  for (const group of host.querySelectorAll(".lease-group")) {
    const visible = [...group.querySelectorAll("[data-lease-row]")].some((row) => !row.hidden);
    group.hidden = !visible;
  }
}
