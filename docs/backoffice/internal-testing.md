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
- Run `npm run dev:journey` to start the Worker on 8787, the screening API
  simulator on 8794, and the existing once-per-minute rental/signing scheduler.
  Stop any previous server on 8787 first. Keep the process running during testing.
  Existing DocuSign Connect configuration can accelerate updates; polling also
  reconciles the provider state when a tunnel is unavailable.
- Set `DEV_REAL_EMAIL=true` and a valid `RESEND_API_KEY` in `.dev.vars` before
  starting. The launcher checks both; the sender domain must also be verified
  in Resend. A screening result does not mean an email was sent: the portal
  separately shows pending, sending, failed, local preview, or submitted mail.
  Submitted means accepted by the mail provider, not confirmed inbox delivery.

Use separate browser profiles for Applicant, Landlord and Admin. The shared
HttpOnly login cookie represents one identity per browser profile. The internal
Admin preview is available only locally without an applicant/landlord session;
it is never accepted as the landlord's emailed decision.

## One full run

1. Open the listing, choose Apply, and sign in. The internal banner offers
   **Fill With Sample Data**. It fills normal form fields with synthetic values;
   validation, review, consent and submission still use the ordinary form.
2. Submit, then choose **Continue to Payment & Documents**. The portal selects
   that exact application. Its run ID remains visible in the portal and Admin.
3. Choose **Pay $20 — Simulation** (no real charge). The separate provider owns
   the payment receipt. Failure is retryable and does not unlock screening.
4. Upload the required documents normally, or choose **Upload Sample Documents**.
   Samples are valid PDFs visibly labelled as test fixtures; they pass through
   normal private storage, ownership and document-count checks.
5. Choose the screening scenario, consent and **Submit Screening Materials**.
   The provider receives an idempotent order with application ID and material
   references, then returns Pending before producing a result. Raw identity
   numbers and file bytes are not sent to this simulator.
6. A complete scored report plus complete materials triggers the normal rental
   workflow and landlord summary email. No-score and failure scenarios block
   automatic sharing. The applicant can refresh or leave the page; the scheduler
   continues reconciliation. A missing provider service produces an error, never
   a fabricated successful result.
7. Open the landlord email, sign in as the designated landlord and explicitly
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

The default rehearsal is one tenant, matching the designated test inbox. It
rejects roommate invitations in internal runs. Ordinary multi-applicant workflows
remain separate and keep their existing duplicate-application and invitation rules.

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
