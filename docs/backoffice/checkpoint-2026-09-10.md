# Development checkpoint — September 10, 2026

This checkpoint saves the current implementation on `haiyang_dev`. The local preview uses isolated synthetic data. Cloud migrations, real Supabase project configuration and deployment have not been performed by this checkpoint.

## Implementation stages

| Commit | Stage | Result |
| --- | --- | --- |
| `bc9cf27` | Repository housekeeping | Ignore generated artifacts and patch scratch files. Remove the ignored lease backup and Python bytecode cache locally. |
| `e047bcc` | Listings | Simplify the editor, inherit the selected property's building information, default new listings to drafts, and remove unnecessary presentation columns. |
| `d18f848` | Rental review | Prioritize application summaries and combine staff review with landlord recommendation while preserving role scopes and workflow checks. |
| `e4ecf5d` | Supabase integration | Unify applicant and workspace sessions, bind staff identities, support activation and recovery, and route private files through Supabase Storage. |
| `d5f4550` | New Property | Read DOCX/text PDF leases, review property details and selected defaults, then create a new property atomically with duplicate-safe retries. Existing properties have no import entry. |

The documentation commit following these stages records the setup instructions and this checkpoint. No existing commits were rewritten or backdated.

## Verification

Each implementation stage was reconstructed in a separate temporary directory before committing. Modified JavaScript files passed syntax checks. Stage-specific checks passed:

- Listings: editor behavior, database field removal and complete synthetic demo fixtures.
- Rentals: combined review/recommendation, queue filters and workspace role isolation.
- Supabase: identity flows, identity-binding SQL, Storage operations, account administration and applicant portal visibility.
- Properties: lease extraction, atomic creation SQL, shared property editor, architecture gate, TypeScript checks and production asset build.

The latest browser regression before this checkpoint also passed 34 New Property checks, including DOCX/PDF/manual drafts, lost-response retry, reload, existing-property isolation, cancellation and denied non-Admin writes. The uploaded private lease was exercised only as a review draft, not saved into a real property.

## Deployment and remaining limits

Follow [Supabase setup](supabase-setup.md) for the migration order, secrets, Owner bootstrap and email configuration. The new property flow requires [property-create.sql](../../supabase/property-create.sql). Existing listing databases need the separately documented [presentation-field removal migration](../../supabase/drop-listing-presentation-fields.sql).

Lease import uses deterministic text extraction. Scanned PDFs and handwriting require an OCR text copy; unsupported wording remains for manual review. See [lease import](lease-import.md) for its field boundary, file limits and tests.

Local credentials, `.wrangler`, dependencies, `dist`, original lease documents, screenshots and simulation state are excluded from commits. The source lease template and synthetic supporting-document fixture remain tracked intentionally. No push or production deployment is part of this checkpoint.
