// Fills the lease template for one approved application.
//
// lease/schema/fields.json lists all 147 placeholders in the template and says
// where each one's value comes from. Two sources feed them:
//
//   deal     the application and the listing — tenant, dates, rent, address
//   manager  a stored setting, resolved company < building < unit
//
// Per-lease overrides typed on the generate form win over both, because that
// form is where a person confirms what is about to be signed. Who may type
// which override is site/shared/lease-permissions.js's whitelist: an agent
// settles the terms of the tenancy, a manager may correct anything.
//
// A registry default is NOT a fallback here. Defaults exist to prefill the
// settings form; most of them came from one real building, so falling back to
// them at generation time would assert that building's bedbug history or Good
// Cause exemption about a different one. A field nobody answered is reported
// as missing and generation stops.

import registry from "../lease/schema/fields.json" with { type: "json" };
import { readEntries, readEntryText, replaceEntry } from "./zip.js";
import { ADDRESS_FIELD, composeAddress } from "../site/shared/lease-address.js";
import { applicationColumns } from "../site/shared/lease-application.js";
// The date rules are shared with the lease workspace, which shows the end date
// moving as the term changes. Two copies of that arithmetic is two answers.
import { leaseEndDate, longDate, parseDate, shortDate } from "../site/shared/lease-dates.js";

const TEMPLATE_PATH = "/admin/lease-template.docx";
const PLACEHOLDER = /\{\{([a-z0-9_.]+)\}\}/g;

const FIELDS = registry.fields;
const FIELD_BY_ID = new Map(FIELDS.map((field) => [field.id, field]));

export const LEASE_REGISTRY = registry;

// Only these may be written into a settings layer. Letting a stored setting
// carry "rent.monthly" would let a stale number silently override the
// application on a signed lease.
const MANAGER_FIELD_IDS = new Set(
  FIELDS.filter((field) => field.source === "manager").map((field) => field.id)
);

export function isManagerField(id) {
  return MANAGER_FIELD_IDS.has(id);
}

// ------------------------------------------------------------ formatting

// The date rules moved to site/shared/lease-dates.js, imported above, so the
// workspace can show the end date move as the term changes without holding a
// second copy of the arithmetic.

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2
});

function formatMoney(amount) {
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? money.format(parsed) : "";
}

// Listing addresses are stored as one line, "<street>, <city>, <state>", with
// no ZIP. Splitting it gives the generate form something to show; the agent
// confirms it, and a linked building overrides it with real parts.
export function splitLocation(location) {
  const parts = String(location || "").split(",").map((piece) => piece.trim()).filter(Boolean);
  return {
    street: parts[0] || "",
    city: parts[1] || "",
    state_abbr: parts[2] || ""
  };
}

const STATE_NAMES = { NY: "New York", NJ: "New Jersey", CT: "Connecticut" };

// ------------------------------------------------------------ deal values

// The lease values the application row is the authority for, read off the
// registry rather than listed again here. Both admin screens write through the
// same map, so a correction made on either of them is the same correction.
export const APPLICATION_FIELDS = applicationColumns(FIELDS);


// When the listing was put on the website, as a lease date. created_at is a
// timestamp; only its date part is read, so no time zone can move the day.
function listingReleaseDate(listing) {
  const parts = parseDate(String(listing?.created_at || "").slice(0, 10));
  return parts ? shortDate(parts) : "";
}

// Everything the application and the listing already know. Each is a starting
// point the agent can correct, on either screen.
export function dealValues({ application, listing, building, today }) {
  const parsed = splitLocation(listing?.location);
  const street = building?.street || parsed.street;
  const city = building?.city || parsed.city;
  const abbr = building?.state_abbr || parsed.state_abbr || "NY";
  const state = building?.state || STATE_NAMES[abbr] || "";
  const zip = building?.zip || "";
  const unit = listing?.unit || "";

  const start = parseDate(application?.move_in);
  const end = leaseEndDate(start, Number(application?.lease_term_months));
  const rent = formatMoney(listing?.price_amount);

  const addressFull = [
    [street, unit ? `Unit ${unit}` : ""].filter(Boolean).join(", "),
    city,
    [state || abbr, zip].filter(Boolean).join(" ")
  ].filter(Boolean).join(", ");

  const values = {
    "lease.effective_date": longDate(today),
    "lease.commencement_date": shortDate(start),
    "lease.end_date": shortDate(end),
    // The bedbug disclosure dates the vacancy from the day the listing went
    // up on the website. A listing with no date — an older row, a stub —
    // falls back to the day the lease goes out; a manager corrects either.
    "lease.vacancy_lease_date": listingReleaseDate(listing) || shortDate(today),
    "tenant.names": application?.name || "",
    "tenant.email": application?.email || "",
    "tenant.mailing_address": application?.current_address || "",
    "concession.terms": application?.concession_terms || "",
    "property.address_full": addressFull,
    "property.street": street,
    "property.unit": unit,
    "property.city": city,
    "property.state": state,
    "property.state_abbr": abbr,
    "property.zip": zip,
    "rent.monthly": rent,
    // One month's rent, which is the maximum a New York landlord may hold.
    "deposit.amount": rent
  };

  // The window guard notice asks two questions and the application answers
  // both: whether young children live in the unit, and whether the tenant
  // wants the guards anyway.
  const hasChildren = application?.children_under_11;
  if (hasChildren === true || hasChildren === false) {
    values["window_guard.mark_has_children"] = hasChildren;
    values["window_guard.mark_no_children"] = !hasChildren;
  }
  if (application?.wants_window_guards === true || application?.wants_window_guards === false) {
    values["window_guard.mark_wants_anyway"] = application.wants_window_guards;
  }

  // Every lease made from an application starts a new tenancy, so the DHCR
  // consent is marked as a vacancy lease. A manager may override either mark;
  // an agent may not — see site/shared/lease-permissions.js.
  values["dhcr.mark_vacancy"] = true;
  values["dhcr.mark_renewal"] = false;

  return values;
}

// Overrides arrive as raw booleans and typed dates. On a live lease
// resolveValues formats them; a frozen lease merges them straight onto the
// snapshot, so they have to be formatted the same way here or a manager's
// corrected checkbox prints as the word "true".
export function formatOverrides(overrides) {
  const out = {};
  for (const [id, value] of Object.entries(overrides || {})) {
    const field = FIELDS.find((entry) => entry.id === id);
    if (!field) continue;
    if (field.type === "checkbox") {
      out[id] = value === true ? field.marks.checked : field.marks.unchecked;
      continue;
    }
    let text = value === null || value === undefined ? "" : String(value);
    if (field.type === "date" && text !== "") {
      const parts = parseDate(text);
      if (parts) text = shortDate(parts);
    }
    out[id] = text;
  }
  return out;
}

// ------------------------------------------------------------ resolution

function mergeLayers(layers) {
  return { ...(layers?.company || {}), ...(layers?.building || {}), ...(layers?.unit || {}) };
}

// Which layer answered each field, so the settings screen can show a person
// whether a value is inherited or set here.
export function fieldProvenance(layers) {
  const provenance = {};
  for (const [name, values] of [["company", layers?.company], ["building", layers?.building], ["unit", layers?.unit]]) {
    for (const id of Object.keys(values || {})) provenance[id] = name;
  }
  return provenance;
}

// Resolves every placeholder, and reports what is still unanswered rather than
// quietly substituting a blank.
export function resolveValues({ layers, deal, overrides = {} }) {
  const settings = mergeLayers(layers);
  const values = {};
  const missing = [];

  for (const field of FIELDS) {
    let value;

    if (Object.prototype.hasOwnProperty.call(overrides, field.id)) {
      value = overrides[field.id];
    } else if (field.source === "manager") {
      value = settings[field.id];
    } else if (field.source === "deal") {
      value = deal[field.id];
    }

    if (field.type === "checkbox") {
      // A checkbox is answered by definition — false is an answer, and it is
      // the safe one for a legal assertion nobody has made.
      values[field.id] = value === true ? field.marks.checked : field.marks.unchecked;
      continue;
    }

    let text = value === null || value === undefined ? "" : String(value);

    // One date format per document. Both shapes are read (see parseDate), so a
    // corrected date typed as "2026-10-01" would otherwise print beside a
    // commencement date the application supplied as "10/01/2026" — the same
    // day, written two ways, on a lease somebody has to read in court. Dates
    // written out in words, like the effective date, are left as they are.
    if (field.type === "date" && text !== "") {
      const parts = parseDate(text);
      if (parts) text = shortDate(parts);
    }

    if (text === "" && field.required) missing.push(field.id);
    values[field.id] = text;
  }

  // Recomposed after the loop so it reflects any correction made to a part.
  // An address typed in whole still wins: someone who overrides it means it.
  if (!Object.prototype.hasOwnProperty.call(overrides, ADDRESS_FIELD)) {
    values[ADDRESS_FIELD] = composeAddress(values);
    const field = FIELD_BY_ID.get(ADDRESS_FIELD);
    const index = missing.indexOf(ADDRESS_FIELD);
    if (values[ADDRESS_FIELD] === "" && field?.required) {
      if (index === -1) missing.push(ADDRESS_FIELD);
    } else if (index !== -1) {
      missing.splice(index, 1);
    }
  }

  return { values, missing };
}

// Which required fields a set of already-resolved values leaves blank.
//
// resolveValues() works this out on its way through the layers. A lease read
// back from its snapshot has no layers left to walk — only the strings the
// document was filled with — so the same question is asked of those directly.
// Checkboxes are skipped for the same reason they are never required: false is
// an answer.
export function missingIn(values) {
  return FIELDS
    .filter((field) => field.required && field.type !== "checkbox"
      && String(values?.[field.id] ?? "") === "")
    .map((field) => field.id);
}

export function describeMissing(ids) {
  return ids.map((id) => FIELD_BY_ID.get(id)?.label || id);
}

// ------------------------------------------------------------ generation

async function loadTemplate(env, request) {
  const response = await env.ASSETS.fetch(new Request(new URL(TEMPLATE_PATH, request.url)));
  if (!response.ok) {
    throw new Error(`The lease template could not be loaded (${response.status}).`);
  }
  return response.arrayBuffer();
}

// Substitutes every placeholder and returns the finished .docx bytes.
//
// A plain string replace over the document XML is enough because every
// placeholder sits inside a single run — build-template.py put them there and
// check-fields.py notices if one is later split by editing in Word.
export async function fillTemplate(env, request, values) {
  const entries = readEntries(await loadTemplate(env, request));
  const xml = await readEntryText(entries, "word/document.xml");

  const unknown = new Set();
  const filled = xml.replace(PLACEHOLDER, (match, id) => {
    if (!Object.prototype.hasOwnProperty.call(values, id)) {
      unknown.add(id);
      return match;
    }
    return escapeXml(values[id]);
  });

  if (unknown.size > 0) {
    throw new Error(`The template uses fields the registry does not define: ${[...unknown].join(", ")}.`);
  }

  return replaceEntry(entries, "word/document.xml", filled);
}

// Values reach the document as XML text, so a tenant named "Smith & Jones"
// must not close the run it sits in.
function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// A filename an agent can find later without opening it.
export function leaseFilename({ application, listing }) {
  const parts = [listing?.property_name || listing?.title || "Lease", listing?.unit, application?.name]
    .filter(Boolean)
    .join(" ")
    .replace(/[^A-Za-z0-9 \-_]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return `${parts || "Lease"}.docx`;
}
