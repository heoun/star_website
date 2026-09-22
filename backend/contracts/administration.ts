// Admin workflow and account governance requested on 2026-09-09.
// Owner is a deployment-bound capability, not a role editable in the directory.
export interface AdminPrincipal { email: string; role: string; owner?: boolean }
export interface AccountRecord {
  email: string; name?: string | null; role: "manager" | "agent" | "landlord";
  active: boolean; property_ids?: string[]; account_version?: number;
}
export interface AccountCommand {
  action: "save" | "grant_admin" | "revoke_admin" | "create_admin" | "remove_admin" | "remove_account";
  email: string; version: number; role?: string; name?: string;
  active?: boolean; property_ids?: string[]; reason?: string;
}
export interface AccountRepository {
  list(): Promise<AccountRecord[]>;
  history(email: string): Promise<Record<string, unknown>[]>;
  save(actor: string, ownerEmail: string, command: AccountCommand): Promise<AccountRecord>;
}
export interface IntakeProperty {
  name: string; street: string; city: string; state_abbr: string; zip: string;
  unit_count: string; notes: string; utilities: Record<string, string>;
}
export interface LandlordIntake {
  legal_name: string; contact_name: string; phone: string; mailing_address: string;
  properties: IntakeProperty[];
}
export interface OnboardingRecord {
  id: string; email: string; contact_name: string; created_by: string; created_at: string;
  token_hash: string; expires_at: string; version: number;
  status: "invited" | "submitted" | "changes_requested" | "approved" | "rejected" | "cancelled";
  email_state: "pending" | "sent" | "failed" | "preview";
  data: Partial<LandlordIntake>; review_note: string; building_ids: string[];
  activity: { action: string; by: string; at: string; note?: string }[];
}
export interface OnboardingRepository {
  list(): Promise<OnboardingRecord[]>;
  get(id: string): Promise<OnboardingRecord | null>;
  byToken(hash: string): Promise<OnboardingRecord | null>;
  create(row: OnboardingRecord): Promise<boolean>;
  save(id: string, version: number, patch: Partial<OnboardingRecord>): Promise<OnboardingRecord | null>;
  delivery(id: string, hash: string, state: OnboardingRecord["email_state"]): Promise<void>;
  approve(id: string, version: number, actor: string, ownerEmail: string): Promise<OnboardingRecord>;
  account(email: string): Promise<AccountRecord | null>;
}
export interface OnboardingMail {
  invite(to: string, name: string, url: string, note: string): Promise<"sent" | "failed" | "preview">;
}
export interface OnboardingTokens { issue(): Promise<{ token: string; hash: string }>; hash(token: string): Promise<string> }
