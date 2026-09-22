// The shared language. Types only — no logic, no imports outside contracts/.
// Enums stay minimal on purpose: values are added when a ring needs them, never renamed.

export type Id = string; // uuid

// ----------------------------------------------------------------- people

export type StaffRole = "admin" | "agent";

export type Principal =
  | { kind: "staff"; id: Id; role: StaffRole; email: string }
  | { kind: "applicant"; id: Id; email: string }
  // A landlord acting through a signed single-use link (decision, intake).
  | { kind: "landlord_link"; landlordId: Id; contactId: Id; purpose: "decision" | "intake" };

export interface PersonRef {
  id: Id;
  name: string;
  email: string;
}

// ----------------------------------------------------------------- listings

export type ListingStatus = "draft" | "published" | "rented" | "archived";

export interface Listing {
  id: Id;
  // One physical building. For an unmanaged/condo unit this may be shared
  // with other agents' units in the same building.
  propertyId: Id | null;
  unitLabel: string;
  // Reservation for room-by-room letting: every unit has exactly one
  // whole-unit rentable; cases and leases key on it, not on the unit.
  rentableId: Id;
  rent: number; // dollars per month
  availableOn: string | null; // ISO date; null = now
  status: ListingStatus;
  agentUserId: Id | null;
}

// ----------------------------------------------------------------- cases

// A case is one lease deal on one rentable. Roommates are members of the
// same case, each with their own application.
export type CaseStatus =
  | "open"             // collecting applications and screenings
  | "in_review"        // staff reviewing the assembled package
  | "sent_to_landlord" // decision email out
  | "approved"         // landlord said yes
  | "declined"         // landlord or staff said no (reason recorded)
  | "lease_sent"       // e-sign envelope out
  | "executed"         // everyone signed
  | "closed";          // withdrawn / superseded / unit rented elsewhere

export type MemberRole = "primary" | "co_tenant" | "guarantor" | "occupant";
// guarantor: model reserved, not exercised in MVP. occupant: data only, never signs.

export interface CaseMember {
  personId: Id;
  role: MemberRole;
  applicationId: Id | null; // occupants have none
}

export interface Case {
  id: Id;
  rentableId: Id;
  listingId: Id;
  status: CaseStatus;
  members: CaseMember[];
  moveInDate: string | null; // case attribute; primary's wins on conflict
  declineReason: string | null;
}

// ----------------------------------------------------------------- applications

export type ApplicationStatus = "draft" | "submitted" | "needs_info" | "complete" | "withdrawn";

export interface Application {
  id: Id;
  caseId: Id;
  applicant: PersonRef;
  status: ApplicationStatus;
  // Answers as a flat bag; the form owns its shape, the backend does not.
  answers: Record<string, string>;
}

// ----------------------------------------------------------------- screening

export type ScreeningStatus = "pending" | "complete" | "failed";

export interface ScreeningResult {
  screeningId: Id;
  applicationId: Id;
  status: ScreeningStatus;
  creditScore: number | null;
  // Opaque pointer into the vendor or into storage. Never raw report bytes here.
  reportRef: string | null;
}

// ----------------------------------------------------------------- lease

export type LeaseVersionStatus = "draft" | "sent" | "partially_signed" | "executed" | "voided";

export interface LeaseVersion {
  id: Id;
  caseId: Id;
  status: LeaseVersionStatus;
  // Frozen snapshot of every value the documents printed, keyed by registry id.
  values: Record<string, string>;
  envelopeRef: string | null; // e-sign vendor's id
  executedFileKey: string | null; // storage key of the signed copy
}

// ----------------------------------------------------------------- landlord decision

export interface LandlordDecision {
  caseId: Id;
  approved: boolean;
  decidedAt: string; // ISO datetime
  contactId: Id;
  note: string | null;
}
