# Development checkpoint — 2026-09-15

Local checkpoint on `haiyang_dev`, following `bfcc726`. Changes are grouped by functional dependency. Existing history and working configuration are preserved; no push, deployment or production migration was performed.

## Saved stages

| Commit | Scope |
| --- | --- |
| `f940187` | Unify 129 property settings into 15 sections, complete landlord contacts, shared defaults and dependent contacts, concession and DHCR defaults, conditional sprinkler dates and spare utility rows. Include schema checks and lease-resolution regression coverage. |
| `92c1ef1` | Extract addresses, contacts and lease defaults using role and document context; preserve Word table structure, compare address variants, read form-layout tables and marked choices. Include synthetic fixtures and round-trip coverage for all 125 printed manager fields. |
| `6571114` | Shared manual/import setup, drag-and-drop upload, explicit conflict review, fullscreen form/document editing, account-scoped tab draft recovery, read-only deal-source labels and guided field navigation. Include safe creation retry and browser regression coverage. |
| `794dd33` | Center the sidebar logo in expanded, collapsed and mobile layouts without the toggle displacing it. |
| This documentation commit | Archive local reference files, add a targeted ignore rule, and document the completed workflow and verification. |

## Repository hygiene

- Moved the two local reference lease PDFs from the repository root to `notes/lease-import-samples/` and the two revision DOCX files to `notes/revisions/2026-09-15/`. These originals are preserved locally and excluded by the existing `notes/` rule.
- Added a root-only `/*Lease Template*.pdf` rule so reference lease PDFs are not accidentally staged if copied to the root again. This does not ignore the tracked synthetic PDF fixtures under `scripts/demo-assets/`.
- Kept the canonical Word template, shared field definitions, synthetic fixtures, source assets and repeatable tests tracked.
- No tracked obsolete source or scratch artifact was identified for deletion. No blanket `git clean`, dependency removal or runtime-state deletion was used. `.dev.vars`, `.wrangler/`, `dist/`, `node_modules/`, browser output and scratch files remain ignored.
- No tracked file matches the repository ignore rules. The final working tree is expected to be clean after this commit; ignored local reference files and runtime assets remain available.

## Verification

Passed against the final functional tree before committing:

- Property: 129 fields mapped exactly once across 15 sections, defaults and explicit overrides, lease resolution, conditional dates, spare utility choices, account-scoped draft backup and recovery.
- Lease extraction: 113 checks, including synthetic Word/PDF layouts and round-trip extraction of all 125 printed property defaults.
- New Property browser suite: 159 checks covering file picker and drag/drop, invalid input, role-separated tables, conflict review, document navigation, fullscreen layout, bidirectional synchronization, refresh recovery, idempotent creation retry and role restrictions.
- Lease generation: 35 checks; local lease schema: 46 checks.
- Registry/template validation: 151 registered fields, four deliberately nonprinted property defaults and 17 disclosure rules. The checker also reports the expected property-specific values that must be supplied before generating an actual lease.
- Demo: 69 data checks, 47 identity checks, media checks and all twelve journey scenarios.
- Rentals: 57 workflow, 29 intake and 65 screening-gate checks.
- TypeScript, architecture boundaries (89 modules), production build and Git whitespace checks.

Browser tests use the installed Codex Playwright runtime via `PLAYWRIGHT_MODULE`; no repository dependency change was needed. The Node module-type warning remains pre-existing and does not fail these checks. Passing local fixtures does not establish production provider readiness.

## Related workflow notes

- `property-setup-audit.md`: shared sections, defaults, document workspace and persistence scope.
- `lease-import-review.md`: supported extraction patterns, review evidence, warning conditions and source-label behavior.

Draft backup is scoped to the current browser tab and account, not a server-saved or cross-device draft. Scanned leases still require a searchable/OCR copy. Real credit, payment and signing integrations remain outside this local checkpoint.
