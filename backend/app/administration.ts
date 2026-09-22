import { makeAccounts, makeOnboarding } from "../core/administration.ts";
import { makeAdministrationRepositories } from "../adapters/administration-supabase/index.ts";
import { makeOnboardingMail } from "../adapters/onboarding-email/index.ts";
import { makeOnboardingTokens } from "../adapters/onboarding-tokens/index.ts";
export { accountActions, normalizeIntake, ONBOARDING_UTILITIES } from "../core/administration.ts";
export function administrationFor(config: { url: string; key: string }, env: Record<string,unknown>, request: Request, identity?: {email:string;is_owner?:boolean;owner?:boolean}) {
  const repo = makeAdministrationRepositories({...config,ownerAdminEmail:env.ACCOUNT_SECURITY==='on' && identity?.is_owner && !identity.owner ? identity.email : undefined});
  const owner = String(env.OWNER_EMAIL || "").trim().toLowerCase();
  return { accounts: makeAccounts(repo.accounts, owner), onboarding: makeOnboarding(repo.onboarding,
    makeOnboardingMail(env, request), makeOnboardingTokens(), new URL(request.url).origin, owner) };
}
