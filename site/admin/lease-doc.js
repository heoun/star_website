// The document half of the lease screen.
//
// It renders the lease ONCE — the raw template, placeholders and all — and then
// never renders again. Every keystroke afterwards writes into a text node.
//
// Rendering once is not an optimisation, it is a correctness requirement:
// docx-preview calls URL.createObjectURL and never revokes it, and exposes no
// cleanup API, so each render of this template strands 64 blob URLs for the
// life of the page. Ten renders leak 640. There is no debounce that fixes that.
//
//   *** Do not add a "refresh preview" button, and do not call mountDocument
//   *** twice for the same screen. Patch instead; that is what patchField is.
//
// The placeholders are turned into addressable spans by splitting the text
// nodes that contain them. That has to be done by splitting rather than by
// rewriting a run's text, because a run commonly holds prose AND a placeholder
// together — 67 of the template's 167 placeholder-bearing runs do — and
// rewriting would take the surrounding sentence with it.
//
// Anchoring through OOXML bookmarks was the obvious alternative and was
// rejected: docx-preview's parseHyperlink keeps only w:r children, so a
// bookmark inside a hyperlink is dropped without an error. tenant.email sits in
// one. Text nodes reach all 175 occurrences.

const TEMPLATE_PATH = "/admin/lease-template.docx";
const PLACEHOLDER = /\{\{([a-z0-9_.]+)\}\}/;

// A clause heading is the top level of one of Word's numbering lists, which
// docx-preview renders as class "docx-num-<id>-0", or a real Word heading style.
//
// The clause NUMBER is deliberately not shown. Word puts it in list numbering,
// which docx-preview renders as a CSS counter — getComputedStyle returns the
// expression "counter(docx-num-11-0)", never the resolved value — so a number
// here would have to be recounted by hand and would silently disagree with the
// document whenever Word restarts numbering. The clause NAME is unambiguous and
// is read straight from the text.
const CLAUSE_CLASS = /(?:^|\s)docx-num-\d+-0(?:\s|$)/;
const HEADING_CLASS = /(?:^|\s)docx_heading\d(?:\s|$)/;

let host = null;
let slotsByField = new Map();
let allSlots = [];
let sections = [];
let clauseMarks = [];

export function occurrenceCount(fieldId) {
  return slotsByField.get(fieldId)?.length || 0;
}

export function fieldsInDocument() {
  return [...slotsByField.keys()];
}

export function slotTotal() {
  return allSlots.length;
}

// ------------------------------------------------------------------ mounting

let renderer = null;

async function loadRenderer() {
  if (!renderer) renderer = await import("./vendor/docx-preview.min.mjs");
  return renderer;
}

// Renders the template into `container` and indexes every placeholder.
//
// Returns { slots, fields, sections, expected } so the caller can verify the
// index against the registry — see the check in lease-screen.js. A placeholder
// that Word split across two runs would simply not be found here, and a lease
// would then be produced with a value the screen never showed. That must be
// loud, never silent.
export async function mountDocument(container, { onSlotClick } = {}) {
  host = container;
  host.textContent = "";
  slotsByField = new Map();
  allSlots = [];
  sections = [];
  clauseMarks = [];

  const response = await fetch(TEMPLATE_PATH, { headers: { Accept: "*/*" } });
  if (!response.ok) {
    throw new Error(`The lease template could not be loaded (${response.status}).`);
  }
  const bytes = await response.arrayBuffer();

  const { renderAsync } = await loadRenderer();
  await renderAsync(bytes, host, null, {
    className: "docx",
    inWrapper: true,
    ignoreLastRenderedPageBreak: true,
    // Lays tab stops out where Word puts them instead of collapsing every tab
    // to one space. Roughly 200 lines of this document — every signature line,
    // the fine schedule, each "Date | Signature" caption — are tab-aligned, and
    // without this the preview reads as a different document from the .docx.
    experimental: true
  });

  // Before anything else that awaits: docx-preview starts laying its tab
  // stops out on a timer of its own as the render resolves, and this has to
  // be in place first.
  const origins = restoreTabOrigin();

  const patched = await patchRender(bytes);
  // docx-preview lays its tab stops out half a second after the render
  // resolves, from one measurement of the line, so nothing can be measured
  // against them before that.
  await new Promise((done) => setTimeout(done, TAB_LAYOUT_MS));
  alignFooterTabs();

  indexSections();
  wrapPlaceholders();
  indexPositions();
  remeasure();

  if (onSlotClick) {
    host.addEventListener("click", (event) => {
      const slot = event.target.closest("[data-lease-slot]");
      if (slot) onSlotClick(slot.dataset.leaseSlot, Number(slot.dataset.leaseOccurrence));
    });
  }

  return {
    fields: [...slotsByField.keys()],
    occurrences: allSlots.length,
    sections: sections.length,
    // The text of each rendered section, in order, so the caller can work out
    // where each document in the package begins. See shared/lease-documents.js.
    sectionTexts: sections.map((element) => element.textContent || ""),
    textBoxes: await countTextBoxes(bytes),
    tablesIndented: patched.tables,
    pagesNumbered: patched.pages,
    tabOrigins: origins
  };
}

// docx-preview measures where a tab starts from the paragraph's own left edge
// and then reads the stop positions as though they had been measured from the
// page margin — so a paragraph held an inch in from the margin lands every one
// of its left tab stops an inch further right than Word does. The paragraph
// that footnotes the smoking policy is held in the clause column and puts its
// text a quarter of an inch past the asterisk; unfixed, the sentence starts a
// third of the way across the page.
//
// Stating the indent as padding rather than margin puts the text in exactly
// the same column and leaves the box's left edge where the measurement assumes
// it is, so the pass comes out right without the vendored file being touched.
// Right-aligned stops — the footer — already measure from the margin and are
// unaffected either way.
function restoreTabOrigin() {
  let moved = 0;
  for (const paragraph of host.querySelectorAll("p")) {
    if (!paragraph.querySelector(".docx-tab-stop")) continue;
    // The indent is written as the margin-inline shorthand, so it has to be
    // read back computed rather than off the inline style.
    const style = getComputedStyle(paragraph);
    const indent = parseFloat(style.marginLeft);
    if (!indent || parseFloat(style.paddingLeft)) continue;
    // Padding sits inside a border or a fill and margin sits outside one, so
    // on a paragraph that draws either, moving the indent would move that too.
    if (style.borderLeftStyle !== "none" && parseFloat(style.borderLeftWidth)) continue;
    if (!TRANSPARENT.includes(style.backgroundColor)) continue;
    paragraph.style.marginLeft = "0px";
    paragraph.style.paddingLeft = `${indent}px`;
    moved += 1;
  }
  return moved;
}

const TRANSPARENT = ["rgba(0, 0, 0, 0)", "transparent"];

// -------------------------------------------------- what the renderer omits

// Two things the .docx says that docx-preview does not draw. Both are read
// back out of the document and applied once the render is done, rather than by
// patching the vendored renderer — which stays byte-identical to what npm
// publishes, so upgrading it is a straight copy. Both check that what they
// found lines up with what was drawn, and the screen shows a red banner if it
// does not; a preview that is quietly wrong about a lease is worse than one
// that says so.

async function patchRender(bytes) {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml").async("string");
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  return { tables: applyTableIndents(parsed), pages: applyPageNumbers(parsed) };
}

// docx-preview does not implement `w:tblInd`. Its parser reads a table indent
// the way a *paragraph* states one — `w:left` — and a table states it as
// `w:w`, so every table came out on the left margin while Word holds it in the
// same column as the clause it belongs to. A table that starts an inch left of
// the paragraph above it is the first thing anybody notices about this page.
//
// Tables render in document order and nothing outside the body produces one —
// no footer on this template holds one — so the two lists line up.

function applyTableIndents(parsed) {
  const indents = [...parsed.getElementsByTagNameNS(WORD_NS, "tbl")].map((table) => {
    const found = table.getElementsByTagNameNS(WORD_NS, "tblInd")[0];
    const twips = Number(found?.getAttributeNS(WORD_NS, "w") || 0);
    return Number.isFinite(twips) ? twips : 0;
  });

  const rendered = host.querySelectorAll("table");
  // The two lists must be the same length, or every indent after the first
  // mismatch lands on the wrong table.
  if (rendered.length !== indents.length) return false;

  for (let i = 0; i < rendered.length; i += 1) {
    if (indents[i]) rendered[i].style.marginLeft = `${indents[i] / 1440}in`;
  }
  return true;
}

// docx-preview cannot evaluate a field: it draws the number Word last cached,
// and one footer serves every page of a rider, so every page of the lease read
// "Page 1". The page a footer is on is the section it is on — every section
// break in this template is a page break — so the number is counted here the
// way Word counts it: up by one a section, back to `w:pgNumType`'s start where
// a rider begins.

// The renderer's tab pass measures the line once and comes up an eighth of an
// inch short on this footer — the same amount on every page, whatever the
// label says, and Word puts the same line flush against the column the text is
// justified to. The tab is the gap, so the gap absorbs the difference, which
// is easy to measure once the line is on the page. If the vendored renderer
// ever stops laying tab stops out on a timer this quietly does nothing, and
// the footer is an eighth of an inch short of the text above it.
const TAB_LAYOUT_MS = 700;
// 10834 twips of the 11400 the page gives the text: the column this document
// is justified to, measured in from the right margin.
const RIGHT_COLUMN_PX = ((11400 - 10834) / 1440) * 96;

function alignFooterTabs() {
  for (const page of host.querySelectorAll("section.docx")) {
    const paragraph = page.querySelector(":scope > footer p");
    const tab = paragraph?.querySelector(".docx-tab-stop");
    const last = paragraph?.lastElementChild;
    if (!tab || !last || last === tab) continue;

    const edge = page.getBoundingClientRect().right
      - parseFloat(getComputedStyle(page).paddingRight) - RIGHT_COLUMN_PX;
    const short = edge - last.getBoundingClientRect().right;
    if (Math.abs(short) < 0.5) continue;
    const gap = parseFloat(getComputedStyle(tab).wordSpacing) || 0;
    // Never past the line: one label is long enough to fill it in Word too.
    tab.style.wordSpacing = `${Math.max(0, gap + short)}px`;
  }
}

function applyPageNumbers(parsed) {
  let number = 0;
  const numbers = [...parsed.getElementsByTagNameNS(WORD_NS, "sectPr")]
    .filter((sect) => ["pPr", "body"].includes(sect.parentNode.localName))
    .map((sect) => {
      const restart = sect.getElementsByTagNameNS(WORD_NS, "pgNumType")[0]
        ?.getAttributeNS(WORD_NS, "start");
      number = restart ? Number(restart) : number + 1;
      return number;
    });

  const pages = host.querySelectorAll("section.docx");
  if (pages.length !== numbers.length) return false;

  for (let i = 0; i < pages.length; i += 1) {
    const footer = pages[i].querySelector(":scope > footer");
    if (!footer) continue;
    const digits = [...footer.querySelectorAll("span")]
      .filter((span) => /^\d+$/.test(span.textContent.trim()));
    // A page the form leaves unlabelled has a footer with nothing in it. Any
    // other count means the footer is not the one this was written for.
    if (digits.length === 0 && !/ - Page /.test(footer.textContent)) continue;
    if (digits.length !== 1) return false;
    digits[0].textContent = String(numbers[i]);
  }
  return true;
}

function indexSections() {
  sections = [...host.querySelectorAll("section.docx")];
  if (sections.length === 0) sections = [host.firstElementChild].filter(Boolean);
}

// "RENTAL UNIT. Landlord rents to Tenant…" -> "RENTAL UNIT"
function headingText(element) {
  const text = (element.textContent || "").trim();
  if (!text) return "";
  const stop = text.indexOf(".");
  const head = (stop > 0 ? text.slice(0, stop) : text).trim();
  return head.length >= 2 && head.length <= 60 ? head : "";
}

function isClause(element) {
  return element.tagName === "P"
    && (CLAUSE_CLASS.test(element.className) || HEADING_CLASS.test(element.className));
}

// One walk in document order labels every slot with the clause it sits under
// and the section it sits in, and collects the clause marks the header uses.
//
// It has to be a single ordered walk rather than a backwards search from each
// slot: a slot inside a table is several levels deep, and walking previous
// siblings upwards would step over the clause that precedes the table.
// docx-preview's own stylesheet sets `section.docx { position: relative }`, so
// a clause paragraph's offsetTop is measured from its own section — or from an
// enclosing table cell — never from the scroll container. The binary search
// below needs one origin for everything or it is searching unsorted numbers, so
// each mark carries a top accumulated up its offsetParent chain instead.
function absoluteTop(element) {
  let top = 0;
  for (let node = element; node && node !== host; node = node.offsetParent) {
    top += node.offsetTop;
  }
  return top;
}

// Zoom and the document filter both move everything. Re-measured rather than
// re-indexed: the marks and their headings do not change, only where they are.
export function remeasure() {
  for (const mark of clauseMarks) mark.top = absoluteTop(mark.element);
  sectionTops = sections.map((element) => absoluteTop(element));
}

let sectionTops = [];

function indexPositions() {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_ELEMENT);
  let heading = "";
  let section = 0;

  for (let element = walker.nextNode(); element; element = walker.nextNode()) {
    if (element.tagName === "SECTION" && element.classList.contains("docx")) {
      section = sections.indexOf(element);
      continue;
    }
    if (isClause(element)) {
      const text = headingText(element);
      if (text) {
        heading = text;
        clauseMarks.push({ element, heading, top: 0 });
      }
      continue;
    }
    if (element.dataset && element.dataset.leaseSlot !== undefined) {
      element.dataset.leaseHeading = heading;
      element.dataset.leaseSection = String(section);
    }
  }
}

function wrapPlaceholders() {
  // Collect first: splitText mutates the tree the walker is traversing.
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const candidates = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue && node.nodeValue.includes("{{")) candidates.push(node);
  }

  for (const start of candidates) {
    let current = start;
    let match;
    while (current && (match = PLACEHOLDER.exec(current.nodeValue || ""))) {
      // Cut the placeholder out of its text node: `middle` ends up holding
      // exactly "{{field.id}}" and `rest` holds whatever followed it.
      const middle = current.splitText(match.index);
      const rest = middle.splitText(match[0].length);

      const slot = document.createElement("span");
      slot.dataset.leaseSlot = match[1];
      slot.dataset.leaseOccurrence = String(allSlots.length);
      slot.className = "lease-slot";
      middle.parentNode.insertBefore(slot, middle);
      slot.appendChild(middle);
      middle.nodeValue = "";

      const list = slotsByField.get(match[1]) || [];
      slot.dataset.leaseIndex = String(list.length);
      list.push(slot);
      slotsByField.set(match[1], list);
      allSlots.push(slot);

      current = rest;
    }
  }

}

// ---------------------------------------------------------------- text boxes

// docx-preview renders no text boxes at all: Word wraps them in
// mc:AlternateContent/wps:txbx and its parser skips the whole branch. The
// template used to carry four — "THIS IS A BINDING CONTRACT. PLEASE READ IT
// CAREFULLY.", the bedbug disclosure title, and the SECTION A / SECTION B
// labels on the DHCR consent — and every one of them was clipped by its own
// box in Word too, because a text box does not grow with its text. They are
// bordered paragraphs now, which both Word and this preview draw.
//
// This counts what is left, which should be nothing. A preview that silently
// drops the words "this is a binding contract" is not one anybody should
// approve a lease from, so if a box ever comes back the screen says so.

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

async function countTextBoxes(bytes) {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml").async("string");
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  const boxes = [...parsed.getElementsByTagNameNS(WORD_NS, "txbxContent")];
  return boxes.filter((box) => (box.textContent || "").trim() !== "").length;
}

// -------------------------------------------------------------------- values

// An unanswered field shows its own name in the document, in red. It must never
// render as an empty gap: a blank line in a lease reads as a deliberate blank,
// and this screen exists so nobody signs one by accident.
function writeSlot(slot, text, missingLabel) {
  const unanswered = missingLabel !== null && missingLabel !== undefined;
  slot.firstChild.nodeValue = unanswered ? `«${missingLabel}»` : text;
  slot.classList.toggle("is-missing", unanswered);
  slot.classList.toggle("is-empty", !unanswered && text === "");
}

export function patchField(fieldId, text, missingLabel = null) {
  for (const slot of slotsByField.get(fieldId) || []) writeSlot(slot, text, missingLabel);
}

// Fills everything at once, for the first paint and after a save.
export function patchValues(values, missingLabels = {}) {
  for (const [fieldId, slots] of slotsByField) {
    const label = Object.prototype.hasOwnProperty.call(missingLabels, fieldId)
      ? missingLabels[fieldId]
      : null;
    const text = values[fieldId] ?? "";
    for (const slot of slots) writeSlot(slot, text, label);
  }
}

// ------------------------------------------------------- showing one document

// Which run of sections is on screen, or null for the whole package.
let shown = null;

// Collapses every section outside `from..to` instead of removing it.
//
// NOT display:none. This lease numbers its clauses with Word list numbering
// that docx-preview renders as CSS counters, and an element with no box does
// not increment a counter — hiding the first sixteen sections that way would
// renumber every clause of a rider shown on its own. A box of zero height
// still counts, so the numbering on screen stays the numbering in the .docx.
export function showSections(from, to) {
  shown = from === null || from === undefined ? null : { from, to };
  for (let i = 0; i < sections.length; i += 1) {
    const hide = shown !== null && (i < shown.from || i > shown.to);
    sections[i].toggleAttribute("data-doc-hidden", hide);
  }
  remeasure();
}

export function visibleSections() {
  return shown;
}

// Which section a field prints in — the first of them, when it prints in
// several. Used to open the right document before scrolling to a value.
export function sectionOfField(fieldId) {
  const slot = (slotsByField.get(fieldId) || [])[0];
  return slot ? Number(slot.dataset.leaseSection) : null;
}

// ---------------------------------------------------------------- navigation

let highlighted = [];

export function scrollToOccurrence(fieldId, index = 0) {
  const slots = slotsByField.get(fieldId) || [];
  if (slots.length === 0) return null;

  const slot = slots[Math.max(0, Math.min(index, slots.length - 1))];
  slot.scrollIntoView({ block: "center", behavior: "smooth" });

  // Every place the value prints lights up, not only the one scrolled to: a
  // tenant name is in the parties clause, the occupants clause and above the
  // signature line, and "show on the document" is asked about all of them.
  clearHighlight();
  for (const each of slots) each.classList.add("is-located");
  highlighted = slots.slice();

  return {
    occurrence: Number(slot.dataset.leaseIndex),
    total: slots.length,
    heading: slot.dataset.leaseHeading,
    section: Number(slot.dataset.leaseSection)
  };
}

export function clearHighlight() {
  for (const each of highlighted) each.classList.remove("is-located");
  highlighted = [];
}

// What the header shows: which section is at the top of the viewport, and the
// clause it belongs to. Sections are w:sectPr divisions, not paper pages — 44
// of this template's 55 are taller than a Letter page — so they are labelled as
// sections and paired with a clause name, never as "page N of 55".
//
// Binary search rather than a scan: this runs on every scroll frame, and
// measuring all 175 slots each time would read layout 175 times per frame.
function lastAtOrAbove(items, limit) {
  let low = 0;
  let high = items.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (items[mid].top <= limit) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

export function describePosition(viewport) {
  if (sections.length === 0) return { section: 0, total: 0, heading: "" };

  // A collapsed section is still in the flow at zero height, so offsetTop stays
  // in order and the search below stays valid. It must not be counted, though:
  // "section 3 of 46" while reading a rider on its own is not a position.
  const first = shown === null ? 0 : shown.from;
  const last = shown === null ? sections.length - 1 : shown.to;
  const onScreen = sectionTops.slice(first, last + 1).map((top) => ({ top }));

  const limit = viewport.scrollTop + 8;
  const clause = lastAtOrAbove(clauseMarks, limit);
  const section = lastAtOrAbove(onScreen, limit);

  return {
    section: Math.max(0, section) + 1,
    total: onScreen.length,
    heading: clause >= 0 ? clauseMarks[clause].heading : ""
  };
}

export function setShowSlots(on) {
  if (host) host.classList.toggle("show-slots", Boolean(on));
}
