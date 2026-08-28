// One application, on its own page.
//
// This used to be a details element inside a list row, which meant the list of
// forty applications was also forty full applications: identity, employment,
// rental history, references, documents and a settings editor, all expanded
// into a column somebody had to scroll past to reach the next name. Reading
// one was fine. Working a pipeline was not.
//
// So the list is a list, and this is the page it opens. Two tabs, because the
// reader's first question is what the lease will print, and everything else is
// screening material behind it, opened a section at a time. One sticky panel
// down the right, because the answer to both is a decision.
//
// What stays out of here, deliberately:
//
//   the landlord's terms   they belong to the property, not to an applicant
//   the rent concession    the applicant is never asked for one; the lease
//                          workspace is where it is written
//   the lease end date     it follows from a term the agent confirms later
//
// What may be corrected here is deliberately narrow — the lease dates for
// anybody, the tenant's identity for a manager — through the same
// PATCH /applications/:id, keeping the same record of what the applicant
// originally wrote. The screening tab is the application record, read only.

import { openDocViewer } from "./doc-viewer.js";
import {
  STAGES,
  dayAndTime,
  documentSummary,
  hasLease,
  incomeSummary,
  money,
  plainDate,
  reference,
  requestedItems,
  shortDay,
  stageOf,
  statusLabel
} from "./application-view.js";

let api;
let setStatus;
let escapeHtml = (value) => String(value ?? "");
let isManager = () => false;
let documentTypesOf = () => [];
let onSaved = () => {};
let onDeleted = () => {};
let openLease = () => {};

export function initApplicationScreen(deps) {
  ({ api, setStatus, escapeHtml, isManager, onSaved, onDeleted, openLease } = deps);
  documentTypesOf = deps.documentTypes || (() => []);
}

// ------------------------------------------------------------------- shape

// Two tabs, split by one rule: a value the lease document prints — read off
// lease/schema/fields.json's `applications.*` sources — is on the first tab,
// and everything the applicant answered for screening is on the second.
const TABS = [
  ["lease", "INFO ON LEASE"],
  ["screening", "INFO NOT ON LEASE"]
];

const IDENTITY_FIELDS = [
  { key: "name", label: "Legal name(s)", type: "text",
    note: "Everyone who will sign the lease, as it prints." },
  { key: "first_name", label: "First name", type: "text" },
  { key: "last_name", label: "Last name", type: "text" },
  { key: "email", label: "Email", type: "email" },
  { key: "phone", label: "Phone", type: "tel" },
  { key: "current_address", label: "Current address", type: "text" }
];

const DETAIL_FIELDS = [
  { key: "dob", label: "Date of birth", type: "text", placeholder: "MM/DD/YYYY" }
];

// The window guard notice is the one part of the lease answered by check
// boxes rather than a printed value, which is why these two sit apart.
const GUARD_FIELDS = [
  { key: "children_under_11", label: "Children 10 or younger", type: "boolean",
    note: "Answers the window guard notice on the lease." },
  { key: "wants_window_guards", label: "Wants window guards anyway", type: "boolean",
    note: "The notice's third answer, for applicants without young children." }
];

const TENANCY_FIELDS = [
  { key: "move_in", label: "Lease start date", type: "text", placeholder: "MM/DD/YYYY" },
  { key: "lease_term_months", label: "Preferred term", type: "number", min: 1, max: 60,
    suffix: "months", note: "The agent confirms the term when the lease is made." }
];

const EMPLOYER_FIELDS = [
  { key: "employer", label: "Employer" },
  { key: "position", label: "Position" },
  { key: "start", label: "Employed since" },
  { key: "supervisor_name", label: "Supervisor" },
  { key: "supervisor_phone", label: "Supervisor phone" },
  { key: "supervisor_email", label: "Supervisor email" }
];

// What a student fills in instead of an employer.
const STUDENT_FIELDS = [
  { key: "school_name", label: "School name" },
  { key: "major", label: "Major" },
  { key: "entry_year", label: "School entry year" },
  { key: "graduation_year", label: "Graduation year" },
  { key: "country", label: "Country of citizenship" }
];

// Whether an application is a student's, wherever it needs answering. Rows
// from before the work-or-school question have no answer and read as
// employed, which is what their form asked about.
const isStudentApp = (app) => app?.employment_status === "student";

// Only roommates and pets ever open in an editor here; the other lists are
// the applicant's screening answers, read but never rewritten on this page.
const LISTS = {
  employment_history: { label: "Previous employment", least: 0, fields: [
    { key: "employer", label: "Employer" },
    { key: "position", label: "Position" },
    { key: "start", label: "Employed since" },
    { key: "end", label: "Until" },
    { key: "income", label: "Annual income" },
    { key: "supervisor_name", label: "Supervisor" },
    { key: "supervisor_phone", label: "Supervisor phone" },
    { key: "supervisor_email", label: "Supervisor email" }
  ] },
  rental_history: { label: "Rental history", least: 0, fields: [
    { key: "landlord_name", label: "Landlord" },
    { key: "address", label: "Address" },
    { key: "contact", label: "Contact" },
    { key: "landlord_phone", label: "Landlord phone" },
    { key: "landlord_email", label: "Landlord email" },
    { key: "start", label: "From" },
    { key: "end", label: "Until" },
    { key: "monthly_rent", label: "Monthly rent" }
  ] },
  reference_contacts: { label: "References", least: 2, fields: [
    { key: "name", label: "Name" },
    { key: "relationship", label: "Relationship" },
    { key: "phone", label: "Phone" },
    { key: "email", label: "Email" }
  ] },
  emergency_contacts: { label: "Emergency contacts", least: 0, fields: [
    { key: "name", label: "Name" },
    { key: "relationship", label: "Relationship" },
    { key: "phone", label: "Phone" },
    { key: "email", label: "Email" }
  ] },
  roommates: { label: "Roommates", least: 0, fields: [
    { key: "first_name", label: "First name" },
    { key: "last_name", label: "Last name" },
    { key: "phone", label: "Phone" },
    { key: "email", label: "Email" }
  ] },
  pets: { label: "Pets", least: 0, fields: [
    { key: "type", label: "Type", options: ["", "dog", "cat", "bird", "fish", "reptile", "other"] },
    { key: "species", label: "Breed or species" },
    { key: "weight", label: "Weight (lb)" }
  ] }
};

// What may be corrected on this page, and by whom. The lease dates are
// anybody's typo to fix; the tenant's identity — names, contact, the guard
// answers, roommates, pets — is a manager's, behind a confirmation, because
// these rewrite what the applicant answered. Everything on the screening tab
// is the application record and is not edited here at all. Rent, due date,
// deposit and riders are the lease workspace's.
function editRules() {
  return isManager()
    ? { scalars: [...IDENTITY_FIELDS, ...TENANCY_FIELDS, ...GUARD_FIELDS], lists: ["roommates", "pets"] }
    : { scalars: TENANCY_FIELDS, lists: [] };
}

// ------------------------------------------------------------------- state

// Which tab is open survives a re-render — reading the documents, correcting
// a value and coming back should not throw the reader to the top — but not a
// different application: opening somebody else starts at the top.
let openId = "";
let tab = "lease";
let editing = "";
// Which screening sections are unfolded. A save re-renders the whole page,
// and the section being worked in should still be open afterwards.
let expanded = new Set();
// "decline" or "request": the two actions that ask for a sentence before they
// happen, shown inline rather than through a browser prompt.
let pending = "";

export function resetApplicationScreen() {
  openId = "";
  tab = "lease";
  editing = "";
  expanded = new Set();
  pending = "";
}

// --------------------------------------------------------------- read rows

function fact(label, value, hint) {
  const shown = value === null || value === undefined || value === ""
    ? '<span class="soft">—</span>'
    : escapeHtml(value);
  return `<div class="fact">
    <dt>${escapeHtml(label)}</dt>
    <dd>${shown}${hint ? `<span class="fact-hint">${escapeHtml(hint)}</span>` : ""}</dd>
  </div>`;
}

function factHtml(label, html) {
  return `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${html}</dd></div>`;
}

function group(title, body) {
  return `<section class="factgroup">
    <h3>${escapeHtml(title)}</h3>
    <dl class="factlist">${body}</dl>
  </section>`;
}

function shownValue(app, field) {
  const value = app[field.key];
  if (field.type === "boolean") return value === true ? "Yes" : value === false ? "No" : "";
  if (value === null || value === undefined) return "";
  return String(value);
}

// What the applicant wrote before somebody corrected it. The lease has the
// tenant warrant that the application is accurate, so the version they
// warranted is shown under the value that replaced it.
function correctionNote(app, field) {
  const submitted = app.submitted || {};
  if (!(field.key in submitted)) return "";
  const was = submitted[field.key];
  const text = field.type === "boolean"
    ? (was === true ? "Yes" : was === false ? "No" : "—")
    : (was === null || was === "" ? "nothing" : String(was));
  return `<span class="fact-was">corrected · applicant wrote ${escapeHtml(text)}</span>`;
}

function readField(app, field) {
  const value = shownValue(app, field);
  const shown = value && field.suffix ? `${value} ${field.suffix}` : value;
  return `<div class="fact">
    <dt>${escapeHtml(field.label)}</dt>
    <dd>${shown ? escapeHtml(shown) : '<span class="soft">—</span>'}${correctionNote(app, field)}</dd>
  </div>`;
}

function editField(app, field) {
  const id = `appl-edit-${field.key}`;
  const value = app[field.key] ?? "";
  const common = `id="${id}" data-appl-input="${escapeHtml(field.key)}"`;

  let control;
  if (field.type === "boolean") {
    const answered = app[field.key] === null || app[field.key] === undefined;
    control = `<select ${common}>
      <option value=""${answered ? " selected" : ""}>— not answered —</option>
      <option value="yes"${app[field.key] === true ? " selected" : ""}>Yes</option>
      <option value="no"${app[field.key] === false ? " selected" : ""}>No</option>
    </select>`;
  } else if (field.type === "multiline") {
    control = `<textarea ${common} rows="3">${escapeHtml(value)}</textarea>`;
  } else if (field.type === "number") {
    control = `<input type="number" ${common} min="${field.min}" max="${field.max}" value="${escapeHtml(value)}">`;
  } else {
    const type = field.type === "email" ? "email" : field.type === "tel" ? "tel" : "text";
    control = `<input type="${type}" ${common} value="${escapeHtml(value)}"${
      field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : ""}>`;
  }

  return `<div class="fact is-edit">
    <dt><label for="${id}">${escapeHtml(field.label)}</label></dt>
    <dd>${control}
      ${field.note ? `<span class="fact-hint">${escapeHtml(field.note)}</span>` : ""}
      ${correctionNote(app, field)}</dd>
  </div>`;
}

function fields(app, list, edit) {
  return list.map((field) => (edit ? editField(app, field) : readField(app, field))).join("");
}

// -------------------------------------------------------------- list rows

function entryRow(key, entry, index) {
  const list = LISTS[key];
  const cells = list.fields.map((field) => {
    const value = entry?.[field.key] ?? "";
    const control = field.options
      ? `<select data-appl-entry="${escapeHtml(field.key)}">${field.options
          .map((option) => `<option value="${escapeHtml(option)}"${option === value ? " selected" : ""}>${
            escapeHtml(option || "—")}</option>`).join("")}</select>`
      : `<input type="text" data-appl-entry="${escapeHtml(field.key)}" value="${escapeHtml(value)}">`;
    return `<label><span>${escapeHtml(field.label)}</span>${control}</label>`;
  }).join("");

  return `<div class="entry" data-appl-index="${index}">
    ${cells}
    <button type="button" class="small danger" data-appl-remove>Remove</button>
  </div>`;
}

function entryEditor(app, key) {
  const list = LISTS[key];
  const entries = orderedEntries(app, key);
  return `<div class="entries" data-appl-list="${escapeHtml(key)}">${
    entries.map((entry, index) => entryRow(key, entry, index)).join("")}</div>
    <button type="button" class="small" data-appl-add="${escapeHtml(key)}">Add ${
      escapeHtml(list.label.toLowerCase())}</button>`;
}

// Most recent residence first. `start` and `end` are whatever the applicant
// typed — "August 2022", "8/2022" — so anything a Date will not read keeps its
// place rather than being shuffled somewhere arbitrary. The order shown is the
// order saved, so what a reader sees and what an editor edits are one list.
function orderedEntries(app, key) {
  const entries = Array.isArray(app[key]) ? app[key] : [];
  if (key !== "rental_history") return entries;

  const when = (entry) => {
    const parsed = Date.parse(entry?.end || entry?.start || "");
    return Number.isNaN(parsed) ? null : parsed;
  };

  return entries
    .map((entry, index) => ({ entry, index, at: when(entry) }))
    .sort((a, b) => {
      if (a.at === null && b.at === null) return a.index - b.index;
      if (a.at === null) return 1;
      if (b.at === null) return -1;
      return b.at - a.at;
    })
    .map((item) => item.entry);
}

function entryCards(app, key, render) {
  const entries = orderedEntries(app, key);
  if (entries.length === 0) {
    return `<p class="none">Nothing was entered for ${escapeHtml(LISTS[key].label.toLowerCase())}.${
      LISTS[key].least > 0 ? ` The form asks for ${LISTS[key].least}.` : ""}</p>`;
  }
  return `<div class="cards">${entries.map(render).join("")}</div>`;
}

// ------------------------------------------------------------------- head

function editTools(section) {
  if (editing === section) {
    return `<div class="phead-tools">
      <button type="button" class="small primary" data-appl-save>Save</button>
      <button type="button" class="small" data-appl-cancel>Cancel</button>
    </div>`;
  }
  return `<div class="phead-tools">
    <button type="button" class="small" data-appl-edit="${escapeHtml(section)}">Edit</button>
  </div>`;
}

function panel(title, note, body, { section = "", extra = "" } = {}) {
  return `<article class="panel${extra ? ` ${extra}` : ""}">
    <div class="phead">
      <div><h2>${escapeHtml(title)}</h2>${note ? `<p>${escapeHtml(note)}</p>` : ""}</div>
      ${section ? editTools(section) : ""}
    </div>
    <div class="pbody">${body}</div>
  </article>`;
}

// ------------------------------------------------------------------ tabs

// A screening section: closed, one line saying what it holds; open, the same
// panel it always was. The record is read here, not rewritten, so a fold
// carries no tools.
function fold(key, title, note, body) {
  return `<details class="appl-fold"${expanded.has(key) ? " open" : ""} data-appl-fold="${escapeHtml(key)}">
    <summary>
      <span class="appl-fold-title">${escapeHtml(title)}</span>
      ${note ? `<span class="appl-fold-note">${escapeHtml(note)}</span>` : ""}
    </summary>
    <div class="appl-fold-body">${body}</div>
  </details>`;
}

// In edit mode only the fields this reader may correct become inputs; the
// rest stay read rows, so what a save can touch is what the screen showed
// as touchable.
function gatedFields(app, list, edit) {
  const allowed = new Set(editRules().scalars.map((field) => field.key));
  return list.map((field) =>
    (edit && allowed.has(field.key) ? editField(app, field) : readField(app, field))).join("");
}

function leaseTab(app) {
  const edit = editing === "lease";
  const listing = app.listings || null;
  const canEditLists = edit && isManager();

  const tenant = group("Tenant", gatedFields(app, IDENTITY_FIELDS, edit)
    + (edit ? "" : fact("Also named", coApplicants(app))));

  const where = [
    fact("Listing", listing?.title, listing
      ? "" : "The listing this application was made against has been removed."),
    listing?.property_name ? fact("Property", listing.property_name) : "",
    fact("Unit", listing?.unit)
  ].join("");
  const tenancy = group("The tenancy applied for", where + gatedFields(app, TENANCY_FIELDS, edit));

  const guards = group("Window guard notice", gatedFields(app, GUARD_FIELDS, edit));

  const roommates = canEditLists
    ? entryEditor(app, "roommates")
    : entryCards(app, "roommates", (mate) => `<div class="card">
        <b>${escapeHtml(`${mate.first_name || ""} ${mate.last_name || ""}`.trim() || "Not named")}</b>
        <dl class="factlist">
          ${fact("Phone", mate.phone)}
          ${fact("Email", mate.email)}
        </dl></div>`);

  const pets = canEditLists
    ? entryEditor(app, "pets")
    : entryCards(app, "pets", (pet) => `<div class="card">
        <b>${escapeHtml(pet.type || "Pet")}</b>
        <dl class="factlist">
          ${fact("Breed or species", pet.species)}
          ${fact("Weight", pet.weight ? `${pet.weight} lb` : "")}
        </dl></div>`);

  return panel("Lease Contents",
    "These are starting values from the application. Agent should confirm final lease terms when creating the lease.",
    `<div class="facts">${tenant}${tenancy}${guards}</div>
     <div class="sub"><h3>Roommates</h3>${roommates}
       <p class="note">A roommate is on the lease once the agent adds them to the tenant legal names.</p></div>
     <div class="sub"><h3>Pets</h3>${pets}</div>
     <p class="note">Rent, deposit, concession, prorated rent and every other transaction term are
        settled in the lease workspace, not here.</p>`,
    { section: "lease", extra: "is-start" });
}

function screeningTab(app) {
  return [
    detailsSection(app),
    incomeSection(app),
    rentalSection(app),
    documentsSection(app),
    referencesSection(app)
  ].join("");
}

// The lease prints one `name`, and it may hold more than one person. Anything
// joined by "and", "&" or a comma is somebody else who will sign.
function coApplicants(app) {
  const parts = String(app.name || "").split(/\s*(?:,| and | & )\s*/i).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(", ") : "";
}

function detailsSection(app) {
  const details = `<dl class="factlist">${fields(app, DETAIL_FIELDS, false) + ssnRow(app)}</dl>`;

  const message = app.message
    ? `<p class="longtext">${escapeHtml(app.message)}</p>`
    : '<p class="none">The applicant did not add a message.</p>';

  return fold("details", "Applicant details", "Identity details kept for screening.",
    `${details}
     <div class="sub"><h3>Anything else the applicant wrote</h3>${message}</div>
     <p class="sensitive">Sensitive information is masked. ${
       isManager()
         ? "Revealing the full identity number is a manager’s, and it is never shown in the lease workflow."
         : "The full identity number is a manager’s to see, and it is never shown in the lease workflow."}</p>`);
}

// The identity number is an SSN or, for applicants without one, a passport
// number; `id_type` says which this row holds and the mask follows.
function idNumberMask(app) {
  return app.id_type === "passport" ? `•••••${app.ssn_last4}` : `•••-••-${app.ssn_last4}`;
}

function idNumberLabel(app) {
  return app.id_type === "passport" ? "Passport number" : "Social Security number";
}

// The full number is fetched one at a time, from an endpoint only a manager may
// call, and it is never part of the applications payload. The control is a
// small text button rather than a button beside the value, because reading
// somebody's identity number should take a decision, not a reflex.
function ssnRow(app) {
  if (!app.ssn_last4) return "";
  const masked = escapeHtml(idNumberMask(app));
  if (!isManager()) return fact(idNumberLabel(app), idNumberMask(app));
  return factHtml(idNumberLabel(app),
    `<span data-role="ssn-cell">${masked}</span>
     <button type="button" class="link reveal" data-role="ssn-reveal">Reveal in full</button>`);
}

function incomeSection(app) {
  const income = incomeSummary(app);
  const employer = app.current_employer || {};
  const student = app.student || {};

  // The work-or-school branch: the section shows the half this application
  // answered. The other half was never asked.
  const current = isStudentApp(app)
    ? group("Study", STUDENT_FIELDS.map((field) => fact(field.label, student[field.key])).join(""))
    : group("Current employment",
      EMPLOYER_FIELDS.map((field) => fact(field.label, employer[field.key])).join(""));

  const summary = group("Income",
    fact("Annual income", income.annual === null ? income.written : money(income.annual)));

  // Older records carry keys the form no longer asks about — an end date, a
  // supervisor — and what was answered then should still be readable now.
  const history = entryCards(app, "employment_history", (entry) => `<div class="card">
        <b>${escapeHtml(entry.employer || "Employer")}</b>
        <dl class="factlist">
          ${fact("Position", entry.position)}
          ${fact("Employed since", entry.start)}
          ${entry.end ? fact("Until", entry.end) : ""}
          ${fact("Annual income", entry.income)}
          ${entry.supervisor_name ? fact("Supervisor", entry.supervisor_name) : ""}
          ${entry.supervisor_phone ? fact("Supervisor phone", entry.supervisor_phone) : ""}
          ${entry.supervisor_email ? fact("Supervisor email", entry.supervisor_email) : ""}
        </dl></div>`);

  const historyBlock = isStudentApp(app)
    && (!Array.isArray(app.employment_history) || app.employment_history.length === 0)
    ? ""
    : `<div class="sub"><h3>Previous employment</h3>${history}</div>`;

  return fold("income", isStudentApp(app) ? "Study and income" : "Employment and income",
    "How the rent is supported.",
    `<div class="facts">${current}${summary}</div>${historyBlock}`);
}

function rentalSection(app) {
  const body = entryCards(app, "rental_history", (entry) => `<div class="card">
        <b>${escapeHtml(entry.address || "Address not given")}</b>
        <dl class="factlist">
          ${fact("From", entry.start)}
          ${fact("Until", entry.end)}
          ${fact("Monthly rent", entry.monthly_rent)}
          ${fact("Landlord", entry.landlord_name)}
          ${fact("Contact", entry.contact)}
          ${fact("Landlord phone", entry.landlord_phone)}
          ${fact("Landlord email", entry.landlord_email)}
        </dl></div>`);

  return fold("rental", "Rental history", "Most recent residence first.", body);
}

function referencesSection(app) {
  const contactCard = (entry) => `<div class="card">
    <b>${escapeHtml(entry.name || "Not named")}</b>
    <dl class="factlist">
      ${fact("Relationship", entry.relationship)}
      ${fact("Phone", entry.phone)}
      ${fact("Email", entry.email)}
    </dl></div>`;

  return fold("references", "References and contacts",
    "References the applicant named, and who to reach in an emergency.",
    `<div class="sub"><h3>References</h3>${entryCards(app, "reference_contacts", contactCard)}</div>
     <div class="sub"><h3>Emergency contacts</h3>${entryCards(app, "emergency_contacts", contactCard)}</div>`);
}

// ------------------------------------------------------------- documents

const DOC_STATES = {
  received: { label: "Received", tone: "good" },
  // Satisfied by an alternative — an offer letter standing in for paystubs.
  covered: { label: "Covered", tone: "good" },
  partial: { label: "Partly received", tone: "busy" },
  missing: { label: "Missing", tone: "bad" },
  optional: { label: "Optional", tone: "off" }
};

function documentsSection(app) {
  const docs = documentSummary(app, documentTypesOf());

  if (!docs) {
    return fold("documents", "Documents", "No document checklist on this database.",
      `<p class="none">This database has no document checklist. Run supabase/schema.sql on it and
        the applicant's uploads appear here.</p>`);
  }

  const rows = docs.rows.map((row) => {
    const state = DOC_STATES[row.state];
    const count = row.type.required > 1
      ? `${row.files.length} of ${row.type.required}`
      : (row.files.length === 1 ? "1 file" : row.files.length ? `${row.files.length} files` : "No files");

    const names = row.files.length
      ? row.files.map((file) => escapeHtml(file.file_name || "document")).join(", ")
      : "";

    return `<div class="docrow${row.state === "missing" ? " is-missing" : ""}">
      <div>
        <b>${escapeHtml(row.type.label)}</b>
        <small>${escapeHtml(row.type.hint || "")}</small>
      </div>
      <span class="pill is-${state.tone}">${escapeHtml(state.label)}</span>
      <div class="docfiles">
        <span class="docfiles-count">${escapeHtml(count)}</span>
        ${names ? `<small>${names}</small>` : ""}
      </div>
      <div class="docactions">
        ${row.files.length
          ? `<button type="button" class="small" data-appl-view="${escapeHtml(row.type.id)}">View</button>`
          : '<span class="soft">Uploaded by the applicant</span>'}
        ${row.files.length ? docMenu(row) : ""}
      </div>
    </div>`;
  }).join("");

  return fold("documents", "Documents",
    docs.complete ? "Every required document has been received."
      : `${docs.requiredMet} of ${docs.required} required received.`,
    `<div class="counts">
        <div class="count"><span class="k">Required received</span><b>${docs.requiredMet} / ${docs.required}</b></div>
        <div class="count"><span class="k">Optional received</span><b>${docs.optionalReceived} / ${docs.optional}</b></div>
        <div class="count"><span class="k">Missing</span><b class="${docs.missing ? "is-bad" : "is-good"}">${docs.missing}</b></div>
        <div class="count"><span class="k">Overall</span><b class="${docs.complete ? "is-good" : ""}">${
          docs.complete ? "Complete" : `${Math.round((docs.requiredMet / Math.max(docs.required, 1)) * 100)}%`}</b></div>
     </div>
     <div class="doclist">${rows}</div>
     <p class="note">The applicant uploads these at /portal/. Opening one shows the file itself.</p>`);
}

// Replace, download and remove are one click away, not zero: a red Delete
// beside every filename is a mis-click away from making the applicant upload
// their passport again.
function docMenu(row) {
  const single = row.files.length === 1 ? row.files[0] : null;
  return `<details class="menu">
    <summary aria-label="More actions for ${escapeHtml(row.type.label)}">⋯</summary>
    <div class="menu-sheet">
      ${single
        ? `<a class="menu-link" href="/api/admin/documents/${escapeHtml(single.id)}"
             download="${escapeHtml(single.file_name || "document")}">Download</a>`
        : '<p class="menu-note">Open the checklist entry to download one file.</p>'}
      <p class="menu-note">A replacement is uploaded by the applicant at /portal/. Removing a file
         here asks them for it again.</p>
      ${row.files.map((file) => `<button type="button" class="danger"
        data-appl-remove-doc="${escapeHtml(file.id)}">Remove ${
          escapeHtml(file.file_name || "this file")}</button>`).join("")}
    </div>
  </details>`;
}

// -------------------------------------------------------- decision panel

function decisionPanel(app) {
  const stage = stageOf(app);
  const items = requestedItems(app, documentTypesOf());
  const decision = app.decision || null;

  const statusSelect = `<select id="appl-status" data-role="appl-status">${
    STAGES.map((entry) => `<optgroup label="${escapeHtml(entry.label)}">${
      entry.values.map((value) =>
        `<option value="${value}"${app.status === value ? " selected" : ""}>${
          escapeHtml(statusLabel(value))}</option>`).join("")}</optgroup>`).join("")}</select>`;

  return `<aside class="decide">
    <div class="decide-head">
      <h2>Application decision</h2>
      <p>What happens next, and the record of who decided it.</p>
    </div>
    <div class="decide-body">
      <div class="decide-now">
        <span class="pill is-${stage.tone}">${escapeHtml(stage.label)}</span>
      </div>

      <label for="appl-status">Status</label>
      ${statusSelect}

      <label for="appl-notes">Screening outcome and internal notes</label>
      <textarea id="appl-notes" data-role="appl-notes"
        placeholder="Decision notes, follow-ups, what the landlord said…">${escapeHtml(app.notes || "")}</textarea>

      ${items.length > 0 ? `<div class="decide-missing">
        <b>Still outstanding</b>
        <ul>${items.slice(0, 5).map((item) => `<li>${escapeHtml(item.label)}${
          item.detail ? ` <span class="soft">— ${escapeHtml(item.detail)}</span>` : ""}</li>`).join("")}</ul>
        ${items.length > 5 ? `<p class="soft">and ${items.length - 5} more</p>` : ""}
      </div>` : '<p class="decide-clear">Nothing is outstanding on this application.</p>'}

      <dl class="decide-meta">
        ${fact("Last updated", dayAndTime(app.updated_at || app.created_at))}
        ${fact("Reviewed by", decision?.by || "")}
        ${fact("Decided", decision?.at ? dayAndTime(decision.at) : "")}
        ${fact("Lease", hasLease(app) ? "Created" : "Not created")}
      </dl>

      ${decision?.reason ? `<p class="decide-reason"><b>Reason given</b><br>${escapeHtml(decision.reason)}</p>` : ""}

      ${pendingBlock(app)}
      ${actionButtons(app, stage)}
    </div>
  </aside>`;
}

function pendingBlock(app) {
  if (pending === "decline") {
    return `<div class="decide-ask">
      <label for="appl-reason">Why is it declined?</label>
      <textarea id="appl-reason" data-role="appl-reason" rows="3"
        placeholder="Kept on the application record."></textarea>
      <div class="decide-buttons">
        <button type="button" class="danger" data-appl-confirm="declined">Decline this application</button>
        <button type="button" data-appl-cancel-ask>Cancel</button>
      </div>
    </div>`;
  }

  if (pending === "request") {
    const items = requestedItems(app, documentTypesOf());
    return `<div class="decide-ask">
      <b>The applicant will be asked for</b>
      ${items.length
        ? `<ul>${items.map((item) => `<li>${escapeHtml(item.label)}</li>`).join("")}</ul>`
        : '<p class="soft">Nothing is outstanding — say what is needed below.</p>'}
      <label for="appl-reason">Anything to add</label>
      <textarea id="appl-reason" data-role="appl-reason" rows="3"
        placeholder="Kept on the application record."></textarea>
      <p class="soft">This records the request. Sending it is still a message you write yourself —
         nothing here emails the applicant.</p>
      <div class="decide-buttons">
        <button type="button" class="primary" data-appl-confirm="needs_info">Mark as needing information</button>
        <button type="button" data-appl-cancel-ask>Cancel</button>
      </div>
    </div>`;
  }

  return "";
}

function actionButtons(app, stage) {
  if (pending) return "";

  const buttons = [];

  if (stage.key === "new" || stage.key === "review") {
    buttons.push('<button type="button" data-appl-ask="request">Request information</button>');
    buttons.push('<button type="button" class="primary" data-appl-set="approved">Approve</button>');
    buttons.push('<button type="button" class="danger" data-appl-ask="decline">Decline…</button>');
  } else if (stage.key === "needs_info") {
    buttons.push('<button type="button" data-appl-goto="documents">View requested items</button>');
    buttons.push('<button type="button" data-appl-set="review">Mark information received</button>');
    buttons.push('<button type="button" class="primary" data-appl-set="approved">Approve</button>');
    buttons.push('<button type="button" class="danger" data-appl-ask="decline">Decline…</button>');
  } else if (stage.key === "approved") {
    buttons.push('<button type="button" class="primary is-wide" data-appl-lease>Create lease</button>');
    buttons.push('<button type="button" data-appl-set="review">Reopen review</button>');
  } else if (stage.key === "declined") {
    buttons.push('<button type="button" data-appl-set="review">Reopen review</button>');
  } else if (stage.key === "lease") {
    buttons.push('<button type="button" class="primary is-wide" data-appl-lease>Open lease</button>');
  }

  const note = stage.key === "approved"
    ? `<p class="decide-note">Approved. Creating the lease opens the lease workspace, where the agent
        confirms the transaction terms. There is no second approval.</p>`
    : "";

  // Deleting the application is a manager's; an agent's menu would hold one
  // refused button, so it is not drawn at all.
  const more = isManager()
    ? `<details class="menu decide-more">
        <summary aria-label="More actions">More</summary>
        <div class="menu-sheet">
          <button type="button" class="danger" data-appl-delete>Delete application</button>
          <p class="menu-note">Removes the application, its answers and its uploaded documents.
             This cannot be undone.</p>
        </div>
      </details>`
    : "";

  return `<div class="decide-buttons">${buttons.join("")}</div>${note}${more}`;
}

// ------------------------------------------------------------------ public

export function renderApplicationScreen(host, app) {
  if (app.id !== openId) {
    openId = app.id;
    tab = "lease";
    editing = "";
    expanded = new Set();
    pending = "";
  }

  const stage = stageOf(app);
  const income = incomeSummary(app);
  const docs = documentSummary(app, documentTypesOf());
  const docFact = docs
    ? (docs.complete ? "Complete" : `${docs.requiredMet} of ${docs.required}`)
    : "—";

  const bodies = {
    lease: leaseTab,
    screening: screeningTab
  };

  host.innerHTML = `
    <button type="button" class="link back" data-appl-back>← All applications</button>

    <div class="pagehead">
      <div>
        <span class="appl-id">Application ${escapeHtml(reference(app))}</span>
        <h1>${escapeHtml(app.name || "Applicant")}</h1>
      </div>
      <span class="pill is-${stage.tone} is-large">${escapeHtml(stage.label)}</span>
    </div>

    <div class="statbar is-wide">
      <div class="stat is-lead">
        <span class="dot${stage.tone === "good" ? "" : stage.tone === "bad" ? " is-bad" : " is-warn"}"></span>
        <div>
          <span class="k">Applicant</span>
          <b>${escapeHtml(app.name || "—")}</b>
          <small>${escapeHtml(app.email || "")}</small>
        </div>
      </div>
      <div class="stat"><span class="k">Applied</span><b>${escapeHtml(shortDay(app.created_at))}</b></div>
      <div class="stat"><span class="k">Lease start</span><b>${escapeHtml(plainDate(app.move_in))}</b></div>
      ${isStudentApp(app)
        ? `<div class="stat"><span class="k">Student at</span><b>${
            escapeHtml(app.student?.school_name || "—")}</b></div>`
        : `<div class="stat"><span class="k">Annual income</span><b>${
            escapeHtml(income.annual === null ? (income.written || "—") : money(income.annual))}</b></div>`}
      <div class="stat"><span class="k">Documents</span><b class="${
        docs && docs.complete ? "is-good" : docs && docs.missing ? "is-bad" : ""}">${escapeHtml(docFact)}</b></div>
    </div>

    <div class="tabs" role="tablist" aria-label="Application sections">
      ${TABS.map(([key, label]) => `<button type="button" class="tab" role="tab"
        id="appl-tab-${key}" data-appl-tab="${key}" aria-selected="${key === tab}"
        aria-controls="appl-panel">${escapeHtml(label)}</button>`).join("")}
    </div>

    <div class="appl-cols">
      <div id="appl-panel" role="tabpanel" aria-labelledby="appl-tab-${tab}" tabindex="0">
        ${bodies[tab](app)}
      </div>
      ${decisionPanel(app)}
    </div>`;
}

// ---------------------------------------------------------------- writing

function collect(host) {
  const rules = editRules();
  const values = {};

  for (const input of host.querySelectorAll("[data-appl-input]")) {
    const key = input.dataset.applInput;
    const field = rules.scalars.find((entry) => entry.key === key);
    if (!field) continue;
    if (field.type === "boolean") {
      values[key] = input.value === "yes" ? true : input.value === "no" ? false : null;
    } else if (field.type === "number") {
      values[key] = input.value === "" ? null : Number(input.value);
    } else {
      values[key] = input.value.trim();
    }
  }

  for (const key of rules.lists) {
    const list = host.querySelector(`[data-appl-list="${CSS.escape(key)}"]`);
    if (!list) continue;
    values[key] = [...list.querySelectorAll(".entry")].map((row) => {
      const entry = {};
      for (const input of row.querySelectorAll("[data-appl-entry]")) {
        entry[input.dataset.applEntry] = input.value.trim();
      }
      return entry;
    });
  }

  return values;
}

async function patch(app, body, message) {
  setStatus("Saving…");
  try {
    const { application } = await api(`/applications/${encodeURIComponent(app.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    Object.assign(app, application);
    setStatus(message || "Saved.");
    onSaved(application);
    return true;
  } catch (error) {
    setStatus(error.message, "error");
    return false;
  }
}

// ----------------------------------------------------------------- events

// Returns true when it handled the click, so admin.js can stop looking.
export async function handleApplicationClick(event, host, app) {
  const back = event.target.closest("[data-appl-back]");
  if (back) {
    location.hash = "#/applications";
    return true;
  }

  const tabButton = event.target.closest("[data-appl-tab]");
  if (tabButton) {
    tab = tabButton.dataset.applTab;
    editing = "";
    renderApplicationScreen(host, app);
    host.querySelector(`[data-appl-tab="${CSS.escape(tab)}"]`)?.focus();
    return true;
  }

  // The fold's open state is ours, not the browser's: a save re-renders the
  // whole page, and a details element rebuilt from HTML forgets it was open.
  const summary = event.target.closest("summary");
  if (summary) {
    const key = summary.closest("details")?.dataset.applFold;
    if (key) {
      event.preventDefault();
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      renderApplicationScreen(host, app);
      host.querySelector(`[data-appl-fold="${CSS.escape(key)}"] > summary`)?.focus();
      return true;
    }
  }

  const jump = event.target.closest("[data-appl-goto]");
  if (jump) {
    tab = "screening";
    expanded.add(jump.dataset.applGoto);
    editing = "";
    pending = "";
    renderApplicationScreen(host, app);
    return true;
  }

  const startEdit = event.target.closest("[data-appl-edit]");
  if (startEdit) {
    // A manager's edit reaches the tenant's identity, so it is a decision,
    // not a reflex: the applicant's original answers stay on the record.
    if (isManager() && !confirm(
      "Editing here corrects what the applicant answered. The original answers stay on the record. Continue?")) {
      return true;
    }
    editing = startEdit.dataset.applEdit;
    renderApplicationScreen(host, app);
    return true;
  }

  if (event.target.closest("[data-appl-cancel]")) {
    editing = "";
    renderApplicationScreen(host, app);
    return true;
  }

  if (event.target.closest("[data-appl-save]")) {
    if (!editing) return true;
    const saved = await patch(app, collect(host), "Saved.");
    if (saved) editing = "";
    renderApplicationScreen(host, app);
    return true;
  }

  const add = event.target.closest("[data-appl-add]");
  if (add) {
    const key = add.dataset.applAdd;
    const list = host.querySelector(`[data-appl-list="${CSS.escape(key)}"]`);
    list.insertAdjacentHTML("beforeend", entryRow(key, {}, list.children.length));
    return true;
  }

  if (event.target.closest("[data-appl-remove]")) {
    event.target.closest(".entry").remove();
    return true;
  }

  const view = event.target.closest("[data-appl-view]");
  if (view) {
    const types = documentTypesOf();
    const type = types.find((entry) => entry.id === view.dataset.applView);
    const files = (app.application_documents || []).filter((doc) => doc.doc_type === view.dataset.applView);
    openDocViewer({ title: type?.label || "Uploaded document", files });
    return true;
  }

  const removeDoc = event.target.closest("[data-appl-remove-doc]");
  if (removeDoc) {
    removeDoc.closest("details")?.removeAttribute("open");
    await deleteDocument(host, app, removeDoc.dataset.applRemoveDoc);
    return true;
  }

  const ask = event.target.closest("[data-appl-ask]");
  if (ask) {
    pending = ask.dataset.applAsk;
    renderApplicationScreen(host, app);
    host.querySelector('[data-role="appl-reason"]')?.focus();
    return true;
  }

  if (event.target.closest("[data-appl-cancel-ask]")) {
    pending = "";
    renderApplicationScreen(host, app);
    return true;
  }

  const confirmAsk = event.target.closest("[data-appl-confirm]");
  if (confirmAsk) {
    const reason = host.querySelector('[data-role="appl-reason"]')?.value.trim() || "";
    const status = confirmAsk.dataset.applConfirm;
    pending = "";
    await patch(app, { status, decision_reason: reason }, statusMessage(status));
    renderApplicationScreen(host, app);
    return true;
  }

  const set = event.target.closest("[data-appl-set]");
  if (set) {
    const status = set.dataset.applSet;
    await patch(app, { status }, statusMessage(status));
    renderApplicationScreen(host, app);
    return true;
  }

  if (event.target.closest("[data-appl-lease]")) {
    openLease(app);
    return true;
  }

  const remove = event.target.closest("[data-appl-delete]");
  if (remove) {
    remove.closest("details")?.removeAttribute("open");
    if (!confirm(`Delete the application from "${app.name}"? This cannot be undone.`)) return true;
    try {
      await api(`/applications/${encodeURIComponent(app.id)}`, { method: "DELETE" });
      setStatus("Application deleted.");
      onDeleted(app.id);
    } catch (error) {
      setStatus(error.message, "error");
    }
    return true;
  }

  const reveal = event.target.closest('[data-role="ssn-reveal"]');
  if (reveal) {
    await revealSsn(host, app, reveal);
    return true;
  }

  return false;
}

function statusMessage(status) {
  if (status === "approved") return "Approved.";
  if (status === "declined") return "Declined.";
  if (status === "needs_info") return "Marked as needing information.";
  if (status === "review") return "Back under review.";
  return "Saved.";
}

async function deleteDocument(host, app, id) {
  if (!confirm("Remove this file? The applicant will have to upload it again.")) return;
  try {
    await api(`/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
    app.application_documents = (app.application_documents || []).filter((doc) => doc.id !== id);
    setStatus("File removed.");
    onSaved(app);
    renderApplicationScreen(host, app);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function revealSsn(host, app, button) {
  const cell = host.querySelector('[data-role="ssn-cell"]');

  if (button.dataset.shown === "true") {
    if (cell) cell.textContent = idNumberMask(app);
    button.dataset.shown = "false";
    button.textContent = "Reveal in full";
    return;
  }

  button.disabled = true;
  try {
    const { ssn } = await api(`/applications/${encodeURIComponent(app.id)}/ssn`);
    if (cell) cell.textContent = ssn;
    button.dataset.shown = "true";
    button.textContent = "Hide";
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

// The status dropdown and the notes box are the two controls that write on
// change rather than on a button, because both are corrections rather than
// decisions. The buttons above are what a decision goes through.
export async function handleApplicationChange(event, host, app) {
  const control = event.target.closest('[data-role="appl-status"], [data-role="appl-notes"]');
  if (!control) return false;

  const isStatus = control.dataset.role === "appl-status";
  await patch(app, isStatus ? { status: control.value } : { notes: control.value },
    isStatus ? statusMessage(control.value) : "Notes saved.");
  if (isStatus) renderApplicationScreen(host, app);
  return true;
}
