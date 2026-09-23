# Google Identity Platform migration — Dev preparation

Status (2026-09-22): **Dev configured for GIP; production retains Supabase Auth**.
`AUTH_PROVIDER=gip` selects GIP explicitly; an absent flag retains Supabase Auth.
No automatic provider fallback is allowed. Production remains Supabase.

## Approved target

- Google project: `starreusa-dev-auth` (`54640971372`).
- Applicant tenant: `Applicant-sw0j9`.
- Workspace tenant: `Workspace-7ppgr`.
- Intended runtime: Cloudflare `star-website-staging`, `dev.starreusa.com`.
- Runtime service account:
  `star-dev-auth-runtime@starreusa-dev-auth.iam.gserviceaccount.com`.
- Supabase remains the business database. Existing application ownership,
  Workspace grants and the singleton Owner must survive migration.
- Production is outside this preparation. The admin adapter deliberately rejects
  any project other than this Dev project.

Both tenants enable email/password and TOTP, disable anonymous sign-in and SMS,
require passwords of at least eight characters, and enable improved email privacy.
Workspace client signup and both tenants' client deletion are disabled.
A tenant MFA setting does not enforce administrator MFA by itself: the application
must enforce it before granting Workspace access.

## Runtime credentials and current blocker

The organization prohibits Google service-account private-key creation. That
policy was retained. Workload Identity Federation instead trusts a public RSA
key pinned on pool `star-dev-auth`, provider `cloudflare-worker`:

- issuer: `https://dev.starreusa.com/workload-identity`
- subject: `star-website-staging`
- condition: `assertion.sub == 'star-website-staging'`
- audience: `//iam.googleapis.com/projects/54640971372/locations/global/workloadIdentityPools/star-dev-auth/providers/cloudflare-worker`

The workload principal has `roles/iam.workloadIdentityUser` on only the runtime
service account. The Worker will hold its own external workload private key;
this is **not** a completely keyless setup. It signs five-minute assertions and
requests ten-minute Google access tokens. No Google service-account key was
created. Runtime material is installed only on `star-website-staging`.

The approved custom role `projects/starreusa-dev-auth/roles/starAuthRuntime`
contains only:

- `firebaseauth.users.create`
- `firebaseauth.users.get`
- `firebaseauth.users.update`
- `firebaseauth.users.sendEmail`

The four-permission role is bound on the Dev project and its two tenants.
Real audit logs established two additional requirements: `SignUp` requires
`identitytoolkit.tenants.update`, and `GetAccountInfo` requires
`identitytoolkit.tenants.get`. Both were approved separately. The single-permission
roles `starAuthTenantWriter` and `starAuthTenantReader` are bound **only to the two
named Dev tenant resources**, never the project. The write permission also permits
changing tenant authentication configuration; it is broader than user writes.
No Editor, Owner, tenant IAM-management or production permission was granted.
Temporary read audit logging used for diagnosis was restored afterwards.

The actual WIF runtime now passes the 25-check live acceptance probe, including
account provisioning, lookup and branded-action generation. Synthetic accounts
were removed and no emails were sent. Earlier provider-only results were not
used as a substitute for this runtime verification.

## Local tools and secrets

The official Google Cloud CLI is installed only under the ignored directory
`.local/gip-tools/google-cloud-sdk`. Its OAuth configuration is in
`.local/gip-tools/config`; no user access tokens are printed by the scripts.

Ignored, mode-0600 files:

- `.local/gip/dev-config.json`: project, API key, tenant IDs.
- `.local/gip/workload.json`: external workload signing key and fixed target.
- `.local/gip/workload-public-jwks.json`: public verification key uploaded to Google.

Do not commit these files or paste their contents into chat/logs. The intended
Worker secret `GIP_WORKLOAD_IDENTITY` is the contents of `workload.json`.

```sh
npm run gip:dev -- inspect
npm run gip:dev -- configure
npm run gip:dev -- save-config
npm run gip:workload -- prepare
npm run gip:workload -- create
npm run gip:workload -- grant
npm run gip:workload -- grant-tenants
npm run gip:workload -- grant-tenant-write
npm run gip:workload -- grant-tenant-read
npm run gip:dev -- domains
```

Provisioning commands are Dev-only. `create`, `grant` and `grant-tenants` change
Google infrastructure/IAM and require the applicable authorization. They must not
replace a missing workload key automatically. `grant-tenants` preserves existing
policy bindings and the policy etag. The project custom role itself was created
and approved separately; these commands do not add permissions to it.

## Validation

```sh
npm run test:gip
npm run test:gip:live
# Diagnostic fallback while runtime IAM is unresolved:
npm run test:gip:live -- --provider-only
```

Offline provider tests pass 89 checks across signed JWT validation, issuer/
audience/tenant isolation, refresh isolation, disabled/revoked users, MFA pending
credentials, email action purpose/replay handling, recent MFA enrollment,
credential confinement and provider error redaction.

The live probe uses only two disposable `@example.invalid` accounts with random
unprinted passwords, generates email links without sending mail, and removes
only its own created UIDs. It does not access business records. The normal probe
requires the actual WIF runtime credential for Workspace provisioning; do not
mark it passed based on `--provider-only`.

Additional tests cover the real Worker routes with synthetic Google transports,
a real PostgreSQL-compatible migration schema, and browser forms. Run
`npm run test:gip:ui` with Playwright available for browser coverage.
The GIP gate also runs the actual workerd fetch implementation with intercepted
outbound requests. Keep this regression: Workers rejects `redirect: 'error'` at
request construction, unlike Node. Both transports use `manual` and reject all
3xx responses before processing their bodies or following any credential-bearing
redirect.

## Migration and cutover

The operator-only `scripts/gip-migrate-dev.mjs` supports `plan`, `provision` and
`sql`. It is pinned to Star Dev and never exports password hashes or TOTP secrets.
It chooses stable target UIDs before provisioning, verifies both source and target
identities, and refuses to bind a pre-existing target merely because email matches.
The ignored manifest must be retained for resumability and audit. No emails are
sent by this script. SQL execution is a separate operator action.

The reviewed Dev plan has three Workspace identities and two Applicant identities,
preserving 18 applications, two drafts, staff roles and the singleton Owner's
business UUID. The same mailbox can have an independent identity in both tenants.
The user explicitly approved new passwords and fresh MFA enrollment for Dev;
source Supabase accounts and their factors remain unchanged. Staff-only accounts
are not automatically registered in the Applicant tenant.

Release sequence:
1. Apply the tested schema bundle while GIP realm configuration is inactive.
2. Install runtime secrets and deploy compatible code with existing Supabase Auth.
3. Enable `AUTH_MIGRATION=maintenance` and stop local writers using the same DB.
   All normal HTTP requests receive 503 with Retry-After; scheduled jobs pause.
4. Execute the generated cutover SQL atomically: migrate verified bindings,
   preserve Workspace UUIDs, rebind Applicant records, and enable both realms.
5. Select `AUTH_PROVIDER=gip`, verify configuration, remove maintenance, and
   check the public login/portal routes and access gates. Align local configuration.
6. Existing users choose passwords through their realm's reset/activation flow.
   Owner/Admin access stays blocked until fresh TOTP enrollment is completed.

Do not roll back only the Worker after business data migration. Keep maintenance
active and review the recorded old/new bindings and any post-cutover writes before
reverting database references. Retaining old accounts alone is not a full rollback.
Production requires a separate reviewed migration; this adapter's runtime credential
is deliberately restricted to the Dev project.

## Google-managed security emails

Dev uses Resend SMTP (`smtp.resend.com:465`, TLS), with the existing Resend
credential explicitly authorized for storage in `starreusa-dev-auth`. Both Dev
tenants inherit the project's email settings. All four Google template senders
are `Star Real Estate <no-reply@starreusa.com>` with replies to
`info@starreusa.com`. The Google project's display name is `Star Real Estate Dev`;
its project ID is unchanged.

Use `node scripts/gip-email-config.mjs plan|apply|verify` to inspect, apply or
read back this Dev-only configuration. The tool never sends mail or prints SMTP
credentials. Application-owned verification/reset emails still use the existing
branded Worker/Resend flow.

The automatic MFA enrollment notification is a Google-owned safety email. On
2026-09-22, its custom HTML update and a separate subject-only update returned
`EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`, including after custom SMTP was enabled.
Sender name/local part/reply-to updates succeeded. Do not claim its body uses our
logo/card layout. Preserve Google's original security text, tenant-bound link,
and hosted action handler; replacing the handler with `/login/` would break
`revertSecondFactorAddition`. No real user's factor is changed to test branding.

References: [Google tenant access control](https://docs.cloud.google.com/identity-platform/docs/multi-tenancy-access-control),
[Google account API permissions](https://docs.cloud.google.com/identity-platform/docs/access-control),
[Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers).
