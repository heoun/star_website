// What an application says — worked out once, for both screens that say it.
//
// The list and the detail page answer the same three questions about the same
// row: who is this, is it complete, and what can be done about it. When each
// screen worked that out for itself the list said "Docs 3/6" while the panel
// below it said something else, because the two counts were written twice. So
// every derived value lives here and both screens read it.
//
// Nothing in this file fetches or writes. It reads an application row exactly
// as `GET /api/admin/applications` returns it.

// ---------------------------------------------------------------- statuses
//
// The database keeps ten status values and every one of them is on rows
// today, so none of them is dropped. What the screens show is six stages —
// the six decisions a person actually makes — with the finer values grouped
// underneath. "Contacted" and "Fee pending" remain things somebody can say;
// they just both mean "under review" when you are scanning a list of forty.

export const STAGES = [
  { key: "new", label: "New", tone: "warn", values: ["new"] },
  { key: "review", label: "Under review", tone: "busy",
    values: ["contacted", "fee_pending", "screening", "review", "sent_to_landlord"] },
  { key: "needs_info", label: "Needs information", tone: "warn", values: ["needs_info"] },
  { key: "approved", label: "Approved", tone: "good", values: ["approved"] },
  { key: "declined", label: "Declined", tone: "bad", values: ["declined"] },
  { key: "lease", label: "Lease created", tone: "good", values: ["lease_sent", "lease_signed"] }
];

// The stored values, under the names an agent chose them by.
export const STATUSES = [
  ["new", "New"],
  ["contacted", "Contacted"],
  ["fee_pending", "Fee pending"],
  ["screening", "Screening"],
  ["review", "In review"],
  ["sent_to_landlord", "Sent to landlord"],
  ["needs_info", "Needs information"],
  ["approved", "Approved"],
  ["declined", "Declined"],
  ["lease_sent", "Lease sent"],
  ["lease_signed", "Lease signed"]
];

const STATUS_LABELS = new Map(STATUSES);
const STAGE_OF = new Map();
for (const stage of STAGES) for (const value of stage.values) STAGE_OF.set(value, stage);

export function stageOf(app) {
  return STAGE_OF.get(app?.status) || STAGES[0];
}

export function statusLabel(status) {
  return STATUS_LABELS.get(status) || status || "—";
}

// A lease exists once the application says one went out. There is no leases
// table to ask — see lease/README.md — so these two statuses are the record.
export function hasLease(app) {
  return app?.status === "lease_sent" || app?.status === "lease_signed";
}

// ---------------------------------------------------------------- documents

// The checklist, read against the registry the portal enforces. The registry
// arrives with the applications list, so the console cannot hold a different
// list of required documents than the applicant was shown.
//
// Returns null when the database predates the portal tables: no documents to
// count is different from none uploaded, and a screen that reports "0 of 7"
// for a database that has never had a checklist is lying.
export function documentSummary(app, types) {
  const docs = app?.application_documents;
  if (!Array.isArray(docs) || !Array.isArray(types) || types.length === 0) return null;

  const rows = types.map((type) => {
    const files = docs.filter((doc) => doc.doc_type === type.id);
    const needed = type.required > 0;
    let state;
    if (!needed) state = files.length > 0 ? "received" : "optional";
    else if (files.length === 0) state = "missing";
    else if (files.length < type.required) state = "partial";
    else state = "received";
    return { type, files, state, needed };
  });

  const required = rows.filter((row) => row.needed);
  const optional = rows.filter((row) => !row.needed);
  const met = required.filter((row) => row.state === "received").length;

  return {
    rows,
    required: required.length,
    requiredMet: met,
    optional: optional.length,
    optionalReceived: optional.filter((row) => row.files.length > 0).length,
    missing: required.filter((row) => row.state !== "received").length,
    complete: met === required.length
  };
}

// The one line a list column has room for.
export function documentsFact(app, types) {
  const summary = documentSummary(app, types);
  if (!summary) return { text: "—", tone: "off" };
  if (summary.complete) return { text: "Complete", tone: "good" };
  return { text: `${summary.requiredMet} of ${summary.required}`, tone: "busy" };
}

// ------------------------------------------------------------------ money

// `income_note` is free text — the form asks for an annual figure and shows
// "$120,000" as the example, but somebody will type "120k a year". Anything
// that reads as one number is turned into one; anything else is left alone and
// shown as written, with no arithmetic done on top of a guess.
export function parseMoney(value) {
  const text = String(value ?? "").replace(/[$,\s]/g, "");
  const found = /^-?\d+(\.\d+)?/.exec(text);
  if (!found) return null;
  const amount = Number(found[0]);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function money(amount, { cents = false } = {}) {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return "";
  return Number(amount).toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0
  });
}

// Annual income, the monthly figure that follows from it, the rent this
// apartment is asking, and what one is of the other. Every part is optional:
// an application with no listing still has an income, and an income nobody can
// parse still has the words the applicant wrote.
export function incomeSummary(app) {
  const written = String(app?.income_note ?? "").trim();
  const annual = parseMoney(written);
  const rent = Number(app?.listings?.price_amount);
  const monthly = annual === null ? null : annual / 12;
  const hasRent = Number.isFinite(rent) && rent > 0;

  return {
    written,
    annual,
    monthly,
    rent: hasRent ? rent : null,
    ratio: monthly && hasRent ? (rent / monthly) * 100 : null
  };
}

export function ratioText(ratio) {
  return ratio === null || ratio === undefined ? "—" : `${ratio.toFixed(1)}%`;
}

// ------------------------------------------------------------------ dates

export function shortDay(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function dayAndTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
  });
}

// The move-in date arrives as the applicant typed it — MM/DD/YYYY — and is
// shown that way rather than pushed through a Date, which would move it a day
// west of Greenwich.
export function plainDate(value) {
  const text = String(value ?? "").trim();
  return text || "—";
}

// ------------------------------------------------------------- what is left

// What somebody would have to send in for this application to be decidable.
// Derived, not stored: the answer is exactly the required documents that have
// not arrived plus the required answers that are blank, and a second copy in
// the database would be a second thing to keep in step.
const NEEDED_ANSWERS = [
  { key: "income_note", label: "Annual income" },
  { key: "current_address", label: "Current address" },
  { key: "phone", label: "Phone number" },
  { key: "move_in", label: "Desired move-in date" },
  { key: "dob", label: "Date of birth" }
];

export function requestedItems(app, types) {
  const items = [];

  for (const answer of NEEDED_ANSWERS) {
    const value = app?.[answer.key];
    if (value === null || value === undefined || String(value).trim() === "") {
      items.push({ kind: "answer", label: answer.label });
    }
  }

  if (!Array.isArray(app?.rental_history) || app.rental_history.length === 0) {
    items.push({ kind: "answer", label: "Rental history" });
  }
  if (!Array.isArray(app?.reference_contacts) || app.reference_contacts.length < 3) {
    items.push({ kind: "answer", label: "Three references" });
  }

  const summary = documentSummary(app, types);
  if (summary) {
    for (const row of summary.rows) {
      if (!row.needed || row.state === "received") continue;
      items.push({
        kind: "document",
        label: row.type.label,
        detail: row.state === "partial"
          ? `${row.files.length} of ${row.type.required} received`
          : "nothing received"
      });
    }
  }

  return items;
}

// ------------------------------------------------------------------ naming

export function homeLabel(app) {
  const listing = app?.listings;
  if (!listing) return "Listing removed";
  const home = [listing.building_name, listing.unit ? `Unit ${listing.unit}` : ""]
    .filter(Boolean).join(" · ");
  return home || listing.title || "Listing removed";
}

export function propertyLine(app) {
  const listing = app?.listings;
  if (!listing) return "The listing this application was made against has been removed.";
  const home = [listing.building_name, listing.unit ? `Unit ${listing.unit}` : ""]
    .filter(Boolean).join(" · ");
  return [listing.title, home].filter(Boolean).join(" — ");
}

// The reference an agent reads down the phone. There is no application number
// column, so it is the row's own id — shortened, because the whole UUID is
// twelve characters of noise around the eight anybody would actually quote.
export function reference(app) {
  return `APP-${String(app?.id || "").slice(0, 8).toUpperCase()}`;
}
