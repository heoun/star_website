# Lease generation

Turns an approved rental application into a ready-to-sign New York residential
lease. Agent-facing, admin only — nothing here is reachable from the public
site.

The lease is a 30-page bundle: the lease itself plus the riders and statutory
notices that have to travel with it (utilities, packages, keys, renters
insurance, community rules and fine schedule, window guards, bedbug disclosure,
sprinkler notice, indoor allergen certification, gas and CO alarms, smoking
policy, the DHCR electronic-signature consent, and the Good Cause Eviction
notice). Every one of those repeats the tenant's name, the unit address and the
lease date in its own preamble, which is exactly the kind of copying that goes
wrong by hand.

## What is here

| Path | What it is |
| --- | --- |
| `template/lease-template.docx` | The lease with every variable value replaced by `{{placeholder}}`. **This is the source of truth.** |
| `template/logos/` | The two agency marks, at the resolution they print at. `reflow-template.py` embeds them. |
| `schema/fields.json` | Every placeholder: label, where its value comes from, type, default, and scope. |
| `tools/check-fields.py` | Verifies the template and the registry still agree. Run it after editing either. |
| `tools/test-lease.mjs` | Regression test for generation. No dependencies: `node lease/tools/test-lease.mjs`. |
| `tools/test-schema.mjs` | Runs `supabase/schema.sql` on real PostgreSQL. Needs PGlite installed ad hoc. |
| `tools/build-template.py` | One-off. Rebuilt the template from the landlord's filled-in lease. |
| `tools/restyle-template.py` | One-off. Underlines the placeholders and replaces the form's credit line. Idempotent. |
| `tools/reflow-template.py` | One-off. Replaces the PDF conversion's layout tricks with text, and builds the footers. Idempotent. |

The three one-off tools are the template, in order: `build-template.py "Lease
Template (2).docx"`, then `restyle-template.py`, then `reflow-template.py`.
Running the three of them against the landlord's source lease reproduces
`template/lease-template.docx` part for part — every one of the forty parts
identical, the same parts in the same order, differing only in the timestamp
the zip stamps on each entry. That is what makes it safe to change one of them
and rebuild: a diff of the result is a diff of the change.

The admin screen is three modules: `site/admin/lease-doc.js` renders and patches
the document, `site/admin/lease-form.js` draws the fields, and
`site/admin/lease-screen.js` is the shell that joins them.

The code lives with the rest of the Worker: `worker/lease.js` resolves values
and fills the template, `worker/zip.js` reads and rewrites the .docx, and
`site/admin/lease.js` is the admin screen. The filled-in lease the template was
built from is deliberately **not** in git: it carries a real tenant's name and
email address.

## Where a value comes from

Every field declares one of three sources. This is the whole design — get the
source right and the rest follows.

**`deal`** (19 fields) — from the application and the listing. Tenant names, the
unit address, move-in date, rent, deposit. The agent confirms these on the
generate form rather than typing them.

**`manager`** (125 fields) — a stored setting, resolved in three layers where
the later one wins:

    company  <  building  <  unit

- `company` (32) — the same everywhere. Fees, guest limits, the fine schedule.
- `building` (93) — differs per building: who pays for water, the sprinkler
  inspection date, the bedbug history, the Good Cause exemption.

**`agent`** (2) — `lease.vacancy_lease_date` and `tenant.mailing_address`, left
blank on purpose: nothing knows the day a vacancy lease is signed, and the DHCR
consent asks for a mailing address only if it differs from the apartment.

`property.address_full` is derived rather than stored: `site/shared/lease-address.js`
composes it from the street, unit, city, state and ZIP, and both the Worker and
the admin screen import that one function. Correcting a ZIP therefore moves the
address everywhere it prints — a lease that names the same apartment two
different ways is one somebody has to explain later.

Dates arrive in two shapes and both are read. The apply form stores
`10/01/2026`, because that is what a New York applicant types; a stored setting
or a typed correction is more likely to be `2026-10-01`. Whichever arrives, a
date field prints `MM/DD/YYYY`, so one document cannot write the same day two
ways. A date already written out in words — the effective date — is left alone.

Signature and initial lines have no placeholders at all, apart from the printed
name above the tenant's signature on the DHCR consent, which the form asks for.
They stay empty for whatever e-signature service the lease is sent through, and
each one is a rule the service can find: a cell or paragraph border under an
empty line, never an underlined tab.

Every text placeholder is underlined in the template, the way a filled blank is
underlined on a paper lease. 55 of the runs that carry one also carry prose, so
`restyle-template.py` splits those runs and underlines only the placeholder
half; check-box marks are left alone, because an underlined `[X]` is wrong.

### Defaults are not fallbacks

The registry's defaults came from one real building. Falling back to them when a
lease is generated would assert *that* building's bedbug history or Good Cause
exemption about a different one, in a document someone signs. So:

- A field nobody stored counts as **unanswered**. Generating a final lease with
  a required field unanswered is refused, with the list of what is missing.
- The company settings form prefills from the registry, because those are fee
  and policy numbers and accepting them is the point.
- The building settings form does **not** prefill. It shows the sample value as
  a hint and starts empty, and it saves only the fields a person actually
  touched — so opening the tab and pressing Save cannot assert 93 things nobody
  reviewed.
- The database enforces the same distinction: an empty string and a JSON null
  are rejected, so "answered blank" is not a state a setting can reach.

## How an agent produces a lease

Everything happens on one screen: the lease itself on the left, the 146 values
that fill it on the right.

1. **New lease** (no application) or **Applications → Lease…** (one
   application). Both open the same screen. With an application, the 19 deal
   fields are answered from it; without one, the apartment answers what it can
   — its address, its rent, its stored settings — and the agent types the rest.

   Every field is editable in both. An application can be wrong, and until
   credit reporting is wired up a lease often has to be produced before any
   application exists.
2. Values belong to one apartment, named by its full address in the bar. The
   company and building layers still exist in the database and are still
   inherited, but nothing on this screen writes to them.
3. Type. The document updates on the keystroke. An unanswered required field
   prints its own name in red, in place, so a gap can never read as a blank.
4. **Find** scrolls the document to where a value appears; a value printed in
   several places steps through them with `‹ 1/13 ›`.
5. **Download draft** produces a .docx with gaps marked. **Produce lease** is
   enabled once nothing required is missing.

### Defaults for the apartment, versus this one lease

A manager value changed while a lease is open is a change to **that lease only**
— the field says so — and it travels with the document when it is produced. The
apartment's stored answers are untouched, so the next lease still starts from
them.

**Save these as the unit's defaults** is the deliberate second step that
promotes what is on screen into the apartment's stored settings, after a
confirmation naming the address.

The gap this leaves: settings changes are audited, a per-lease change is not,
because the produced document and the values behind it are not stored anywhere
yet. Until they are, a one-off change to a legal assertion leaves no trace once
the .docx is downloaded.

All of it runs locally under `npm run dev`, against the development Supabase
project, so lease wording and the settings can be worked on without deploying
and without touching a real building's stored answers.

### How the screen stays fast

The template is rendered **once**, with its `{{placeholders}}` still in it, and
every placeholder is split out of its text node into an addressable span. After
that a keystroke writes a string into one to fourteen text nodes — 0.5 ms for
the worst field — with no re-merge, no re-render, and no request.

Rendering once is a correctness requirement, not an optimisation: docx-preview
calls `URL.createObjectURL` and never revokes it, and offers no cleanup API, so
each render of this template strands 64 blob URLs for the life of the page.
`site/admin/lease-doc.js` says this again where someone might be tempted to add
a refresh button.

Anchoring through OOXML bookmarks was tried first and rejected: docx-preview's
`parseHyperlink` keeps only `w:r` children, so a bookmark inside a hyperlink is
dropped with no error, and `tenant.email` sits in one. Splitting text nodes
reaches all 188 occurrences. The screen checks that count against the registry
on every open and shows a red banner if they disagree — a placeholder that Word
split across two runs must never fail quietly.

**There are no Word text boxes left.** docx-preview renders none of them — Word
wraps them in `mc:AlternateContent`/`wps:txbx` and its parser skips the branch —
and this template had four: the binding-contract notice, the bedbug disclosure
title, and the SECTION A / SECTION B labels on the DHCR consent. Every one of
them was clipped by its own box in Word as well, because a text box does not
grow with its text: the cover printed "THIS IS A BINDING CONTRACT. PLEASE READ"
and swallowed "IT CAREFULLY.", the bedbug notice lost "INFESTATION HISTORY", and
Section A lost "Representative)". They are bordered paragraphs now, which both
Word and the preview draw. The screen still counts them and raises the red
banner if one ever comes back.

**Two things are applied after rendering.** Both are read back out of the
document by `site/admin/lease-doc.js` rather than by patching the vendored
renderer, which stays byte-identical to what npm publishes so that upgrading it
is a straight copy. Both check that what they found lines up with what was
drawn and raise the red banner if it does not.

- **Table indents.** docx-preview does not implement `w:tblInd`: its parser
  reads a table indent the way a *paragraph* states one, `w:left`, and a table
  states it as `w:w`. Every table therefore came out on the left margin while
  Word held it in the clause's column. The count of rendered tables is checked
  against the document's first, because otherwise every indent after a
  mismatch would land on the wrong table.
- **Page numbers.** docx-preview cannot evaluate a field; it draws the number
  Word last cached, and one footer serves every page of a rider, so every page
  of the lease read "Page 1". The page a footer is on is the section it is on,
  so the number is counted here the way Word counts it: up by one a section,
  back to `w:pgNumType`'s start where a rider begins.

Two more are corrections rather than readings, and both concern the same pass:
docx-preview lays its tab stops out half a second after the render resolves,
from one measurement of the line.

- **The origin every tab is measured from.** The pass measures where a tab
  starts from the paragraph's own left edge and then reads the stop positions
  as though they had been measured from the page margin, adding the indent to
  both. A paragraph held an inch in from the margin therefore lands every left
  tab stop two inches further right than Word does — far enough, on the smoking
  policy's footnote, to start the sentence a third of the way across the page.
  Stating the indent as padding instead of margin puts the text in exactly the
  same column and leaves the box's left edge where the pass assumes it is, so
  it does its own arithmetic correctly. 55 paragraphs are moved that way; the
  ones that draw a border or a fill are left alone, because padding sits inside
  those and margin sits outside them. Right-aligned stops — the footer —
  measure from the margin already and are unaffected either way. The count is
  checked too: if it ever comes back zero — the renderer having changed how it
  writes an indent — the red banner says so, because a tab silently drawn two
  indents wide reads as a document nobody wrote.
- **The footer's own tab.** Even with the origin right it comes up an eighth of
  an inch short there — the same amount on every page, whatever the label says.
  The tab is the gap, so the gap absorbs the difference once the line is on the
  page. If the vendored renderer ever stops laying tab stops out on a timer,
  this quietly does nothing and the footer is an eighth of an inch short of the
  text above it.

**Two fonts are named in CSS, because the .docx does not name them.**

- **Calibri.** The window guard notice is set in Calibri, because the New York
  City form it reproduces is. Calibri ships *inside* Microsoft Word rather than
  with the operating system, so no browser on a machine that has Word can use
  it, and all 20 of those paragraphs fell back to whatever the browser picked —
  wider, and different from one browser to the next. The Spanish notice at the
  head of the page wrapped onto a second line the .docx does not have. Carlito
  is metric-compatible with Calibri, character for character, so declaring it
  under that family name makes the page break where Word breaks it. Vendored
  beside the renderer, latin subset, under the SIL Open Font License, with
  `local("Calibri")` first so a machine that really has Calibri uses the real
  one.
- **Times New Roman.** About 6,000 characters of this lease — the Key Rider,
  the Community Rules headings, the DHCR consent's instructions — name no font
  anywhere: not on the run, not on the style, not in `w:docDefaults`. Word draws
  those in its own default, which is Times New Roman, and the browser drew them
  in the admin page's font. Naming it on the wrapper is inherited only by the
  runs the document leaves open, which is exactly the set Word defaults.

**Tab stops are laid out, not collapsed.** docx-preview prints a tab as a single
space unless `experimental` is on; roughly 200 lines of this document — every
signature rule, the fine schedule, each "Date | Signature" caption — are
positioned by tab stops, and collapsing them makes the preview read as a
different document from the one that gets signed.

Two things the screen deliberately does not claim:

- **It is a content preview, not a page preview.** Its 45 "pages" are the
  template's `w:sectPr` sections. They line up one for one with the document's
  own pages, because every section break in the template is a page break and
  no section overflows — see *The PDF conversion* below — but a section whose
  text outgrows a Letter page would grow with it rather than breaking. The
  header says which section and which clause, never a page number.
- **The .docx is still produced by the Worker**, from the same template and the
  same resolved values, so what was read is what gets signed.

## The PDF conversion

The lease arrived as a PDF and was converted to .docx. The converter had no idea
what a form is, so wherever the paper form put a label and its blank side by
side it reproduced the *picture*: a multi-column section break with one
paragraph per column, a large right indent to end a line early, and a floating
line shape drawn where the underline belonged.

Word replays that almost correctly. Nothing else does, and neither does Word
once a value is longer than the one the sample was printed with — a manager's
name inside a table cell with `right="3773"` printed one word per line.
`tools/reflow-template.py` replaced those pictures with the thing they were
pictures of, and the shape of the document now follows from three rules:

- **Every section break is a page break.** The ten `continuous` breaks were
  column tricks and are gone. What is left is 45 sections, one per page of the
  paper original, which is also the only kind of break a renderer gets right
  without implementing Word's column model. The bedbug disclosure was four
  pages and is one; the DHCR consent was seven and is one.
- **A right indent means the text really stops there.** The ones measured off
  the sample's own values are gone.
- **Nothing is positioned by a floating shape.** Rules were drawn as shapes
  several inches long inside a frame a hundredth of an inch wide, so Word laid
  out the frame and printed a dot; the DBB-N form's border was a shape as tall
  as the page, which a renderer without floating gave a line of its own. Rules
  are cell and paragraph borders now, the DBB-N border is a one-cell table, and
  the two logos are inline with the alignment they displaced restated as a tab
  stop.
- **A blank to write on is a border, not an underlined tab.** Every signature
  line on this document was a space and a tab character wearing an underline.
  Word draws the underline the whole width of the tab; a renderer that lays tab
  stops out after the fact underlines the space and leaves the rest bare. The
  twelve blocks the conversion squeezed to a third of the page with a right
  indent — "Signature: ____  Print Name: ____" — are a row per label.

  The tab stop stays on the paragraph, because it is the only record of how
  long Word drew the line, and the border is held back to it. Four people sign
  this lease and the form gives each of them a line; the gap between one line
  and the next is the shortfall between the tab and the edge of its column, so
  a border run across the whole cell would have merged the middle two and made
  four lines read as three. The landlord's own signature lines are half the
  width of the page for the same reason: that is where the tab stopped.
- **A check box is a box, not a blank.** Thirty-three marks kept the underline
  of the blank they replaced and printed struck through. Which placeholders are
  boxes is read from the registry, so a fill-in blank that is genuinely
  underlined stays underlined.
- **A table stands in the column of the text around it.** The paper form put
  each one wherever it fitted — six different indents across eighteen tables,
  none lining up with the clause above and none reaching the margin the text is
  justified to. A numbered clause hangs its number out to the left of its own
  text, and a table that finishes one of those sentences — clause 25's two
  notice addresses, the key schedule, the smoking locations — now starts where
  the sentence starts rather than under the number. Everything else, the
  signature blocks above all, is a block of its own and stands in the clause
  column itself. Both kinds end on the margin the text is justified to.

  Only the conversion's tables are placed this way. The ones this tool builds
  — the DBB-N border, which is the page; the DHCR consent's, which has a column
  of its own; the gas provider's caption, which sits under the value it labels;
  the binding-contract box in the corner of page one; and the twelve
  label-and-rule blocks — are given their column by whichever fix builds them,
  which is the one place that knows what the table is for.
- **A page break ends the page.** Up to forty-eight blank paragraphs padded the
  bottom of a section, which decides nothing except whether the page overflows
  — and a preview that grows its pages to fit renders them. Where the padding
  held a caption down, it is a measured gap instead.
- **The line every page ends on is a footer.** The paper form labels every
  page of every rider, two ways: a line of body text on the first and last
  page of one, and a footer on the pages between. The conversion kept the body
  lines and anchored the footers nine inches below the paper, so half the
  labels have been invisible ever since — the lease read "Page 1" on page one,
  nothing for fifteen pages, and "Page 17" at the end — and the half it kept
  floated in the middle of any page that ended early. Read together the two
  halves name every page and say where each rider starts counting, which is
  one footer per document, `w:pgNumType` restarting the count, and the number
  itself a `PAGE` field so that a rider which grows by a page renumbers
  itself. The pages the form leaves unlabelled — the two NYC notices, the DHCR
  consent, the Good Cause notice — get a footer that is deliberately empty,
  because Word inherits the section before it otherwise.

  The footer names its font, which the line it replaces did not: Word fell
  back to the theme's and a browser to whatever `system-ui` is, and the
  difference in width was enough to fit the longest of these labels on one
  line in one renderer and not the other.
- **A signature line starts in the same column on every page.** The conversion
  measured the column holding "Signature:" and "Print Name:" afresh each time
  — 1254 twips on one page, 1324 on another — and the landlord's block, which
  this tool builds, took its own from the tab that used to draw the rule. It
  is one width now, so the landlord signs on a line that begins where the
  tenants' begin.
- **A seal beside an address is two cells, not a tab.** The DHCR consent sets
  its seal inline and sends the department's name to a tab stop past it. Word
  puts that stop where the paragraph asks; a renderer that lays tab stops out
  afterwards measured it from a different origin and threw the name into the
  middle of the page. Both renderers read a table the same way.

The conversion also lost content, not only layout. Questions 3 and 4 of the
Good Cause notice ended `…described above: ;` where the paper form has a check
box, so fifteen answers a landlord is required to give could not be given; the
DHCR consent's title was stored in the *empty* half of an `mc:AlternateContent`
pair, so Word — which reads that half — printed nothing where the title goes;
and the DBB-N form spelled the unit address out a second way, by hand, beside a
lease that composes that line once and prints it everywhere else.

Word and the preview now agree page for page: 45 sections, 45 pages in the
.docx, 45 pages in the preview, none of them near-empty.

### What is not in document.xml

Several things in the package needed the same treatment as the body, and
`reflow-template.py` owns them too — the footers it builds, the artwork it
embeds, the relationships and content types that hold both, and the document's
own properties.

**The e-signature banner is gone.** Every one of the conversion's ten footers
carried a floating shape reading "Document digitally signed using RentCafe
eSignature services. Document ID: 1919" — the previous landlord's signing
service, which would have travelled on every lease this generator produces.
Nothing in them printed: Word laid them out off the page and the preview drew
them below the paper, which is why they went unnoticed for so long. The page
labels those same footers carried are the only thing kept from them; see *The
line every page ends on* above.

**A dangling `mailto:` relationship went with them.** The source lease
hyperlinked the tenant's email address; `build-template.py` replaced the visible
text with a placeholder, but the relationship kept the address, so a real
person's email was sitting in a file that is in git.

**The two agency logos are PNGs rendered at 600 dpi of their printed size** —
the Equal Housing Opportunity mark from the official vector artwork, the NYC
Health mark from the department's own high-resolution file. The conversion's
copies were 56 and 257 pixels wide, which is 190 dpi at the size they print,
and they read as blurry on screen at any zoom. Both are quantised to their own
few colours, so the replacements are smaller than what they replace: 2.2 KB and
4.8 KB against 2.9 KB and 25 KB. They live in `template/logos/`, which is what
makes the three tools reproduce the template on their own.

**The document says whose it is.** The conversion left that answer to somebody
else three times over: no author at all in `docProps/core.xml`, "Aspose Ltd." —
the library the landlord's signing service converted the form with — as the
custom Creator property, and a Google Docs comment store under `customXML/`
still holding a colleague's email address, their Google account id, and the text
of editing suggestions made on the original. All three travelled with every
lease. The core properties now name the agency and the document, the other two
parts are gone, and the created date stays what the form says so the tool writes
the same bytes every time it runs.

Word's *"This file is locked for editing — locked by …"* dialog is not one of
these. That name comes from Word's own user information on the machine the file
is open on, written into the `~$…docx` companion file; it is the same for a
document with no author and for this one. It is changed in Word's settings, not
here, and only whoever has the file open ever sees it.

**A footer needs room.** The conversion left less than a line of anything
between `w:footer` and `w:bottom` on every page. That room is taken from the
top margin rather than from the text, so the block of text keeps the height it
had — and the document keeps its pagination — and sits a fifth of an inch
higher on the sheet instead. The Equal Housing mark in the footer is twelve
points beside eight points of text, which is as tall as it can be and still
read as part of the line.

## Placeholders

Syntax is `{{group.field}}`, lowercase, dot-separated. A value appearing in ten
riders uses the same placeholder in all ten, so it can only be filled one way.

Check boxes are text, not graphics. A field of type `checkbox` renders its
`marks.checked` or `marks.unchecked` string — `[X]`/`[ ]` in most forms, a bare
`X`/empty in the sprinkler and Good Cause notices, which is how those official
forms are marked.

## Changing the wording

Open `template/lease-template.docx` in Word, edit, save, `npm run build`. No
code involved — which is the point, because the people who revise lease language
are not the people who deploy the site.

One caveat: Word splits text into runs wherever formatting changes, and typing
inside an existing `{{placeholder}}` can split it so it stops matching. Type
placeholders in one go, and run `check-fields.py` afterwards — a split
placeholder disappears from the template's placeholder list, so the check
catches it.

## Adding a field

1. Type `{{group.field}}` where it belongs in the template.
2. Add an entry to `schema/fields.json` with its label, group, source and type
   (and `scope` for a manager field).
3. `python3 lease/tools/check-fields.py && node lease/tools/test-lease.mjs`

The check fails if a placeholder is unregistered (it would print as literal
`{{...}}` in a signed lease) or if a registered field no longer appears in the
template (it would collect data that goes nowhere).

## Adding a rider

Riders are just more pages in the same document: paste it in, replace its
repeated values with the placeholders that already exist, add placeholders for
anything genuinely new, register those, run the checks.

Every existing rider opens with the same sentence — `This Rider is incorporated
into the Lease entered on {{lease.effective_date}}, by and between
{{landlord.entity_name}} … {{tenant.names}} … {{property.address_full}}`. Reuse
it verbatim so a new rider stays consistent for free.

## How the .docx is written

A .docx is a ZIP of XML. `worker/zip.js` reads the entries, `worker/lease.js`
substitutes the placeholders in `word/document.xml`, and the archive is written
back out with only that one entry recompressed — every other entry, fonts and
images included, is copied across still compressed with its original CRC. No
library: `DecompressionStream`/`CompressionStream` are in the Workers runtime,
which is also how `site/admin/docx.js` already reads .docx in the browser.

Substitution is a plain string replace, which works only because every
placeholder sits inside a single run. `build-template.py` put them there and
`check-fields.py` notices if one is later split.

## Known gap: the flood disclosure

RPL § 231-b has required **two** things in every New York residential lease
since 21 June 2023: the FEMA flood-insurance notice, and a four-part disclosure
of the premises' flood history and risk (FEMA-designated floodplain; Special
Flood Hazard Area; moderate-risk area; prior flood damage).

This template carries the insurance notice, in the Renters Insurance Rider. It
does **not** carry the four-part history and risk disclosure. That is a gap in
the landlord's source form, not something the generator introduced, but every
lease produced here inherits it. Adding it is four building-scoped fields and a
short block in the template — worth having counsel confirm the wording first.

## Still to build

The template, the settings, and generation are done. Sending is not.

- **DocuSign.** Envelope with the tenants as the first routing order and the
  landlord countersigning. Two things block it: the template's ~40 signature and
  initial positions carry no anchor text for AutoPlace to find, and the
  application collects one name and one email while the lease has room for two
  tenants — DocuSign needs an address per signer.
- **One more application question.** The window guard notice offers "I want
  window guards even though I have no children 10 years of age or younger."
  `applications.children_under_11` answers the first half; nothing answers the
  second, so it falls to the agent.
- **A record of what was sent.** Settings changes are audited
  (`lease_settings_audit`), but the generated document is not stored anywhere.
  Once leases actually go out, the file and the exact values behind it should be
  kept.

`applications.status` already carries `lease_sent` and `lease_signed`, so the
flow has somewhere to land without a schema change.
