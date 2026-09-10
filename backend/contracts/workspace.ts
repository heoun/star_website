// Scope approved with the three-role design on 2026-09-08. Existing applications
// remain the source of truth; their id is the workspace case reference until the
// household migration explicitly links multiple applications to one Case.
export type WorkspaceRole = "manager" | "agent" | "landlord";
export interface WorkspacePrincipal { email: string; role: WorkspaceRole; property_ids?: string[] }
// Read-only property facts remain visible before any marketing listing exists.
// External partners never receive intake history, account data or private defaults.
export interface WorkspaceProperty {
  id: string; name: string; street?: string; city?: string; state_abbr?: string;
  zip?: string; declared_units?: number | null; [key: string]: unknown;
}
export type WorkspaceAction = "assign" | "checks" | "approve" | "request_info" | "decline"
  | "terms" | "review_and_recommend" | "recommend" | "landlord_accept" | "landlord_changes" | "landlord_decline"
  | "note" | "admin_note" | "prepare_lease" | "record_tenant_signature" | "record_landlord_signature" | "archive_lease";
export interface LeaseFile { path: string; name: string; size: number; uploaded_at: string }
export interface WorkspaceTerms {
  "lease.effective_date"?: string;
  "lease.commencement_date"?: string;
  "lease.end_date"?: string;
  "rent.monthly"?: string;
  "rent.due_day"?: string;
  "deposit.amount"?: string;
  "concession.terms"?: string;
}
// What a landlord may know about the tenant and about Star's review, fixed
// when the recommendation goes out. Never the application itself: no
// identity numbers, no contact details, no documents, no staff notes.
export interface RecommendationSummary {
  move_in: string; lease_term_months: number | null; employment_status: string;
  annual_income: string; credit_score: number | null;
  roommates: string[]; pets: { type: string; breed: string; weight: string }[];
  verified: { fee: boolean; screening: boolean; documents: boolean; at: string };
}
export interface Recommendation {
  revision: number; sent_at: string; sent_by: string; landlord_email: string;
  tenant_name: string; property_title: string; unit: string; terms: WorkspaceTerms;
  summary?: RecommendationSummary;
}
export interface WorkspaceState {
  terms?: WorkspaceTerms;
  checks?: { fee: string; screening: string; documents: string; reference: string; by: string; at: string; credit_score?: number | null };
  // What the team asked the applicant for, so the request can be repeated
  // verbatim and new uploads can be read against when it was made.
  info_request?: { message: string; by: string; at: string };
  review?: { by: string; at: string };
  recommendation?: Recommendation;
  // proposed_terms is the landlord's counter-offer, when requesting changes
  // came with one: the rent, the dates, the deposit or the concessions.
  landlord_decision?: { outcome: string; comment: string; by: string; at: string; revision: number; proposed_terms?: WorkspaceTerms };
  lease_preparation?: { by: string; at: string };
  tenant_signature?: { reference: string; by: string; at: string };
  landlord_signature?: { reference: string; by: string; at: string };
  signed_lease?: LeaseFile;
  admin_note?: string;
  activity?: { action: WorkspaceAction; by: string; at: string; detail: string }[];
}
export interface WorkspaceApplication {
  id: string; listing_id?: string; status: string; name?: string;
  responsible_email?: string | null; collaborator_emails?: string[];
  workspace_version?: number; workspace?: WorkspaceState;
  listings?: { id: string; building_id?: string; title?: string; unit?: string; property_name?: string; price_amount?: number } | null;
  [key: string]: unknown;
}
export interface WorkspaceRepository {
  get(id: string): Promise<WorkspaceApplication | null>;
  list(principal: WorkspacePrincipal): Promise<WorkspaceApplication[]>;
  // Compare-and-swap: never silently overwrite a decision or revoked assignment.
  save(id: string, expectedVersion: number, patch: Record<string, unknown>, actor: string): Promise<WorkspaceApplication | null>;
  staff(): Promise<{ email: string; role: string; active: boolean; property_ids?: string[] }[]>;
}
export interface WorkspaceCommand {
  action: WorkspaceAction; version: number;
  [key: string]: unknown;
}

// A review must check the current uploads using the same checklist as intake.
export interface WorkspaceReviewPolicy { missingDocuments(row: WorkspaceApplication): string[] }
