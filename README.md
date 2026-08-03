# Star Website

Static real-estate website for Star Realty, hosted on Cloudflare Workers at https://starreusa.com. Property data lives in Supabase and is served by the Worker; staff manage listings at `/admin/`. The contact form sends inquiry email through Resend.

## Quick start

Requirements:

- Node.js 18 or newer

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
├── data/                          Offline fallback listings JSON
├── scripts/                       Static build and HTML rendering scripts
├── .github/workflows/             CI build and deploy workflow
├── admin/                         Listings admin page (behind Cloudflare Access)
├── supabase/                      Database schema and one-off import script
├── worker/                        Cloudflare Worker (listings feed, admin API, contact form)
├── wrangler.jsonc                 Cloudflare Workers configuration
├── dist/                          Generated build output (not tracked in Git)
├── server.js                      Local development server
└── package.json                   Local development, build, and deploy commands
```

### Source pages

The root `index.html` and page directories such as `buy/`, `rental/`, and `contact-us/` are the editable source files. Each page directory contains an `index.html` so the deployed site can use clean paths such as `/buy/`.

Pages that use the shared navigation contain a `SHARED_HEADER` marker. The renderer replaces that marker with `partials/site-header.html` while serving or building the site. Edit the partial or `scripts/render-html.js` for site-wide navigation changes; do not copy the generated header markup back from `dist/`.

### Listings data

Listing data lives in Supabase Postgres; media bytes (photos, floor plans, videos) live in the Cloudflare R2 bucket `listing-media` and are served at `/media/<key>` by the Worker with long-lived caching and Range support. The Worker answers `GET /data/listings.json` by querying the database, shaping rows into the JSON the pages already expect, and caching the result at the edge for 60 seconds. The listing pages were not changed: they still fetch that same path.

- `supabase/schema.sql` creates the `listings` table (structured columns: numeric price, integer bedrooms, building/unit, description, video URL) and the `listing_media` table that ties R2 object keys to listings with captions and ordering.
- `worker/listings.js` serves the feed; `worker/supabase.js` maps database rows to the frontend contract; `worker/media.js` serves and manages R2 objects.
- `supabase/import-folder.mjs` imports one marketing folder (docx copy + photos + floor plan + video) as a complete listing; `supabase/import-seed.mjs` loads the old sample data as placeholder inventory.
- `data/listings.json` is no longer generated data. It stays in the repository as the offline fallback the Worker serves whenever Supabase is unreachable, so the site never renders an empty grid.
- `shared/listings-page.js` contains shared browser-side listing behavior.
- `buy/`, `rental/`, and `commercial/` filter the dataset for their respective views.

Editors manage listings at `/admin/`: create, edit, publish, delete, multi-photo upload with in-browser compression and per-photo captions, photo ordering (first photo is the card cover), one floor plan, and one video (uploaded to R2 or an external link).

### Admin access

`/admin/` and `/api/admin/*` are protected twice. A Cloudflare Access application gates the routes at the edge, and `worker/access.js` independently verifies the signature, audience, issuer, and expiry of the JSON Web Token that Access attaches. Verification fails closed: if `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD` are unset, every admin request is rejected.

The browser never talks to Supabase and never holds a database key. All reads and writes go through the Worker using the service role key, and the `listings` table has row-level security enabled with no policies, so the anon key cannot reach it either.

Required Worker secrets and variables:

| Name | Purpose |
| --- | --- |
| `SUPABASE_URL` | Project URL, e.g. `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side database key (secret) |
| `CF_ACCESS_TEAM_DOMAIN` | Zero Trust team domain, e.g. `starrealty.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | Application Audience tag of the Access application |
| `RESEND_API_KEY` | Contact form email (secret) |

## What is `dist/`?

`dist/` is generated output produced from the source files by `npm run build`. It is not tracked in Git: the deploy workflow regenerates it in CI on every push to `main`, and local builds exist only for preview or a manual `npm run deploy`.

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

- Automatic: `.github/workflows/deploy.yml` builds and deploys on every push to `main`.
- Manual fallback: `npm run build && npm run deploy` (requires a wrangler login on the Cloudflare account).

Deploying from CI requires two repository secrets: `CLOUDFLARE_API_TOKEN` (create it in Cloudflare with the "Edit Cloudflare Workers" template) and `CLOUDFLARE_ACCOUNT_ID`.

The contact form endpoint `/api/contact` is implemented in `worker/index.js` and sends inquiry email through Resend. The Resend API key lives in the Worker secret `RESEND_API_KEY` (set once with `npx wrangler secret put RESEND_API_KEY`); secrets persist across deployments and are never part of the repository.

## First-time Supabase and admin setup

1. Create a Supabase project, then run `supabase/schema.sql` in the SQL editor.
2. Create a Cloudflare Access application (Zero Trust > Access > Applications) for `starreusa.com/admin*` and `starreusa.com/api/admin*`, with a policy allowing the staff email addresses. Copy its Application Audience tag.
3. Set the Worker configuration (the R2 bucket `listing-media` already exists; its binding is in `wrangler.jsonc`):

   ```bash
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
   npx wrangler secret put CF_ACCESS_AUD
   ```

4. Deploy, then open `https://starreusa.com/admin/` and confirm the sign-in prompt appears before the page loads.
5. Import inventory. Real listings from marketing folders:

   ```bash
   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
   node supabase/import-folder.mjs "/path/to/Evergarden 7A"
   ```

   Optionally load the old sample data as placeholder inventory with `node supabase/import-seed.mjs`.

Until step 3 is complete the admin routes reject every request, and the listings feed serves the bundled fallback copy.

## What belongs in the repository

Commit these files when they change:

- Source HTML pages, including `admin/`
- `worker/`, `supabase/`, and `wrangler.jsonc`
- `partials/`, `shared/`, and `scripts/`
- Optimized website assets in `jpg/` and `png/`
- `data/listings.json`, which is the offline fallback for the listings feed
- `.github/workflows/`
- Project documentation and package metadata

Do not commit:

- `dist/` build output (regenerated in CI on every deploy)
- The Supabase service role key, the Resend API key, or any other credential
- `.env` files containing secrets
- `node_modules/`, `.wrangler/`, editor files, or operating-system metadata
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

1. Sign in at `https://starreusa.com/admin/`.
2. Add, edit, publish, or remove a listing, uploading a photo if there is one.
3. The change appears on the website within a minute. No deploy is involved.

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

- [ ] Refresh the bundled `data/listings.json` fallback periodically so it does not drift far from live inventory.
- [ ] Add automated tests for the row-to-feed mapping and the fallback path.
- [ ] Add visible handling for loading, empty, and failed listing-data states.
- [ ] Add listing detail pages or confirm that `details_url` should continue linking to an external system.
- [ ] Resize and compress uploaded photos, and define a fallback image for listings without one.
- [ ] Add a documented content publishing checklist for non-developer editors.

### Priority 3: build, deployment, and maintenance

- [ ] Add automated HTML, link, JavaScript, and accessibility checks to continuous integration.
- [ ] Add cache-control guidance and asset versioning for production deployments.
- [ ] Add monitoring for failed contact-form submissions.
- [ ] Add dependency and runtime version checks if third-party npm tooling is introduced.

### Later enhancements

- [ ] Add search, filtering, sorting, pagination, and map-based listing discovery when inventory size requires them.
- [ ] Add multilingual content if required by the target audience.
- [ ] Add analytics and consent handling after privacy requirements are defined.
- [ ] Extend `/admin/` to page content if editing outside code becomes a recurring operational need.
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
for file in worker/*.js admin/admin.js; do node --check "$file"; done
```

Also verify that:

- The main navigation works from both root and nested pages.
- Listing pages load `/data/listings.json` without browser errors.
- `/admin/` prompts for sign-in and rejects unauthenticated requests.
- The contact form submits successfully on the deployed site (`/api/contact`).
- No credential or local configuration file is included in the commit.
