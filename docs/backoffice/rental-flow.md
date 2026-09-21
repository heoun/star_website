# Application groups and landlord decisions

The agreed flow is now implemented behind `RENTAL_AUTOMATION=on`. The isolated role demo enables it automatically. Production configuration remains off until the additive migration is applied; this change does not deploy or migrate a live database.

## Business rules

- One property can have multiple agents. Published rental applications optionally select an active property agent; the agent’s referral link preselects them. No selection leaves assignment to Admin. Property access does not grant access to every application: an agent must own or collaborate on that application group.
- Only Admin can change the responsible Agent. The assignee must be an active Agent; Admin may be a collaborator but cannot own the assignment. Collaborator choices appear as Agent, then Admin. Reviewing or recommending an unassigned application does not silently assign the reviewing Admin.
- One unit can have competing application groups. A group has one lead, its own common lease terms, and one or more applicants. Each applicant retains their private application and uploads. Grouping in the queue never merges competing applications.
- A group holds one lease signer per bedroom (a studio holds one), enforced on the form, on submission, on admin invitations and on joins. Roommate invitations go out from the form's roommate step when the applicant ticks the invitation box, otherwise once the lead's application fee is paid or waived; the admin's own invitations are sent at once. The invited person signs in with the exact invited email and submits through the invitation link or from the plain application page, where an open invitation for that email and home joins them to the group. Every invitation link names the invited address; the portal starts with it filled in, and the form refuses to open under any other signed-in account and offers to switch. A roommate who applied independently before the lead is adopted into the group when the lead submits. Every invitation, whether sent from the form, after the fee or by staff, is the same branded card as the landlord decision request, from the same sender, with the home, the inviter, one button and the invited address. Insertion and joining are one transaction. Authorized staff can still join an existing independent application after explicit confirmation; the destination group’s terms and team apply. Both versions are checked.
- Every group member must have the required uploads, fee payment or waiver, and a completed report before a decision package is created. This is completeness, not a favorable credit decision. Pending invitations block sharing. Scores, model/date and applicant-reported income appear separately for each person.
- Payment precedes screening. Unpaid applications cannot trigger screening or record a completed report/score. A completed report cannot be edited back to payment pending. Contradictory imported payment/report records require evidence review and do not expose a usable credit score or allow sharing. Only the isolated demo repairs identified synthetic report/payment fixtures; real payments are never inferred from a score.
- An active landlord associated with the property’s signer email is preferred. If there is exactly one eligible landlord, that account is used. Ambiguous or missing recipients require an Admin correction and are never guessed.
- The email contains facts, a detail link, and Agree to proceed / Do not proceed links. Links perform no mutation. With `LANDLORD_DECISION_SECRET` configured, the confirmation page uses a scoped, expiring email link and the current packet revision; otherwise it requires the current landlord account. SSNs, identity files, internal notes and raw application objects are excluded from this projection.
- Approval records the landlord decision and prepares the group’s lease draft in one versioned save. A complete draft freezes all resolved values, including all tenant names. Missing property fields or resolution errors remain visible; they do not turn approval into a failed decision. Draft refresh uses the approved terms.
- Each tenant’s signature receipt is recorded separately. The landlord step opens only after every tenant receipt is present. Existing private executed-PDF upload/archive remains in use. Membership and applicant evidence changes are blocked during signing.

## Screens

The automatic rental workspace displays screening results read-only. It has no manual payment/report verification form. Credit score, income, report status and an existing report link remain visible. An unconnected provider is shown as unavailable, without directing staff to re-enter screening data. The legacy audited report-recording API remains separate from this automatic UI.

Rentals uses Property, Unit, Applications and Needs attention columns. Expand a unit to see competing groups. A rental has three workspaces: Applicants, Lease & decision, and Activity. Applicants uses a horizontal person selector and two parallel dossiers: Lease Details and Application & Screening. Chapters follow the agreed application field order, with compact summaries and expandable records; all sections can be expanded together. Credit score and applicant-reported income stay visible. Lease terms, landlord decisions and signing tools live in Lease & decision; notes and audit history live in Activity. Shared terms are stored once. Team/admin notes remain separate from landlord data.

The top status strip identifies the current stage and outstanding work. Pending invitations are distinct from submitted applications. Existing application correction permissions remain enforced: Admin may correct supported applicant fields, while Agent corrections are limited to tenancy fields. Identity numbers stay masked in the dossier. Switching workspaces retains unsaved inputs on the mounted page. Pet names absent from the current intake schema are explicitly marked as not collected.

The landlord confirmation page is `/landlord-decision/`. New signed email links require no login and preselect the requested decision; the recipient confirms before it is saved. Legacy account-based links return to the same decision after login. Reloading or scanning a link does not approve anything. Old revisions are rejected.

## Integration boundaries

`backend/contracts/rentals.ts` defines group persistence, screening, email and lease-resolution interfaces. `backend/core/rentals.ts` implements the use cases. The app composition root selects adapters; Workers provide HTTP/authentication and the existing lease field resolver. Database group commits check all member versions, including concurrent edits and merges.

**Credit provider is not connected.** Production returns `not_connected`; the automatic applicant workspace shows read-only screening results and does not offer manual payment/report entry. The legacy audited API remains available for its existing integrations. The local demo explicitly uses deterministic mock reports, marked as mock. No real credit check is purchased or performed. A future provider adapter must implement consent/payment prerequisites, authenticated callbacks or polling, and idempotent requests. The scheduler provides reconciliation without requiring a staff page to stay open.

**Email delivery uses the existing Resend sender.** Local messages go to the demo inbox and are never sent unless the separate real-email development override is explicitly enabled. Delivery failures stay visible; retries retain the same provider idempotency key. The provider’s deduplication retention is not unlimited, so delivery semantics are retryable rather than an unconditional exactly-once guarantee.

**Electronic signing remains external.** This version creates the common lease draft and tracks per-person signing receipts. It does not send an electronic signature envelope or claim that a typed receipt itself is a signature. Full credit-report viewing likewise awaits the selected provider’s authorized report-sharing integration; the landlord detail page currently shows the approved summary only.

## Setup and validation

1. Apply `supabase/rental-flow.sql` after `schema.sql`, `backoffice.sql` and `workspace.sql`. It is repeatable and adds the group relation plus service-only RPCs. Existing roommate entries become pending invitations rather than assumed applications. Existing confirmed/signed leases are preserved.
   Apply `supabase/rental-membership.sql` afterward to enable atomic applicant separation and removal.
   Apply `supabase/rental-drafts.sql` to persist invitations before intake; either applicant can then submit first.
2. Set `RENTAL_AUTOMATION=on` only after the migration. Configure `SITE_ORIGIN` if different from `https://starreusa.com`. The Worker has a one-minute scheduled reconciliation hook.
3. Configure the existing outbound email credentials and verified sender for real delivery. Do not set `RENTAL_SCREENING=mock` in production; the adapter also rejects mock selection for non-loopback origins.
4. Run `npm run test:rentals`, `npm run test:rentals:db`, `npm run test:rentals:ui` (requires Playwright), `npm run typecheck`, `npm run gate` and `npm run build`.

The local demo remains at `http://127.0.0.1:8792/__demo`. Its inbox at `/__demo/inbox` includes a shortcut that selects the matching synthetic landlord before opening a decision. The Applicant B / Applicant E group demonstrates the complete group-to-landlord-to-draft flow. Demo fixtures, screenshots and local persisted state are not production data.


## Screening evidence gate — 2026-09-11

A `checks.screening = received` marker or a verification note is not report evidence.
The shared core policy in `backend/core/screening.ts` requires a report linked to the
specific application, its provider, reference, report date, score and scoring model.
An external report also requires an HTTPS report link and an authenticated reviewer
record (or a future provider adapter). Manual entry records the staff member's
verification; it does **not** independently authenticate a report's contents or
replace a screening vendor integration. Report URLs are retained for authorized
staff and are not added to landlord packets.

An explicit `no_score` provider outcome is stored with its reason and shown as
“Needs review”. It cannot automatically progress; no exception policy is implemented.
Pending, unconfigured, malformed, wrong-applicant and production mock reports all
block readiness. Only the local mock adapter, with the explicit localhost mock
configuration, may supply synthetic reports. Screening starts after the applicant's
payment or waiver is recorded.

All intended members must have submitted, uploaded required documents, resolved
information requests, paid or received a waiver, and passed the report evidence
gate. The service checks this before sharing/retrying the packet, accepting a
landlord decision, preparing/downloading a lease and recording signatures/archiving.
A complete group is automatically shared; completeness does not itself approve it.
Landlord decisions still require the current packet revision and version. Every
lease signer signs before the landlord. The signed PDF closes the workflow.

Incomplete historical approvals are shown as blocked. An authorized staff member
may reopen an unsigned, incomplete approval: the prior event remains in activity,
the active approval and draft are cleared, and a new landlord decision is required.
Production reads never silently rewrite historical decisions. Versioned local demo
repair resets inconsistent synthetic cases while retaining their activity; it
never invents a score to support an old approval. Applicant A is a stable pending-report
scenario. Identifiable old provider-generated mock reports retain their existing
score/date during the evidence-format upgrade.

Regression checks: `npm run test:rentals`, `npm run test:rentals:db`,
`npm run test:workspace`, and `scripts/test-rental-ui.mjs`. The browser suite also
compares the grouped rental header and row column positions at desktop widths.


## Demo naming

All local demo identities use a persisted catalogue in `scripts/demo-names.mjs`: Applicant A/B/C, Property A/B/C, Agent A/B, Admin A/B and Landlord A/B. Labels remain stable across reloads and list sorting. Invitations sharing an applicant account reuse its label; unrelated applicants do not share a realistic placeholder name. The existing complete household is Applicant B + Applicant E, and Applicant A is the pending-report example.

Local normalization updates property/listing names, applicant and contact details, property lease defaults, packets, draft snapshots, mailbox text and account history references together. It preserves record IDs, workflow statuses, report results, property membership and supporting files. This module is never imported by deployed application code. Person tabs use “Member 1/2” for position within a household, independently of the mock person's fixed name.

Generated roommate emails now use the application UUID instead of a reused list index. A local-only, one-time repair separates repeated, unsubmitted placeholder roommates across independent groups, updates their declared roommate records and local invitation messages, and advances only the affected workspace version. Accepted invitations and submitted accounts are not split. This is a fixture correction, not a restriction on real applicants applying to multiple properties.

Mock applications are generated only for published listings. Draft properties still have sample lease defaults and standalone previews, but no fabricated incoming application. A one-time local repair removes identifiable old preview-only applications under drafts; genuine submissions and progressed historical cases are retained. Public intake rejects unpublished listings and invalid/inactive Agent selections. Selecting a valid property Agent sets `responsible_email`; no preference leaves it unassigned, and an invited member inherits the group's Agent. `test-rental-intake.mjs` covers these paths.


## Workspace refinements — 2026-09-14

The rental queue expands each property/unit into a labelled application-group table. Each entire row links to its application detail. Progress names the pending applicant or report instead of repeating the property and a generic task label. Waiting on another party is distinct from an actionable team issue.

The selected applicant has one compact credit-score/income summary above the two five-section dossiers. Its name is not repeated in that summary. View Report opens an existing authorized HTTPS report URL, or a clearly labelled local mock preview using the selected applicant's saved screening result. Missing reports disable the control. The mock preview is not a full bureau report or a new provider integration.

Only Admin assigns the responsible Agent; active Admin and Agent collaborators are grouped with Agent first. Agent navigation has one My Rentals destination. The sidebar has a persistent desktop collapse preference and a separate mobile menu; the content expands when it collapses. Dashboard, Rentals, Properties and Listings share the same outer width rule, so loading a route no longer applies a narrower content cap.

## Applicants who leave a combined application

In the rental's **Applicants → Manage applicants** section, assigned staff can
split one member into a separate application; managers can permanently delete
one withdrawing member after entering the reason, full name and confirmation.
An invitation that has not been accepted can be cancelled without deleting an
account. These actions never delete the person's Supabase login.

Splitting retains each person's documents, fee receipt and screening evidence.
Deletion removes only the selected application and its document rows, then cleans
up that application's private storage prefix. It does not issue a fee refund.
If the primary applicant leaves, the earliest remaining applicant becomes the
remaining group's primary record. The team and group terms stay with that group.
Accepted invitations for the departing member are removed; pending invitations
for other people stay with the remaining group. Group approvals, signing drafts
and lease overrides are invalidated and a reason is recorded in the activity log.
The normal reconciliation process requires a fresh landlord decision.

An active envelope must be voided first. Signed/closed applications cannot be
changed this way; an applicant with signing history can be separated but cannot
be permanently deleted. The service-only SQL function locks group membership and
checks every member's version before changing or deleting anything. The legacy
single-application delete route refuses grouped applications.

Run `npm run test:membership` for domain and real PostgreSQL-compatible transaction
coverage, including primary replacement, stale writes, cascade and signing locks.

## Invitations before submission

The first-step invite endpoint saves an account-owned draft group before sending
email. Both ordinary and internal-test links carry the stable group and invitation
IDs. No incomplete application or fabricated consent is inserted: the first person
to submit creates the case, and later submissions join it atomically. The inviter
is a reserved, pending member until their own form is submitted. Existing readiness
checks block landlord review while any invitation is pending, even if the first
applicant has completed payment, documents and screening.

The draft ID is kept per listing and signed-in account in session storage. Repeated
submissions return the saved application without overwriting answers or sending
another receipt. The database checks the authenticated email, inviter identity,
listing, expiry, capacity and current case membership. Revoked invitations and
deleted/separated cases cannot be recreated from old draft records.

Invitations emailed before this migration had no durable draft record. The inviter
must refresh their form and resend them once; the inviter does not need to submit.
Do not create invitation records based only on an unverified browser URL.
