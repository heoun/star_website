import type { AccountCommand, AccountRecord, AccountRepository, AdminPrincipal, LandlordIntake,
  OnboardingMail, OnboardingRecord, OnboardingRepository, OnboardingTokens } from "../contracts/administration.ts";
export class AdministrationError extends Error {
  status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}
const fail = (message: string, status = 422): never => { throw new AdministrationError(message, status); };
const clean = (value: unknown, max = 200) => String(value ?? "").trim().slice(0, max);
const emailOf = (value: unknown) => clean(value, 180).toLowerCase();
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const staffOnly = (p: AdminPrincipal) => { if (p.role !== "manager") fail("Only Admin can manage accounts and landlord onboarding.", 403); };
const businessAdminOnly = (p: AdminPrincipal) => { staffOnly(p); if (p.owner) fail("Platform Owner manages permissions only.", 403); };
const ownerOf = (p: AdminPrincipal, owner: string) => !!owner && p.owner === true && emailOf(p.email) === emailOf(owner);
export function accountActions(p: AdminPrincipal, owner: string, account: AccountRecord) {
  if (p.role !== "manager" || account.email === owner || account.email === p.email) return [];
  if (account.role === "manager") return ownerOf(p, owner) ? ["save", "revoke_admin", ...(account.active ? ["remove_admin"] : [])] : [];
  return ["save", ...(account.active ? ["remove_account"] : []), ...(account.role === "agent" && account.active && ownerOf(p, owner) ? ["grant_admin"] : [])];
}
export function makeAccounts(repo: AccountRepository, owner: string) {
  return {
    async list(p: AdminPrincipal) {
      staffOnly(p);
      return { staff: (await repo.list()).filter(a => a.email !== owner).map(a => ({ ...a, allowed_actions: accountActions(p, owner, a) })),
        owner: owner || null, you: { email: p.email, owner: ownerOf(p, owner) } };
    },
    async history(p: AdminPrincipal, email: string) { staffOnly(p); return repo.history(emailOf(email)); },
    async execute(p: AdminPrincipal, raw: AccountCommand) {
      staffOnly(p);
      const email = emailOf(raw.email);
      if (!validEmail(email) || !Number.isInteger(raw.version)) fail("Choose an account and refresh before saving.");
      if (email === owner || email === p.email) fail("Your account and the platform owner cannot be changed here.", 403);
      const existing = (await repo.list()).find(a => a.email === email);
      if (raw.action === "create_admin") {
        if (!ownerOf(p, owner)) fail("Only the platform owner can add Admins.", 403);
        if (existing) fail("This email already has an account. Select the existing internal account to grant Admin access.", 409);
        if (raw.version !== -1 || !clean(raw.name, 120) || clean(raw.reason, 1000).length < 5) fail("Enter a name, email and authorization reason for the new Admin.");
        return repo.save(p.email, owner, { action: "create_admin", email, version: -1, name: clean(raw.name, 120), reason: clean(raw.reason, 1000) });
      }
      if (raw.action === "remove_account") {
        if (!existing || !["agent", "landlord"].includes(existing.role) || !accountActions(p, owner, existing).includes("remove_account")) fail("Choose an active Agent or Landlord account you can manage.", 403);
        if (clean(raw.reason, 1000).length < 5) fail("Record why this account is being removed.");
        return repo.save(p.email, owner, { action: "remove_account", email, version: raw.version, reason: clean(raw.reason, 1000) });
      }
      if (existing?.role === "landlord" && raw.action !== "save") fail("Landlord accounts cannot be converted to internal staff accounts.", 409);
      if (existing && !accountActions(p, owner, existing).includes(raw.action)) fail("Only the platform owner can manage Admin accounts.", 403);
      if (!["save", "grant_admin", "revoke_admin", "remove_admin"].includes(raw.action)) fail("Unknown account action.");
      if (raw.action !== "save") {
        if (!ownerOf(p, owner)) fail("Only the platform owner can grant or revoke Admin access.", 403);
        if (!existing || (raw.action === "grant_admin" ? existing.role !== "agent" || !existing.active : existing.role !== "manager")) fail("Admin access changes apply to active internal team members only.");
        if (clean(raw.reason, 1000).length < 5) fail("Record why Admin access is being changed.");
      } else {
        if (existing && raw.role !== existing.role) fail("Account type is fixed. Use the separate Owner authorization action for Admin access.", 409);
        if (!existing && !["agent", "landlord"].includes(raw.role || "")) fail("Create an Agent or a Landlord account. Only the Owner grants Admin access.", 403);
        if (raw.active !== undefined && typeof raw.active !== "boolean") fail("Choose an active or inactive account state.");
        if (raw.property_ids !== undefined && (!Array.isArray(raw.property_ids) || raw.property_ids.some(id => !uuid(id)))) fail("Choose valid property assignments.");
        if (!existing && raw.role === "landlord") fail("Landlord accounts and properties are created through approved onboarding.", 403);
        if (existing?.role === "landlord" && raw.property_ids !== undefined &&
          JSON.stringify([...new Set(raw.property_ids)].sort()) !== JSON.stringify([...new Set(existing.property_ids || [])].sort())) {
          fail("Landlord properties are bound through approved onboarding and cannot be reassigned in Accounts & access.", 403);
        }
        if (existing?.role === "manager" && raw.active !== undefined && raw.active !== existing.active && clean(raw.reason, 1000).length < 5) fail("Record why this Admin account is being activated or suspended.");
      }
      return repo.save(p.email, owner, { ...raw, email, name: raw.name === undefined ? existing?.name || "" : clean(raw.name, 120), reason: clean(raw.reason, 1000) });
    }
  };
}
export const ONBOARDING_UTILITIES = ["water", "sewer", "gas", "electricity", "trash", "internet"];
export function normalizeIntake(raw: unknown, required: boolean): LandlordIntake {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("Enter your landlord and property details.");
  const input = raw as Record<string, unknown>;
  const properties = input.properties;
  if (!Array.isArray(properties) || properties.length < 1 || properties.length > 10) fail("Add between one and ten properties.");
  const result: LandlordIntake = {
    legal_name: clean(input.legal_name), contact_name: clean(input.contact_name, 120), phone: clean(input.phone, 50), mailing_address: clean(input.mailing_address, 400),
    properties: (properties as Record<string, unknown>[]).map(property => {
      if (!property || typeof property !== "object" || Array.isArray(property)) fail("Check the property details.");
      const value = { name: clean(property.name), street: clean(property.street), city: clean(property.city, 100), state_abbr: clean(property.state_abbr, 2).toUpperCase(), zip: clean(property.zip, 10), unit_count: clean(property.unit_count, 6), notes: clean(property.notes, 2000), utilities: {} as Record<string, string> };
      if (value.unit_count && (!/^\d+$/.test(value.unit_count) || Number(value.unit_count) < 1 || Number(value.unit_count) > 100000)) fail("Enter a valid number of rental units.");
      for (const [key, val] of Object.entries((property.utilities || {}) as object)) {
        if (!ONBOARDING_UTILITIES.includes(key) || !["Landlord", "Tenant", "N/A", ""].includes(String(val))) fail("Choose who pays for each utility.");
        if (val) value.utilities[key] = String(val);
      }
      if (required && (!value.name || !value.street || !value.city || !/^[A-Z]{2}$/.test(value.state_abbr) || !/^\d{5}(-\d{4})?$/.test(value.zip))) fail("Complete the name and US mailing address for every property.");
      return value;
    })
  };
  if (required && (!result.legal_name || !result.contact_name || !result.phone || !result.mailing_address)) fail("Complete the landlord entity, contact, phone and mailing address.");
  if (required && new Set(result.properties.map(p => p.name.toLowerCase())).size !== result.properties.length) fail("Use a different name for each property.");
  return result;
}
export const publicIntake = (r: OnboardingRecord) => ({ id: r.id, email: r.email, contact_name: r.contact_name, status: r.status, version: r.version, expires_at: r.expires_at, data: r.data, review_note: r.review_note });
export const adminIntake = (r: OnboardingRecord) => { const { token_hash, ...safe } = r; return safe; };
export function makeOnboarding(repo: OnboardingRepository, mail: OnboardingMail, tokens: OnboardingTokens, origin: string, owner: string) {
  const deadline = () => new Date(Date.now() + 14 * 86400000).toISOString();
  const activity = (r: OnboardingRecord, action: string, by: string, note = "") => [...r.activity, { action, by, note, at: new Date().toISOString() }];
  const load = async (id: string) => { const r = uuid(id) ? await repo.get(id) : null; return r || fail("Invitation not found.", 404); };
  const byToken = async (token: string) => {
    if (!/^[a-f0-9]{64}$/.test(token)) fail("This invitation link is unavailable or expired. Please contact your leasing team.", 410);
    const r = await repo.byToken(await tokens.hash(token));
    if (!r || Date.parse(r.expires_at) <= Date.now() || ["cancelled", "rejected"].includes(r.status)) fail("This invitation link is unavailable or expired. Please contact your leasing team.", 410);
    return r!;
  };
  const deliver = async (row: OnboardingRecord, token: string) => {
    let state: OnboardingRecord["email_state"] = "failed";
    try { state = await mail.invite(row.email, row.contact_name, `${origin}/landlord-onboarding/#${token}`, row.review_note); } catch {}
    await repo.delivery(row.id, row.token_hash, state);
    return state;
  };
  return {
    async list(p: AdminPrincipal) { businessAdminOnly(p); return (await repo.list()).map(adminIntake); },
    async get(p: AdminPrincipal, id: string) { businessAdminOnly(p); return adminIntake(await load(id)); },
    async invite(p: AdminPrincipal, input: { id: string; email: string; contact_name: string }) {
      businessAdminOnly(p); const email = emailOf(input.email);
      if (!uuid(input.id) || !validEmail(email) || !clean(input.contact_name, 120)) fail("Enter the landlord's name and email.");
      const account = await repo.account(email);
      if (email === owner || (account && (account.role !== "landlord" || !account.active))) fail("This address belongs to an internal or inactive account. Use the landlord's own contact address.", 409);
      const existing = await repo.get(input.id);
      if (existing) { if (existing.email !== email) fail("Invitation already exists.", 409); return adminIntake(existing); }
      const secret = await tokens.issue();
      const row: OnboardingRecord = { id: input.id, email, contact_name: clean(input.contact_name, 120), created_by: p.email, created_at: new Date().toISOString(), token_hash: secret.hash,
        expires_at: deadline(), version: 0, status: "invited", email_state: "pending", data: {}, review_note: "", building_ids: [], activity: [] };
      row.activity = activity(row, "invited", p.email);
      if (!await repo.create(row)) return adminIntake(await load(row.id));
      row.email_state = await deliver(row, secret.token);
      return adminIntake(row);
    },
    async readPublic(token: string) { return publicIntake(await byToken(token)); },
    async submit(token: string, input: { version: number; data: unknown; submit?: boolean; attested?: boolean }) {
      const row = await byToken(token);
      if (!Number.isInteger(input.version) || (input.submit !== undefined && typeof input.submit !== "boolean")) fail("Reload this form and choose Save draft or Submit for review.");
      if (!["invited", "changes_requested"].includes(row.status)) fail("This submission is with your leasing team and is no longer editable.", 409);
      if (input.submit && input.attested !== true) fail("Confirm that you are authorized to provide this information.");
      const data = normalizeIntake(input.data, input.submit === true);
      const saved = await repo.save(row.id, input.version, { data, status: input.submit ? "submitted" : row.status,
        activity: activity(row, input.submit ? "submitted" : "draft_saved", row.email) });
      if (!saved) fail("This form changed in another window. Reload before saving.", 409);
      return publicIntake(saved!);
    },
    async act(p: AdminPrincipal, id: string, input: { version: number; action: string; reason?: string }) {
      businessAdminOnly(p); const row = await load(id);
      if (row.version !== input.version) fail("This submission changed. Refresh before reviewing.", 409);
      if (input.action === "approve") {
        if (row.status !== "submitted") fail("Only submitted information can be approved.", 409);
        normalizeIntake(row.data, true);
        return adminIntake(await repo.approve(id, input.version, p.email, owner));
      }
      if (["approved", "rejected", "cancelled"].includes(row.status)) fail("This invitation is already closed.", 409);
      const reason = clean(input.reason, 2000);
      if (!["resend", "request_changes", "reject", "cancel"].includes(input.action)) fail("Unknown invitation action.");
      if (["request_changes", "reject"].includes(input.action) && (row.status !== "submitted" || reason.length < 5)) fail("Review a submitted form and explain what needs to change.");
      if (input.action === "resend" && row.status === "submitted") fail("The landlord has already submitted. Review their information first.", 409);
      const send = ["resend", "request_changes"].includes(input.action);
      const secret = send ? await tokens.issue() : null;
      const saved = await repo.save(id, input.version, {
        status: input.action === "request_changes" ? "changes_requested" : input.action === "reject" ? "rejected" : input.action === "cancel" ? "cancelled" : row.status,
        ...(input.action === "request_changes" || input.action === "reject" ? { review_note: reason } : {}),
        ...(secret ? { token_hash: secret.hash, expires_at: deadline(), email_state: "pending" } : {}),
        activity: activity(row, input.action, p.email, reason)
      });
      if (!saved) fail("This invitation changed. Refresh before saving.", 409);
      if (secret) saved!.email_state = await deliver(saved!, secret.token);
      return adminIntake(saved!);
    }
  };
}
