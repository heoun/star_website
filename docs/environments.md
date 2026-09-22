# Development, acceptance and production releases

The acceptance site is `https://dev.starreusa.com`. Production stays at
`https://starreusa.com`. A release promotes code and reviewed schema changes;
it never copies test applications, users or screening reports into production.

| Component | Local development | Online Dev | Production |
| --- | --- | --- | --- |
| Runtime | Wrangler on this computer | `star-website-staging` Worker | `star-website` Worker |
| Database / files / Auth | Star Dev, or isolated fixture demo | Star Dev (`shlodyxlnepxnafthvod`) | Existing production project |
| Login | Optional local staff preview | Real verified account and staff directory | Real verified account and staff directory |
| Payments / credit | Local simulator / fixtures | Private `star-screening-staging` service with D1 persistence | Real provider configuration required |
| Signing | DocuSign Sandbox | DocuSign Sandbox, fixed HTTPS callback | Production DocuSign credentials required |
| Background jobs | Only while local scheduler runs | Cloudflare cron, once per minute; webhooks process arriving events | Cloudflare cron and webhooks |
| Public URLs | localhost | Fixed Dev domain; noindex and visible test badge | Main domain |

Online Dev keeps the normal application, portal, upload, review, landlord decision,
lease and signing flow. Sample-fill and simulation controls require the configured
test account/inbox and listing allowlists. There is no deployed admin bypass.
Application mail is restricted to configured test inboxes. Auth verification
messages are sent by the separate Star Dev Supabase project.

## Everyday workflow

1. Develop locally and commit a coherent change. `npm run dev` remains available
   for quick edits; `npm run demo:workspace` uses isolated synthetic fixtures.
2. Run `npm run test:release`. It covers isolation, schema, applicant identity,
   email, rental workflow, signing and the simulated application journey.
3. Deploy that commit to Dev, then test it at `https://dev.starreusa.com`.
   `/api/release` identifies the exact commit currently running.
4. Once accepted, release the **same commit SHA** to production. The release
   script refuses a commit different from the currently deployed Dev version.
   Production configuration and provider readiness must also be prepared; a
   successful simulated payment is not a verified production payment integration.

Pushes to `haiyang_dev` run the gate and publish Dev automatically.
GitHub Actions → **Release a verified revision** accepts a full commit SHA and
`staging` or `production`. Its deployment job depends on its verification job.
There is no automatic production deployment on a push to `main`.
The manual production run is the explicit promotion action; do not use it merely
to save work. The available GitHub account has write access, not Admin access.
This workflow therefore does not require GitHub environments. Environment
reviewers and branch protection are future administrator setup, not enforced
by the current repository. Workflow dispatch becomes available after the workflow
is present on the default branch; Dev push runs work on the development branch.

The existing repository `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets
are used by CI. Supabase and provider keys stay in their respective Workers.
CI checks the target's public health response for the expected schema hash;
it does not need another copy of the database service key. Initial provisioning
uses local target credentials until the version-aware health endpoint is live.

For a local release, supply the target database credentials through the process
environment and run `npm run deploy:dev` or `npm run deploy`. These commands require
a clean committed tree, perform schema verification, run the test gate and build
with the locked local Wrangler installation. Avoid direct Wrangler deployment
because it bypasses the application release checks.

## Database versions

Generate a reviewed additive SQL bundle with:

```sh
npm run db:bundle -- /tmp/star-release.sql
```

Apply the bundle to **Dev first**, through the project's SQL editor. The bundle
runs in a single transaction and records its content hash in `star_schema_release`.
The release script requires the expected hash. It contains the ordered setup
scripts, including staff identity binding, storage access, memberships, drafts
and signing. Column/table removal scripts are deliberately excluded.

Before applying a production bundle, review compatibility with the running
version and take the appropriate backup. Apply additive changes before code
promotion; schedule destructive cleanup separately after old code is retired.
Rolling back Worker code does not roll back database schema or third-party state.
For changes that cannot coexist with the prior version, use a separately reviewed
migration plan instead of the additive bundle.

The private simulator has its own versioned D1 migrations in
`testing/screening/migrations/`. Apply reviewed changes with:

```sh
npx --no-install wrangler d1 migrations apply star-screening-staging --remote --config testing/screening/wrangler.jsonc
```

CI checks the applied migration list through Dev health. The existing CI token
cannot execute D1 migrations, so these use the operator's Cloudflare login before
a release; normal code releases do not need a broader CI token.

## One-time online Dev setup

- Apply the Dev schema bundle; keep both Supabase storage buckets private.
- Set Star Dev Auth Site URL to `https://dev.starreusa.com`. The app uses codes,
  rather than depending on emailed localhost callback links. Keep SMTP sender
  `Star Real Estate <no-reply@starreusa.com>`.
- Prepare the selected existing test secrets with `node scripts/staging-secrets.mjs`.
  Upload `.local/staging/secrets.json` with Wrangler `secret bulk --env staging`,
  then delete the temporary file. Never upload `DEV_ADMIN_EMAIL` or a production
  provider key. This preparation command itself makes no network calls.
- Deploy the private screening Worker and main staging Worker, then verify the
  public domain, authentication boundaries and HMAC webhook.
- Configure a dedicated Sandbox Connect subscription pointing to
  `https://dev.starreusa.com/api/webhooks/docusign`. Keep its name distinct from
  local temporary-tunnel subscriptions.

`npm run dev:testing` remains a **local** integration rehearsal. Local and online
Dev currently share the Star Dev database. Do not run both background schedulers
against that database during acceptance: use online Dev as the job owner and
stop the local rehearsal. The local simulator's on-disk receipts are separate
from the online D1 receipts; start a fresh online test run for full acceptance.

## Recovery

Inspect the Cloudflare deployment history to identify the last known good
Worker version before rolling back. Preserve the production database and files.
Dev failures should be fixed and retested on Dev; they do not require taking
production offline. If `/api/release` returns 503, check the deployment boundary
configuration before enabling jobs or attempting test actions.

Cloudflare environment variables and bindings are explicitly scoped; see the
[environment configuration documentation](https://developers.cloudflare.com/workers/wrangler/environments/).
