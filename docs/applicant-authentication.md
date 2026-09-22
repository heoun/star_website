# Independent applicant authentication

Status: local implementation and automated fixtures only. Hosted Dev and production still use the existing provider until an operator completes the cutover below. No applicant provider has been provisioned. The current Supabase organization has reached its two-project Free limit; a hosting/budget decision is required. Never pause or delete an existing environment to make room without authorization.

## Boundaries

The server route selects the realm. Workspace login, invitations, password recovery, Owner/Admin MFA and staff grants keep using `SUPABASE_URL`. Applicant signup, login, email verification, password reset, refresh and logout use `APPLICANT_AUTH_URL` only when `APPLICANT_AUTH_MODE=isolated`. There is no fallback to workspace Auth if isolated configuration is invalid. `maintenance` closes applicant authentication for a coordinated migration while workspace authentication stays available. An unset mode preserves the current deployment until cutover.

Each project must enforce confirmed email and use its own signing keys. The Worker needs only the new project's publishable key. Provider service-role keys stay with the operator, not in the browser or the new Worker bindings. The existing business database and file storage remain in place.

A mailbox may have independent `app_users` rows in the `workspace` and `applicant` realms. Provider bindings include the applicant issuer. Verified provider subjects cannot be rebound to an existing applicant solely because the email matches. Applicant routes never turn a matching staff email into a staff principal. Existing backend passwords and MFA factors are not copied or reset. Old applicant cookies fail validation against the new provider; workspace cookies remain valid.

For reserved, unconfirmed provider accounts, Supabase signup does not overwrite a password. The isolated registration flow therefore verifies the email code and then installs the applicant's chosen password before completing login. The browser retains that password only in page memory across the code step. A repeated code cannot change it. See [Supabase signup implementation](https://github.com/supabase/auth/blob/master/internal/api/signup.go). Recovery changes only the applicant password.

## Prepare Dev first

1. Obtain approval for any hosting cost, create a distinct applicant Auth project and record its exact project URL. Do not substitute the production database or share a provider between Dev and production.
2. Configure confirmed email, password policy and rate limits. Use the reviewed Star Real Estate sender and OTP templates for signup/recovery. Confirm delivery and first-password/logout/password-login/recovery with an isolated test mailbox. Provisioning, SMTP configuration and hosted-provider behavior are still unverified.
3. Apply the reviewed `npm run db:bundle` schema to Dev. It is additive and leaves `applicant_auth_config` absent/inactive. Existing workspace bindings remain unchanged.
4. Inventory applications, rental drafts, existing Auth subjects/business IDs and internal test account references. Record the exact old subject, old business ID, email, new subject and new issuer for each applicant in a protected migration manifest. Review unverified users, null application identities and orphaned drafts explicitly; do not delete records to pass readiness checks.
5. Provision corresponding **unconfirmed, passwordless** users through the new provider's Admin API. Verify every new ID and email by reading the target Admin API. Do not copy password hashes or MFA, auto-confirm a mailbox, send invitations automatically or assume email matching proves ownership. New holders verify their mailbox and choose their own applicant password. Users with no historical applicant data can register normally after cutover.
6. Take a protected, restorable snapshot of business identities/bindings, applications, drafts and test-account settings. Include private file metadata/content and encryption-key recovery as separate backup requirements. Rehearse restore outside the running environments.

## Coordinated cutover

Pause applicant writes with `APPLICANT_AUTH_MODE=maintenance`, drain in-flight applicant requests and pause test automation that can create applications. Capture the final inventory. Keep workspace account management available, but do not edit applicant records during the maintenance window.

Run migration in one operator SQL transaction, locking applications and rental drafts against concurrent writes. Insert `applicant_auth_config` with the approved issuer (`https://<new-project>.supabase.co/auth/v1`) and `enabled=false`. For each manifest row call:

```sql
select public.migrate_applicant_identity(
  p_old_subject := '<verified source UUID>',
  p_new_subject := '<target Admin API UUID>',
  p_email := '<confirmed source email>',
  p_issuer := 'https://<new-project>.supabase.co/auth/v1'
);
```

The service-only function validates the confirmed source identity, records an exact old/new mapping, moves application ownership and draft owner/test IDs, and audits the change. It preserves account suspension. It never changes staff, Owner, source Auth credentials, documents, payment or screening records. Replays must match the recorded mapping exactly.

Before committing, set `applicant_auth_config.enabled=true`. Its trigger refuses activation while any application lacks an applicant business identity or any rental draft lacks a matching applicant provider binding. A failure rolls back the entire transaction; resolve the reported records and rerun the reviewed manifest. Verify record counts, unchanged staff/Owner bindings and sample private-document ownership before commit. The function accepts source/target mappings under operator authority; its target identity verification must occur against the external Admin API beforehand.

Configure the Worker with `APPLICANT_AUTH_URL`, `APPLICANT_AUTH_PUBLISHABLE_KEY` and `APPLICANT_AUTH_MODE=isolated`; retain `ACCOUNT_SECURITY=on`. Update `INTERNAL_TEST_USER_ID` to the mapped applicant subject if that fixture was migrated. The staging secret preparation script intentionally does not upload these settings automatically: use the approved exact target project and Worker, then remove any local secret staging files.

Do not silently enable isolation by changing repository defaults. Deploy Dev and perform the acceptance below before considering production. Production requires a separate provider, inventory, migration and explicit release.

## Recovery and rollback

Before migration commit, SQL rollback leaves business ownership untouched. If provider provisioning failed, keep those reserved accounts inactive; do not delete source users. The original provider remains usable after restoring the previous applicant mode **only when no business migration was committed**.

After committing but before opening applicant traffic, keep maintenance mode until the target can validate sessions and resolve bindings. If rollback is required, restore the protected pre-cutover business snapshot in a rehearsed operator procedure while writes remain paused, verify all source mappings and then restore the previous configuration. Ordinary application updates cannot reverse pinned identities; do not bypass the trigger on a live system. There is no automatic rollback command in this change.

Once new applicant traffic has been accepted, do not switch back to the shared provider or overwrite the database with an old snapshot. Keep the isolated provider, place applicant routes in maintenance if necessary, reconcile new writes and fix forward or prepare a reviewed reverse migration. Workspace access is preserved throughout.

## Acceptance

`npm run test:auth-realms` runs isolated PostgreSQL and two simulated Auth providers. It covers same-email independent passwords, registration into a pending account, OTP replay, recovery, MFA preservation, token swapping, refresh, logout, route scope, record migration, cutover readiness, schema replay and missing/malformed/shared provider configuration. It is part of `npm run test:release`. `npm run test:auth-realms:ui` adds browser registration, logout/password-login and recovery checks (requires Playwright, or `PLAYWRIGHT_MODULE` pointing to the installed module).

Hosted Dev acceptance remains mandatory: same email on both sides, different passwords, applicant signup/verification/logout/login, both recovery flows, simultaneous sessions, backend MFA still required, no role escalation, migrated application/draft/document visibility, roommate submission/merge and internal test tools. Verify authentication emails and confirm wrong-realm credentials fail. Passing simulated tests does not prove a hosted provider or SMTP is configured.
