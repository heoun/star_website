// The dates a lease is written in, and the one piece of arithmetic it does.
//
// Shared by the Worker, which fills the document, and by the lease workspace,
// which shows the end date moving as the agent changes the term. Both have to
// agree to the day: a screen that says the lease runs to 30 September while the
// .docx says 1 October is worse than a screen that says nothing.
//
// One format reaches the document — MM/DD/YYYY — but both shapes have to be
// read. The apply form sends and the applications table stores "10/01/2026",
// because that is what a New York applicant types and what apply.js validates;
// a settings value or a hand-typed correction is more likely to arrive as
// "2026-10-01". Reading only the second one silently blanked the commencement
// and end dates on every lease generated from a real application — the two
// dates that decide when the tenancy runs.
//
// Parsing is done on UTC parts rather than through the host's time zone, so a
// browser west of Greenwich cannot shift the day the lease starts.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function validParts(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject a day the month does not have, so "02/30/2026" is not silently
  // rolled forward into March on a signed lease.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function parseDate(value) {
  const text = String(value || "").trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return validParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (us) return validParts(Number(us[3]), Number(us[1]), Number(us[2]));

  return null;
}

export function shortDate(parts) {
  if (!parts) return "";
  return `${String(parts.month).padStart(2, "0")}/${String(parts.day).padStart(2, "0")}/${parts.year}`;
}

export function longDate(parts) {
  if (!parts) return "";
  return `${MONTHS[parts.month - 1]} ${parts.day}, ${parts.year}`;
}

// A twelve-month lease that starts on 1 October ends on 30 September, not on
// 1 October — the last day of the term, not the first day after it.
export function leaseEndDate(start, months) {
  if (!start || !Number.isFinite(months) || months <= 0) return null;
  const zeroBased = start.month - 1 + months;
  const date = new Date(Date.UTC(start.year + Math.floor(zeroBased / 12), zeroBased % 12, start.day));
  date.setUTCDate(date.getUTCDate() - 1);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// What the workspace shows under "Lease term": the end date the document will
// carry, recomputed from whatever the agent has just typed.
export function endDateFor(startText, months) {
  return shortDate(leaseEndDate(parseDate(startText), Number(months)));
}
