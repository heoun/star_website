// The single permission authority. One function answers every "may X do Y to Z"
// in the new backend; UI sections and API guards both derive from it, so a rule
// changes in exactly one place. Supersedes site/shared/lease-permissions.js for
// routes that have moved over; the 7-id agent whitelist lives HERE from Ring 1.

import type { Principal } from "./domain";

// Grows additively. Grep for a string to find every checkpoint.
export type PolicyAction =
  | "listing.publish"
  | "case.review"
  | "case.send_to_landlord" // Admin picks the recipients at send time
  | "case.decline"
  | "lease.edit_deal_fields" // the agent whitelist
  | "lease.edit_all_fields"
  | "lease.send"
  | "screening.view"
  | "application.view"
  | "application.edit_identity"; // manager-confirm rule from the two-tab decision

export interface PolicyResource {
  type: "listing" | "case" | "application" | "lease_version";
  id: string;
  // Scope hooks for later per-property agent assignment; unused while every
  // agent is global, present so adding scoping is a data change, not a contract change.
  propertyId?: string;
  agentUserId?: string;
}

export interface PolicyPort {
  can(p: Principal, action: PolicyAction, resource: PolicyResource): boolean;
  // Which field ids this principal may see on an entity — drives both the API
  // response shape and the UI sections (INFO ON LEASE / NOT ON LEASE tabs).
  viewFields(p: Principal, resourceType: PolicyResource["type"]): string[];
}
