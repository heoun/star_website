// The single permission authority. Rules live here and nowhere else.
// Ring 1 carries the decisions already made: agents work their deals,
// identity and full-field edits are an admin's.

import type { Principal } from "../contracts/domain.ts";
import type { PolicyAction, PolicyPort, PolicyResource } from "../contracts/policy.ts";

const ADMIN_ONLY: PolicyAction[] = [
  "lease.edit_all_fields",
  "application.edit_identity",
];

export function makePolicy(): PolicyPort {
  return {
    can(p: Principal, action: PolicyAction, _resource: PolicyResource): boolean {
      if (p.kind === "staff") {
        if (ADMIN_ONLY.includes(action)) return p.role === "admin";
        return true;
      }
      if (p.kind === "landlord_link") {
        // A decision link decides; it does nothing else.
        return false;
      }
      // Applicants act through their own routes, not through staff actions.
      return false;
    },

    viewFields(p: Principal, _resourceType: PolicyResource["type"]): string[] {
      // Field-level shaping arrives with the UI ring; staff see everything,
      // nobody else sees staff surfaces at all.
      return p.kind === "staff" ? ["*"] : [];
    },
  };
}
