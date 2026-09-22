# Google Identity Platform migration — Dev preparation

Status (2026-09-22): **provider adapter and Dev infrastructure only; not cut over**.
The current Worker routes, account UI and business identity resolvers still use
Supabase Auth. These new files do not switch Dev or production authentication.

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
created. Runtime material is not yet uploaded to Cloudflare.

The approved custom role `projects/starreusa-dev-auth/roles/starAuthRuntime`
contains only:

- `firebaseauth.users.create`
- `firebaseauth.users.get`
- `firebaseauth.users.update`
- `firebaseauth.users.sendEmail`

The role is bound to the runtime service account on the Dev project and both Dev
tenants. The impersonation exchange succeeds. IAM `testIamPermissions` reports
all four permissions, and a default-project account lookup succeeds, but tenant
account lookup and creation return `INSUFFICIENT_PERMISSION`. Do not broaden to
Editor, Owner, or Identity Platform Admin to bypass this failure. A proposed
additional **tenant-scoped read-only** `identitytoolkit.tenants.get` diagnostic
permission is awaiting the user's separate approval; it has not been granted.
Its necessity has not yet been established.

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

Offline tests currently pass 89 checks across signed JWT validation, issuer/
audience/tenant isolation, refresh isolation, disabled/revoked users, MFA pending
credentials, email action purpose/replay handling, recent MFA enrollment,
credential confinement and provider error redaction.

The live probe uses only two disposable `@example.invalid` accounts with random
unprinted passwords, generates email links without sending mail, and removes
only its own created UIDs. It does not access business records. The normal probe
requires the actual WIF runtime credential for Workspace provisioning; do not
mark it passed based on `--provider-only`.

Last provider-only result: 25 checks passed, including actual email verification,
independent passwords for the same mailbox, invitation password setup, TOTP
signin, reset isolation and replay rejection. Both test accounts were removed.
The runtime-IAM acceptance probe remains failing as described above.

## Remaining cutover work

1. Resolve and verify minimum runtime tenant permissions; read back the final
   policy and remove any diagnostic permission that was not needed.
2. Add provider/project/tenant business bindings and an audited migration with
   conflict checks. Workspace Owner/staff must retain their business UUIDs;
   applicant identities must remain separate even with the same email.
3. Integrate GIP into server sessions, invitation acceptance, branded verification
   and recovery links, login UI, MFA enrollment and role-switch authorization.
   A pending MFA credential must never become an authenticated session. A reset
   link must never bypass the next MFA challenge. Do not silently fall back to
   the old provider after cutover.
4. Prepare and verify existing account migration, including the Owner's MFA
   transition. Do not assume Supabase TOTP secrets can be imported. Do not bind
   a newly registered identity to historical records by email alone.
5. Configure allowed Dev domains, install the authorized runtime secrets on
   `star-website-staging`, run migration/route/UI regression tests and release
   gates, then deploy Dev and verify the actual live workflows.
6. Keep production unchanged until it has a separately reviewed rollout.

References: [Google tenant access control](https://docs.cloud.google.com/identity-platform/docs/multi-tenancy-access-control),
[Google account API permissions](https://docs.cloud.google.com/identity-platform/docs/access-control),
[Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers).
