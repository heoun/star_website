// Which lease values an agent may not write.
//
// The rule is the registry's `source`: "manager" is the landlord's own standing
// terms, and an agent reads those rather than typing them.
//
// Two fields are an exception to that rule and this is where the exception is
// written down for the browser. The DHCR consent's two marks are declared
// `source: "deal"` because they vary per lease, but which of them is ticked is
// the landlord's assertion about the tenancy, not the agent's — so the Worker
// refuses them for an agent. worker/staff.js holds the same two ids and is the
// half that enforces; this half only decides whether to draw an input or a
// value, so that an agent is never handed a box whose Save returns 403.
//
// Both lists disappear together on the day the registry marks these two fields
// `source: "manager"`. lease/tools/test-permissions.mjs fails if they drift.
export const MANAGER_CONTROLLED = ["dhcr.mark_vacancy", "dhcr.mark_renewal"];

const CONTROLLED = new Set(MANAGER_CONTROLLED);

export function isManagerControlledField(field) {
  return field.source === "manager" || CONTROLLED.has(field.id);
}
