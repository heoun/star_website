# Star Website

Static real-estate website for Star Realty, hosted on Cloudflare Workers at https://starreusa.com. Property data lives in Supabase and is served by the Worker; staff manage listings at `/admin/`. The contact form sends inquiry email through Resend.

## Quick start

Requirements:

- Node.js 18 or newer

Run `npm ci` to install the locked development dependencies for type checking and architecture checks. The development server and build use Node.js built-in modules; Cloudflare's wrangler CLI is fetched on demand through npx. CI uses Node.js 24.

```bash
npm ci

# Copy the development configuration and fill it in (see below)
cp .dev.vars.example .dev.vars

# The real Worker, on your machine, at http://127.0.0.1:8787
npm run dev

# Rebuild the dist/ output
npm run build

# Manual deploy to Cloudflare (normally not needed; pushing to main auto-deploys)
npm run deploy
```

## Development

`npm run dev` runs `worker/index.js` under `wrangler dev`, exactly as Cloudflare
runs it, and watches `site/` so a saved edit appears on the next reload without
a restart. Everything works locally: the listings feed, the apply and contact
forms, `/admin/`, and lease generation with its live document preview.

`npm run preview` is the older static server (`server.js`) on port 8000. It
starts instantly and needs no configuration, but it has no Worker in it — no
`/api`, no `/admin`, no Supabase — so it is only useful for a quick look at page
markup and styling.

### Telling development apart from production

Three environment-specific behaviours, all decided in `worker/env.js`:

**Local role simulation.** With `DEV_ADMIN_EMAIL` unset, workspace users sign
in through Supabase. An optional local administrator identity opens the console, behind two independent locks that must both
hold: `DEV_ADMIN_EMAIL` has a value, and the request arrived on a loopback
hostname. `DEV_ADMIN_EMAIL` can only come from `.dev.vars`, which is gitignored,
is never uploaded by `wrangler deploy`, and does not exist in GitHub Actions;
production traffic never arrives as `localhost`. Either lock alone keeps this
shut in production.

**Email.** On a loopback request, notification email is printed to the dev
server's terminal instead of being sent, so a local form submission cannot reach
a real inbox — and you get to read the whole message while you are working on
its wording.

**Media.** Your local R2 bucket is empty, so every listing photo would 404. Set
`DEV_MEDIA_ORIGIN` and a local miss is read from the live site instead. Reading
only: uploads and deletes stay in the local bucket.

The admin page shows an amber **Development** banner naming the Supabase project
it is connected to. Running locally is obvious; being pointed at the production
database while doing so is not, and that is the mistake worth catching.

Supabase keeps a project's display name in its dashboard only — neither the URL
nor the service role key carries it, both identify a project by its ref — so set
`DEV_SUPABASE_LABEL` to whatever you call yours and the banner shows it beside
the ref. The label is typed by hand and can go stale; the ref is read from the
URL actually in use and cannot, which is why both are shown.

Wrangler reloads the Worker when `.dev.vars` changes, but it reads the file once
for its bindings: adding a name that was not there before needs a restart.

### The development database

Development uses its own Supabase project, so a mis-click locally cannot delete
a real listing and local lease settings cannot land in production tables.

1. Create a second (free) Supabase project.
2. Run `supabase/schema.sql` on it.
3. Put its URL and service role key in `.dev.vars`.
4. Optionally seed it with a copy of the live listings:

   ```bash
   SOURCE_SUPABASE_URL=https://<production>.supabase.co \
   SOURCE_SUPABASE_SERVICE_ROLE_KEY=<production service role key> \
   npm run seed:dev
   ```

   Rows keep their ids, so `DEV_MEDIA_ORIGIN` finds the photos at the same
   `/media/` URLs and the local site looks like the real one without copying a
   byte out of R2. The script refuses to run if `.dev.vars` turns out to point
   at the same project as the source. Applications are never copied: they hold
   real names, addresses and encrypted SSNs.

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
│   ├── portal/                    Applicant portal (sign-in, status, document uploads)
│   ├── contact-us/                Contact page (form posts to /api/contact)
│   ├── our-team/                  Team page
│   ├── admin/                     Workspace (Supabase login + business permissions)
│   ├── partials/                  Shared HTML fragments (not deployed)
│   ├── shared/                    Design system, page runtime, listing and property scripts, vendored browser libraries
│   ├── video/                     Background films and their poster frames
│   ├── png/                       Brand marks (masters; pages draw the logo as inline SVG)
│   └── data/                      Offline fallback listings JSON
├── worker/                        Cloudflare Worker (listings feed, admin API, applications, contact form)
├── supabase/                      Database schema and one-off import scripts
├── scripts/                       Build, HTML rendering, dev server, and dev seeding
├── .github/workflows/             CI build and deploy workflow
├── notes/                         Working files — design drafts, requirement docs (not tracked in Git)
├── wrangler.jsonc                 Cloudflare Workers configuration
├── dist/                          Generated build output (not tracked in Git)
├── server.js                      Static-only preview server (npm run preview)
├── .dev.vars.example              Template for local configuration (.dev.vars is gitignored)
└── package.json                   Local development, build, and deploy commands
```

Copy conventions worth keeping: residential rentals are labeled "For Rent",
commercial rentals "For Lease".

### Source pages

`site/index.html` and page directories such as `site/buy/`, `site/rental/`, and `site/contact-us/` are the editable source files. Each page directory contains an `index.html` so the deployed site can use clean paths such as `/buy/`.

The logo paths live in `site/partials/brand-logo.html`. `INLINE_LOGO` embeds them directly into page HTML at build/serve time; `currentColor` inherits each page’s existing palette. `INLINE_BRAND_ICON` embeds the same shape as a data-URL favicon. There is no runtime logo image request or dependency on the original design file.

Pages that use the shared navigation contain a `SHARED_HEADER` marker. The renderer replaces that marker with `site/partials/site-header.html` while serving or building the site. Edit the partial or `scripts/render-html.js` for site-wide navigation changes; do not copy the generated header markup back from `dist/`.

### Listings data

Listing data lives in Supabase Postgres; media bytes (photos, floor plans, videos) live in the Supabase Storage bucket `listing-media` and are served at `/media/<key>` by the Worker with long-lived caching and Range support. The Worker answers `GET /data/listings.json` by querying the database, shaping rows into the JSON the pages already expect, and caching the result at the edge for 60 seconds. The listing pages were not changed: they still fetch that same path.

- `supabase/schema.sql` creates the `listings` table (structured columns: numeric price, integer bedrooms, building/unit, description, video URL) and the `listing_media` table that ties storage object keys to listings with captions and ordering.
- `worker/listings.js` serves the feed; `worker/supabase.js` maps database rows to the frontend contract; `worker/media.js` serves and manages files through `worker/storage.js`.
- `supabase/import-folder.mjs` imports one marketing folder (docx copy + photos + floor plan + video) as a complete listing; `supabase/import-seed.mjs` loads the old sample data as placeholder inventory.
- `site/data/listings.json` is no longer generated data. It stays in the repository as the offline fallback the Worker serves whenever Supabase is unreachable, so the site never renders an empty grid.
- `shared/listings-page.js` contains shared browser-side listing behavior.
- `buy/`, `rental/`, and `commercial/` filter the dataset for their respective views.

Editors manage listings at `/admin/`: create, edit, publish, delete, multi-photo upload with in-browser compression and per-photo captions, photo ordering (first photo is the card cover), one floor plan, and one video (uploaded to Supabase Storage or an external link).

### Admin access

`/login/` signs workspace users in through Supabase Auth. `/portal/` uses the same identity provider and HttpOnly session for applicants. `/admin/` redirects unauthenticated visitors to sign in; every `/api/admin/*` request checks the verified identity against the active staff directory. Role and property assignments are never taken from user-editable Auth metadata. Cloudflare Access is no longer required for application login.

See [Supabase deployment and account setup](docs/backoffice/supabase-setup.md) for the migration order, Owner bootstrap, email templates, storage and verification checklist.

The browser never talks to Supabase and never holds a database key. All reads and writes go through the Worker using the service role key, and the `listings` table has row-level security enabled with no policies, so the anon key cannot reach it either.

Required Worker secrets and variables:

| Name | Purpose |
| --- | --- |
| `SUPABASE_URL` | Project URL, e.g. `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side database key (secret) |
| `SUPABASE_PUBLISHABLE_KEY` | Auth API key for both portals; kept server-side. The legacy `SUPABASE_ANON_KEY` is also accepted |
| `OWNER_AUTH_USER_ID` | Supabase Auth user UUID pinned to the platform owner (secret); required together with `OWNER_EMAIL` |
| `STORAGE_BACKEND` | `supabase` in deployed configuration; `r2` for isolated local development |
| `RESEND_API_KEY` | Contact form and application notification email (secret) |
| `APP_ENCRYPTION_KEY` | AES-256 key for applicant SSNs, 32 random bytes base64 (secret) |
| `TURNSTILE_SECRET_KEY` | Optional; enforces human verification on the application form (secret) |
| `OWNER_EMAIL` | The permissions-only platform owner. Must match the verified email of `OWNER_AUTH_USER_ID`. Only this identity can appoint/remove Admins, and it cannot access business operations. Set it with `wrangler secret put OWNER_EMAIL`: a plain variable set in the dashboard is wiped by the next `wrangler deploy`, and this is the account that gets you back in |

None of these are set locally except Supabase and `APP_ENCRYPTION_KEY`; `.dev.vars.example` says what a development machine needs instead.

#### The console

Four screens, each with its own address so one can be linked to and gone back from:

| Address | Screen |
| --- | --- |
| `#/listings` | Everything the public site shows. Folder import, media, the listing editor |
| `#/applications` | The pipeline, as a table, and `#/applications/<id>` for one of them |
| `#/leases` | Approved applications, and `#/leases/<id>` for one of them |
| `#/properties` | Properties and their landlord defaults, and `#/properties/<id>` for one. Manager only |

`#/applications/<id>` is the **application page**. The list is a list —
applicant, apartment, applied, move-in, income, documents, status, one action —
and everything else lives here, behind six tabs: *Overview*, *Applicant &
household*, *Employment & income*, *Rental history*, *Documents*, *References &
contacts*. The list used to expand the whole application inside the row it
belonged to, which meant a screen of forty applicants was also forty full
applications and reaching the next name meant scrolling past a stranger's
employment history.

Overview answers the three questions a decision needs — who is this, is it
complete, what should happen next — and nothing else. Its **Lease starting
values** card is marked as starting values, because that is what they are: the
agent confirms the final terms in the lease workspace. The lease end date is
not shown here and neither is the rent concession; one follows from a term
nobody has confirmed yet and the other is never asked of an applicant.

**Documents** is a checklist against the same registry the portal enforces:
required, partly received, received, optional, with counts. *View* opens the
file itself — `GET /api/admin/documents/<id>`, the endpoint that already
streams the object out of private storage — in a window that switches between the files of a
multi-file entry. Replacing and removing live in a `⋯` menu behind a
confirmation, because a red Delete beside every filename is one mis-click away
from asking the applicant for their passport again.

The **decision panel** stays in view down the right on desktop and moves under
the page on a narrow one. It shows the status, the internal notes, what is
still outstanding, and who last decided — and its buttons depend on where the
application has got to: request information, approve or decline while it is
under review; create the lease once it is approved; open the lease once one
exists. Approving is the end of the application. There is no second approval
before a lease.

`#/leases/<id>` is the **lease workspace**: the rendered document on the left, what it will say on the right. The right pane has three tabs.

**Lease information** groups by who owns each value, not by which template placeholder it fills. *Tenant* comes from the approved application and shows only what a lease needs — never date of birth, social security number, income, employment, references or screening notes, which stay on the application record. *Transaction terms* are the tenancy's and the agent's to set. *Landlord defaults* are the manager's, read-only and collapsed. *Filled in for you* is what nobody types.

Two things the agent is deliberately never asked for: the address, which is composed from the apartment they select and written into every place the template asks for it; and the end date, which follows from the start date and the term. `site/shared/lease-dates.js` holds that arithmetic and is imported by the Worker as well, so the screen and the .docx cannot disagree about when the tenancy ends.

**Documents** lists the fifteen documents in the package. Selecting one filters the preview to it. The sections outside it are collapsed to zero height rather than removed — `display: none` generates no box, and a box that does not exist does not increment the CSS counters this lease numbers its clauses with, so hiding the first sixteen sections that way renumbers every clause of the rider left showing.

**E-sign recipients** names every signer before anything is produced: the tenants from the application, then the landlord signer, which comes from the property and cannot be changed from a lease. There is no e-signature integration — the console produces the Word file and says who it is for, and the tab says so rather than implying a delivery that does not happen.

The status in the header is `Draft` until every required value is answered and `Ready to send` once they are; beyond that it reports what the application says, because the application row carries the only record that a lease was sent or signed. There is no `leases` table and no `Partially signed`, since nothing here talks to a signing service.

`#/properties/<id>` is the **property configuration**. The list says only what a
manager decides on: entity, signer, apartment count, and whether an agent can
send a lease for it today — `Ready`, `1 required item`, or `Setup incomplete`.
Not a count of blanks; twenty-seven unanswered values with no priority between
them tells nobody what to do next.

The page has three tabs. **Property defaults** regroups the same registry the
document is built from — contacts, fees, utilities, keys, fines, disclosures —
by what a value is *for* rather than where it prints: Landlord & signing,
Management & notices, Payments & standing fees, Utilities & services, and the
sixty-three genuinely optional ones folded away behind one button. Nothing is
stored twice; `site/admin/property-sections.js` is a second reading of the same
fields, and it refuses to lose one. **Lease setup** says who owns which values —
the application, the agent, the manager, the system — and lists the fifteen
documents in the package, each of which opens. **Document preview** opens the
real lease reader on this property's values, one document at a time.

The **landlord signer** is the one setting whose absence stops an agent, so it
is the one with its own affordance rather than a row in a table of ninety-three.
It is stored in two places for a reason: the printed name is a lease value
(`landlord.print_name`) because it appears above the signature line, and the
address the signature request goes to appears nowhere in the document, so it has
no placeholder and lives on the property row as `buildings.landlord_signer_email`.
Both are refused for an agent by the Worker.

**A sent lease stops following this screen.** The moment an application moves to
`lease_sent`, every value the lease was generated from is frozen onto it as
`applications.lease_snapshot`, and generation reads that from then on. Without
it a manager correcting a payee address next week would change what somebody has
already been asked to sign.

**One value, one place it is written.** A building default is written on Properties; a single lease's override on the document screen; a tenant correction straight back to the application row. No screen writes a layer that belongs to another screen, which is why the settings form and the generate dialog were merged in the first place — two write paths to the same 147 values is how somebody edits a building's legal disclosures without realising it.

#### Accounts and platform ownership

The current role workflow and migration instructions are in [Backoffice implementation](docs/backoffice/implementation.md), including the September 9 Admin dashboard and landlord onboarding changes. `manager` is the stored value for **Admin**.

Supabase Auth verifies identity; `staff` determines business permissions and pins each workspace account to its Auth user ID. Unknown or inactive accounts are refused. The configured `OWNER_EMAIL` and `OWNER_AUTH_USER_ID` identify the protected permissions-only Owner without a staff row. Only the Owner can appoint, demote or suspend another Admin, with an authorization reason and audit record. Ordinary Admins manage Agents and Landlords; they cannot alter peer Admins. Account type is fixed during ordinary editing, and Landlord accounts cannot become internal staff accounts.

Agents see applications assigned to them or in which they collaborate. Landlords see assigned properties and explicitly shared rental recommendations, without original application material. Property defaults remain Admin controlled; Agents may edit only the allowed transaction fields for their own cases. The complete permission matrix is in `docs/backoffice/implementation.md`.

Property default writes land in `lease_settings_audit`. Per-lease overrides are also checked: `normalizeOverrides` refuses manager-controlled fields for an Agent on both lease routes, not only on the stored layers. `worker/staff.js` holds the policy, and `lease/tools/test-permissions.mjs` drives the real routes to prove it.

The admin page renders an agent's view read-only rather than hiding it: an agent has to be able to review what the lease will print. That is convenience only — the Worker refuses the write whatever the browser sends.

**Order matters when deploying this the first time.** Run `supabase/schema.sql`, `supabase/backoffice.sql`, `supabase/workspace.sql`, then `supabase/administration.sql`, `supabase/identity.sql` and `supabase/storage.sql`; configure `OWNER_EMAIL` and `OWNER_AUTH_USER_ID` with `wrangler secret put OWNER_EMAIL`, *then* deploy the Worker. The Owner can create an Agent account and separately grant Admin access through Accounts & access. Deploy first and everyone is refused until the table exists — the Worker says so in as many words rather than reporting a permissions problem, but nobody can work in the meantime.

Three doors reach a landlord value and all three are closed to an agent: `PUT /lease/settings`, an `overrides` entry on either lease route, and the `building_id` on a listing — re-pointing a unit at another building swaps all 93 per-building values at once, which is the same write by another name.

```sql
insert into public.staff (email, role, name) values
  ('someone@starreusa.com', 'manager', 'Name'),
  ('agent@starreusa.com',   'agent',   'Name');
```

Locally no `staff` row is needed — the role comes from a variable, and there are two commands rather than a file to edit and remember to change back:

```bash
npm run dev         # manager, the default
npm run dev:agent   # the other half of the console, same port
```

`DEV_ADMIN_ROLE` in `.dev.vars` sets a standing default if you want one. Either way the role is read when the Worker starts, so switching means restarting it.

### Rental applications

`/apply/?id=<listing>` is the full rental application. It requires a signed-in
applicant account — see [The applicant portal](#the-applicant-portal) — and the
form collects: applicant identity (name,
date of birth, SSN), current residence, desired move-in and lease term,
employment and income with supervisor contact, previous employment, rental
history, three required references, emergency contacts, pets, and whether
children under 11 will live in the home. Repeated sections follow the same
structure Innago uses, so agents can review them the way they are used to.

It is asked in five steps, not on one page: **About you · Employment & income ·
Rental history · References & household · Identity & review**. The page wears
its own header — the property, the step, a way back to that property and a help
dialog, and none of the site navigation, because every one of those links is a
way to lose a part-filled form. Its styling lives in `site/apply/apply.css`,
loaded by that page alone, which is where the form-density decisions sit:
sentence-case labels at 15px, a full 1.5px input border at 3:1 against white,
and 54px controls.

Three things about that shape are load-bearing:

- **All five steps are one `<form>` and one document.** A step that is not on
  screen is hidden, never unmounted, so moving between steps cannot lose an
  answer and the last step validates everything at once. The step lives in the
  URL fragment (`#step-3`) and nothing else does — no answer is ever written to
  the address bar.
- **There is no draft and no autosave**, so the page promises neither. What it
  does instead is ask before the page goes away once anything has been typed.
- **The form is `method="post" action="/api/apply"`, and both should be dead
  letters.** With JavaScript off there is no form at all: the whole thing lives
  inside a `<template>`, which is inert, and the page renders a `<noscript>`
  panel saying so. With JavaScript on, the page always intercepts its own
  submit. The method and action exist for the one case in between — the handler
  failing to attach after the form has been rendered — because a form with no
  method is a form that would put a Social Security Number in a URL. The Worker
  then refuses a body that is not `application/json` with a page explaining
  that JavaScript is needed, which is also what keeps a cross-site form off the
  route: no HTML form can set that header, whatever it does with `enctype`.

  The `novalidate` attribute survives from the previous page on purpose. The
  five step validators and the Worker's own re-check are stricter than native
  bubbles, and native validation cannot run against four hidden panels.

The SSN is handled more strictly than everything else:

- The Worker encrypts it with AES-256-GCM before insert (`worker/ssn.js`); the
  key lives only in the `APP_ENCRYPTION_KEY` secret. Generate it once with
  `openssl rand -base64 32` and set it with `npx wrangler secret put APP_ENCRYPTION_KEY`.
  Submissions fail closed with a 503 while the secret is missing.
- The database stores the ciphertext plus the last four digits. Admin list
  responses only ever include the last four; the full number is decrypted on
  demand through `GET /api/admin/applications/<id>/ssn` (behind Cloudflare
  Access) when a manager clicks "Reveal in full" on the application page.
- Notification email carries the applicant's name only — never form contents.
- Nothing writes it to `localStorage`, `sessionStorage`, a URL or an analytics
  call, because the page has none of those. A failed insert is logged with the
  row Supabase quoted back stripped out, so not even the last four digits reach
  a log line. `lease/tools/test-apply.mjs` holds all of this to account.
  That redaction matches PostgREST's `Failing row contains …` detail, which is
  the shape every constraint on `applications` produces today — a column added
  later with a unique index would raise `Key (col)=(value) already exists`
  instead, and would need the same treatment.

The full number is a **manager's**. `GET /api/admin/applications/<id>/ssn`
refuses an agent: nothing in the lease workflow reads an SSN — it is screening
material and it is not on the document — so the only reason to want the whole
number is a credit check. An agent sees the last four, which is what matching a
report against an applicant takes. There is no audit log of reveals yet; when
one exists, that endpoint is the single place to write to.

The admin Applications screen tracks each submission through the pipeline:
new → contacted → fee pending → screening → in review → sent to landlord →
needs information → approved / declined → lease sent → lease signed. Ten of
those are the office's own vocabulary and all of them are on rows today, so the
screens group rather than replace them: **New**, **Under review**, **Needs
information**, **Approved**, **Declined**, **Lease created** are what the
filters and the status badges say, with the finer value still settable from the
dropdown. A status change records who made it, when, and any reason given, in
`applications.decision`.

Credit reports, application-fee payment, and DocuSign signing happen in outside
systems for now; record their outcomes with the status control and notes.
Nothing here emails an applicant — "request information" records the request
and lists what is missing; the message is still one somebody writes.

### The applicant portal

`/portal/` is where an applicant creates their account, follows their
application, and uploads the documents tenant screening needs. **Applying
requires the account**: `/apply/` sends anyone without a session to the
portal to sign in (or register) and returns them to the form, and
`/api/apply` enforces the same thing server-side — the application's email is
taken from the verified session, never from the form, so a typo'd or
borrowed address can never detach an application from the portal where its
documents arrive.

Accounts are email and password, hosted by **Supabase Auth**: registration,
email confirmation, password hashing, sign-in throttling, and password reset
are the platform's, not this repository's. The Worker proxies `/api/portal/*`
to the project's auth API, so the browser still never talks to Supabase
directly and never holds a token JavaScript can read — the session is an
HttpOnly cookie carrying Supabase's access and refresh tokens, validated
(and quietly refreshed) by the Worker on every request.

Registration confirms the email with a 6-digit code before the account
works, because everything the portal shows is claimed by email, and an
unverified address would let anyone read a stranger's application by typing
their email into a signup form. "Forgot your password" is the same proof
again: a code to the inbox, then a new password. Those code emails are sent
by Supabase Auth itself — not by Resend, and not printed to the local
terminal the way this Worker's own notification emails are.

Applicants who applied before the portal existed simply register with the
same email address; the confirmation code proves it is theirs, and their
applications appear.

Signed in, an applicant sees each of their applications — the property, an
applicant-facing status, and a document checklist:

- Required: government ID front and back, the job offer letter, the last two
  paystubs, and the last two months' bank statements.
- Optional: the last two years' tax returns, and a landlord's reference
  letter.

Files are PDF or photos (JPEG, PNG, WebP, HEIC), 10 MB each; the Worker
checks a file's first bytes against its declared type before storing it.
The bytes land in the **private `applicant-docs` Supabase Storage bucket** — never in
`listing-media`, whose objects anyone can fetch at `/media/` — and only ever
leave through the Worker: `/api/portal/documents/<id>` for the applicant's
own session, `/api/admin/documents/<id>` after workspace permission checks for staff.

The admin Applications tab shows the same checklist in each application's
panel (with a `Docs: 3/6` tally on the row) and staff can open or delete any
file. The office is emailed once, when the last required document arrives —
not on every upload.

Setup, once (production, and the same in the development project except
where noted):

1. Create the `applicant-docs` R2 bucket in Cloudflare (its binding is
   already in `wrangler.jsonc`) — not needed locally, wrangler simulates R2
   on disk.
2. Re-run `supabase/schema.sql` — safe to re-run — so the
   `application_documents` table exists. A database that predates it still
   lists its applications in the admin; the checklist simply does not appear.
3. Give the Worker the project's low-privilege key — Settings → API Keys.
   Copy the publishable key (`sb_publishable_…`) if the project has one and
   set `SUPABASE_PUBLISHABLE_KEY`; an older project shows the legacy `anon`
   key instead, which goes in `SUPABASE_ANON_KEY`. Either way
   `npx wrangler secret put <name>` (locally: `.dev.vars`). It stays
   server-side; the portal answers 503 without it.
4. In the Supabase dashboard, Authentication → Emails → Templates: edit
   **Confirm signup**, **Magic Link** and **Reset password** so the body shows
   `{{ .Token }}` — the 6-digit code — instead of (or beside) the
   confirmation link. The portal verifies codes; it has no page for the
   link to land on.
5. Production only — Authentication → Emails → SMTP: configure custom SMTP
   (Resend works: host `smtp.resend.com`, username `resend`, password the
   API key). Supabase's built-in sender is limited to a couple of emails an
   hour and is meant for development.
6. Development convenience: in the dev project, turning **Confirm email**
   off (Authentication → Sign In / Providers → Email) skips the code step
   entirely — registering signs straight in, and no real email is sent.

"Full application" opens a panel that answers the question an agent actually
has — will the lease this produces be right — and shows its working underneath.

- **The verdict.** Ready, or what is in the way. It resolves all 147 values for
  this application and this apartment, exactly as generating the lease would.
- **What this lease will say.** The document's own sentences — landlord,
  apartment, tenant, term, rent, deposit — followed by the three answers this
  tenancy alone decides: the window guard notice, the rent concession, and
  whether the DHCR consent is a vacancy or a renewal. It is meant to be read
  against what was agreed, not against a list of field names.
- **What is wrong**, sorted by what an agent does about it:
  - *will stop generation* — required and unanswered. The safe kind of wrong.
  - *will print blank or wrong* — generates without complaint. A statutory
    disclosure with neither box ticked is not missing a value; it prints two
    empty boxes and discloses nothing. See "Disclosure rules" in
    [lease/README.md](lease/README.md).
  - *not confirmed for this building* — a real value that came with the sample
    lease rather than from anyone who knows this building.
- **Tenant's and landlord's information in full**, collapsed. Each is split the
  same way — what does not print on the lease on the left, what does on the
  right — and this is where corrections are made. Reading 147 values is not how
  anyone finds out that one of them is wrong; that is what the verdict is for.
- **Rent concession** — the text of the Rent Concession Rider, if there is one.

`site/shared/lease-review.js` decides the verdict, so it is testable without a
browser and the lease screen can read the same reasoning later rather than grow
a second copy of it.

Edit opens the detail and makes the panel editable in place. Tenant values are validated by the same
rules `worker/apply.js` applies to the public form, so a corrected application
cannot end up shaped differently from a submitted one, and what the applicant
originally wrote is kept and shown under anything that changed — the lease has
the tenant warrant that their application is accurate, so the version they
warranted has to survive being corrected. Landlord values are saved to the
property they belong to.

The five values the lease repeats are edited in **both** places and are the
same values: correcting a name on the lease screen writes it to the application
row, and the overview shows it on the way back. `site/shared/lease-application.js`
reads which values those are off the field registry, so the two screens cannot
hold different lists.

> Correcting an application needs the `submitted` and `concession_terms`
> columns, which arrived after some databases were created. Run
> `supabase/schema.sql` again — it is safe to re-run — or the correction is
> refused with a message saying so. Listing and reading applications is
> unaffected either way.

### Lease generation

The admin turns an approved application into a ready-to-sign New York
residential lease — the lease plus its fourteen riders and statutory notices —
without anyone retyping the tenant's name into fourteen rider preambles.

`lease/template/lease-template.docx` is the lease with every variable value
replaced by a `{{placeholder}}`, and `lease/schema/fields.json` says where each
of the 147 values comes from: 20 from the application and the listing, 125 from
a stored setting, two typed in by the agent. Settings resolve in two layers,
later winning: property (fees, fine schedule, utilities, sprinkler, bedbug
history, Good Cause exemption) < unit.

A registry default is never a fallback when a lease is generated. Most of them
came from one real building, so a field nobody stored counts as unanswered and
the final lease is refused until it is filled in. An agent can still read a
draft, which marks the gaps as `[ TO BE COMPLETED ]`.

The Worker fills the template itself: `worker/zip.js` rewrites the .docx with
the runtime's own compression streams, no library. The preview in the browser
renders that same generated file with `docx-preview`, vendored under
`site/admin/vendor/` with its licenses.

Changing lease wording means editing the .docx in Word — no code — then
`npm run build`. See [lease/README.md](lease/README.md) for the field model, how
to add a field or a rider, and the two things still needed before leases can be
sent through DocuSign.

**One thing to know before using this in earnest:** RPL § 231-b has required a
four-part flood history and risk disclosure in every New York residential lease
since June 2023, and the landlord's source form does not contain one. Every
lease generated from it inherits that gap. See the "Known gap" section in
[lease/README.md](lease/README.md).

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
apply/          portal/          contact-us/
our-team/       admin/           png/
video/          data/            shared/
favicon.ico     favicon.svg     apple-touch-icon.png
```

To add another deployable page or asset directory, create it under `site/` and add it to `copyTargets` in `scripts/build.js`.

## Deployment

The site runs on Cloudflare Workers as the `star-website` Worker, with `starreusa.com` and `www.starreusa.com` bound as custom domains.

- Automatic: `.github/workflows/deploy.yml` builds and deploys on every push to `main`.
- Manual fallback: `npm run build && npm run deploy` (requires a wrangler login on the Cloudflare account).

Deploying from CI requires two repository secrets: `CLOUDFLARE_API_TOKEN` (create it in Cloudflare with the "Edit Cloudflare Workers" template) and `CLOUDFLARE_ACCOUNT_ID`.

The contact form endpoint `/api/contact` is implemented in `worker/index.js` and sends inquiry email through Resend. The Resend API key lives in the Worker secret `RESEND_API_KEY` (set once with `npx wrangler secret put RESEND_API_KEY`); secrets persist across deployments and are never part of the repository.

## First-time Supabase and admin setup

1. Follow [Supabase setup](docs/backoffice/supabase-setup.md): apply the six SQL files in order and create the private storage buckets.
2. Bootstrap the Owner in Supabase Auth and set both Owner secrets. Configure email confirmation, SMTP and code templates.
3. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `OWNER_EMAIL` and `OWNER_AUTH_USER_ID` as Worker secrets. Production uses `STORAGE_BACKEND=supabase`; R2 bindings remain only for local compatibility.
4. Deploy to a test environment and verify `/login/` and each role. If a Cloudflare Access application previously covered these paths, remove that application gate as part of the tested cutover; it is separate from the Worker and will otherwise keep showing the old login.
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
- `lease/` — the lease template, its field registry, and the tools that check
  them. `*.docx` is otherwise git-ignored; `lease/template/` is the exception,
  because the template is a source file rather than a working draft
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
for file in server.js scripts/*.js worker/*.js site/shared/*.js site/admin/*.js site/apply/apply.js site/portal/portal.js; do node --check "$file"; done
python3 lease/tools/check-fields.py
node lease/tools/test-lease.mjs
node lease/tools/test-apply.mjs
node lease/tools/test-permissions.mjs
```

Also verify that:

- The main navigation works from both root and nested pages.
- Listing pages load `/data/listings.json` without browser errors.
- `/admin/` prompts for sign-in and rejects unauthenticated requests.
- The contact form submits successfully on the deployed site (`/api/contact`).
- No credential or local configuration file is included in the commit.

## Repository maintenance

See [repository layout and delivery checkpoints](docs/repository.md) for source-file retention, local artifacts, validation commands and the ordered delivery history.

### Listing metadata cleanup

Existing databases: deploy code that no longer references the removed listing columns, then run [`supabase/drop-listing-presentation-fields.sql`](supabase/drop-listing-presentation-fields.sql). This permanently deletes Price override, Neighborhood, Card badge and listing Sort order data. Photo ordering is retained. New databases use the updated `supabase/schema.sql`.

Run `npm run test:listings` for the save/read flow and `npm run test:listings:db` with PGlite installed (or `PGLITE_MODULE` set) for the database migration checks.
