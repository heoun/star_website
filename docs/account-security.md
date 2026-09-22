# Account identity, access and recovery

Status: Dev implementation and automated verification complete; human activation/acceptance pending. Production remains unchanged until an accepted Dev revision is released.

## Identity and roles

`app_users.id` is the permanent business identity. `auth_bindings` maps a provider and subject to that identity. No email-only automatic rebind is allowed after an identity exists. Supabase currently verifies credentials; `resolve_business_identity` verifies the confirmed Auth record before resolving its business ID. Applications retain this ID and private applicant documents require it when `ACCOUNT_SECURITY=on`.

Each database has one `platform_owner` singleton. Its email is `info@starreusa.com`. Dev and production have separate identities. Provision through `scripts/owner-identity.mjs`, never public role claims or Auth user metadata. A fresh operator-provisioned identity may be reserved before verification; access still requires verified email, password setup and MFA. Existing confirmed identities are pinned, not recreated.

The Owner governs accounts only. Its optional Admin grant is independent; role changes require a recent MFA challenge (five minutes), validate grants on every request and are audited. Role cookies select a mode and never grant permission. Admin cannot appoint Admins or change Owner. Agent and Landlord types remain separate. Landlord accounts are created on invitation with no property access; submission and Admin approval bind properties. Landlord decision email links additionally require the matching authenticated, active landlord.

`ACCOUNT_SECURITY=on` is the migration rollout switch, enabled in the repository's production and staging Worker configurations. The old path remains only for compatibility fixtures; do not turn the switch off to recover an account. Local role demos can bypass real login on loopback only and are not authentication acceptance tests.

## Invitations and activation

Workspace invitations are hashed, bound to email and role, expire in seven days and are accepted atomically once. Landlord onboarding invitations expire in fourteen days. Resending replaces the token; revoking invalidates pending acceptance. Suspending the directory account blocks access even with an existing cookie. Revoking an invitation does not suspend an already active account.

An existing user signs in or verifies an email code and accepts the invitation without changing their password. A new or previously unverified account verifies email before setting its first password. First-time setup is explicit state; provider-generated password hashes do not count as a user-set password. Password reset is a separate explicit flow. Owner/Admin must enroll and verify a TOTP authenticator before business or account-management APIs become accessible. Provider access and refresh tokens remain in HttpOnly, Secure, host-only cookies on deployed sites; refresh rotation must propagate to the browser.

## Operator bootstrap

1. Apply the reviewed `npm run db:bundle -- /private/path/release.sql` to the intended database. Never apply a Dev data dump to production.
2. Run `node scripts/owner-identity.mjs staging /path/to/dev.env --provision`. For production use `production` and that environment's credentials. This checks the exact approved email, creates a passwordless Auth identity only if absent, and pins the Owner. An incompatible existing identity is refused.
3. Deploy with `ACCOUNT_SECURITY=on`, `OWNER_EMAIL=info@starreusa.com`.
4. The human Owner opens `/login/`, selects “Activate an invited account”, verifies their email, creates a password and binds their own authenticator. Do not collect their password, setup key or OTP in chat.
5. Grant the optional Admin role in Account security & roles, record a reason and switch roles explicitly.

Bootstrap is idempotent. It must never delete a conflicting account or replace an existing Owner. Operator credentials, password hashes and MFA secrets never belong in the repository or logs.

## Recovery

Recovery is an operator procedure, not a public elevation endpoint. Loss of a password uses verified email recovery; this does not waive MFA. For a lost authenticator, independently verify the account holder through the known business contact and control of the existing mailbox. Record the request and approval outside the affected login before changing factors. For Owner recovery, an authorized infrastructure operator with Supabase administrative access is required; another application Admin cannot reset the Owner.

After approval: identify the exact existing provider subject and internal user ID, revoke affected sessions, reset only the lost factor through the provider's administrative interface, and require the holder to enroll a replacement before privileged access. Revoke any remaining sessions after replacement and verify the old factor no longer works. Preserve `app_users`, `auth_bindings`, roles and audit history. Record operator, target ID, reason and time in the security incident record and `identity_audit`. An operator must never mark email verified solely to bypass the normal mailbox proof.

Keep infrastructure account recovery methods and encrypted credentials in the organization's controlled password manager. Do not rely on the sole app Owner account to access infrastructure recovery. Automated self-service MFA recovery is not implemented.

## Migration and backup

Back up business tables including `app_users`, provider bindings, staff, Owner singleton, invitations, audits, applications and rental drafts. Auth schema backups are separately protected because they contain password hashes and MFA material. Back up private file contents independently of database metadata. Store the application encryption key in a separate recoverable secret store; a database backup alone cannot recover encrypted SSNs.

Provider migration maps a new verified provider subject onto the SAME business ID under operator control. Never use public email matching to do this. Rental draft `owner_id`, test fixture account IDs and historical email fields still retain legacy provider identifiers; include and reconcile these explicitly in a migration manifest. Do not claim those legacy fields are provider-independent. At cutover invalidate sessions and pending invitation links, reissue invitations where necessary, and verify role/data boundaries before DNS changes. MFA portability and password-hash compatibility must be validated for the chosen provider.

A backup is accepted only after a restore rehearsal in an isolated database. No automated remote backup schedule is created by this change.

## Acceptance

`npm run test:account-security` uses isolated PostgreSQL and a simulated Auth provider: Owner singleton, identity reuse refusal, MFA gates, role grants/revocation, forged sessions, invitation replay, and preservation of existing passwords. `npm run test:release` covers the existing rental and signing flows.

Human acceptance on Dev is still required: Owner email verification/password/authenticator enrollment, a new and existing Admin invite, Agent scope, landlord registration/draft/approval/property access, sign-out, password reset, expired/revoked invitations, suspension and denied cross-account/private-file access. Only after this acceptance should the same revision and schema be promoted to production.
