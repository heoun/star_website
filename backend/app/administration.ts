import { makeAccounts, makeOnboarding } from "../core/administration.ts";
import { makeAdministrationRepositories } from "../adapters/administration-supabase/index.ts";
import { makeOnboardingMail } from "../adapters/onboarding-email/index.ts";
import { makeOnboardingTokens } from "../adapters/onboarding-tokens/index.ts";
export { accountActions, normalizeIntake, ONBOARDING_UTILITIES } from "../core/administration.ts";
export function administrationFor(config: { url: string; key: string }, env: Record<string,unknown>, request: Request) {
  const repo = makeAdministrationRepositories(config);
  const owner = String(env.OWNER_EMAIL || "").trim().toLowerCase();
  return { accounts: makeAccounts(repo.accounts, owner), onboarding: makeOnboarding(repo.onboarding,
    makeOnboardingMail(env, request), makeOnboardingTokens(), new URL(request.url).origin, owner) };
}
