# Supabase accounts, database and files

The application uses Supabase Auth, PostgreSQL and Storage. Cloudflare continues
to serve the website and run the API. Choosing this stack does not subscribe the
project to a paid plan or change any deployed configuration automatically.

## Account flow

| Account | Created by | Where to sign in |
| --- | --- | --- |
| Platform Owner | Operator bootstraps an Auth user and pins its ID in Worker secrets | `/login/` |
| Admin | Platform Owner adds the account in Accounts & access | `/login/` |
| Agent | Owner or Admin adds the account in Accounts & access | `/login/` |
| Landlord | Admin approves landlord onboarding; properties and account are created together | `/login/` |
| Applicant | Self-registration and email confirmation | `/portal/` |

Creating an active internal account or approving onboarding requests an activation
code from Supabase. The recipient chooses **Activate an invited account** at
`/login/`, requests a fresh code if needed, and sets their password. Existing
Supabase users can use their existing password. No passwords are chosen by Admin.
If delivery fails, the saved account remains available and the UI explicitly says
the email failed. Use **Send activation code** in Accounts & access to retry.

The invitation request uses Auth's OTP endpoint with `create_user: true`, but only
after the application authorizes the directory account. The verification uses
`type: email`. Both existing and new Auth users can activate. Public applicant
registration never inserts a `staff` record. User-editable metadata never supplies
the role. Codes follow the expiry and rate limits configured in Supabase.

## One-time project setup

1. Apply these files in the SQL editor, in this order:
   - `supabase/schema.sql`
   - `supabase/backoffice.sql`
   - `supabase/workspace.sql`
   - `supabase/administration.sql`
   - `supabase/identity.sql`
   - `supabase/storage.sql`
   - `supabase/property-create.sql` (atomic New Property creation with initial defaults)
2. Enable email/password Auth and **Confirm email**. Keep the email OTP length at
   **6 digits** for compatibility with the applicant registration/reset screens.
3. Set Auth Site URL to the website origin, e.g. `https://starreusa.com`.
4. Configure custom SMTP in Supabase for real deliveries. The built-in sender is
   suitable for limited project testing, not sending to arbitrary customers.
5. Update **Confirm signup**, **Magic Link**, and **Reset password** email
   templates to display `{{ .Token }}`. Confirm signup must work for both
   applicants registering and workspace users receiving their first OTP.
   Tell recipients to enter the code on the page where they requested it.
   The default magic-link redirect/token-fragment flow is not used by this app.
6. Confirm both `listing-media` and `applicant-docs` buckets are **private**.
   `storage.sql` creates them and restricts direct anon/authenticated access even
   if another permissive Storage policy exists. Do not add public document URLs.

Example code-email body (use an appropriate subject for each template):

```html
<h2>Star Real Estate</h2>
<p>Your verification code:</p>
<p style="font-size:28px;letter-spacing:6px"><strong>{{ .Token }}</strong></p>
<p>Enter this code on the page where you requested it.</p>
<p>Invited to our workspace? Open <a href="{{ .SiteURL }}/login/">Workspace sign in</a>
and choose “Activate an invited account”.</p>
<p>If you did not request this code, you can ignore this email.</p>
```

The app's contact/application/onboarding notifications still use the existing
email adapter (`RESEND_API_KEY`); Supabase Auth sends verification/reset emails
through the SMTP provider configured in Supabase. File storage and identity
consolidation do not replace the transactional notification provider.

## Bootstrap the Platform Owner

Create the intended Owner account through `/portal/` and confirm the email, or
provision it in Supabase Auth and verify the account owner through your internal
setup process. Copy its Auth user UUID from Supabase Authentication → Users.

Set these Worker secrets (never put their values in source control):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — server-side database/Storage credential
- `SUPABASE_PUBLISHABLE_KEY` (or existing `SUPABASE_ANON_KEY`)
- `OWNER_EMAIL` — normalized verified email
- `OWNER_AUTH_USER_ID` — exact UUID of that Auth user

Keep the existing SSN encryption and notification secrets. `wrangler.jsonc`
sets `STORAGE_BACKEND=supabase`. Owner login fails closed if the UUID is missing
or mismatched. Owner has account/permission management only; use a separate
Admin account for rentals and applications. Losing an Owner login requires
operator recovery through Supabase Auth; it cannot be repaired by another Admin.

## Identity and data boundaries

- Both portals share the HttpOnly `star_portal` cookie. Tokens are verified with
  Supabase on the server; refreshed cookies are returned on allowed and denied
  workspace requests. Signing out clears the shared browser session and requests
  revocation of that Supabase session.
- Staff role, active status and assignments are checked against the database on
  each request. Suspension blocks workspace access during an existing session.
- The first successful verified workspace login atomically pins `staff.auth_user_id`.
  Recreating an Auth user with the same email cannot replace that pinned ID.
  Changing the login email or relinking an Auth user is deliberately not exposed
  as an ordinary account edit. These require an operator-reviewed change.
- Applicants retain the existing verified-email ownership rules for their
  applications; registration cannot grant workspace privileges.
- The server-side service key bypasses database RLS. Row/field/action checks in
  the application remain mandatory; hiding navigation items is not authorization.
- Public `/media/` reads only `listing-media`. Private documents and lease PDFs
  are served through authenticated application routes after permission checks.
- Supabase Storage bucket paths match the existing file keys. Switching the
  provider does **not** copy files already stored in R2. For a fresh project use
  new/synthetic uploads; preserve or explicitly copy existing files before a live
  cutover. Folder imports now write to Supabase Storage.

## Local development and rollout

For the synthetic role demo, keep using `npm run demo:workspace`. It uses fixture
accounts and local file storage; it does not test a real Supabase login and never
sends an activation email. The new login screen can be previewed at `/login/`.

For a real Auth rehearsal, use a separate development Supabase project, apply the
SQL and configure SMTP. Leave `DEV_ADMIN_EMAIL` blank, set the Auth keys and Owner
ID in ignored `.dev.vars`, and use `STORAGE_BACKEND=supabase`. Workspace OTP emails
are suppressed on loopback unless `DEV_REAL_EMAIL=true`. Applicant registration
and password reset already call Supabase Auth directly and can send real email.
For offline/local file work choose `STORAGE_BACKEND=r2`; retained R2 bindings are
simulated by Wrangler locally.

Deploy and verify in a test environment before changing any production login
gate. An existing Cloudflare Access application is independent of this code:
remove its gate on `/admin*` and `/api/admin*` during the tested cutover, otherwise
users will still encounter the previous Access login. Ensure `/login/`,
`/api/auth/*`, `/portal/` and `/api/portal/*` are reachable. Do not retain an Access
header fallback that could bypass Supabase account binding.

## Verification

```sh
npm run test:identity
npm run test:identity:db
npm run test:storage
npm run test:administration
npm run test:workspace
npm run test:case-review
npm run typecheck
npm run gate
npm run build
# With Playwright available, or PLAYWRIGHT_MODULE set to its module path:
npm run test:identity:ui
```

These tests use synthetic identities and a local embedded PostgreSQL engine.
They verify app behavior and SQL policies; they do not prove that your selected
cloud project's secrets, SMTP, email templates, buckets or Access settings have
been configured. Complete a real invitation → activation → login → suspension
rehearsal with a controlled test mailbox before launch.

References: [Supabase email OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless),
[SMTP](https://supabase.com/docs/guides/auth/auth-smtp),
[private downloads](https://supabase.com/docs/guides/storage/serving/downloads).
