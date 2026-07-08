# Star Website

Static real-estate website for Star Realty, with property data synchronized from private Google Sheets. The site is designed to be built locally and uploaded to a static/PHP-capable host such as Hostinger.

## Quick start

Requirements:

- Node.js 18 or newer
- Python 3.11 or newer only when synchronizing Google Sheets data

No npm dependencies need to be installed. The development server and build use Node.js built-in modules.

```bash
# Preview the source site at http://127.0.0.1:8000
npm run dev

# Rebuild the deployable dist/ directory
npm run build
```

`npm run dev` serves the source files from the repository root and renders shared HTML partials in memory. `npm run build` creates the static version that should be deployed.

## How the project is organized

```text
.
├── index.html                    Home page source
├── buy/                          Residential properties for sale
├── rental/                       Residential properties for rent
├── commercial/                   Commercial property page
├── listings/                     General listings page
├── new-development/              New development page
├── contact-us/                   Contact page and PHP form handler
├── our-team/                     Team page
├── partials/                     Shared HTML fragments
├── shared/                       Shared listing-page CSS and JavaScript
├── jpg/ and png/                 Website image assets
├── data/                          Current generated listings JSON
├── scripts/                       Static build and HTML rendering scripts
├── backend/                       Google Sheets synchronization tools
├── .github/workflows/             Scheduled listings synchronization
├── dist/                          Generated deployment snapshot
├── server.js                      Local development server
└── package.json                   Local development and build commands
```

### Source pages

The root `index.html` and page directories such as `buy/`, `rental/`, and `contact-us/` are the editable source files. Each page directory contains an `index.html` so the deployed site can use clean paths such as `/buy/`.

Pages that use the shared navigation contain a `SHARED_HEADER` marker. The renderer replaces that marker with `partials/site-header.html` while serving or building the site. Edit the partial or `scripts/render-html.js` for site-wide navigation changes; do not copy the generated header markup back from `dist/`.

### Listings data

- `data/listings.json` is the frontend listings dataset.
- `data/listings_meta.json` records the most recent synchronization result.
- `backend/sync_listings.py` pulls and validates private Google Sheets data.
- `shared/listings-page.js` contains shared browser-side listing behavior.
- `buy/`, `rental/`, and `commercial/` filter the dataset for their respective views.

See [backend/README.md](backend/README.md) for credentials, sheet requirements, and automation setup. See [backend/LISTINGS_IMPORT_README.md](backend/LISTINGS_IMPORT_README.md) for the detailed import contract.

## What is `dist/`?

`dist/` is generated output: a complete static deployment snapshot produced from the source files. It is useful as a sample of the final directory layout, but it is also the actual folder intended for deployment.

Important rules:

- Do not edit files in `dist/` directly. The next build will overwrite them.
- `npm run build` deletes the existing `dist/` directory and recreates it from scratch.
- HTML partial markers are expanded into complete HTML during the build.
- Images, shared assets, page directories, and listings JSON are copied into the output.
- This repository currently tracks `dist/` so a known deployable snapshot is available for direct upload. After source changes, rebuild and commit the corresponding `dist/` changes.

The build currently copies these source targets:

```text
index.html
buy/
rental/
commercial/
listings/
new-development/
contact-us/
our-team/
jpg/
png/
data/
shared/
```

To add another deployable top-level page or asset directory, add it to `copyTargets` in `scripts/build.js`.

## Generate a fresh deployment snapshot

For normal website changes:

```bash
# 1. Edit source files outside dist/
# 2. Rebuild dist/ from those sources
npm run build

# 3. Review which generated files changed
git status --short
git diff --stat
```

The resulting `dist/` folder can be uploaded as the web root. For Hostinger, upload the contents of `dist/` into the target domain's `public_html` directory. The contact form requires PHP support; the Node development server only serves files and does not execute the PHP handler.

To preview the exact static build without PHP execution:

```bash
python3 -m http.server 8000 --directory dist
```

Then open `http://127.0.0.1:8000`.

## Refresh listings and rebuild

Google Sheets synchronization requires the credentials and sheet IDs described in `backend/README.md`.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

# Writes data/listings.json and data/listings_meta.json
npm run sync:listings

# Copies the refreshed data into a fresh deployment snapshot
npm run build
```

The scheduled GitHub Actions workflow performs the Sheets sync and mirrors changed JSON into `dist/data/`. It does not rebuild every site page because listing-only changes do not require HTML regeneration.

## What belongs in the repository

Commit these files when they change:

- Source HTML pages and `contact-us/submit-inquiry.php`
- `partials/`, `shared/`, and `scripts/`
- Optimized website assets in `jpg/` and `png/`
- `data/listings.json` and `data/listings_meta.json`
- `backend/` code, example configuration, and documentation
- `.github/workflows/`
- The rebuilt `dist/` snapshot
- Project documentation and package metadata

Do not commit:

- Google service-account JSON or other credentials
- A real `backend/sheets_config.json` containing private sheet IDs
- `.env` files containing secrets
- `.venv/`, `node_modules/`, Python caches, editor files, or operating-system metadata
- Temporary exports or unoptimized working assets that are not used by the site

The `.ai` and `.pdf` files at the repository root are original logo source documents. Keep them only if the repository is intended to remain the canonical archive for those brand assets; the website itself uses the optimized files in `jpg/` and `png/`.

## Common workflows

### Change page content or styling

1. Edit the source page, shared CSS/JavaScript, or partial.
2. Preview with `npm run dev`.
3. Run `npm run build`.
4. Review both source and generated changes before committing.

### Change the shared header

1. Edit `partials/site-header.html` for markup.
2. Edit navigation definitions in `scripts/render-html.js` when labels or routes change.
3. Run `npm run build` so every generated page receives the update.

### Update listing content

1. Update the configured private Google Sheet.
2. Run or dispatch the listings sync.
3. Confirm `data/listings_meta.json` reports a successful result.
4. Run `npm run build` locally when preparing a complete deployment snapshot.

## Future roadmap and backlog

The items below are proposed work, not implemented features or delivery commitments. Keep completed work in Git history and update this list as priorities change.

### Priority 1: production readiness

- [ ] Confirm final navigation labels, page order, and property information architecture.
- [ ] Replace remaining sample listing content and placeholder links with production data.
- [ ] Configure and test the contact form on the production PHP host, including recipient addresses, spam protection, validation, and failure handling.
- [ ] Add production domain configuration, canonical URLs, page titles, descriptions, Open Graph metadata, `robots.txt`, and `sitemap.xml`.
- [ ] Run responsive, cross-browser, keyboard-navigation, and accessibility checks on every page.
- [ ] Optimize large images and document target dimensions and compression settings.
- [ ] Decide whether the original `.ai` and `.pdf` brand files belong in Git or in a separate brand-assets archive.

### Priority 2: listings and content operations

- [ ] Confirm the final Google Sheets columns and publish a maintained schema/template for editors.
- [ ] Add automated tests for listing normalization, duplicate IDs, primary/secondary sheet failover, and stale-cache behavior.
- [ ] Add visible handling for loading, empty, stale, and failed listing-data states.
- [ ] Add listing detail pages or confirm that `details_url` should continue linking to an external system.
- [ ] Define image hosting, fallback images, and validation rules for listing photos.
- [ ] Decide whether direct CSV/XLSX upload is needed; preserve the existing JSON contract if another input method is added.
- [ ] Add a documented content publishing checklist for non-developer editors.

### Priority 3: build, deployment, and maintenance

- [ ] Add automated HTML, link, JavaScript, and accessibility checks to continuous integration.
- [ ] Add a deployment workflow so a successful build can publish `dist/` without a manual upload.
- [ ] Decide whether `dist/` should remain tracked long term or become a CI-generated deployment artifact. Until that decision changes, keep rebuilding and committing it.
- [ ] Add cache-control guidance and asset versioning for production deployments.
- [ ] Add monitoring for failed scheduled listing syncs and failed contact-form submissions.
- [ ] Expand `.gitignore` for local environments, secrets, editor metadata, and operating-system files; remove any already tracked local-only files after review.
- [ ] Add dependency and runtime version checks if third-party npm tooling is introduced.

### Later enhancements

- [ ] Add search, filtering, sorting, pagination, and map-based listing discovery when inventory size requires them.
- [ ] Add multilingual content if required by the target audience.
- [ ] Add analytics and consent handling after privacy requirements are defined.
- [ ] Add a CMS only if page editing outside Google Sheets becomes a recurring operational need.
- [ ] Add structured real-estate data where supported and appropriate for search engines.

### Backlog maintenance rules

- Keep secrets and private customer data out of issues, documentation, JSON fixtures, and commits.
- Treat source files outside `dist/` as authoritative; regenerate `dist/` after relevant changes.
- Keep listing output backward-compatible unless source pages and deployment data are updated together.
- Move an item into active work only after its requirements and acceptance criteria are clear.
- Remove completed checklist items during periodic documentation cleanup; Git history remains the record of completed work.

## Deployment checklist

Before uploading `dist/`:

```bash
npm run build
node --check server.js
node --check scripts/build.js
node --check scripts/render-html.js
python3 -m py_compile backend/sync_listings.py
```

Also verify that:

- The main navigation works from both root and nested pages.
- Listing pages load `data/listings.json` without browser errors.
- `data/listings_meta.json` reflects the expected sync state.
- The production host is configured to execute `contact-us/submit-inquiry.php`.
- No credential or local configuration file is included in the upload or commit.
