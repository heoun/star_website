import type { WorkspaceApplication, WorkspacePrincipal, WorkspaceTerms, ScreeningResult } from './workspace.ts';
export interface RentalInvitation { id: string; email: string; name: string; expires: string; accepted?: string; delivery?: string }
export interface RentalMemberSummary { id: string; name: string; annual_income: string; income_source: string; employment: string; credit_score: number | null; score_model: string; report_date: string; report_status: string; report_issue: string; mock: boolean }
export interface RentalGroup { root: WorkspaceApplication; members: WorkspaceApplication[] }
export interface RentalStore {
  group(id: string): Promise<RentalGroup | null>;
  save(group: RentalGroup, patches: Record<string, Record<string, unknown>>, actor: string, join?: WorkspaceApplication): Promise<void>;
  staff(): Promise<{ email: string; name?: string; role: string; active: boolean; property_ids?: string[] }[]>;
  pending(): Promise<string[]>;
  list(principal: RentalPrincipal): Promise<RentalGroup[]>;
}
export interface RentalScreening {
  // Idempotent per application and input version; returns pending when a vendor is not connected.
  check(row: WorkspaceApplication): Promise<ScreeningResult>;
}
export interface RentalMail {
  decision(root: WorkspaceApplication, members: RentalMemberSummary[], key: string): Promise<'sent' | 'preview' | 'failed'>;
  invite(root: WorkspaceApplication, invitation: RentalInvitation): Promise<'sent' | 'preview' | 'failed'>;
}
export interface RentalDependencies {
  allowMockScreening?: boolean;
  store: RentalStore; screening: RentalScreening; mail: RentalMail;
  missingDocuments(row: WorkspaceApplication): string[];
  lease(group: RentalGroup, terms: WorkspaceTerms): Promise<{ values: Record<string, unknown>; missing: string[] }>;
  landlord(root: WorkspaceApplication): Promise<string | null>;
}
export type RentalPrincipal = WorkspacePrincipal;
