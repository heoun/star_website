# Application groups and landlord decisions

The agreed flow is now implemented behind `RENTAL_AUTOMATION=on`. The isolated role demo enables it automatically. Production configuration remains off until the additive migration is applied; this change does not deploy or migrate a live database.

## Business rules

- One property can have multiple agents. Published rental applications optionally select an active property agent; the agent’s referral link preselects them. No selection leaves assignment to Admin. Property access does not grant access to every application: an agent must own or collaborate on that application group.
- One unit can have competing application groups. A group has one lead, its own common lease terms, and one or more applicants. Each applicant retains their private application and uploads. Grouping in the queue never merges competing applications.
- Roommate invitations are sent after the lead application is submitted. The invited person signs in with the exact invited email and submits through their invitation link. Insertion and joining are one transaction. Existing independent applications can be joined by authorized staff after explicit confirmation; the destination group’s terms and team apply. Both versions are checked.
- Every group member must have the required uploads, fee payment or waiver, and a completed report before a decision package is created. This is completeness, not a favorable credit decision. Pending invitations block sharing. Scores, model/date and applicant-reported income appear separately for each person.
- An active landlord associated with the property’s signer email is preferred. If there is exactly one eligible landlord, that account is used. Ambiguous or missing recipients require an Admin correction and are never guessed.
- The email contains facts, a detail link, and Agree to proceed / Do not proceed links. Links perform no mutation. The confirmation page requires the current landlord account and current packet revision. SSNs, identity files, internal notes and raw application objects are excluded from this projection.
- Approval records the landlord decision and prepares the group’s lease draft in one versioned save. A complete draft freezes all resolved values, including all tenant names. Missing property fields or resolution errors remain visible; they do not turn approval into a failed decision. Draft refresh uses the approved terms.
- Each tenant’s signature receipt is recorded separately. The landlord step opens only after every tenant receipt is present. Existing private executed-PDF upload/archive remains in use. Membership and applicant evidence changes are blocked during signing.

## Screens

Rentals uses Property, Unit, Applications and Needs attention columns. Expand a unit to see competing groups. A rental has three workspaces: Applicants, Lease & decision, and Activity. Applicants uses a horizontal person selector and two parallel dossiers: Lease Details and Application & Screening. Chapters follow the agreed application field order, with compact summaries and expandable records; all sections can be expanded together. Credit score and applicant-reported income stay visible. Lease terms, landlord decisions and signing tools live in Lease & decision; notes and audit history live in Activity. Shared terms are stored once. Team/admin notes remain separate from landlord data.

The top status strip identifies the current stage and outstanding work. Pending invitations are distinct from submitted applications. Existing application correction permissions remain enforced: Admin may correct supported applicant fields, while Agent corrections are limited to tenancy fields. Identity numbers stay masked in the dossier. Switching workspaces retains unsaved inputs on the mounted page. Pet names absent from the current intake schema are explicitly marked as not collected.

The landlord confirmation page is `/landlord-decision/`. A signed-out recipient returns to the same decision after login. Reloading or scanning a link does not approve anything. Old revisions are rejected.

## Integration boundaries

`backend/contracts/rentals.ts` defines group persistence, screening, email and lease-resolution interfaces. `backend/core/rentals.ts` implements the use cases. The app composition root selects adapters; Workers provide HTTP/authentication and the existing lease field resolver. Database group commits check all member versions, including concurrent edits and merges.

**Credit provider is not connected.** Production returns `not_connected`; staff can record an external provider report, its score/model and reference. The local demo explicitly uses deterministic mock reports, marked as mock. No real credit check is purchased or performed. A future provider adapter must implement consent/payment prerequisites, authenticated callbacks or polling, and idempotent requests. The scheduler provides reconciliation without requiring a staff page to stay open.

**Email delivery uses the existing Resend sender.** Local messages go to the demo inbox and are never sent unless the separate real-email development override is explicitly enabled. Delivery failures stay visible; retries retain the same provider idempotency key. The provider’s deduplication retention is not unlimited, so delivery semantics are retryable rather than an unconditional exactly-once guarantee.

**Electronic signing remains external.** This version creates the common lease draft and tracks per-person signing receipts. It does not send an electronic signature envelope or claim that a typed receipt itself is a signature. Full credit-report viewing likewise awaits the selected provider’s authorized report-sharing integration; the landlord detail page currently shows the approved summary only.

## Setup and validation

1. Apply `supabase/rental-flow.sql` after `schema.sql`, `backoffice.sql` and `workspace.sql`. It is repeatable and adds the group relation plus service-only RPCs. Existing roommate entries become pending invitations rather than assumed applications. Existing confirmed/signed leases are preserved.
2. Set `RENTAL_AUTOMATION=on` only after the migration. Configure `SITE_ORIGIN` if different from `https://starreusa.com`. The Worker has a one-minute scheduled reconciliation hook.
3. Configure the existing outbound email credentials and verified sender for real delivery. Do not set `RENTAL_SCREENING=mock` in production; the adapter also rejects mock selection for non-loopback origins.
4. Run `npm run test:rentals`, `npm run test:rentals:db`, `npm run test:rentals:ui` (requires Playwright), `npm run typecheck`, `npm run gate` and `npm run build`.

The local demo remains at `http://127.0.0.1:8792/__demo`. Its inbox at `/__demo/inbox` includes a shortcut that selects the matching synthetic landlord before opening a decision. The Robin Chen / Morgan Example group demonstrates the complete group-to-landlord-to-draft flow. Demo fixtures, screenshots and local persisted state are not production data.
