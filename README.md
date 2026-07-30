# Star Website

Static real-estate website for Star Realty, with property data synchronized from private Google Sheets. The site is hosted on Cloudflare Workers (static assets plus a small Worker) at https://starreusa.com; the contact form sends inquiry email through Resend.

## Quick start

Requirements:

- Node.js 18 or newer
- Python 3.11 or newer only when synchronizing Google Sheets data

No npm dependencies need to be installed. The development server and build use Node.js built-in modules; Cloudflare's wrangler CLI is fetched on demand through npx.

```bash
# Preview the source site at http://127.0.0.1:8000
npm run dev

# Rebuild the dist/ output
npm run build

# Manual deploy to Cloudflare (normally not needed; pushing to main auto-deploys)
npm run deploy
```

`npm run dev` serves the source files from the repository root and renders shared HTML partials in memory; it does not run the Worker, so `/api/contact` is unavailable there. To preview the full site including the Worker, run `npm run build` followed by `npx wrangler dev`.

## How the project is organized

```text
.
├── index.html                    Home page source
├── buy/                          Residential properties for sale
├── rental/                       Residential properties for rent
├── commercial/                   Commercial property page
├── listings/                     General listings page
├── new-development/              New development page
├── contact-us/                   Contact page (form posts to /api/contact)
├── our-team/                     Team page
├── partials/                     Shared HTML fragments
├── shared/                       Shared listing-page CSS and JavaScript
├── jpg/ and png/                 Website image assets
├── data/                          Current generated listings JSON
├── scripts/                       Static build and HTML rendering scripts
├── backend/                       Google Sheets synchronization tools
├── .github/workflows/             Scheduled listings synchronization
├── worker/                        Cloudflare Worker (routing + contact form email)
├── wrangler.jsonc                 Cloudflare Workers configuration
├── dist/                          Generated build output (not tracked in Git)
├── server.js                      Local development server
└── package.json                   Local development, build, and deploy commands
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

`dist/` is generated output produced from the source files by `npm run build`. It is not tracked in Git: Cloudflare Workers Builds regenerates it in CI on every push to `main`, and local builds exist only for preview or a manual `npm run deploy`.

Important rules:

- Do not edit files in `dist/` directly. The next build will overwrite them.
- `npm run build` deletes the existing `dist/` directory and recreates it from scratch.
- HTML partial markers are expanded into complete HTML during the build.
- Images, shared assets, page directories, and listings JSON are copied into the output.
- The build writes `dist/.assetsignore` to keep non-asset files (e.g. stray `.php`) out of the static upload.

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

## Deployment

The site runs on Cloudflare Workers as the `star-website` Worker, with `starreusa.com` and `www.starreusa.com` bound as custom domains.

- Automatic: Cloudflare Workers Builds is connected to this repository. Every push to `main` runs `npm run build` and deploys the result.
- Manual fallback: `npm run build && npm run deploy` (requires a wrangler login on the Cloudflare account).

The contact form endpoint `/api/contact` is implemented in `worker/index.js` and sends inquiry email through Resend. The Resend API key lives in the Worker secret `RESEND_API_KEY` (set once with `npx wrangler secret put RESEND_API_KEY`); secrets persist across deployments and are never part of the repository.

## Refresh listings and rebuild

Google Sheets synchronization requires the credentials and sheet IDs described in `backend/README.md`.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

# Writes data/listings.json and data/listings_meta.json
npm run sync:listings

# Optional: rebuild locally to preview the refreshed data
npm run build
```

The scheduled GitHub Actions workflow performs the Sheets sync and commits changed JSON in `data/`. That push triggers Cloudflare Workers Builds, which rebuilds and deploys the site with the fresh data.

## What belongs in the repository

Commit these files when they change:

- Source HTML pages
- `worker/` and `wrangler.jsonc`
- `partials/`, `shared/`, and `scripts/`
- Optimized website assets in `jpg/` and `png/`
- `data/listings.json` and `data/listings_meta.json`
- `backend/` code, example configuration, and documentation
- `.github/workflows/`
- Project documentation and package metadata

Do not commit:

- `dist/` build output (regenerated in CI on every deploy)
- Google service-account JSON, the Resend API key, or other credentials
- A real `backend/sheets_config.json` containing private sheet IDs
- `.env` files containing secrets
- `.venv/`, `node_modules/`, `.wrangler/`, Python caches, editor files, or operating-system metadata
- Temporary exports or unoptimized working assets that are not used by the site

The original logo source documents (`.ai`/`.pdf`) are intentionally not tracked: the website only uses the optimized image in `jpg/`. Archive the brand source files in shared storage (e.g. Google Drive), not in this repository.

## Common workflows

### Change page content or styling

1. Edit the source page, shared CSS/JavaScript, or partial.
2. Preview with `npm run dev`.
3. Commit and push; merging to `main` deploys automatically.

### Change the shared header

1. Edit `partials/site-header.html` for markup.
2. Edit navigation definitions in `scripts/render-html.js` when labels or routes change.
3. Push to `main`; the CI build regenerates every page.

### Update listing content

1. Update the configured private Google Sheet.
2. Run or dispatch the listings sync.
3. Confirm `data/listings_meta.json` reports a successful result.
4. The sync commit triggers an automatic rebuild and deploy.

## Future roadmap and backlog

The items below are proposed work, not implemented features or delivery commitments. Keep completed work in Git history and update this list as priorities change.

### Priority 1: production readiness

- [ ] Confirm final navigation labels, page order, and property information architecture.
- [ ] Replace remaining sample listing content and placeholder links with production data.
- [ ] Add spam protection (e.g. Cloudflare Turnstile) to the contact form, which currently relies on a honeypot field only.
- [ ] Tighten DMARC from `p=none` to `p=quarantine` once SPF/DKIM have been stable for a few weeks.
- [ ] Add canonical URLs, page titles, descriptions, Open Graph metadata, `robots.txt`, and `sitemap.xml`.
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
- [ ] Add cache-control guidance and asset versioning for production deployments.
- [ ] Add monitoring for failed scheduled listing syncs and failed contact-form submissions.
- [ ] Add dependency and runtime version checks if third-party npm tooling is introduced.

### Later enhancements

- [ ] Add search, filtering, sorting, pagination, and map-based listing discovery when inventory size requires them.
- [ ] Add multilingual content if required by the target audience.
- [ ] Add analytics and consent handling after privacy requirements are defined.
- [ ] Add a CMS only if page editing outside Google Sheets becomes a recurring operational need.
- [ ] Add structured real-estate data where supported and appropriate for search engines.

### Backlog maintenance rules

- Keep secrets and private customer data out of issues, documentation, JSON fixtures, and commits.
- Treat source files as authoritative; `dist/` is regenerated by CI on every deploy.
- Keep listing output backward-compatible unless source pages and deployment data are updated together.
- Move an item into active work only after its requirements and acceptance criteria are clear.
- Remove completed checklist items during periodic documentation cleanup; Git history remains the record of completed work.

## Deployment checklist

Before merging to `main`:

```bash
npm run build
node --check server.js
node --check scripts/build.js
node --check scripts/render-html.js
node --check worker/index.js
python3 -m py_compile backend/sync_listings.py
```

Also verify that:

- The main navigation works from both root and nested pages.
- Listing pages load `data/listings.json` without browser errors.
- `data/listings_meta.json` reflects the expected sync state.
- The contact form submits successfully on the deployed site (`/api/contact`).
- No credential or local configuration file is included in the commit.
