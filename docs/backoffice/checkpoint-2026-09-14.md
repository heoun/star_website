# Development checkpoint — 2026-09-14

Saved on `haiyang_dev`, following `6937516`. These commits group accumulated work by functional dependency and use their actual creation times. Existing history is preserved. This is a local checkpoint; nothing was pushed, deployed or migrated to a live database.

## Saved stages

| Commit | Stage |
| --- | --- |
| `a5c5f33` | Require application-bound screening evidence before landlord decisions, lease preparation and signing; payment precedes screening; only Admin assigns a responsible Agent. |
| `ae1150c` | Stable Applicant/Property/Agent mock identities and distinct emails, consistent invitation/payment/report states, and reproducible listing photos, floor plans and video. |
| `5b69e1b` | New Property document-based defaults, mandatory landlord signer email, consistent required-field marks and streamlined applicant steps. |
| `c816a19` | Compact property/unit application tables with whole-row links, selected-applicant score/income summary, mock report preview and organized collaborators. |
| `9878a48` | Collapsible sidebar, one Agent rental destination, consistent navigation capitalization and shared page width rules. |
| This commit | Retire the obsolete manual-flow browser scenario and update workflow, maintenance and checkpoint documentation. |

The final tree is the reviewable checkpoint. Shared files were staged by feature where needed without replacing the working copies.

## Repository hygiene

- Existing ignore rules already exclude local credentials, dependencies, build output, runtime state, reference documents, browser artifacts and scratch files. No additional broad ignore patterns were needed.
- Keep synthetic demo assets and lease source templates tracked so another checkout can reproduce the demo. The new mock MP4 is approximately 80 KB.
- Local `.dev.vars`, `notes/` and the running demo's saved state were preserved. No blanket clean command was used.
- Removed `scripts/test-backoffice-ui.mjs`: it assumes four flat cases and the old manual recommendation UI while starting the now-automatic group demo. Its attempted run failed at the obsolete flat-row assertion. Current browser coverage is `scripts/test-rental-ui.mjs`; legacy API checks remain in `test-case-review.mjs`, `test-workspace.mjs` and the screening-gate suite.
- Updated one stale review assertion: reviewing an unassigned application must not silently make Admin the responsible Agent.

## Verification

Passed for this checkpoint:

- TypeScript, architecture boundaries (89 modules), production build and Git whitespace checks.
- Workspace: 160 checks; portal request visibility: 12.
- Rental workflow: 57; HTTP intake: 29; screening evidence and progression gates: 65.
- Demo data: 69; stable demo identities: 47; listing media byte/content, scope and reseeding checks.
- Property section coverage: 125 fields across 15 steps; lease import: 42; listings: 24.
- Legacy review API: 71; queue filters, priority and scope: 12.
- Rental browser suite: 53; New Property/import and applicant form browser suite: 50.
- Targeted local browser checks during the interface changes: all four row cells open the correct application on desktop and mobile; keyboard Enter works; pending reports disable viewing; mock preview follows the selected applicant; shared page gutters across four routes at 1600/2200px in both sidebar modes; no Dashboard/Rentals width jump through reload.

Database schema suites and production integration tests were not rerun for this checkpoint; no SQL changed. Passing fixture tests is not production acceptance.

## Remaining integration boundaries

The actual credit provider is not connected. The local preview displays saved synthetic screening data; it is not a full bureau report. Real signing remains an external integration, with signing receipts tracked by the current workflow. Production activation still requires the existing Supabase setup and rental-flow migration, configured identity and delivery services, and provider integration. This checkpoint does not perform those external actions.

## Follow-up checkpoint — journey scenarios and property directories

This later checkpoint follows `5102af9` on the same branch, preserving the earlier stages above.

| Commit | Stage |
| --- | --- |
| `1639c17` | Publish local Property C/D listings and seed twelve independent rental journey scenarios, including blocking cases, landlord decisions, lease drafts, ordered signing and a marked mock archive PDF. Include a scenario catalogue and repeatable checks. |
| `6b6a32a` | Group Rentals by Property → Unit → application group and Listings by Property → Unit. Share natural property/unit ordering and property-name typography across all three directories; retain per-unit application priority and remove repeated location text beside prices. Update browser coverage. |
| This follow-up documentation commit | Record repository hygiene and validation for the saved state. |

Repository review found no untracked scratch files requiring deletion and no tracked files matching the ignore rules. Existing rules cover `.dev.vars`, `.wrangler/`, `dist/`, `node_modules/`, `notes/` and generated test output. Runtime state and browser screenshots remain outside the repository. Keep the small, explicitly synthetic archive PDF and its Python generator as reproducible demo fixtures; neither is a real signed lease. No additional ignore patterns were necessary.

Rechecked before these commits:

- `npm run test:demo`: 69 data checks, 47 identity checks, media checks, and all twelve journey scenarios, including state preservation and idempotent seeding.
- `npm run test:rentals`: 57 workflow, 29 intake and 65 screening-gate checks.
- `npm run test:case-queue`: 12 filtering, priority and scope checks.
- Rental browser suite: 53 checks passed with `PLAYWRIGHT_MODULE` pointing to the installed local runtime. The first attempt without that variable failed because Playwright is not installed in this checkout; no dependency change was needed.
- Production build and Git whitespace checks passed.
- Targeted browser checks during these changes verified Property A–D order in all three directories, nested unit order, common title styles across desktop/sidebar/mobile states, and price-only text in all ten local listings. Natural-sort checks covered 1A/2A/10A and preserved application order within groups.

These are local commits only. No push, deployment, production database operation or real email/payment/signature action was performed. Integration boundaries from the earlier checkpoint still apply.
