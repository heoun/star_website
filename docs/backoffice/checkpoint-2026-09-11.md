# Development checkpoint — 2026-09-11

Local checkpoint on `haiyang_dev`, following `998f72b`. This checkpoint saves the approved rental group flow and the subsequent application workspace revisions. It does not deploy the Worker, run a live database migration, or send real emails.

## Saved stages

1. `3f0ebaa` — Application group foundation: hexagonal contracts and adapters, whole-group readiness, revisioned landlord packets, atomic persistence and database protections.
2. `17477c2` — End-to-end integration: optional property agent selection, account-bound roommate invitations, reconciliation, authenticated landlord decisions and shared lease drafts.
3. `09bb8ae` — Property/unit rental navigation; Applicants, Lease & decision and Activity workspaces; horizontal applicant selection; complete left/right dossiers with expandable chapters; local demo and browser coverage.
4. This documentation checkpoint — current interface, setup order, validation and outstanding integrations.

The interface commits capture the final implemented code state rather than preserving each intermediate layout experiment. All commits use their actual creation timestamps.

## Current behavior

- An Agent only accesses assigned or collaborating applications. Property access alone does not expose every applicant.
- Roommates submit their own applications; competing groups for the same unit remain separate. All intended members must complete the required uploads, payment/waiver and screening report before landlord sharing.
- Landlord emails contain the allowed score/income summary and links. A GET never approves a rental. The signed-in landlord explicitly confirms a current packet revision.
- Approval prepares a lease draft containing the group’s tenants. Missing property defaults remain visible. Tenant signature receipts are recorded individually before the landlord signature step.
- Staff view each applicant’s Lease Details and Application & Screening side by side. Chapters follow the agreed field order; sections can be opened individually or together. Group terms/decisions and internal activity each have their own workspace.
- Corrections reuse existing server-side permissions and audit behavior. SSN/passport values remain masked in these dossiers. Missing pet names are marked as not collected; no names are invented.

## Validation

Re-run while creating this checkpoint:

- `npm run test:rentals`: 51 workflow checks and 21 HTTP intake checks.
- `npm run test:rentals:db`: 21 checks in an isolated PGlite database, including repeatable migration and concurrent/versioned writes.
- `npm run test:workspace`: 158 checks.
- `npm run test:case-queue`: 12 checks.
- `npm run test:identity`: 70 checks.
- `npm run test:storage`: 51 checks.
- TypeScript, architecture gate, build and Git whitespace checks passed.

Immediately before this checkpoint, the final interface passed 33 isolated Playwright checks, including parallel panels, applicant selection, expandable chapters, keyboard workspace switching, preservation of unsaved input while switching workspaces, mobile overflow, corrections, role restrictions and the landlord-to-draft path. Only documentation changed after that successful interface test run.

Playwright is an external browser-test prerequisite. Set `PLAYWRIGHT_MODULE` to its installed module path when it is not available through normal module resolution; then run `npm run test:rentals:ui`.

## Local preview and repository hygiene

- Demo: `http://127.0.0.1:8792/__demo`; inbox: `/__demo/inbox`.
- `npm run demo:workspace` builds and starts the isolated role demo. Demo state is stored in the operating system temporary directory, outside the repository.
- Build output, dependency directories, local credentials, Wrangler state, notes and browser artifacts stay ignored. No tracked generated/cache directories or files larger than 5 MB were found during this cleanup. Existing local files were preserved.
- Source fixtures intentionally contain synthetic records; those are versioned so tests and the demo can be reproduced.

## Remaining integrations

Production `RENTAL_AUTOMATION` remains off. Apply `supabase/rental-flow.sql` in the documented order before enabling it. Credit reports currently use explicit local mocks or staff-recorded external results; no production credit provider is connected. Signing records external receipts; automatic electronic signature envelope delivery is not implemented. Full report sharing depends on the chosen provider’s authorized integration. Production email needs configured credentials and a verified sender.

See [rental-flow.md](rental-flow.md) for business rules and rollout instructions.
