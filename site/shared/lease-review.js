// Whether the lease about to be produced will be right.
//
// resolveValues() answers the easy half: a required value nobody supplied is
// reported by name and generation refuses. The hard half is everything it
// cannot report. A checkbox is answered by definition — false is an answer, and
// the safe one for a legal assertion nobody has made — so a statutory
// disclosure with neither box ticked is not missing anything. It prints two
// empty boxes and asserts nothing, and the lease goes out of the door.
//
// So this reads the resolved values the way a person reads the printed page,
// and sorts what it finds by what an agent has to do about it:
//
//   stops     required and unanswered — generation refuses, loudly and safely
//   blank     will print, and will print empty, broken, or contradicting itself
//   borrowed  a real value, but the sample lease's rather than this building's
//
// The rules behind `blank` live in the registry next to the fields they are
// about, because they are properties of the form, not of this screen: the
// sprinkler notice says "Landlord check one" in its own words.
//
// It is in site/shared/ rather than in the panel because nothing here is about
// a screen: it takes resolved values and returns what is wrong with them. The
// lease screen has its own alarm for values that stop generation and does not
// read this yet — when it should also say what will print wrong, this is the
// module it reads, and the two screens will agree by construction.

const ORDINAL = ["th", "st", "nd", "rd"];

function ordinal(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "");
  const rest = number % 100;
  return `${number}${ORDINAL[(rest - 20) % 10] || ORDINAL[rest] || ORDINAL[0]}`;
}

function indexFields(registry) {
  return new Map((registry?.fields || []).map((field) => [field.id, field]));
}

// A checkbox is ticked only when it carries the mark the registry says means
// ticked. Comparing against "" would read the sprinkler notice's blank mark as
// an answer.
function ticked(field, values) {
  if (!field || field.type !== "checkbox") return false;
  const mark = field.marks && field.marks.checked;
  return mark !== undefined && values[field.id] === mark;
}

function filled(values, id) {
  return String((values && values[id]) ?? "").trim() !== "";
}

function labelsFor(fields, ids) {
  return ids.map((id) => (fields.get(id) || {}).label || id);
}

// ---------------------------------------------------------------- the rules

function ruleFindings(registry, values, fields) {
  const findings = [];

  const add = (rule, detail, ids) => findings.push({
    kind: "blank",
    id: rule.id,
    title: rule.label,
    where: rule.where,
    detail,
    why: rule.why,
    fields: ids
  });

  for (const rule of registry.rules || []) {
    // A branch nobody is standing in has no unanswered questions.
    if (rule.only_when && !ticked(fields.get(rule.only_when), values)) continue;

    if (rule.kind === "one_of" || rule.kind === "any_of") {
      const on = rule.fields.filter((id) => ticked(fields.get(id), values));
      if (on.length === 0) {
        add(rule, rule.fields.length === 2
          ? "Neither box is ticked."
          : `None of the ${rule.fields.length} boxes is ticked.`, rule.fields);
      } else if (rule.kind === "one_of" && on.length > 1) {
        add(rule, `${on.length} boxes are ticked and the form allows one: `
          + `${labelsFor(fields, on).join(", ")}.`, on);
      }
      continue;
    }

    if (rule.kind === "required_when") {
      if (!ticked(fields.get(rule.when), values)) continue;
      const empty = rule.then.filter((id) => !filled(values, id));
      if (empty.length > 0) {
        add(rule, `${labelsFor(fields, empty).join(", ")} left empty while `
          + `"${(fields.get(rule.when) || {}).label}" is ticked.`, empty);
      }
      continue;
    }

    if (rule.kind === "blank_unless") {
      if (ticked(fields.get(rule.when), values)) continue;
      const set = rule.then.filter((id) => filled(values, id));
      if (set.length > 0) {
        add(rule, `${labelsFor(fields, set).join(", ")} carries a value while `
          + `"${(fields.get(rule.when) || {}).label}" is not ticked.`, set);
      }
      continue;
    }

    if (rule.kind === "idle_unless") {
      if (filled(values, rule.when_filled)) continue;
      const parked = String((values && values[rule.then]) ?? "");
      if (parked !== rule.idle) {
        add(rule, `Nothing is named, but the row still reads "${parked}".`,
          [rule.when_filled, rule.then]);
      }
    }
  }

  return findings;
}

// ------------------------------------------------------------- the sample

// A value that is not this building's.
//
// Two ways to tell. The registry keeps what the sample lease carried on the
// fields it came off, so a value equal to one of those came from that lease
// whichever field it now sits on — which is how the housing emergency number
// on every lease is the sample landlord's. And a per-building setting still
// equal to its registry default has never been looked at for this building;
// the registry says as much about where those defaults came from.
function borrowedFindings(registry, values, fields) {
  const sample = new Map();
  for (const field of registry.fields || []) {
    if (field.source_value) sample.set(String(field.source_value), field);
  }

  const findings = [];
  for (const field of registry.fields || []) {
    if (field.source !== "manager" || field.type === "checkbox") continue;
    const value = String((values && values[field.id]) ?? "").trim();
    if (value === "") continue;

    const from = sample.get(value);
    if (from) {
      findings.push({
        kind: "borrowed",
        id: field.id,
        title: field.label,
        where: null,
        detail: `${value} — the sample lease's ${from.label.toLowerCase()}.`,
        why: from.id === field.id
          ? "Recorded as what the sample lease said, and it is still saying it."
          : `Recorded on ${from.id} as the sample lease's value, and reused here.`,
        fields: [field.id]
      });
      continue;
    }

    if (field.scope === "building" && field.type !== "choice"
      && field.default !== null && field.default !== undefined
      && String(field.default) === value) {
      findings.push({
        kind: "borrowed",
        id: field.id,
        title: field.label,
        where: null,
        detail: `${value} — unchanged from the registry default.`,
        why: "This one differs per building, and its default came from one "
          + "specific building. Nobody has confirmed it for this one.",
        fields: [field.id]
      });
    }
  }
  return findings;
}

// ------------------------------------------------------------- the summary

// What the lease says, in the order it says it, so an agent can read it
// against what was actually agreed rather than against a list of field names.
function summarize(registry, values, fields, application) {
  const text = (id) => String((values && values[id]) ?? "").trim();
  const lines = [];

  const line = (key, label, body, ids) => lines.push({
    key,
    label,
    text: body || "—",
    tone: body ? "ok" : "gap",
    fields: ids
  });

  line("landlord", "Landlord", text("landlord.entity_name"), ["landlord.entity_name"]);
  line("apartment", "Apartment", text("property.address_full"), ["property.address_full"]);
  line("tenant", "Tenant", text("tenant.names"), ["tenant.names"]);

  const start = text("lease.commencement_date");
  const end = text("lease.end_date");
  const months = Number(application && application.lease_term_months);
  const term = start && end
    ? `${start} to ${end}${Number.isFinite(months) && months > 0
      ? ` (${months} month${months === 1 ? "" : "s"})` : ""}`
    : "";
  line("term", "Term", term, ["lease.commencement_date", "lease.end_date"]);

  const rent = text("rent.monthly");
  const due = text("rent.due_day");
  const payee = text("payee.name");
  line("rent", "Rent", rent
    ? `${rent} a month${due ? `, due on the ${ordinal(due)}` : ""}`
    + `${payee ? `, payable to ${payee}` : ""}`
    : "", ["rent.monthly", "rent.due_day", "payee.name"]);

  const deposit = text("deposit.amount");
  const bank = text("deposit.bank_name");
  line("deposit", "Deposit", deposit
    ? `${deposit}${bank ? `, held at ${bank}` : ""}` : "",
    ["deposit.amount", "deposit.bank_name"]);

  // The three answers this lease alone decides.
  const has = ticked(fields.get("window_guard.mark_has_children"), values);
  const none = ticked(fields.get("window_guard.mark_no_children"), values);
  const anyway = ticked(fields.get("window_guard.mark_wants_anyway"), values);
  line("window_guard", "Window guards",
    has ? `A child aged 10 or younger lives here${anyway ? ", and guards were asked for" : ""}`
      : none ? `No child aged 10 or younger${anyway ? ", but guards were asked for" : ""}`
        : "", ["window_guard.mark_has_children", "window_guard.mark_no_children"]);

  const concession = text("concession.terms");
  lines.push({
    key: "concession",
    label: "Rent concession",
    text: concession
      ? `${concession.split(/\s+/).length} words — the rider prints them`
      : "None — the rider prints blank",
    tone: "ok",
    fields: ["concession.terms"]
  });

  const vacancy = ticked(fields.get("dhcr.mark_vacancy"), values);
  const renewal = ticked(fields.get("dhcr.mark_renewal"), values);
  line("dhcr", "DHCR consent",
    vacancy && renewal ? "" : vacancy ? "Vacancy lease" : renewal ? "Renewal lease" : "",
    ["dhcr.mark_vacancy", "dhcr.mark_renewal"]);

  return lines;
}

// ---------------------------------------------------------------- the verdict

export function reviewLease({ registry, values = {}, missing = [], application = null }) {
  const fields = indexFields(registry);

  const stops = missing.map((id) => ({
    kind: "stops",
    id,
    title: (fields.get(id) || {}).label || id,
    where: null,
    detail: "Required, and nobody has answered it.",
    why: "Generation refuses until this has a value.",
    fields: [id]
  }));

  const blank = ruleFindings(registry, values, fields);
  const borrowed = borrowedFindings(registry, values, fields);

  // Answered means a person's answer is in it: text that is not empty, or a
  // box actually ticked. An untouched checkbox is not an achievement.
  let answered = 0;
  for (const field of registry.fields || []) {
    if (field.type === "checkbox") {
      if (ticked(field, values)) answered += 1;
    } else if (filled(values, field.id)) {
      answered += 1;
    }
  }

  const verdict = stops.length > 0 ? "blocked"
    : blank.length + borrowed.length > 0 ? "check" : "ready";

  return {
    verdict,
    counts: {
      stops: stops.length,
      blank: blank.length,
      borrowed: borrowed.length,
      answered,
      total: (registry.fields || []).length
    },
    summary: summarize(registry, values, fields, application),
    findings: { stops, blank, borrowed }
  };
}

export { ticked as isTicked };
