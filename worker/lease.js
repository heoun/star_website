// Fills the lease template for one approved application.
//
// lease/schema/fields.json lists all 146 placeholders in the template and says
// where each one's value comes from. Three sources feed them:
//
//   deal     the application and the listing — tenant, dates, rent, address
//   manager  a stored setting, resolved company < building < unit
//   agent    typed in at generation time
//
// The agent's own entries win over everything, because the generate form is
// where a person confirms what is about to be signed.
//
// A registry default is NOT a fallback here. Defaults exist to prefill the
// settings form; most of them came from one real building, so falling back to
// them at generation time would assert that building's bedbug history or Good
// Cause exemption about a different one. A field nobody answered is reported
// as missing and generation stops.

import registry from "../lease/schema/fields.json" with { type: "json" };
import { readEntries, readEntryText, replaceEntry } from "./zip.js";
import { ADDRESS_FIELD, composeAddress } from "../site/shared/lease-address.js";

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

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

// A date, without letting the host's time zone shift the day.
//
// Both shapes have to be accepted. The apply form sends and the applications
// table stores "10/01/2026", because that is what a New York applicant types
// and what apply.js validates; a settings value or a hand-typed correction is
// more likely to arrive as "2026-10-01". Reading only the second one silently
// blanked the commencement and end dates on every lease generated from a real
// application — the two dates that decide when the tenancy runs.
function parseDate(value) {
  const text = String(value || "").trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return validParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (us) return validParts(Number(us[3]), Number(us[1]), Number(us[2]));

  return null;
}

function validParts(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject a day the month does not have, so "02/30/2026" is not silently
  // rolled forward into March on a signed lease.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

function longDate(parts) {
  if (!parts) return "";
  return `${MONTHS[parts.month - 1]} ${parts.day}, ${parts.year}`;
}

function shortDate(parts) {
  if (!parts) return "";
  return `${String(parts.month).padStart(2, "0")}/${String(parts.day).padStart(2, "0")}/${parts.year}`;
}

// The last day the tenant holds the unit: the day before the same date N
// months on, so a 12-month term starting 09/01/2026 ends 08/31/2027.
function leaseEndDate(start, months) {
  if (!start || !Number.isFinite(months) || months <= 0) return null;
  const zeroBased = start.month - 1 + months;
  const date = new Date(Date.UTC(start.year + Math.floor(zeroBased / 12), zeroBased % 12, start.day));
  date.setUTCDate(date.getUTCDate() - 1);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

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

// Everything the application and the listing already know. Each is a starting
// point the agent can correct on the generate form.
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
    "tenant.names": application?.name || "",
    "tenant.email": application?.email || "",
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

  // The window guard notice asks two questions. The application answers the
  // first; nothing answers the second yet, so it stays for the agent.
  const hasChildren = application?.children_under_11;
  if (hasChildren === true || hasChildren === false) {
    values["window_guard.mark_has_children"] = hasChildren;
    values["window_guard.mark_no_children"] = !hasChildren;
  }

  return values;
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
  const parts = [listing?.building_name || listing?.title || "Lease", listing?.unit, application?.name]
    .filter(Boolean)
    .join(" ")
    .replace(/[^A-Za-z0-9 \-_]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return `${parts || "Lease"}.docx`;
}
