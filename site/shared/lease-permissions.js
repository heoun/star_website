// Which lease values an agent may write. A whitelist, set by the client: an
// agent settles the terms of one tenancy and reads everything else.
//
// Everything outside this list is a manager's — the landlord's standing terms
// (source "manager"), the tenant's identity, the premises address, the
// statutory marks. worker/staff.js is the half that enforces; this half is
// also read by the admin screens to decide whether to draw an input or a
// value, so an agent is never handed a box whose Save returns 403.
// lease/tools/test-permissions.mjs exercises both halves.
export const AGENT_WRITABLE = [
  // The date on page one. Defaults to the day the lease goes out.
  "lease.effective_date",
  // The tenancy's dates: move-in is the application's, which the agent may
  // correct there too, and the end date follows from the term.
  "lease.commencement_date",
  "lease.end_date",
  // Defaults from the listing.
  "rent.monthly",
  // Defaults from the property settings a manager keeps.
  "rent.due_day",
  // Defaults to one month of rent.
  "deposit.amount",
  // The Rent Concession Rider, written per deal.
  "concession.terms"
];

const WRITABLE = new Set(AGENT_WRITABLE);

export function agentMayWriteField(fieldId) {
  return WRITABLE.has(fieldId);
}
