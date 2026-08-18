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

`npm run dev` serves the source files under `site/` and renders shared HTML partials in memory; it does not run the Worker, so `/api/contact` is unavailable there. To preview the full site including the Worker, run `npm run build` followed by `npx wrangler dev`.

## How the project is organized

Everything the visitor's browser receives lives under `site/`; everything that
builds, serves, or feeds the site lives at the root. The build flattens `site/`
into `dist/`, so deployed URLs never contain the `site/` prefix.

```text
.
├── site/                          Website source (flattened into dist/ by the build)
│   ├── index.html                 Home page
│   ├── buy/                       Residential properties for sale
│   ├── rental/                    Residential properties for rent
│   ├── commercial/                Commercial property page
│   ├── listings/                  General listings page
│   ├── new-development/           New development page
│   ├── property/                  Single-property page
│   ├── apply/                     Rental application form
│   ├── contact-us/                Contact page (form posts to /api/contact)
│   ├── our-team/                  Team page
│   ├── admin/                     Listings admin page (behind Cloudflare Access)
│   ├── partials/                  Shared HTML fragments (not deployed)
│   ├── shared/                    Design system, page runtime, listing and property scripts, vendored browser libraries
│   ├── video/                     Background films and their poster frames
│   ├── png/                       Brand marks (masters; pages draw the logo as inline SVG)
│   └── data/                      Offline fallback listings JSON
├── worker/                        Cloudflare Worker (listings feed, admin API, applications, contact form)
├── supabase/                      Database schema and one-off import scripts
├── scripts/                       Static build and HTML rendering scripts
├── .github/workflows/             CI build and deploy workflow
├── notes/                         Working files — design drafts, requirement docs (not tracked in Git)
├── wrangler.jsonc                 Cloudflare Workers configuration
├── dist/                          Generated build output (not tracked in Git)
├── server.js                      Local development server
└── package.json                   Local development, build, and deploy commands
```

Copy conventions worth keeping: residential rentals are labeled "For Rent",
commercial rentals "For Lease".

### Source pages

`site/index.html` and page directories such as `site/buy/`, `site/rental/`, and `site/contact-us/` are the editable source files. Each page directory contains an `index.html` so the deployed site can use clean paths such as `/buy/`.

Pages that use the shared navigation contain a `SHARED_HEADER` marker. The renderer replaces that marker with `site/partials/site-header.html` while serving or building the site. Edit the partial or `scripts/render-html.js` for site-wide navigation changes; do not copy the generated header markup back from `dist/`.

### Listings data

Listing data lives in Supabase Postgres; media bytes (photos, floor plans, videos) live in the Cloudflare R2 bucket `listing-media` and are served at `/media/<key>` by the Worker with long-lived caching and Range support. The Worker answers `GET /data/listings.json` by querying the database, shaping rows into the JSON the pages already expect, and caching the result at the edge for 60 seconds. The listing pages were not changed: they still fetch that same path.

- `supabase/schema.sql` creates the `listings` table (structured columns: numeric price, integer bedrooms, building/unit, description, video URL) and the `listing_media` table that ties R2 object keys to listings with captions and ordering.
- `worker/listings.js` serves the feed; `worker/supabase.js` maps database rows to the frontend contract; `worker/media.js` serves and manages R2 objects.
- `supabase/import-folder.mjs` imports one marketing folder (docx copy + photos + floor plan + video) as a complete listing; `supabase/import-seed.mjs` loads the old sample data as placeholder inventory.
- `site/data/listings.json` is no longer generated data. It stays in the repository as the offline fallback the Worker serves whenever Supabase is unreachable, so the site never renders an empty grid.
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
| `RESEND_API_KEY` | Contact form and application notification email (secret) |
| `APP_ENCRYPTION_KEY` | AES-256 key for applicant SSNs, 32 random bytes base64 (secret) |
| `TURNSTILE_SECRET_KEY` | Optional; enforces human verification on the application form (secret) |

### Rental applications

`/apply/?id=<listing>` is the full rental application: applicant identity (name,
date of birth, SSN), current residence, desired move-in and lease term,
employment and income with supervisor contact, previous employment, rental
history, three required references, emergency contacts, pets, and whether
children under 11 will live in the home. Repeated sections follow the same
structure Innago uses, so agents can review them the way they are used to.

The SSN is handled more strictly than everything else:

- The Worker encrypts it with AES-256-GCM before insert (`worker/ssn.js`); the
  key lives only in the `APP_ENCRYPTION_KEY` secret. Generate it once with
  `openssl rand -base64 32` and set it with `npx wrangler secret put APP_ENCRYPTION_KEY`.
  Submissions fail closed with a 503 while the secret is missing.
- The database stores the ciphertext plus the last four digits. Admin list
  responses only ever include the last four; the full number is decrypted on
  demand through `GET /api/admin/applications/<id>/ssn` (behind Cloudflare
  Access) when staff click "Reveal SSN".
- Notification email carries the applicant's name only — never form contents.

The admin Applications tab shows each submission with the full detail
(employment, rental history, references, emergency contacts, pets) and tracks
it through the pipeline: new → contacted → fee pending → screening → in review
→ sent to landlord → approved / declined → lease sent → lease signed. Credit
reports, application-fee payment, and DocuSign signing happen in outside
systems for now; record their outcomes with the status dropdown and notes.

## How the site is designed

The look is defined once in `site/shared/site.css` and used by every page: change a
token there and the whole site follows. `site/index.html` carries additional styles
inline because the home page is the only page with the full-bleed films and the
particle instrument.

### Palette and type

| Token | Value | Used for |
| --- | --- | --- |
| `--paper` / `--paper2` | `#f6f4ef` / `#efece3` | page ground and inset panels |
| `--ink` | `#141834` | headlines and body text |
| `--soft` | `#666d8a` | secondary text and labels |
| `--line` / `--line2` | `#dcd8cd` / `#c9c4b6` | rules and card borders |
| `--blue` | `#3E3EE5` | the accent, reserved for the active thing: status chips, primary buttons, the logo, hover states |
| `--navy` | `#101538` | footer and dark panels |

Three families, loaded from Google Fonts: Inter Tight for display headlines,
Inter for body copy, IBM Plex Mono for kickers, labels, and figures set in
uppercase with wide letter spacing. Prices and counts carry the `.num` class so
digits are tabular and columns align.

Layout constants: content sits inside `.wrap` (max 1440px with fluid gutters), the
fixed header is 62px tall, and the lower sections of a page share one measure,
`--sect: clamp(620px, 92svh, 1020px)`, so they stand the same height.

### Page structure

Pages follow the same order: fixed header, page head (a mono kicker above the
`h1`), content sections each introduced by a rule and a heading, a call-to-action
band, and the dark footer carrying the crest and navigation. Cards, forms, fact
lists, and the property sheet share one grammar of hairline rules and mono labels,
so a new page needs only the existing classes.

Listing cards are styled in `site.css` but produced by `shared/listings-page.js`
from the live feed, so the same markup serves the home page, rental, buy, and
commercial views.

The three listing pages close with a skyline strip. `shared/b64-skyline-plate.js`
carries a small greyscale plate in which each pixel value is how deep into the
distance that part of the city sits; `shared/site.js` paints it as dots on
`canvas.cityfoot`, turning that depth into colour, dot size, and opacity, so the
city recedes rather than reading as a flat silhouette.

### The home page

The home page runs in this order: a full-bleed film behind the headline and search
bar, featured listings from the live feed, a statement that lights word by word as
it scrolls, About Star over a second film, and a spread where New Development holds
the left half of the screen while Submit Your Request scrolls past on the right.

The instrument on `#orb` is a WebGL point cloud (three.js) that holds the Star mark
and scatters into a galaxy when dragged or clicked, then re-forms.

### Motion and its off switch

Scroll animation uses GSAP with ScrollTrigger, and Lenis for smooth scrolling.
`shared/site.js` handles everything else without libraries: the mobile navigation
sheet, reveal-on-scroll, and the skyline strip. Browser libraries are vendored in
`site/shared/vendor/` and served from the site, so no page depends on a third-party
CDN to render. The only outside requests a visitor's browser makes are the web
fonts and, on the application form, the optional Cloudflare Turnstile widget.

When the browser reports `prefers-reduced-motion: reduce`, `site.js` puts
`.reduced` on the document, which turns off reveals and animation and stops the
background films from autoplaying.

## What is `dist/`?

`dist/` is generated output produced from the source files by `npm run build`. It is not tracked in Git: the deploy workflow regenerates it in CI on every push to `main`, and local builds exist only for preview or a manual `npm run deploy`.

Important rules:

- Do not edit files in `dist/` directly. The next build will overwrite them.
- `npm run build` deletes the existing `dist/` directory and recreates it from scratch.
- HTML partial markers are expanded into complete HTML during the build.
- Images, shared assets, page directories, and listings JSON are copied into the output.
- The build writes `dist/.assetsignore` to keep non-asset files (e.g. stray `.php`) out of the static upload.

The build currently copies these targets from `site/` into `dist/`:

```text
index.html
buy/            rental/          commercial/
listings/       new-development/ property/
apply/          contact-us/      our-team/
admin/          png/             video/
data/           shared/
favicon.ico     favicon.svg      apple-touch-icon.png
```

To add another deployable page or asset directory, create it under `site/` and add it to `copyTargets` in `scripts/build.js`.

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

- Everything under `site/` — pages, `admin/`, `partials/`, `shared/`, the brand
  marks in `png/`, the films and posters in `video/`, and the `data/listings.json`
  offline fallback
- `worker/`, `supabase/`, `scripts/`, and `wrangler.jsonc`
- `.github/workflows/`
- Project documentation and package metadata

Do not commit:

- `dist/` build output (regenerated in CI on every deploy)
- `notes/` — design drafts, requirement docs, and other working files
- The Supabase service role key, the Resend API key, the SSN encryption key, or any other credential
- `.env` files containing secrets
- `node_modules/`, `.wrangler/`, editor files, or operating-system metadata
- Temporary exports or unoptimized working assets that are not used by the site

The pages draw the logo as inline SVG — in the header, the footer crest, and the favicons — so no logo image is downloaded to render a page. `site/png/` keeps the brand masters for uses outside the page chrome, such as social preview images. The original logo source documents (`.ai`/`.pdf`) are intentionally not tracked; archive them in shared storage (e.g. Google Drive), not in this repository.

## Common workflows

### Change page content or styling

1. Edit the source page for its content. For anything that should look the same
   everywhere — colours, type, spacing, cards, forms, header, footer — edit
   `site/shared/site.css` rather than the page, and `site/shared/site.js` for
   shared behavior.
2. Preview with `npm run dev`.
3. Commit and push; merging to `main` deploys automatically.

### Change the shared header

1. Edit `site/partials/site-header.html` for markup.
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
for file in worker/*.js site/shared/*.js site/admin/admin.js site/apply/apply.js; do node --check "$file"; done
```

Also verify that:

- The main navigation works from both root and nested pages.
- Listing pages load `/data/listings.json` without browser errors.
- `/admin/` prompts for sign-in and rejects unauthenticated requests.
- The contact form submits successfully on the deployed site (`/api/contact`).
- No credential or local configuration file is included in the commit.
