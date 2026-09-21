import type { WorkspaceApplication, WorkspacePrincipal, WorkspaceTerms, ScreeningResult } from './workspace.ts';
export interface RentalInvitation { id: string; email: string; name: string; expires: string; accepted?: string; delivery?: string }
export interface RentalMemberSummary { id: string; name: string; annual_income: string; income_source: string; employment: string; credit_score: number | null; score_model: string; report_date: string; report_status: string; report_issue: string; mock: boolean }
export interface RentalGroup { root: WorkspaceApplication; members: WorkspaceApplication[] }
export interface RentalStore {
  group(id: string): Promise<RentalGroup | null>;
  save(group: RentalGroup, patches: Record<string, Record<string, unknown>>, actor: string, join?: WorkspaceApplication): Promise<void>;
  separate(group: RentalGroup, memberId: string, remainingRoot: string, remove: boolean, patches: Record<string, Record<string, unknown>>, actor: string): Promise<void>;
  staff(): Promise<{ email: string; name?: string; role: string; active: boolean; property_ids?: string[] }[]>;
  pending(): Promise<string[]>;
  // Roots of automatic cases, whatever their status, with a member whose
  // ready-for-review confirmation is still queued or failed. Only rows that
  // carry such a notice are read; closed cases are not scanned, and a declined
  // case leaves the set once reconciliation cancels its unsent notices.
  notices(): Promise<string[]>;
  list(principal: RentalPrincipal): Promise<RentalGroup[]>;
  // Every automatic-flow group for one listing, competing groups included.
  listing(listingId: string): Promise<RentalGroup[]>;
}
export interface RentalScreening {
  // Idempotent per application and input version; returns pending when a vendor is not connected.
  check(row: WorkspaceApplication): Promise<ScreeningResult>;
}
export interface RentalMail {
  decision(root: WorkspaceApplication, members: RentalMemberSummary[], key: string): Promise<'sent' | 'preview' | 'failed'>;
  invite(root: WorkspaceApplication, invitation: RentalInvitation): Promise<'sent' | 'preview' | 'failed'>;
  // One member's confirmation that their own part of the application is
  // complete and under review. `key` is stable across retries.
  ready(root: WorkspaceApplication, member: WorkspaceApplication, key: string): Promise<'sent' | 'preview' | 'failed'>;
}
export interface RentalDependencies {
  allowMockScreening?: boolean;
  store: RentalStore; screening: RentalScreening; mail: RentalMail;
  missingDocuments(row: WorkspaceApplication): string[];
  lease(group: RentalGroup, terms: WorkspaceTerms): Promise<{ values: Record<string, unknown>; missing: string[] }>;
  landlord(root: WorkspaceApplication): Promise<string | null>;
}
export type RentalPrincipal = WorkspacePrincipal;
