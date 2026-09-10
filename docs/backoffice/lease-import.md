# Import property defaults from a previous lease

Admin opens **Properties & settings → New property**, then chooses a PDF/DOCX or Enter manually. The review contains a new property name and address plus selected default settings and their source excerpts. Nothing is persisted before Create property. Existing property pages have no import entry. Conflicting source values require manual selection and correction; undetected settings remain available for manual entry.

The review focuses on shared property settings. Unit-number discrepancies and former tenant details are silently ignored, without warnings or explanatory UI about those excluded records.

The address hint accepts explicitly labelled property/building/premises addresses or a building address in the Property clause, removes recognized unit suffixes, and does not fall back to a generic cover-sheet Address. Blank management telephone fields cannot consume a subsequent email line.

An explicitly identified property address prefills the new property form for confirmation. Admin can enter the new landlord signature email. Initial defaults are restricted to the 125 manager-owned lease fields. Tenant identities, rent, deposit amounts, unit numbers, lease dates and concessions cannot enter the defaults patch. Opposite checkbox choices are shown together and a contradictory selected answer is rejected.

## Implementation

- `site/admin/lease-import-reader.js` reads DOCX text with the existing bounded OOXML reader and PDF text using a self-hosted Mozilla PDF.js worker. Files, original document text and drafts stay in browser memory. No OCR provider, AI API, external upload, document storage or email is involved.
- `site/admin/lease-import-extract.js` is a pure extraction and review-validation module. It recognizes exact labelled settings and explicit clauses in supported lease wording. Each candidate includes a source excerpt and text-line locator. Multiple distinct values are retained as conflicts. There is no inference that a payment bank is a deposit bank, no fallback to another property's defaults, and no legal classification inferred from boilerplate.
- `site/admin/property-import.js` owns the temporary new-property draft and posts property details, selected validated `initial_settings`, and a random `creation_token` to `POST /api/admin/buildings`. It never submits an existing property ID or updates a settings layer. The server validates the defaults allowlist and rejects attempts to specify an existing property ID. `supabase/property-create.sql` creates the building and initial defaults in one transaction, retaining the existing settings audit. A service-only creation-request table and transaction advisory lock make retries return the original created property without reapplying defaults or duplicating records. Retries with a different actor or payload are rejected. After an uncertain response the UI freezes the submitted draft for retry.
- Admin-only visibility supplements the server permission check. Agents, landlords and Platform Owners do not gain property-edit permissions from this feature. Existing database permissions and settings auditing remain in force.
- PDF.js is pinned in `package.json`; the build copies its runtime, worker, fonts, character maps, WASM assets and license into `dist/admin/vendor/pdfjs`. No generated dependencies are checked into `site/`.

## Supported files and limits

DOCX and PDF with extractable text, up to 20 MB. PDF packages are limited to 100 pages; extracted text to 500,000 characters; DOCX XML decompression to 8 MB. Tracked deletions are excluded. Password-protected PDFs prompt for an unlocked copy. Scans and handwriting need an OCR text copy; low-text PDF pages produce an explicit warning. Unsupported clauses, missing riders and blank answers are not fabricated.

This is deterministic extraction, not a general-purpose language-model reader. Different lease wording can leave values unrecognized. Reviewers can fill those rows themselves. Historical disclosures and unit-specific notices should be checked before applying them as defaults to future leases. Source documents and extraction provenance are not retained after the dialog closes; the normal settings write is audited.

## Verification

- `npm run test:lease-import`: evidence extraction, privacy exclusions, ambiguity, unset checkboxes, typed values, stale reviews and paired choices.
- `npm run test:lease-import:ui`: real browser and Worker with isolated Supabase fixtures; DOCX/PDF and manual drafts, selective creation, lost-response retry, reload, existing-property isolation, cancellation, invalid fields/files, mobile layout and Agent/Landlord/Platform Owner denial.
- `npm run test:property-create:db`: executes the SQL on embedded PostgreSQL, checking transaction rollback, duplicate-free retries, no replay of defaults after later edits, actor/payload binding, and service-only access.
- Apply `supabase/property-create.sql` after `schema.sql` before using New Property against a real Supabase project. The isolated local preview implements the same RPC with fixtures; it does not apply cloud migrations.
- Set `PLAYWRIGHT_MODULE` to an installed Playwright module when it is not installed in the repository. Optional `LEASE_IMPORT_SAMPLE` exercises a private local DOCX/PDF in the review UI without saving its values. Private lease fixtures and screenshots remain outside the repository.
- Existing `npm run test:property` verifies the shared settings editor continues to behave normally.

PDF extraction follows the [Mozilla PDF.js API](https://mozilla.github.io/pdf.js/api/draft/api.js.html) and [official examples](https://mozilla.github.io/pdf.js/examples/).
