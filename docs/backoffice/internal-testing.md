# Repeatable application-to-lease rehearsal

This is a development-only test profile over the real listing, authentication,
application, document upload, rental decision, lease, and DocuSign paths. It does
not grant the applicant an Admin role. Payment and screening alone use a separate
simulated HTTP provider. No real payment or credit inquiry is performed.

## Current local entry points

- Browse `/rental/`, open the **DocuSign Sandbox — MOCK TEST · TEST-1** listing,
  and choose Apply. The allowlisted listing ID is
  `dd741474-9526-4e6f-a51b-93deacd86bee` in the Star dev database.
- Applicant: `ocean.xu@arcof-group.com`, using the existing verified login.
  Register/verify remains the normal flow for genuinely new accounts; do not
  delete an existing identity just to repeat a rental application.
- Landlord: `augustusvash@gmail.com`. Activate the invited account on `/login/`
  on first use, using the email code and a password chosen by its owner.
- Run **`npm run dev:testing`**. It starts the Worker on 8787, payment/screening
  simulator on 8794, a webhook-only listener on 8788, an HTTPS tunnel and a
  15-second background scheduler. `dev:journey` is a compatibility alias.
  Stop any old server first; the launcher never kills an unrelated process.
  Wait for **TESTING READY** before starting a run. Ctrl+C stops the whole stack.
- One-time machine dependency: Node 24+, `npm install`, and `cloudflared`
  (`brew install cloudflared` on macOS). The configured Sandbox sender needs
  account-admin permission for its dedicated Connect subscription. Production
  credentials, a mismatched database, or a nonlocal screening provider fail startup.
- Startup verifies the database schema, simulator authorization, local HMAC
  rejection, and public HTTPS → authenticated durable inbox path. It creates or
  updates only `Star local testing <database-host>` in the Sandbox account,
  scoped to the configured sender. It replays pending test envelopes so a restart
  does not strand them at the previous temporary callback URL. It never signs,
  resends invitations, changes recipients, or clears past test applications.
- The website and admin remain local; the tunnel exposes only the authenticated
  DocuSign webhook. The runtime callback URL is passed to Wrangler without
  rewriting `.dev.vars`. Callback health is checked every 30 seconds. A failed
  child or three failed callback checks stops the stack with a visible error.
- Login, real test email, approvals, private storage, lease generation and signing
  run through the application's normal paths. Payment/credit use the local
  provider simulator; DocuSign uses Sandbox. This is a full workflow rehearsal,
  not a promise of identical production infrastructure or third-party latency.
- Set `DEV_REAL_EMAIL=true` and a valid `RESEND_API_KEY` in `.dev.vars` before
  starting. The launcher checks both; the sender domain must also be verified
  in Resend. A screening result does not mean an email was sent: the portal
  separately shows pending, sending, failed, local preview, or submitted mail.
  Submitted means accepted by the mail provider, not confirmed inbox delivery.

Use separate browser profiles for Applicant, Landlord and Admin. The shared
HttpOnly login cookie represents one identity per browser profile. The internal
Admin preview is available only locally without a workspace session;
it is never accepted as the landlord's emailed decision.

Roommates must open the complete invitation email link, not the listing's
ordinary `/apply/?id=…` URL. Invitations include `invited` plus `invite` (a
saved invitation) or `group` (an early invitation for a specific test run).
An invitation opened in the lead's browser shows account creation for the
invited email, with a sign-in option for an existing account. Once authenticated,
the roommate returns to that invitation and fills their own details. If the
lead has not submitted the run yet, the roommate can fill the form but must
retry submission after the lead submits. Multiple open invitations for the
same inbox require a case-specific link; a generic link cannot pick a case.
Switching applicant accounts affects other tabs in that browser, so submission
checks the account again and refuses to file answers under a different login.

For an allowlisted roommate, a live invitation to a saved internal test case also
shows **Fill With Sample Data**. It preserves the invited email and case, offers
no new-run button, and does not create a separate test root. After submission,
**Continue to Payment & Documents** opens that roommate's own simulated fee,
sample-document upload, and credit-screening steps. The test marker is saved
with the application so these pages work on the first portal visit, before any
background reconciliation. Each roommate completes their own fee and screening.

## One full run

1. Open the listing, choose Apply, and sign in. The internal banner offers
   **Fill With Sample Data**. It fills normal form fields with synthetic values;
   validation, review, consent and submission still use the ordinary form.
2. Submit, then choose **Continue to Payment & Documents**. The portal selects
   that exact application. Its run ID remains visible in the portal and Admin.
3. The portal shows the test run as the applicant will see it once a screening
   provider is connected: a step bar (Application, Fee, Documents, Screening,
   Landlord, Lease), the current step's page, and an **Internal Test** strip
   at the bottom with the demo controls. Pay the **Application Fee** on the
   card form (no real charge). The card details never leave the browser; only
   the outcome goes to the separate provider, which owns the receipt. The
   approved test card pays, the declined test card fails, and both are one
   click in the demo strip. A declined payment is retryable and does not
   unlock documents or screening.
4. Upload the required documents normally, or choose **Upload Sample Documents**.
   Samples are valid PDFs visibly labelled as test fixtures; they pass through
   normal private storage, ownership and document-count checks.
5. On the **Credit Screening** page, confirm the identity fields, authorize the
   screening and choose **Authorize and Submit**. Date of birth and SSN digits
   are checked in the browser only. The scenario (scored, no score, provider
   failure) is chosen in the demo strip. The provider receives an idempotent
   order with application ID and material references, then returns Pending
   before producing a result; the page shows **Preparing Your Report** and
   refreshes itself. Raw identity numbers and file bytes are not sent to this
   simulator.
6. A complete scored report plus complete materials triggers the normal rental
   workflow and landlord summary email. No-score and failure scenarios block
   automatic sharing. The applicant can refresh or leave the page; the scheduler
   continues reconciliation. A missing provider service produces an error, never
   a fabricated successful result.
7. Open the landlord email using its private decision link and explicitly
   confirm whether to proceed. Link previews and GET requests do not approve it.
   The current packet revision and application version are checked on POST.
8. In Admin, open the corresponding rental, review the lease and signing
   positions, and send via DocuSign. This is a real Sandbox envelope to the two
   designated mailboxes. Tenant signs first; landlord signs after the tenant.
   The signing reconciler downloads the completed PDF and certificate and marks
   the rental completed. Automated tests do not stand in for a person's signature.

## Repeatability and boundaries

An account is reused; an application is not. Each **Start New Test Run** creates
a new UUID, which becomes the application ID and independent rental root. A
retried submit within that run uses the same primary key and is idempotent.
Payment, screening, landlord revision and signing package belong to that specific
application. The portal's Application / Test Run selector retains prior attempts.
No destructive reset or overwriting of an old approval/signature is needed.

The lead tenant is the designated test inbox. Roommates are allowed when every
roommate email is in `INTERNAL_TEST_ROOMMATE_EMAILS`; each roommate signs in as
itself, submits its own application and uploads its own files, and its portal
offers the same simulated payment and screening because the application inherits
the lead's run. With real delivery on, mail leaves the machine only for the
designated inbox, the landlord inbox and these roommate inboxes. Fill With
Sample Data leaves an answered roommate step alone, so a roommate named before
the fill stays on the case. The home's bedroom count caps the group (two people in a
two-bedroom home), and a sandbox envelope holds the landlord plus at most four
tenants. Invitations follow the ordinary rules: ticked on the roommate step they
are emailed at once, otherwise after the lead's fee is paid; a roommate who
applies from the plain link joins the group that named their email, and one who
applied first is adopted when the lead submits. Ordinary multi-applicant
workflows keep their existing duplicate-application rules.

All helper entry points require loopback origin, explicit enablement, the pinned
development database hostname, DocuSign demo mode, the verified user ID and email,
and an allowlisted listing. The intake marker is reconstructed server-side, never
accepted as arbitrary workspace JSON from the browser. Production and other
accounts cannot obtain repeat-run or simulated-payment privileges.

The simulator persists only synthetic order/payment state in ignored
`.local/screening-simulator/state.json`, with authenticated local HTTP access.
The application integrates through `ApplicantChecksProvider`; the simulator
launcher and browser helpers are not dependencies of normal production operation.
Leave retained test helpers in version control; dispose of one-off diagnostics,
screenshots and generated data outside the repo. Turning `INTERNAL_TESTING=off`
removes the helpers. A real provider is still required for production checkout
and automated screening; disabling tests does not pretend that integration exists.

## Validation

`npm run test:journey` exercises the real Worker routes and rental core against
isolated auth/database/email fixtures and a separate local HTTP screening server.
It checks repeated runs, retry idempotency, authorization, payment/material/consent
gates, asynchronous reports, exactly one decision packet, landlord revision,
lease generation, and failure/no-score holds.

`npm run test:journey:ui` adds browser traversal and screenshots (requires
Playwright; `PLAYWRIGHT_MODULE` may point to an installed module). Artifacts go to
`/tmp/star-journey-ui`. Existing `test:signing` verifies DocuSign recovery, recipient
order, completion and archiving independently. Neither suite sends real mail.

Manual acceptance is the two mailbox owners finishing the new Sandbox envelope
and seeing the completed lease in Admin. This remains distinct from automated
coverage or a previous Sandbox envelope's successful send.

### Email branding

All website notifications pass through `prepareMail` in `worker/mail-layout.js`
before either Resend or the local email sink. It always sets `MAIL_FROM` and
renders plain-text or unbranded legacy HTML in the shared logo/card shell.
Only HTML generated by `mailShell` is retained as a custom body. Individual
callers must not define sender names or call a separate email transport.
`npm run test:email` checks the actual Resend JSON payload; `test:rentals` also
asserts branding on the receipt emitted by a real application-route submission.
Use `EMAIL_RECEIPT_PREVIEW=/tmp/application-receipt.html node scripts/test-rental-intake.mjs`
to render that isolated fixture receipt without sending a real email.

Landlord decision emails use a centered 600px HTML card and a public HTTPS PNG
logo, with no image attachment. `EMAIL_LOGO_URL` can point to a publicly readable
brand asset for local testing; it must not point to localhost or require a login.
The default is `https://starreusa.com/png/email-logo-v1.png`, shipped from
`site/png/email-logo-v1.png` on the next site deployment. The PNG is a raster
export of `site/partials/brand-logo.html`, sized for email clients.

For development, keep public logos in a dedicated `email-brand-assets` bucket.
Do not make the existing listing-media or applicant-docs buckets public. Verify
the logo URL without credentials before sending. Local previews do not send mail;
received emails will retain their original layout.

Each decision notification includes a reference derived from its delivery key in
both the subject and body. This keeps independent notifications out of the same
Gmail conversation, where repeated actions can be collapsed as quoted content.
Transport retries must reuse the original key; an explicitly requested resend
must use a new key. Never randomize the subject during retries. Gmail ultimately
controls collapsed content, so browser HTML previews cannot verify inbox folding.


### Landlord email decisions without sign-in

Set `LANDLORD_DECISION_SECRET` to 32 random bytes encoded as base64 (for example,
`openssl rand -base64 32`). Set it as a Worker secret for deployment, never as a
public build variable. With this secret configured, new notifications contain a
signed, private capability for only that application, recommendation revision,
recipient, website origin and database. Links expire 14 days after the
recommendation was prepared. To renew an expired request, prepare a fresh
recommendation; transport retries deliberately do not extend its lifetime.

Opening any of the three email links only reads the approved landlord summary.
Agree / Do Not Proceed preselect the choice and require an explicit confirmation;
declining requires a reason. Confirmation writes through the existing versioned
rental workflow, records the recipient email and timestamp, and starts normal
lease preparation on approval. It never signs or sends a lease. Refreshes and
repeated confirmations cannot overwrite a recorded decision.

The link is a credential: do not forward it. It is kept in a URL fragment and
sent to `/api/landlord-decision` in an Authorization header, never query strings.
The endpoint checks current active landlord/property access, signer assignment,
revision and application readiness. It returns the landlord projection only and
does not grant admin access or a logged-in session. Rotation of the signing secret
revokes all outstanding links. New revisions revoke previous requests.

If the secret is absent, emails retain the account-based approval flow. Emails
already sent without a token also still require login; send a new notification
to use the no-login flow. For tests, `npm run test:rentals` covers token security
and decisions, and `npm run test:rentals:ui` covers both an unrelated signed-in
browser and a signed-out mobile browser using isolated fixtures.
