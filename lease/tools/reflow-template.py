#!/usr/bin/env python3
"""One-off. Rewrites the parts of the template that were layout tricks, not text.

    python3 lease/tools/reflow-template.py

The lease came to us as a PDF and was converted to .docx. The converter had no
idea what a form is, so wherever the paper form put a label and its blank side
by side it reproduced the *picture*: a two-, three- or four-column section
break holding one paragraph per column, an enormous right indent to force a
line to end early, and a floating line shape drawn where the underline was.

Word draws that back almost correctly. Nothing else does, and neither does
Word once the values are longer than the ones the sample PDF was printed with:

  - Ten "continuous" section breaks split the bedbug disclosure across four
    pages and the DHCR consent across seven, each holding one line. Renderers
    start a new page at every section break, so the preview an agent reads
    before sending a lease looked nothing like the document.
  - `w:ind right="3773"` inside a table cell left about half an inch of usable
    width, so "Star Real Estate Management" printed one word per line.
  - A label and its value that the converter put in different columns landed
    on different baselines, and a value long enough to wrap pushed the next
    label onto the end of the wrapped line.

So this replaces the pictures with the thing they were pictures of: one
paragraph per line, tab stops instead of columns, and no right indent unless
the text genuinely stops early. Page breaks stay where the paper form has
them — every section break in the finished template is `nextPage`, which is
also the only kind a renderer gets right without implementing Word's column
model.

It also fills in the blanks the conversion left as bare punctuation. The Good
Cause notice's questions 3 and 4 read "…described above: ;" where the paper
form has a check box, so fifteen answers a landlord is required to give could
not be given at all.

Idempotent: every step looks for the shape it is about to replace and reports
nothing to do once it has run. Run it, then check-fields.py, then
test-lease.mjs.
"""

import json
import pathlib
import re
import shutil
import sys
import xml.etree.ElementTree as ET
import zipfile

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
WNS = "{%s}" % W
MCNS = "{%s}" % MC
WPNS = "{%s}" % WP
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"

ROOT = pathlib.Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "lease" / "template" / "lease-template.docx"

# w:pPr's children are a sequence, not a set: Word rejects a tab stop that
# comes after the indent it applies to. Anything not named here is appended.
PPR_ORDER = [
    "pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr",
    "widowControl", "numPr", "suppressLineNumbers", "pBdr", "shd", "tabs",
    "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct",
    "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd",
    "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents",
    "suppressOverlap", "jc", "textDirection", "textAlignment",
    "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr",
]

# The page is 12240 twips wide with 420-twip margins, so text runs 11400 wide
# and its middle — where the DBB-N form prints the answers — is at 5700.
PAGE_MIDDLE = 5700


def register_namespaces(xml_text):
    """Keep Word's own prefixes; ElementTree renames them to ns0/ns1 otherwise."""
    for prefix, uri in re.findall(r'xmlns:([A-Za-z0-9]+)="([^"]+)"', xml_text[:4000]):
        ET.register_namespace(prefix, uri)


# ------------------------------------------------------------------ reading

def own_text(node):
    """The text this paragraph prints, ignoring anything a text box holds.

    A text box is a whole document nested inside a run, so a plain walk would
    splice a page title out of the middle of the sentence around it. The
    paragraph's own properties are skipped for a subtler reason: `w:tab`
    declares a tab STOP inside `w:pPr/w:tabs` and a tab CHARACTER inside a run,
    and reading the first as the second puts tabs at the front of a paragraph
    that has none.
    """
    out = []

    def walk(element):
        for child in element:
            if child.tag in (WNS + "pPr", WNS + "rPr", MCNS + "AlternateContent",
                             WNS + "pict", WNS + "drawing"):
                continue
            if child.tag == WNS + "t":
                out.append(child.text or "")
            elif child.tag == WNS + "tab":
                out.append("\t")
            elif child.tag == WNS + "br":
                kind = child.get(WNS + "type")
                out.append("\n" if kind is None else "‖%s‖" % kind)
            else:
                walk(child)

    walk(node)
    return "".join(out)


def box_text(paragraph):
    """What the text boxes anchored to this paragraph say."""
    said = []
    for inner in paragraph.iter(WNS + "txbxContent"):
        said.append("".join(node.text or "" for node in inner.iter(WNS + "t")))
    return said


DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
FOOTER_TYPE = ("application/vnd.openxmlformats-officedocument"
               ".wordprocessingml.footer+xml")


class Package:
    """The .docx around word/document.xml.

    Most of this tool rewrites the body and nothing else. Two things cannot
    be said in the body alone — a footer is a part of its own, and the
    relationship the conversion left pointing at the sample tenant's email
    address lives in word/_rels/document.xml.rels — so those parts are handed
    around as text. They are a few one-line elements each; a parser would be
    more machinery than the job needs.
    """

    def __init__(self, entries):
        self.entries = entries
        self.rewritten = {}
        self.dropped = set()

    def names(self):
        return ([info.filename for info, _ in self.entries if info.filename not in self.dropped]
                + [name for name in self.rewritten
                   if name not in {info.filename for info, _ in self.entries}])

    def read(self, name):
        if name in self.rewritten:
            return self.rewritten[name].decode("utf-8")
        return next(data for info, data in self.entries
                    if info.filename == name).decode("utf-8")

    def write(self, name, text):
        self.rewritten[name] = text.encode("utf-8")
        self.dropped.discard(name)

    def drop(self, match):
        """Every part whose name matches, and its relationships file."""
        gone = {name for name in self.names() if match(name)}
        self.dropped |= gone
        for name in list(self.rewritten):
            if name in gone:
                del self.rewritten[name]
        return gone

    def relationships(self):
        return self.read("word/_rels/document.xml.rels")

    def link(self, target, kind):
        """The id of a relationship to `target`, adding one if it is new."""
        rels = self.relationships()
        found = re.search(r'<Relationship Id="([^"]+)"[^>]*Target="%s"'
                          % re.escape(target), rels)
        if found:
            return found.group(1)
        taken = {int(number) for number in re.findall(r'Id="rId(\d+)"', rels)}
        new = f"rId{max(taken) + 1}"
        rels = rels.replace("</Relationships>",
                            f'<Relationship Id="{new}" Type="{RELATIONSHIPS}/{kind}"'
                            f' Target="{target}"/></Relationships>')
        self.write("word/_rels/document.xml.rels", rels)
        return new

    def unlink(self, match):
        """Every relationship whose target matches, by id."""
        rels = self.relationships()
        gone = set()
        for id_, target in re.findall(r'<Relationship Id="([^"]+)"[^>]*Target="([^"]+)"', rels):
            if match(target):
                gone.add(id_)
                rels = re.sub(r'<Relationship Id="%s".*?/>' % re.escape(id_), "", rels)
        if gone:
            self.write("word/_rels/document.xml.rels", rels)
        return gone

    # Word writes an Override's two attributes in either order, so both of
    # these look the part up rather than matching an element it wrote.
    def content_type(self, name, kind):
        types = self.read("[Content_Types].xml")
        if f'PartName="/{name}"' in types:
            return
        self.write("[Content_Types].xml", types.replace(
            "</Types>", f'<Override ContentType="{kind}" PartName="/{name}"/></Types>'))

    def drop_content_types(self, match):
        def keep(element):
            named = re.search(r'PartName="/([^"]+)"', element.group(0))
            return "" if named and match(named.group(1)) else element.group(0)

        types = self.read("[Content_Types].xml")
        kept = re.sub(r"<Override [^>]*/>", keep, types)
        if kept != types:
            self.write("[Content_Types].xml", kept)

    def read_bytes(self, name):
        if name in self.rewritten:
            return self.rewritten[name]
        return next(data for info, data in self.entries if info.filename == name)

    def write_bytes(self, name, data):
        self.rewritten[name] = data
        self.dropped.discard(name)

    def save(self, path):
        known = {info.filename for info, _ in self.entries}
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as out:
            for info, data in self.entries:
                if info.filename in self.dropped:
                    continue
                out.writestr(info, self.rewritten.get(info.filename, data))
            for name, data in self.rewritten.items():
                if name not in known:
                    out.writestr(name, data)


class Doc:
    def __init__(self, root, package=None):
        self.root = root
        self.package = package
        self.body = root.find(WNS + "body")
        self.reindex()

    def reindex(self):
        def walk(node):
            for child in node:
                if child.tag == WNS + "p":
                    yield child
                elif child.tag == WNS + "tbl":
                    for row in child.findall(WNS + "tr"):
                        for cell in row.findall(WNS + "tc"):
                            yield from walk(cell)

        self.paragraphs = list(walk(self.body))
        self.parents = {child: parent for parent in self.root.iter() for child in parent}

    def _one(self, hits, what):
        """Ambiguity here is a bug in this tool, not a coin to flip."""
        if len(hits) > 1:
            raise SystemExit(f"{len(hits)} paragraphs match {what!r}; refusing to guess")
        return hits[0] if hits else None

    def find(self, text):
        return self._one([p for p in self.paragraphs if own_text(p) == text], text)

    def find_all(self, text):
        return [p for p in self.paragraphs if own_text(p) == text]

    def find_after(self, anchor, text):
        """The first paragraph after `anchor` saying this. Two forms on this
        document print the tenant's name into a column of their own, so the
        text alone does not say which one is meant."""
        start = self.paragraphs.index(anchor)
        return next((p for p in self.paragraphs[start + 1:] if own_text(p) == text), None)

    def containing(self, text):
        return self._one([p for p in self.paragraphs if text in own_text(p)], text)

    def find_box(self, text):
        return self._one([p for p in self.paragraphs
                          if any(text in said for said in box_text(p))], text)

    def after(self, paragraph):
        index = self.paragraphs.index(paragraph)
        return self.paragraphs[index + 1] if index + 1 < len(self.paragraphs) else None

    def remove(self, paragraph):
        self.parents[paragraph].remove(paragraph)

    def insert_after(self, paragraph, new):
        parent = self.parents[paragraph]
        parent.insert(list(parent).index(paragraph) + 1, new)
        self.reindex()


# ------------------------------------------------------------------ writing

def properties(paragraph):
    found = paragraph.find(WNS + "pPr")
    if found is None:
        found = ET.Element(WNS + "pPr")
        paragraph.insert(0, found)
    return found


def set_property(paragraph, name, attributes=None, children=None):
    """Replace one w:pPr child, keeping the schema's element order."""
    pPr = properties(paragraph)
    for existing in pPr.findall(WNS + name):
        pPr.remove(existing)

    if attributes is None and children is None:
        return

    element = ET.Element(WNS + name)
    for key, value in (attributes or {}).items():
        element.set(WNS + key, str(value))
    for child in children or []:
        element.append(child)

    rank = PPR_ORDER.index(name) if name in PPR_ORDER else len(PPR_ORDER)
    position = len(pPr)
    for index, existing in enumerate(pPr):
        tag = existing.tag.split("}")[-1]
        other = PPR_ORDER.index(tag) if tag in PPR_ORDER else len(PPR_ORDER)
        if other > rank:
            position = index
            break
    pPr.insert(position, element)


# w:rPr's children are a sequence as well.
RPR_ORDER = [
    "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike",
    "dstrike", "outline", "shadow", "emboss", "imprint", "noProof",
    "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern",
    "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd",
    "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout",
    "specVanish", "oMath",
]


def set_run_property(run, name, attributes):
    """Replace one w:rPr child, keeping the schema's element order."""
    rPr = run.find(WNS + "rPr")
    if rPr is None:
        rPr = ET.Element(WNS + "rPr")
        run.insert(0, rPr)
    for existing in rPr.findall(WNS + name):
        rPr.remove(existing)

    element = ET.Element(WNS + name)
    for key, value in attributes.items():
        element.set(WNS + key, str(value))

    rank = RPR_ORDER.index(name) if name in RPR_ORDER else len(RPR_ORDER)
    position = len(rPr)
    for index, existing in enumerate(rPr):
        tag = existing.tag.split("}")[-1]
        other = RPR_ORDER.index(tag) if tag in RPR_ORDER else len(RPR_ORDER)
        if other > rank:
            position = index
            break
    rPr.insert(position, element)


def set_indent(paragraph, **values):
    set_property(paragraph, "ind", dict(values))


def set_tabs(paragraph, stops):
    """stops: [(alignment, twips), …]. An empty list removes the tab stops."""
    if not stops:
        set_property(paragraph, "tabs")
        return
    children = []
    for alignment, position in stops:
        tab = ET.Element(WNS + "tab")
        tab.set(WNS + "val", alignment)
        tab.set(WNS + "leader", "none")
        tab.set(WNS + "pos", str(position))
        children.append(tab)
    set_property(paragraph, "tabs", children=children)


# Enough that two rules side by side read as two.
RULE_GAP = 160


def rule_columns(index, position, widths, rule_row, rules):
    """Whether this cell is a rule, and whether another rule follows it."""
    drawn = index == rule_row or (index, position) in rules
    if not drawn:
        return False, False
    following = (index == rule_row and position + 1 < len(widths)) \
        or (index, position + 1) in rules
    return True, following


def make_table(model, rows, widths, *, indent=0, rule_row=None, rules=()):
    """A borderless table. Two renderers agree on a table; they do not always
    agree on a tab stop, and a form is only useful if its columns line up.

    `rule_row` underlines a whole row; `rules` takes (row, column) pairs, for
    the blocks where only one column is a line to write on.
    """
    rules = set(rules)
    table = ET.Element(WNS + "tbl")
    pr = ET.SubElement(table, WNS + "tblPr")
    width = ET.SubElement(pr, WNS + "tblW")
    width.set(WNS + "w", str(sum(widths)))
    width.set(WNS + "type", "dxa")
    if indent:
        left = ET.SubElement(pr, WNS + "tblInd")
        left.set(WNS + "w", str(indent))
        left.set(WNS + "type", "dxa")
    # w:tblPr's children are a sequence as well: borders before the layout.
    borders = ET.SubElement(pr, WNS + "tblBorders")
    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
        line = ET.SubElement(borders, WNS + side)
        line.set(WNS + "val", "none")
        line.set(WNS + "sz", "0")
        line.set(WNS + "space", "0")
    layout = ET.SubElement(pr, WNS + "tblLayout")
    layout.set(WNS + "type", "fixed")
    # The converter's own tables set these to zero in their style, so a cell
    # built here starts its text where one of those does: on the table's edge.
    margins = ET.SubElement(pr, WNS + "tblCellMar")
    for side in ("top", "left", "bottom", "right"):
        element = ET.SubElement(margins, WNS + side)
        element.set(WNS + "w", "0")
        element.set(WNS + "type", "dxa")

    grid = ET.SubElement(table, WNS + "tblGrid")
    for column in widths:
        ET.SubElement(grid, WNS + "gridCol").set(WNS + "w", str(column))

    for index, cells in enumerate(rows):
        row = ET.SubElement(table, WNS + "tr")
        for position, (column, runs) in enumerate(zip(widths, cells)):
            cell = ET.SubElement(row, WNS + "tc")
            cellPr = ET.SubElement(cell, WNS + "tcPr")
            size = ET.SubElement(cellPr, WNS + "tcW")
            size.set(WNS + "w", str(column))
            size.set(WNS + "type", "dxa")
            paragraph = ET.SubElement(cell, WNS + "p")
            set_property(paragraph, "jc", {"val": "center"})
            set_indent(paragraph, left=0, right=0, firstLine=0)
            # The rule belongs to the paragraph, not the cell: two cells side
            # by side share an edge, and two signature lines must not. The gap
            # between them is the paragraph's own, so it does not depend on
            # what a renderer thinks a cell's margins are — and the last rule
            # of a row has nothing to separate itself from, so it runs the
            # whole width it was given.
            drawn, following = rule_columns(index, position, widths,
                                            rule_row, rules)
            if drawn:
                set_property(paragraph, "pBdr",
                             children=[edge("bottom", size="6")])
                set_indent(paragraph, left=0,
                           right=RULE_GAP if following else 0, firstLine=0)
            if model is not None:
                rPr = model.find(WNS + "rPr")
                if rPr is not None:
                    properties(paragraph).append(ET.fromstring(ET.tostring(rPr)))
            for run in runs:
                paragraph.append(run)
    return table


def section(paragraph):
    pPr = paragraph.find(WNS + "pPr")
    return pPr.find(WNS + "sectPr") if pPr is not None else None


def move_section(source, target):
    """A section break belongs to the last paragraph of its section."""
    sect = section(source)
    if sect is None:
        return
    source.find(WNS + "pPr").remove(sect)
    properties(target).append(sect)


def content(paragraph):
    """The paragraph's runs and hyperlinks — everything except its properties."""
    return [child for child in paragraph if child.tag != WNS + "pPr"]


def set_content(paragraph, runs):
    for child in content(paragraph):
        paragraph.remove(child)
    for run in runs:
        paragraph.append(run)


def clone_run(model, *, text=None, tab=False, underline=None):
    """A new run wearing `model`'s character formatting."""
    run = ET.Element(WNS + "r")
    rPr = model.find(WNS + "rPr") if model is not None else None
    if rPr is not None:
        copied = ET.fromstring(ET.tostring(rPr))
        if underline is not None:
            for existing in copied.findall(WNS + "u"):
                copied.remove(existing)
            element = ET.Element(WNS + "u")
            element.set(WNS + "val", "single" if underline else "none")
            copied.append(element)
        run.append(copied)
    if tab:
        run.append(ET.Element(WNS + "tab"))
    if text is not None:
        node = ET.SubElement(run, WNS + "t")
        node.set(XML_SPACE, "preserve")
        node.text = text
    return run


def runs_of(paragraph):
    return [child for child in content(paragraph) if child.tag == WNS + "r"]


def first_run(paragraph):
    found = runs_of(paragraph)
    return found[0] if found else None


def take(paragraph, text):
    """Whatever prints exactly this text, detached from its paragraph.

    A hyperlink rather than a run, sometimes: the tenant's email address is a
    mailto link, and lifting the run out of it would drop the link.
    """
    for child in content(paragraph):
        if own_text(child) == text:
            paragraph.remove(child)
            return child
    raise SystemExit(f"nothing says {text!r} in {own_text(paragraph)!r}")


def blank_like(paragraph):
    """An empty paragraph carrying this one's formatting, minus its section."""
    new = ET.Element(WNS + "p")
    pPr = paragraph.find(WNS + "pPr")
    if pPr is not None:
        copied = ET.fromstring(ET.tostring(pPr))
        for sect in copied.findall(WNS + "sectPr"):
            copied.remove(sect)
        new.append(copied)
    return new


def split_at(doc, paragraph, index):
    """Splits a paragraph after `index` runs; the tail becomes the next one."""
    tail = blank_like(paragraph)
    move_section(paragraph, tail)
    for child in content(paragraph)[index:]:
        paragraph.remove(child)
        tail.append(child)
    doc.insert_after(paragraph, tail)
    return tail


def drop_breaks(paragraph, kind="column"):
    """Removes column breaks, and any run left holding nothing."""
    for run in list(runs_of(paragraph)):
        for br in run.findall(WNS + "br"):
            if br.get(WNS + "type") == kind:
                run.remove(br)
        if not [c for c in run if c.tag != WNS + "rPr"]:
            paragraph.remove(run)


def strip_leading_tabs(paragraph):
    """Drops the tab characters a paragraph opens with, and any empty run."""
    for run in list(runs_of(paragraph)):
        text = own_text(run)
        if text.strip():
            return
        for tab in run.findall(WNS + "tab"):
            run.remove(tab)
        if not [c for c in run if c.tag != WNS + "rPr"]:
            paragraph.remove(run)


def drop_tabs(paragraph):
    for run in runs_of(paragraph):
        for tab in run.findall(WNS + "tab"):
            run.remove(tab)


def drop_drawings(paragraph):
    """Removes floating shapes. Text boxes stay: they carry real text."""
    for run in list(runs_of(paragraph)):
        for child in list(run):
            if child.tag in (MCNS + "AlternateContent", WNS + "drawing", WNS + "pict"):
                if child.find(".//" + WNS + "txbxContent") is None:
                    run.remove(child)
        if not [c for c in run if c.tag != WNS + "rPr"]:
            paragraph.remove(run)



# w:tblPr's children are a sequence too.
TBLPR_ORDER = [
    "tblStyle", "tblpPr", "tblOverlap", "bidiVisual", "tblStyleRowBandSize",
    "tblStyleColBandSize", "tblW", "jc", "tblCellSpacing", "tblInd",
    "tblBorders", "shd", "tblLayout", "tblCellMar", "tblLook", "tblCaption",
    "tblDescription",
]


def cells_of(table):
    for row in table.findall(WNS + "tr"):
        for cell in row.findall(WNS + "tc"):
            yield row, cell


# w:tcPr's children are a sequence too, and Word is as strict about this one.
TCPR_ORDER = [
    "cnfStyle", "tcW", "gridSpan", "hMerge", "vMerge", "tcBorders", "shd",
    "noWrap", "tcMar", "textDirection", "tcFitText", "vAlign", "hideMark",
]


def cell_properties(cell):
    found = cell.find(WNS + "tcPr")
    if found is None:
        found = ET.Element(WNS + "tcPr")
        cell.insert(0, found)
    return found


def edge(side, kind="single", size="4"):
    element = ET.Element(WNS + side)
    element.set(WNS + "val", kind)
    element.set(WNS + "sz", "0" if kind == "nil" else size)
    element.set(WNS + "space", "0")
    element.set(WNS + "color", "000000")
    return element


def set_cell_borders(cell, **sides):
    """sides: top/left/bottom/right, each "single" or "nil".

    Both renderers read a cell's own borders, and only one of them reads
    `w:insideH`/`w:insideV`, so anything that has to look the same in the
    preview and the .docx is stated on the cell.
    """
    pr = cell_properties(cell)
    for existing in pr.findall(WNS + "tcBorders"):
        pr.remove(existing)

    borders = ET.Element(WNS + "tcBorders")
    for side in ("top", "left", "bottom", "right"):
        if side in sides:
            borders.append(edge(side, sides[side]))

    rank = TCPR_ORDER.index("tcBorders")
    position = len(pr)
    for index, existing in enumerate(pr):
        tag = existing.tag.split("}")[-1]
        other = TCPR_ORDER.index(tag) if tag in TCPR_ORDER else len(TCPR_ORDER)
        if other > rank:
            position = index
            break
    pr.insert(position, borders)


def type_size(run):
    rPr = run.find(WNS + "rPr")
    found = rPr.find(WNS + "sz") if rPr is not None else None
    return found.get(WNS + "val") if found is not None else None


def underlined_tab(run):
    """A rule the converter drew by underlining a tab character."""
    rPr = run.find(WNS + "rPr")
    underline = rPr.find(WNS + "u") if rPr is not None else None
    return (underline is not None
            and underline.get(WNS + "val") not in (None, "none")
            and run.find(WNS + "tab") is not None)


def ancestor(doc, node, tag):
    while node in doc.parents:
        node = doc.parents[node]
        if node.tag == tag:
            return node
    return None


def empty_boxes_only(paragraph):
    """True when everything this paragraph holds is a text box with no text.

    The converter drew a good many rules as a text box with a bottom border
    and nothing in it. Word floats them; a renderer that does not gives each
    one a line of its own, and the rule lands nowhere near what it belongs to.
    """
    if own_text(paragraph).strip():
        return False
    boxes = list(paragraph.iter(WNS + "txbxContent"))
    if not boxes:
        return False
    return not any(box_text(paragraph))


# ------------------------------------------------------------------- fixes


def fix_sections(doc):
    """One page per page of the paper form, and every break a page break.

    A "continuous" section break is how the converter opened a set of columns
    and closed it again. Nothing here needs columns any more, so those breaks
    go; the two that end a form keep a break but become `nextPage`, which is
    where the paper form ends the page.
    """
    # Each of these paragraphs carries a break that cuts a one-page form in
    # half. They are named by what they say, because paragraph numbers move.
    drop = [
        "‖column‖{{tenant.names}}",
        "‖column‖{{property.state_abbr}}\t{{property.zip}}",
        "Number/Street\tApt. No\tCity, State, Zip Code",
        "(print name)",
        "‖column‖{{dhcr.mark_renewal}}\tRenewal lease",
        "‖column‖{{tenant.email}}",
    ]
    # The break that cuts the bedbug disclosure in two sits on a blank
    # paragraph, so it has to be found by what comes before it.
    drop_after = [
        "Pursuant to the NYC Housing Maintenance Code, an owner/managing agent"
        " of residential rental property shall furnish to each tenant signing a"
        " vacancy lease a notice that sets forth the property’s bedbug"
        " infestation history.",
    ]
    # And these two end a form: keep the break, make it a page break.
    close = [
        "DBB-N (DHCR 10/10)",
        "Date\tTenant Signature(s) (Ink or Electronic)",
    ]

    changed = 0
    for text in drop:
        for paragraph in doc.find_all(text):
            if section(paragraph) is not None:
                set_property(paragraph, "sectPr")
                changed += 1

    for text in drop_after:
        anchor = doc.find(text)
        if anchor is None:
            continue
        start = doc.paragraphs.index(anchor) + 1
        for paragraph in doc.paragraphs[start:start + 3]:
            if section(paragraph) is not None:
                set_property(paragraph, "sectPr")
                changed += 1
                break

    # Some of the removed breaks were closed by an empty one-column section
    # whose only job was to end the columns above it.
    for paragraph in doc.paragraphs:
        sect = section(paragraph)
        if sect is None or own_text(paragraph).strip():
            continue
        kind = sect.find(WNS + "type")
        if kind is not None and kind.get(WNS + "val") == "continuous":
            set_property(paragraph, "sectPr")
            changed += 1

    for text in close:
        paragraph = doc.find(text)
        sect = section(paragraph) if paragraph is not None else None
        if sect is None:
            continue
        kind = sect.find(WNS + "type")
        if kind is None:
            kind = ET.Element(WNS + "type")
            sect.insert(0, kind)
        if kind.get(WNS + "val") != "nextPage":
            kind.set(WNS + "val", "nextPage")
            changed += 1

    doc.reindex()
    return changed


def fix_payment_details(doc):
    """Clause 5.E: name, address and phone, one per line (item 1)."""
    paragraph = doc.find("Address: {{payee.address}} Phone: {{payee.phone}}")
    if paragraph is None:
        return 0

    cut = next(i for i, r in enumerate(content(paragraph)) if own_text(r).strip() == "Phone:")
    tail = split_at(doc, paragraph, cut)
    for node in tail.iter(WNS + "t"):
        if node.text == " Phone: ":
            node.text = "Phone: "

    for part in (doc.find("Name: {{payee.name}}"), paragraph, tail):
        set_indent(part, left=1308, right=0, firstLine=0)
        set_property(part, "jc", {"val": "left"})
    return 1


def fix_notice_table(doc):
    """Clause 25's two address cells (item 2).

    Each paragraph carried `right="3773"` — measured against the sample
    lease's short values, and about half an inch of usable width once the cell
    also has to hold a company name.
    """
    changed = 0
    for who in ("manager", "legal_notice"):
        for label in ("Name", "Address", "Phone"):
            paragraph = doc.find(f"{label}: {{{{{who}.{label.lower()}}}}}")
            if paragraph is None:
                continue
            indent = properties(paragraph).find(WNS + "ind")
            if indent is not None and indent.get(WNS + "right") == "0":
                continue
            set_indent(paragraph, left=108, right=0, firstLine=0)
            changed += 1
    return changed


def fix_key_table(doc):
    """The Key Rider's quantity and charge columns, centred (item 3).

    Only the cells that happened to hold a value in the sample were centred;
    the empty ones kept whatever indent the converter measured, so a filled
    lease showed "0" in the middle of its column and the row below it hard
    against the left edge.
    """
    changed = 0
    targets = ["Key Description", "Quantity Issued", "Replacement Charge per Key or FOB"]
    targets += [f"{{{{key.{row}_{column}}}}}"
                for row in ("unit", "building", "mailbox", "fob", "garage", "other")
                for column in ("qty", "charge")]

    for text in targets:
        paragraph = doc.find(text)
        if paragraph is None:
            continue
        indent = properties(paragraph).find(WNS + "ind")
        centred = properties(paragraph).find(WNS + "jc")
        if indent is not None and indent.get(WNS + "left") == "0" \
                and centred is not None and centred.get(WNS + "val") == "center":
            continue
        set_indent(paragraph, left=0, right=0, firstLine=0)
        set_property(paragraph, "jc", {"val": "center"})
        changed += 1
    return changed


def fix_window_guards(doc):
    """The window guard notice: one answer per line (item 4)."""
    changed = 0

    both = doc.find("{{window_guard.mark_has_children}} Children 10 years of age"
                    " or younger live in my apartment."
                    " {{window_guard.mark_no_children}} No children 10 years of"
                    " age or younger live in my apartment.")
    if both is not None:
        cut = next(i for i, r in enumerate(content(both))
                   if "{{window_guard.mark_no_children}}" in own_text(r))
        tail = split_at(doc, both, cut)
        for node in both.iter(WNS + "t"):
            if node.text and node.text.endswith("apartment. "):
                node.text = node.text.rstrip()
        for part in (both, tail):
            set_indent(part, left=502, right=0, firstLine=0)
        changed += 1

    address = doc.find("Tenant’s Address: {{property.address_full}}"
                       "\tApartment Number: {{property.unit}}")
    if address is not None:
        cut = next(i for i, r in enumerate(content(address))
                   if "Apartment Number:" in own_text(r))
        tail = split_at(doc, address, cut)
        drop_tabs(tail)
        for part in (address, tail):
            set_tabs(part, [])
            set_indent(part, left=299, right=0, firstLine=0)
        changed += 1

    return changed


def fix_bedbug_form(doc):
    """The DBB-N disclosure: one page, each answer beside its label (item 5).

    The converter put every label in column one of a section and its answer in
    column two, which is why the preview showed four pages with a single line
    at the top of each. Here each pair is one paragraph with a centre tab stop,
    which is where the paper form prints the answer.
    """
    changed = 0

    name = doc.find("Name of tenant(s):")
    names = doc.find_after(name, "‖column‖{{tenant.names}}") if name is not None else None
    if name is not None and names is not None:
        label = first_run(name)
        set_content(name, [label,
                           clone_run(label, tab=True),
                           take(names, "{{tenant.names}}")])
        doc.remove(names)
        set_tabs(name, [("center", PAGE_MIDDLE)])
        set_indent(name, left=319, right=0, firstLine=0)
        doc.reindex()
        changed += 1

    premises = doc.find("Subject Premises:")
    street = doc.find("‖column‖{{property.street}} Unit {{property.unit}},")
    city = doc.find("{{property.city}}")
    state = doc.find("‖column‖{{property.state_abbr}}\t{{property.zip}}")
    if None not in (premises, street, city, state):
        label = first_run(premises)
        set_content(premises, [
            label,
            clone_run(label, tab=True),
            take(street, "{{property.street}}"),
            clone_run(label, text=" Unit ", underline=False),
            take(street, "{{property.unit}}"),
            clone_run(label, text=", ", underline=False),
            take(city, "{{property.city}}"),
            clone_run(label, text=", ", underline=False),
            take(state, "{{property.state_abbr}}"),
            clone_run(label, text=" ", underline=False),
            take(state, "{{property.zip}}"),
        ])
        for gone in (street, city, state):
            doc.remove(gone)
        set_tabs(premises, [("center", PAGE_MIDDLE)])
        set_indent(premises, left=319, right=0, firstLine=0)
        doc.reindex()
        changed += 1

    apartment = doc.find("Apt. #:                                    {{property.unit}}")
    if apartment is not None:
        label = first_run(apartment)
        for node in label.iter(WNS + "t"):
            node.text = "Apt. #:"
        set_content(apartment, [label,
                                clone_run(label, tab=True),
                                take(apartment, "{{property.unit}}")])
        set_tabs(apartment, [("center", PAGE_MIDDLE)])
        set_indent(apartment, left=319, right=0, firstLine=0)
        changed += 1

    # The date of the vacancy lease is the one answer on this form the
    # application cannot supply, so it gets the same treatment as the rest:
    # a labelled blank in the same column, not a line of prose.
    vacancy = doc.find("Date of vacancy lease: {{lease.vacancy_lease_date}}")
    if vacancy is not None:
        value = take(vacancy, "{{lease.vacancy_lease_date}}")
        label = take(vacancy, "Date of vacancy lease: ")
        for node in label.iter(WNS + "t"):
            node.text = "Date of vacancy lease:"
        # A shape as tall as the page is anchored here, drawing the border the
        # paper form has around it. Word floats it; a renderer that does not
        # implement floating gives it a line of its own and pushes ten inches
        # of blank paper into the middle of the form. The border goes.
        set_content(vacancy, [label, clone_run(label, tab=True), value])
        set_tabs(vacancy, [("center", PAGE_MIDDLE)])
        set_indent(vacancy, left=319, right=0, firstLine=0)
        changed += 1

    # Every answer starts in the same place, whatever the converter measured.
    # "Other:" put its label at a tab stop of its own, so it started in a
    # different place from the five answers above it. A space does the job; the
    # tab AFTER it stays, because that one is the blank to write on.
    other = doc.find("{{bedbug.mark_other}}\tOther:\t.")
    if other is not None:
        mark = take(other, "{{bedbug.mark_other}}")
        rest = content(other)
        for run in rest:
            tabs = run.findall(WNS + "tab")
            if tabs and own_text(run).startswith("\t"):
                run.remove(tabs[0])
                break
        set_content(other, [mark, clone_run(mark, text=" ", underline=False)] + rest)
        # The blank ends where the "floor(s)" blanks above it end. Running it
        # to the margin left no room for the full stop after it and wrapped the
        # line, which put the check box on a line of its own.
        set_tabs(other, [("left", 8600)])
        changed += 1

    for answer in ("mark_none", "mark_building_eradicated",
                   "mark_building_not_eradicated", "mark_apartment_eradicated",
                   "mark_apartment_not_eradicated", "mark_other"):
        paragraph = doc.containing(f"{{{{bedbug.{answer}}}}}")
        if paragraph is None:
            continue
        indent = properties(paragraph).find(WNS + "ind")
        if indent is not None and indent.get(WNS + "left") == "759" \
                and indent.get(WNS + "right") == "0":
            continue
        strip_leading_tabs(paragraph)
        set_indent(paragraph, left=759, right=0, hanging=439)
        set_property(paragraph, "jc", {"val": "left"})
        changed += 1

    title = doc.find_box("DISCLOSURE OF BEDBUG INFESTATION HISTORY")
    if title is not None:
        inside = [p for inner in title.iter(WNS + "txbxContent")
                  for p in inner.iter(WNS + "p")]
        if any((properties(p).find(WNS + "jc") is None
                or properties(p).find(WNS + "jc").get(WNS + "val") != "center")
               for p in inside):
            for paragraph in inside:
                set_indent(paragraph, left=0, right=0, firstLine=0)
                set_property(paragraph, "jc", {"val": "center"})
            changed += 1

    return changed


def fix_sprinkler(doc):
    """The sprinkler notice's two options start in the same place (item 6)."""
    paragraph = doc.find("{{sprinkler.mark_option1}} Option 1:")
    if paragraph is None:
        return 0
    indent = properties(paragraph).find(WNS + "ind")
    if indent is not None and indent.get(WNS + "left") == "108":
        return 0
    set_indent(paragraph, left=108, right=0, firstLine=0)
    return 1


def fix_gas_provider(doc):
    """The gas provider's name and number, with their captions under them (item 7)."""
    paragraph = doc.find("  {{gas.provider_name}}\t\t{{gas.provider_phone}}"
                         "\t Provider\t\t\tNumber")
    if paragraph is None:
        return 0

    label = first_run(paragraph)
    table = make_table(label, [
        [[take(paragraph, "{{gas.provider_name}}")],
         [take(paragraph, "{{gas.provider_phone}}")]],
        [[clone_run(label, text="Provider", underline=False)],
         [clone_run(label, text="Number", underline=False)]],
    ], [4800, 3400], indent=1320, rule_row=0)

    # A table cannot carry a section break, and this paragraph ends a section,
    # so it stays behind — emptied — to hold it.
    set_content(paragraph, [])
    set_tabs(paragraph, [])
    set_indent(paragraph, left=1320, right=0, firstLine=0)
    parent = doc.parents[paragraph]
    parent.insert(list(parent).index(paragraph), table)
    doc.reindex()
    return 1


def fix_consent_title(doc):
    """The DHCR form's title, as a heading rather than a text box (item 9).

    The box is 0.37 inch tall and the title needs more, so Word printed the top
    half of the letters and clipped the rest.
    """
    paragraph = doc.find_box("Electronic Lease Offer")
    if paragraph is None:
        return 0

    # Two copies of the box are stored, one for renderers that understand
    # Word's shape format and a fallback for those that do not. The first is
    # EMPTY, which is why Word — which reads the first — printed no title here.
    kept = []
    for inner in paragraph.iter(WNS + "txbxContent"):
        kept = [ET.fromstring(ET.tostring(run))
                for child in inner.iter(WNS + "p") for run in runs_of(child)]
        if kept:
            break
    if not kept:
        return 0

    heading = doc.find("General Instructions")
    if heading is not None:
        paragraph.remove(paragraph.find(WNS + "pPr"))
        paragraph.insert(0, ET.fromstring(ET.tostring(heading.find(WNS + "pPr"))))
    set_content(paragraph, kept)
    set_indent(paragraph, left=0, right=0, firstLine=0)
    set_property(paragraph, "jc", {"val": "center"})
    return 1


# The DHCR consent is a form of its own bound into the lease, and its text
# starts 300 twips in rather than in the lease's clause column.
CONSENT_LEFT = 300


def fix_consent_section_a(doc):
    """Section A of the DHCR consent, one line per field (item 10)."""
    changed = 0

    offered = doc.find("Lease Offered to Tenant(s):")
    names = doc.find_after(offered, "‖column‖{{tenant.names}}") if offered is not None else None
    empty = doc.find("‖column‖")
    caption = doc.find("(print name)")
    if None not in (offered, names, caption):
        label = first_run(offered)
        set_content(offered, [label,
                              clone_run(label, tab=True),
                              take(names, "{{tenant.names}}")])
        doc.remove(names)
        if empty is not None:
            doc.remove(empty)
        set_tabs(offered, [("left", 3400)])
        set_indent(offered, left=CONSENT_LEFT, right=0, firstLine=0)

        mark = first_run(caption)
        set_content(caption, [clone_run(mark, tab=True), mark])
        set_tabs(caption, [("left", 3400)])
        set_indent(caption, left=CONSENT_LEFT, right=0, firstLine=0)
        doc.reindex()
        changed += 1

    description = doc.find("Lease Description: (Please select only one)")
    vacancy = doc.find("‖column‖{{dhcr.mark_vacancy}}")
    vacancy_label = doc.find("‖column‖Vacancy lease")
    renewal = doc.find("‖column‖{{dhcr.mark_renewal}}\tRenewal lease")
    if None not in (description, vacancy, vacancy_label, renewal):
        # The mark and the tab that followed it share a run.
        drop_tabs(renewal)
        label = first_run(description)
        set_content(description, [
            label,
            clone_run(label, tab=True),
            take(vacancy, "{{dhcr.mark_vacancy}}"),
            clone_run(label, text=" Vacancy lease", underline=False),
            clone_run(label, tab=True),
            take(renewal, "{{dhcr.mark_renewal}}"),
            clone_run(label, text=" Renewal lease", underline=False),
        ])
        for gone in (vacancy, vacancy_label, renewal):
            doc.remove(gone)
        set_tabs(description, [("left", 4300), ("left", 7800)])
        set_indent(description, left=299, right=0, firstLine=0)
        doc.reindex()
        changed += 1

    # Three lines end with a tab that draws a rule to the right margin. The
    # value is underlined already, and the rule pushed the value onto a second
    # line as soon as it was longer than the sample's. Section B says the same
    # three things without one.
    for field in ("owner_rep.name", "owner_rep.email", "owner_rep.mailing_address"):
        paragraph = doc.containing(f"{{{{{field}}}}}")
        if paragraph is None or not own_text(paragraph).endswith("\t"):
            continue
        drop_tabs(paragraph)
        set_tabs(paragraph, [])
        changed += 1

    return changed


def fix_consent_section_b(doc):
    """Section B of the DHCR consent (item 12).

    The tenant's email sat in its own column, so its rule started halfway
    across the page while the name's started right after the label. The mailing
    address had no blank at all — the converter kept the rule and lost the
    field, so the one line on this form that is not already known could not be
    filled in.
    """
    changed = 0

    label = doc.find("Email Address:")
    value = doc.find("‖column‖{{tenant.email}}")
    if None not in (label, value):
        first = first_run(label)
        set_content(label, [first,
                            clone_run(first, text=" ", underline=False),
                            take(value, "{{tenant.email}}")])
        doc.remove(value)
        set_indent(label, left=CONSENT_LEFT, right=0, firstLine=0)
        set_property(label, "jc", {"val": "left"})
        doc.reindex()
        changed += 1

    mailing = doc.find("Mailing Address:  \t")
    if mailing is not None:
        first = first_run(mailing)
        for node in first.iter(WNS + "t"):
            node.text = "Mailing Address: "
        drop_tabs(first)
        set_content(mailing, [first,
                              clone_run(first, text="{{tenant.mailing_address}}",
                                        underline=True)])
        set_tabs(mailing, [])
        set_indent(mailing, left=CONSENT_LEFT, right=0, firstLine=0)
        set_property(mailing, "jc", {"val": "left"})
        changed += 1

    printed = doc.find("Tenant Name(s) (Please print)")
    if printed is not None:
        for node in printed.iter(WNS + "t"):
            if node.text == "Tenant Name(s) (Please print)":
                node.text = "Printed Tenant name(s)"
        changed += 1

    return changed


def fix_good_cause_unit(doc):
    """The Good Cause notice's unit block: label, value, gap, label (item 13).

    Five labels and five values in ten paragraphs, each value's rule drawn as a
    floating line the width of the page. Two lines hold all of it, and the
    underline under each value is the value's own.
    """
    # Two headings printed as one line and wrapped by a right indent.
    heading = doc.find("NOTICE (THIS SHOULD BE FILLED OUT BY YOUR LANDLORD) UNIT INFORMATION")
    if heading is not None:
        run = first_run(heading)
        for node in run.iter(WNS + "t"):
            node.text = "NOTICE (THIS SHOULD BE FILLED OUT BY YOUR LANDLORD)"
        tail = blank_like(heading)
        move_section(heading, tail)
        set_content(tail, [clone_run(run, text="UNIT INFORMATION", underline=False)])
        for part in (heading, tail):
            set_indent(part, left=588, right=0, firstLine=0)
            set_property(part, "spacing", {"before": 0, "after": 0,
                                           "line": 240, "lineRule": "auto"})
        doc.insert_after(heading, tail)

    street_label = doc.find("STREET:")
    if street_label is None:
        return 1 if heading is not None else 0

    holders = {
        "street": doc.find("{{property.street}}"),
        "unit": doc.find("{{property.unit}} CITY/TOWN/VILLAGE:"),
        "city": doc.find("{{property.city}} STATE:"),
        "state": doc.find("{{property.state}} ZIP CODE:"),
        "zip": doc.find("{{property.zip}}\t"),
    }
    if any(value is None for value in holders.values()):
        return 1 if heading is not None else 0

    label = first_run(street_label)
    values = {name: take(holder, f"{{{{property.{name}}}}}")
              for name, holder in holders.items()}

    second = blank_like(street_label)
    set_content(street_label, [
        clone_run(label, text="STREET: ", underline=False), values["street"],
        clone_run(label, tab=True),
        clone_run(label, text="UNIT OR APARTMENT NUMBER: ", underline=False), values["unit"],
    ])
    set_content(second, [
        clone_run(label, text="CITY/TOWN/VILLAGE: ", underline=False), values["city"],
        clone_run(label, tab=True),
        clone_run(label, text="STATE: ", underline=False), values["state"],
        clone_run(label, tab=True),
        clone_run(label, text="ZIP CODE: ", underline=False), values["zip"],
    ])

    # Everything between the two lines was a label, a rule or a spacer.
    start = doc.paragraphs.index(street_label)
    end = doc.paragraphs.index(holders["zip"])
    for paragraph in doc.paragraphs[start + 1:end + 1]:
        move_section(paragraph, second)
        doc.remove(paragraph)

    set_tabs(street_label, [("left", 6000)])
    set_indent(street_label, left=588, right=0, firstLine=0)
    set_property(street_label, "jc", {"val": "left"})
    set_tabs(second, [("left", 4600), ("left", 8000)])
    set_indent(second, left=588, right=0, firstLine=0)
    set_property(second, "jc", {"val": "left"})
    doc.insert_after(street_label, second)
    return 2 if heading is not None else 1


# Question 3 asks how a rent increase is justified and question 4 why a lease
# is not being renewed. The conversion left both as bare semicolons.
RENT_INCREASE_ANSWERS = [
    ("The rent is not being increased above the threshold",
     "good_cause.increase_below_threshold"),
    ("The rent is being increased above the threshold",
     "good_cause.increase_above_threshold"),
]

NONRENEWAL_ANSWERS = [
    ("subdivision 3 of section 214", "good_cause.nonrenewal_sublet"),
    ("subdivision 4 of section 214", "good_cause.nonrenewal_employment"),
    ("paragraph a of subdivision 1 of section 216", "good_cause.nonrenewal_unpaid_rent"),
    ("paragraph b of subdivision 1 of section 216", "good_cause.nonrenewal_lease_violation"),
    ("paragraph c of subdivision 1 of section 216", "good_cause.nonrenewal_nuisance"),
    ("paragraph d of subdivision 1 of section 216", "good_cause.nonrenewal_illegal_occupancy"),
    ("paragraph e of subdivision 1 of section 216", "good_cause.nonrenewal_illegal_use"),
    ("paragraph f of subdivision 1 of section 216", "good_cause.nonrenewal_refused_access"),
    ("paragraph g of subdivision 1 of section 216", "good_cause.nonrenewal_owner_use"),
    ("paragraph h of subdivision 1 of section 216", "good_cause.nonrenewal_demolition"),
    ("paragraph i of subdivision 1 of section 216", "good_cause.nonrenewal_withdrawal"),
    ("paragraph j of subdivision 1 of section 216", "good_cause.nonrenewal_refused_terms"),
]


def add_answer(paragraph, field):
    """Puts a check box where the form ends a question with bare punctuation."""
    if f"{{{{{field}}}}}" in own_text(paragraph):
        return False

    runs = runs_of(paragraph)
    end = next((i for i in range(len(runs) - 1, -1, -1)
                if own_text(runs[i]).strip() in (";", ".")), None)
    if end is None:
        raise SystemExit(f"no closing punctuation in {own_text(paragraph)[:60]!r}")

    model = runs[0]
    # Not underlined: a check box is a box, and "[_X_]" is not one. This is
    # the same rule restyle-template.py follows for the marks already here.
    mark = clone_run(model, text=f"{{{{{field}}}}}", underline=False)

    # The converter left the blank as an underlined space; that is the box.
    if end > 0 and not own_text(runs[end - 1]).strip():
        position = list(paragraph).index(runs[end - 1])
        paragraph.remove(runs[end - 1])
    else:
        position = list(paragraph).index(runs[end])

    for offset, run in enumerate([clone_run(model, text=" ", underline=False),
                                  mark,
                                  clone_run(model, text=" ", underline=False)]):
        paragraph.insert(position + offset, run)
    return True


def fix_good_cause_answers(doc):
    """Questions 3 and 4 of the Good Cause notice get their blanks (items 14, 15)."""
    changed = 0

    for text, field in RENT_INCREASE_ANSWERS:
        paragraph = doc.containing(text)
        if paragraph is None:
            continue
        # One of the two semicolons was left behind on a line of its own.
        following = doc.after(paragraph)
        if following is not None and own_text(following).strip() == ";":
            drop_tabs(following)
            for run in content(following):
                if not own_text(run).strip() and run.find(WNS + "t") is not None:
                    following.remove(run)
                    continue
                following.remove(run)
                paragraph.append(run)
            doc.remove(following)
            doc.reindex()
        if add_answer(paragraph, field):
            changed += 1

    justification = doc.containing("B-1: If the rent is being increased")
    if justification is not None and "{{good_cause.increase_justification}}" not in own_text(justification):
        model = first_run(justification)
        justification.append(clone_run(model, text=" ", underline=False))
        justification.append(clone_run(model, text="{{good_cause.increase_justification}}",
                                       underline=True))
        changed += 1

    for marker, field in NONRENEWAL_ANSWERS:
        hits = [p for p in doc.paragraphs
                if marker in own_text(p) and own_text(p).rstrip().endswith((";", "."))]
        if len(hits) != 1:
            raise SystemExit(f"{len(hits)} paragraphs end a question with {marker!r}")
        if add_answer(hits[0], field):
            changed += 1

    return changed


# ------------------------------------------------ what the conversion drew
#
# Everything below is the same mistake in different clothes: the converter
# reproduced the *look* of the paper form with whatever Word feature happened
# to land in the right place on the page it was measuring. That survives Word
# and nothing else, and it stops surviving Word as soon as a value is longer
# than the sample's.


def fix_table_grids(doc):
    """Every table's spare column, and the order of its properties.

    The converter ended each `w:tblGrid` with a column that has no width,
    which a renderer counts as a column and draws a border for — the double
    line down the middle of the utilities table was that.
    """
    changed = 0
    for table in doc.body.iter(WNS + "tbl"):
        grid = table.find(WNS + "tblGrid")
        pr = table.find(WNS + "tblPr")
        if grid is None:
            continue

        if pr is not None:
            order = sorted(pr, key=lambda child: TBLPR_ORDER.index(child.tag.split("}")[-1])
                           if child.tag.split("}")[-1] in TBLPR_ORDER else len(TBLPR_ORDER))
            if order != list(pr):
                for child in order:
                    pr.remove(child)
                    pr.append(child)
                changed += 1

        spare = [column for column in grid if column.get(WNS + "w") is None]
        for column in spare:
            grid.remove(column)

        if spare:
            changed += 1
    return changed


# The column the numbered clauses stand in: the number at 588 twips from the
# margin, the justified text ending at 10834.
TEXT_LEFT = 588
TEXT_RIGHT = 10834


def clause_column(doc, table):
    """Where a table's left edge belongs.

    A numbered clause hangs its number out to the left of its own text. A
    table that continues one of those clauses — the two notice addresses, the
    key schedule, the smoking locations — is the end of that sentence, so it
    starts where the sentence starts and not under the number. Everything
    else, the signature blocks above all, is a block of its own and stands in
    the clause column itself.
    """
    children = list(doc.body)
    if table not in children:
        return TEXT_LEFT
    for node in reversed(children[:children.index(table)]):
        # Two forms one under the other: the second reads as part of the first.
        if node.tag == WNS + "tbl":
            return clause_column(doc, node)
        if node.tag != WNS + "p" or not own_text(node).strip():
            continue
        pPr = node.find(WNS + "pPr")
        indent = pPr.find(WNS + "ind") if pPr is not None else None
        if indent is None or not indent.get(WNS + "hanging"):
            return TEXT_LEFT
        return int(float(indent.get(WNS + "left") or 0))
    return TEXT_LEFT


def fix_table_columns(doc):
    """Every table stands in the column of the text around it.

    The paper form put each one wherever it fitted — six different indents
    across eighteen tables, none of them lining up with the clause above, and
    none of them reaching the right margin the text is justified to. A table
    now starts where the text it belongs to starts and ends where that text
    ends, so both of its edges are a line the eye already follows.

    Only the conversion's tables are moved — the ones still carrying its
    styles. A table this tool built was given its column by whichever fix
    built it, which is the one place that knows what the table is for.

    The indent is `w:tblInd`, which is what Word reads. docx-preview reads a
    table indent as `w:left` — the way a paragraph states one — so the preview
    applies these after rendering; see `site/admin/lease-doc.js`.
    """
    changed = 0
    for table in doc.body.iter(WNS + "tbl"):
        pr = table.find(WNS + "tblPr")
        grid = table.find(WNS + "tblGrid")
        if pr is None or grid is None or pr.find(WNS + "tblStyle") is None:
            continue

        left = clause_column(doc, table)
        wanted = TEXT_RIGHT - left

        widths = [float(column.get(WNS + "w") or 0) for column in grid]
        total = sum(widths)
        indent = pr.find(WNS + "tblInd")
        if not total or (indent is not None
                         and int(float(indent.get(WNS + "w") or 0)) == left
                         and int(round(total)) == wanted):
            continue

        scaled = [int(round(width * wanted / total)) for width in widths]
        scaled[-1] += wanted - sum(scaled)
        for column, width in zip(grid, scaled):
            column.set(WNS + "w", str(width))
        for _, cell in cells_of(table):
            cellPr = cell.find(WNS + "tcPr")
            size = cellPr.find(WNS + "tcW") if cellPr is not None else None
            if size is not None and size.get(WNS + "w"):
                size.set(WNS + "w",
                         str(int(round(float(size.get(WNS + "w")) * wanted / total))))

        if indent is None:
            indent = ET.Element(WNS + "tblInd")
            indent.set(WNS + "type", "dxa")
            pr.append(indent)
        indent.set(WNS + "w", str(left))
        indent.set(WNS + "type", "dxa")
        width = pr.find(WNS + "tblW")
        if width is None:
            width = ET.Element(WNS + "tblW")
            width.set(WNS + "type", "dxa")
            pr.append(width)
        width.set(WNS + "w", str(wanted))
        width.set(WNS + "type", "dxa")

        order = sorted(pr, key=lambda child: TBLPR_ORDER.index(child.tag.split("}")[-1])
                       if child.tag.split("}")[-1] in TBLPR_ORDER else len(TBLPR_ORDER))
        for child in order:
            pr.remove(child)
            pr.append(child)
        changed += 1
    return changed


def fix_ruled_cells(doc):
    """The lines this lease is signed on.

    Each was a space and a tab character wearing an underline, alone in a
    table cell. Word draws the underline the whole width of the tab. A
    renderer that lays tab stops out after the fact cannot: it underlines the
    space and leaves the rest bare, which is why the preview showed a dash and
    a stub where the document has a line to sign. A bottom border on the empty
    paragraph is the same rule and neither renderer has to guess.

    The paragraph keeps its indents and its tab stop; `fix_rule_widths` reads
    that stop back, once the columns are settled, to end the rule where the
    tab did.
    """
    changed = 0
    for table in doc.body.iter(WNS + "tbl"):
        for _, cell in cells_of(table):
            paragraphs = cell.findall(WNS + "p")
            if any(own_text(paragraph).strip() for paragraph in paragraphs):
                continue
            ruled = [paragraph for paragraph in paragraphs
                     if any(underlined_tab(run) for run in runs_of(paragraph))]
            if len(ruled) != 1:
                continue
            paragraph = ruled[0]
            # Some of these cells hold a spacer paragraph as well, which is a
            # blank line above a blank line.
            for spare in paragraphs:
                if spare is not paragraph:
                    cell.remove(spare)
            set_content(paragraph, [])
            set_property(paragraph, "pBdr", children=[edge("bottom", size="6")])
            changed += 1
    return changed


def is_ruled(paragraph):
    """A paragraph whose bottom border is a line to write on."""
    pPr = paragraph.find(WNS + "pPr")
    borders = pPr.find(WNS + "pBdr") if pPr is not None else None
    bottom = borders.find(WNS + "bottom") if borders is not None else None
    return bottom is not None and bottom.get(WNS + "val") not in (None, "nil", "none")


def cell_width(row, columns):
    """Each cell of a row with the width of the columns it covers."""
    at = 0
    for cell in row.findall(WNS + "tc"):
        pr = cell.find(WNS + "tcPr")
        span = pr.find(WNS + "gridSpan") if pr is not None else None
        covered = int(float(span.get(WNS + "val"))) if span is not None else 1
        yield cell, sum(columns[at:at + covered])
        at += covered


def fix_rule_widths(doc):
    """A signature line is as long as the tab that drew it.

    Four people sign this lease and the form gives each of them a line, with a
    gap between one line and the next. The tab that drew a line stopped short
    of its column, and that shortfall was the gap; a border drawn across the
    whole paragraph has no shortfall, so the middle two ran together and four
    lines read as three. The tab stop is still on the paragraph — it is the
    only record of how long Word drew the line — so the rule is held back to
    it. Runs last, because the stop is measured against a settled column.
    """
    changed = 0
    for table in doc.body.iter(WNS + "tbl"):
        grid = table.find(WNS + "tblGrid")
        if grid is None:
            continue
        columns = [int(float(column.get(WNS + "w") or 0))
                   for column in grid.findall(WNS + "gridCol")]
        for row in table.findall(WNS + "tr"):
            for cell, width in cell_width(row, columns):
                for paragraph in cell.findall(WNS + "p"):
                    if not is_ruled(paragraph):
                        continue
                    pPr = paragraph.find(WNS + "pPr")
                    tabs = pPr.find(WNS + "tabs")
                    indent = pPr.find(WNS + "ind")
                    if tabs is None or indent is None or len(tabs) != 1:
                        continue
                    right = str(max(0, width - int(float(tabs[0].get(WNS + "pos")))))
                    if indent.get(WNS + "right") == right:
                        continue
                    indent.set(WNS + "right", right)
                    changed += 1
    return changed


def is_padding(paragraph):
    """An empty paragraph that draws nothing and holds nothing."""
    if own_text(paragraph).strip():
        return False
    if list(paragraph.iter(WNS + "drawing")) or list(paragraph.iter(MCNS + "AlternateContent")):
        return False
    pPr = paragraph.find(WNS + "pPr")
    borders = pPr.find(WNS + "pBdr") if pPr is not None else None
    if borders is not None and any(side.get(WNS + "val") not in (None, "nil", "none")
                                   for side in borders):
        return False
    return True


# Enough of a gap to read as a caption rather than as another line of the
# form, in place of the seventeen to forty-eight blank paragraphs that used to
# hold one down.
CAPTION_GAP = 600


def fix_section_padding(doc):
    """Blank paragraphs padding the bottom of a page that already ends.

    Every section on this document is a page break, so blank lines before one
    decide nothing except whether the page overflows — and a preview that
    grows its pages to fit renders them, so the two stopped agreeing on where
    a page ends. Nine of these sections end with a caption the conversion
    pushed towards the bottom with up to forty-eight blank paragraphs; those
    get a measured gap instead, which says the same thing once and cannot
    spill a sheet on its own.
    """
    changed = 0
    for paragraph in list(doc.paragraphs):
        if section(paragraph) is None:
            continue
        parent = doc.parents[paragraph]
        removed = 0
        while True:
            siblings = list(parent)
            index = siblings.index(paragraph)
            if index == 0:
                break
            previous = siblings[index - 1]
            if previous.tag != WNS + "p" or not is_padding(previous):
                break
            parent.remove(previous)
            removed += 1

        if removed >= 6 and own_text(paragraph).strip():
            spacing = properties(paragraph).find(WNS + "spacing")
            attributes = dict(spacing.attrib) if spacing is not None else {}
            attributes[WNS + "before"] = str(CAPTION_GAP)
            set_property(paragraph, "spacing",
                         {key.split("}")[-1]: value for key, value in attributes.items()})
        changed += removed

    if changed:
        doc.reindex()
    return changed


def fix_landlord_signature(doc):
    """The one signature block the conversion wrapped instead of breaking.

    "Landlord or Landlord's Representative: Signature: … Print Name: …" was a
    single paragraph squeezed to a third of the page by a right indent, so
    Word broke the label across two lines and drew each rule an inch long. It
    is three lines, the way the same block reads everywhere else on this
    lease.
    """
    paragraph = doc.find("Landlord or Landlord’s Representative: "
                         "Signature:\t \t Print Name:\t \t")
    if paragraph is None:
        return 0

    heading = take(paragraph, "Landlord or Landlord’s Representative: ")
    for node in heading.iter(WNS + "t"):
        node.text = node.text.rstrip()

    # The same block, ten times over, is what this one is measured against.
    model = doc.find_all("Landlord or Landlord’s Representative:")[0]
    label = blank_like(model)
    set_content(label, [heading])

    reference = doc.find_all("Signature:\t \t Print Name:\t \t")[0]
    indent = properties(reference).find(WNS + "ind")
    set_indent(paragraph, left=indent.get(WNS + "left"),
               right=indent.get(WNS + "right"), firstLine=0)
    set_tabs(paragraph, [(tab.get(WNS + "val"), int(float(tab.get(WNS + "pos"))))
                         for tab in properties(reference).find(WNS + "tabs")])

    parent = doc.parents[paragraph]
    parent.insert(list(parent).index(paragraph), label)
    doc.reindex()
    return 1


def label_and_blanks(paragraph):
    """The labels, when a paragraph is nothing but labels and blanks to fill."""
    labels, pending = [], []
    for node in content(paragraph):
        if node.tag != WNS + "r":
            return None
        text = own_text(node)
        if underlined_tab(node):
            label = "".join(pending).strip()
            if not label.endswith(":"):
                return None
            labels.append(label)
            pending = []
        elif text.strip("\t ") == "" or text.strip().endswith(":"):
            pending.append(text)
        else:
            return None
    return labels if labels and not "".join(pending).strip() else None


def fix_label_rules(doc):
    """"Signature: ____  Print Name: ____", one line each.

    Twelve of these are a single paragraph squeezed to a third of the page by
    a right indent, so Word breaks them into a line per label and draws each
    rule with an underlined tab. Neither half survives a renderer that lays
    tab stops out afterwards: it cannot know where Word will break the line,
    so the labels land on top of each other and the rules shrink to a dash. A
    row per label says the same thing, and the rule is the bottom of the cell
    it is written in.

    The two tab stops are the block's own measurements, and the table is built
    to them: the first is where the rule starts, the second where it ends. A
    landlord's signature line is half the width of the page on this form, and
    was meant to be.
    """
    changed = 0
    for paragraph in list(doc.paragraphs):
        labels = label_and_blanks(paragraph)
        indent = properties(paragraph).find(WNS + "ind")
        tabs = properties(paragraph).find(WNS + "tabs")
        if not labels or indent is None or tabs is None:
            continue
        right = int(float(indent.get(WNS + "right") or 0))
        # A right indent this deep is the converter forcing the wrap. Where
        # the line genuinely fits — the bedbug notice signs on one — it stays.
        if right < 3000:
            continue
        stops = sorted(int(float(tab.get(WNS + "pos"))) for tab in tabs)
        if len(stops) != 2:
            continue
        left = int(float(indent.get(WNS + "left") or 0))

        model = first_run(paragraph)
        rows = [[[clone_run(model, text=label, underline=False)], []]
                for label in labels]
        # The table carries the indent; the label starts at its own left edge.
        table = make_table(model, rows, [stops[0] - left, stops[1] - stops[0]],
                           indent=left,
                           rules={(index, 1) for index in range(len(labels))})
        for row in table.findall(WNS + "tr"):
            for cell in row.findall(WNS + "tc"):
                # Line under line, the way Word wrapped the one paragraph
                # these rows were: nothing between them but the leading.
                set_property(cell.find(WNS + "p"), "spacing",
                             {"before": 0, "after": 0, "line": 240,
                              "lineRule": "auto"})
            first = row.findall(WNS + "tc")[0].find(WNS + "p")
            set_property(first, "jc", {"val": "left"})
            set_indent(first, left=0, right=0, firstLine=0)

        set_content(paragraph, [])
        set_tabs(paragraph, [])
        set_indent(paragraph, left=0, right=0, firstLine=0)
        set_property(paragraph, "spacing",
                     {"before": 0, "after": 0, "line": 20, "lineRule": "exact"})
        parent = doc.parents[paragraph]
        parent.insert(list(parent).index(paragraph), table)
        doc.reindex()
        changed += 1
    return changed


SIGNATURE_LABELS = {"Tenant:", "Signature:", "Print Name:", "Signed:", "Date:"}


def fix_signature_alignment(doc):
    """The signature blocks start where the clause above them starts.

    Every label in them carried an indent of its own — 50 twips here, 588
    there, and the "Landlord or Landlord's Representative:" heading twice that
    because a style's indent and its own were being added together. The table
    is what holds the block's place on the page now, so the labels start at
    its edge and the whole block stands under the clause number.
    """
    changed = 0
    for paragraph in doc.paragraphs:
        if own_text(paragraph).strip() != "Landlord or Landlord’s Representative:":
            continue
        indent = properties(paragraph).find(WNS + "ind")
        if indent is not None and indent.get(WNS + "left") == str(TEXT_LEFT) \
                and (indent.get(WNS + "firstLine") or "0") == "0":
            continue
        set_indent(paragraph, left=TEXT_LEFT, right=0, firstLine=0)
        changed += 1

    for table in doc.body.iter(WNS + "tbl"):
        first_column = [row.findall(WNS + "tc")[0] for row in table.findall(WNS + "tr")
                        if row.findall(WNS + "tc")]
        labels = [cell.find(WNS + "p") for cell in first_column]
        if not labels or any(paragraph is None
                             or own_text(paragraph).strip() not in SIGNATURE_LABELS
                             for paragraph in labels):
            continue
        for paragraph in labels:
            indent = properties(paragraph).find(WNS + "ind")
            if indent is not None and indent.get(WNS + "left") == "0":
                continue
            set_indent(paragraph, left=0, right=0, firstLine=0)
            changed += 1
    return changed


def fix_empty_text_boxes(doc):
    """Rules drawn as a text box with a bottom border and nothing inside.

    Word floats them into place. A renderer without floating gives each one a
    line of its own, so the rule lands under the wrong thing and the page
    grows by however many of them there are. The ones that are worth keeping
    are rebuilt as real rules where the block they belong to is rebuilt.
    """
    changed = 0
    for paragraph in list(doc.paragraphs):
        if section(paragraph) is not None or not empty_boxes_only(paragraph):
            continue
        doc.remove(paragraph)
        changed += 1
    if changed:
        doc.reindex()
    return changed


# A shape this small reserves about a hundredth of an inch. Nothing that
# reserves a hundredth of an inch is a picture.
COLLAPSED = 45720  # 0.05 inch, in EMU


def fix_collapsed_shapes(doc):
    """The rules the conversion drew as shapes with no room to draw them in.

    Each is a line several inches long inside a frame a hundredth of an inch
    wide, because the converter wrote the line's own geometry and the frame's
    separately. Word lays out the frame, so it prints a dot — a dot under the
    address on the DHCR consent, a dot beside every Good Cause answer. The
    logos, which reserve the space they need, stay.
    """
    changed = 0
    for paragraph in doc.paragraphs:
        for run in list(runs_of(paragraph)):
            for shape in list(run):
                if shape.tag not in (MCNS + "AlternateContent", WNS + "drawing"):
                    continue
                sizes = [(int(node.get("cx") or 0), int(node.get("cy") or 0))
                         for node in shape.iter()
                         if node.tag.endswith("}extent")]
                if not sizes or all(cx >= COLLAPSED and cy >= COLLAPSED
                                    for cx, cy in sizes):
                    continue
                run.remove(shape)
                changed += 1
            if not [child for child in run if child.tag != WNS + "rPr"]:
                paragraph.remove(run)
    return changed


# Text boxes do not grow with their text, and every one of these was sized on
# the sample PDF. Word printed "THIS IS A BINDING CONTRACT. PLEASE READ" and
# swallowed "IT CAREFULLY."; the bedbug notice lost "INFESTATION HISTORY";
# Section A lost "Representative)". The value is how far in from each margin
# the box sits.
# The width the paper form gives the binding-contract notice, and the column
# it stands in: the top right corner of page one, ending on the same line the
# text below it is justified to.
BINDING_WIDTH = 4147
BINDING_LEFT = TEXT_RIGHT - BINDING_WIDTH

BOXED_HEADINGS = [
    ("THIS IS A BINDING CONTRACT", (5300, 0)),
    ("DISCLOSURE OF BEDBUG INFESTATION HISTORY", (760, 760)),
    ("SECTION A (All Fields", (500, 500)),
    ("SECTION B (All Fields", (500, 500)),
]


def fix_boxed_headings(doc):
    """The four headings the conversion left in fixed-height text boxes.

    A paragraph with a box border says the same thing, cannot clip, and sits
    where the page says rather than where the box was anchored. The lines
    inside stay one paragraph, separated by line breaks: two paragraphs would
    be two boxes to a renderer that draws each one's border itself.
    """
    changed = 0
    for text, (left, right) in BOXED_HEADINGS:
        paragraph = doc.find_box(text)
        if paragraph is None:
            continue

        lines = []
        for inner in paragraph.iter(WNS + "txbxContent"):
            lines = [runs_of(line) for line in inner.findall(WNS + "p")]
            if any(lines):
                break
        lines = [line for line in lines if line]
        if not lines:
            continue

        kept = []
        for index, line in enumerate(lines):
            if index:
                kept.append(clone_run(line[0], underline=False))
                kept[-1].append(ET.Element(WNS + "br"))
            kept.extend(ET.fromstring(ET.tostring(run)) for run in line)

        set_content(paragraph, kept)
        set_property(paragraph, "pBdr", children=[
            edge(side) for side in ("top", "left", "bottom", "right")])
        set_property(paragraph, "spacing",
                     {"before": 120, "after": 120, "line": 240, "lineRule": "auto"})
        set_indent(paragraph, left=left, right=right, firstLine=0)
        set_property(paragraph, "jc", {"val": "center"})
        changed += 1
    return changed


def fix_binding_box(doc):
    """The binding-contract notice, in a box the words sit in the middle of.

    A paragraph border hugs its text, and the padding that would hold it off
    — `w:pBdr`'s `w:space` — is one of the things the preview does not read,
    so the box was tight in one renderer and loose in the other. A one-cell
    table pads with cell margins, which both read, and its right edge lands on
    the same line the text below it is justified to.
    """
    paragraph = doc.find_box("THIS IS A BINDING CONTRACT")
    if paragraph is None:
        paragraph = doc.containing("THIS IS A BINDING CONTRACT")
    if paragraph is None or doc.parents[paragraph].tag == WNS + "tc":
        return 0

    model = first_run(paragraph)
    table = make_table(model, [[[ET.fromstring(ET.tostring(run))
                                 for run in runs_of(paragraph)]]],
                       [BINDING_WIDTH], indent=BINDING_LEFT)
    pr = table.find(WNS + "tblPr")
    borders = pr.find(WNS + "tblBorders")
    for existing in list(borders):
        borders.remove(existing)
    for side in ("top", "left", "bottom", "right"):
        borders.append(edge(side))
    for side in ("insideH", "insideV"):
        borders.append(edge(side, "nil"))
    margins = pr.find(WNS + "tblCellMar")
    for element in margins:
        element.set(WNS + "w", "120")
    order = sorted(pr, key=lambda child: TBLPR_ORDER.index(child.tag.split("}")[-1])
                   if child.tag.split("}")[-1] in TBLPR_ORDER else len(TBLPR_ORDER))
    for child in order:
        pr.remove(child)
        pr.append(child)

    set_content(paragraph, [])
    set_property(paragraph, "pBdr")
    set_indent(paragraph, left=0, right=0, firstLine=0)
    set_property(paragraph, "spacing",
                 {"before": 0, "after": 0, "line": 20, "lineRule": "exact"})
    parent = doc.parents[paragraph]
    parent.insert(list(parent).index(paragraph), table)
    doc.reindex()
    return 1


# The air above and below each of "Name:", "Address:" and "Phone:" in clause
# 25's table. A row is as tall as the taller of its two cells, so a value long
# enough to wrap leaves the other side a blank line — that is what keeping
# Name level with Name costs, and no table can give it back. What deliberate
# space does is make that blank a smaller share of the gap; a third of a line
# on each side is as much as this section can spare without running onto a
# page of its own.
NOTICE_GAP = 80


def fix_notice_rows(doc):
    """Clause 25's two addresses, line beside line (item 1).

    Name, address and phone were three paragraphs stacked in one cell, so an
    address long enough to wrap pushed the phone number down on one side only
    and the two columns stopped saying the same thing on the same line. One
    row per line keeps them level whatever the values are.
    """
    anchor = doc.find("Name: {{manager.name}}")
    if anchor is None:
        return 0
    table = ancestor(doc, anchor, WNS + "tbl")
    rows = table.findall(WNS + "tr")
    if len(rows) != 2:
        return 0

    header, block = rows
    left, right = block.findall(WNS + "tc")
    lines = list(zip(left.findall(WNS + "p"), right.findall(WNS + "p")))
    if len(lines) != 3:
        return 0

    position = list(table).index(block)
    table.remove(block)
    for index, pair in enumerate(lines):
        row = ET.Element(WNS + "tr")
        trPr = ET.fromstring(ET.tostring(block.find(WNS + "trPr")))
        # One row's minimum height, taken three times, is an extra page.
        for height in trPr.findall(WNS + "trHeight"):
            trPr.remove(height)
        row.append(trPr)
        for source, paragraph in zip((left, right), pair):
            cell = ET.SubElement(row, WNS + "tc")
            properties_of = source.find(WNS + "tcPr")
            if properties_of is not None:
                cell.append(ET.fromstring(ET.tostring(properties_of)))
            set_cell_borders(cell,
                             top="nil",
                             bottom="single" if index == len(lines) - 1 else "nil",
                             left="single", right="single")
            # A line of its own reads as one only with air around it.
            set_property(paragraph, "spacing",
                         {"before": NOTICE_GAP, "after": NOTICE_GAP,
                          "line": 240, "lineRule": "auto"})
            cell.append(paragraph)
        table.insert(position + index, row)

    for _, cell in [(header, cell) for cell in header.findall(WNS + "tc")]:
        set_cell_borders(cell, top="single", bottom="single",
                         left="single", right="single")
    doc.reindex()
    return 1


def fix_fee_cap_line(doc):
    """Clause 33's check box, without the rule in front of it (item 2).

    The check box carried the underline the amount beside it is drawn with, so
    it looked struck through, and a tab threw ", excluding costs." to a stop
    most of a page to the right of the amount it belongs to.
    """
    paragraph = doc.containing("{{attorney_fees.cap_enabled}}")
    if paragraph is None or paragraph.find(WNS + "pPr").find(WNS + "tabs") is None:
        return 0

    for run in runs_of(paragraph):
        text = own_text(run)
        if "{{attorney_fees.cap_enabled}}" in text:
            rPr = run.find(WNS + "rPr")
            for existing in rPr.findall(WNS + "u"):
                existing.set(WNS + "val", "none")
        if text.startswith("\t"):
            for tab in run.findall(WNS + "tab"):
                run.remove(tab)
    set_tabs(paragraph, [])
    set_indent(paragraph, left=948, right=566, firstLine=0)
    return 1


def fix_window_guard_lines(doc):
    """The window guard notice: even spacing, and lines to sign on (item 4).

    The four answers were spaced by whatever gap the sample happened to have,
    and the two rules under them were floating shapes an inch and a half wide
    holding a line drawing several inches long — Word reserved the inch and a
    half and drew a dot. The page also ran one line past its bottom, which put
    the form's own revision number on a sheet by itself.
    """
    labels = [
        ("Tenant’s Name: {{tenant.names}}", 120),
        ("Tenant’s Address: {{property.address_full}}", 160),
        ("Apartment Number: {{property.unit}}", 160),
        ("Tenant’s Signature:", 220),
    ]
    signature = doc.find("Tenant’s Signature:")
    if signature is None:
        return 0
    if properties(signature).find(WNS + "spacing") is not None \
            and properties(signature).find(WNS + "spacing").get(WNS + "before") == "220":
        return 0

    found = []
    for text, before in labels:
        paragraph = doc.find(text)
        if paragraph is None:
            continue
        found.append(paragraph)
        set_property(paragraph, "spacing",
                     {"before": before, "after": 0, "line": 240, "lineRule": "auto"})

    # Spacers between them would add to that, unevenly.
    for opening, closing in zip(found, found[1:]):
        start = doc.paragraphs.index(opening) + 1
        end = doc.paragraphs.index(closing)
        for paragraph in doc.paragraphs[start:end]:
            if own_text(paragraph).strip():
                continue
            move_section(paragraph, closing)
            doc.remove(paragraph)
        doc.reindex()

    # Everything between the label and the next one was a shape or a spacer.
    # "Date:" labels a cell on other forms too, so it is found from here.
    date = doc.find_after(signature, "Date:")
    ret = doc.find("Return this form to:")
    for label, stop in ((signature, date), (date, ret)):
        if label is None or stop is None:
            continue
        start = doc.paragraphs.index(label) + 1
        end = doc.paragraphs.index(stop)
        rule = None
        for paragraph in doc.paragraphs[start:end]:
            if rule is None:
                rule = paragraph
                set_content(rule, [])
                set_property(rule, "pBdr", children=[edge("bottom", size="6")])
                set_property(rule, "spacing",
                             {"before": 0, "after": 0, "line": 240, "lineRule": "auto"})
                set_indent(rule, left=300, right=4400, firstLine=0)
                continue
            move_section(paragraph, rule)
            doc.remove(paragraph)
        doc.reindex()

    if date is not None:
        set_property(date, "spacing",
                     {"before": 120, "after": 0, "line": 240, "lineRule": "auto"})
    return 1


def fix_bedbug_premises(doc):
    """The DBB-N form's subject premises (item 5).

    It was the address assembled a second way — street, the word "Unit", the
    number, the city, the state, the zip — beside a lease that composes that
    line once and prints it everywhere else. Two spellings of one address on
    one document is one too many.
    """
    premises = doc.containing("Subject Premises:")
    if premises is None or "{{property.address_full}}" in own_text(premises):
        return 0

    label = first_run(premises)
    set_content(premises, [
        label,
        clone_run(label, tab=True),
        # The tab centres the answer with the others when there is room. This
        # address is wider than the space left for it, so there has to be
        # something between the colon and the street number either way.
        clone_run(label, text=" ", underline=False),
        clone_run(label, text="{{property.address_full}}", underline=True),
    ])
    return 1


def fix_bedbug_frame(doc):
    """The border around the DBB-N form (item 5).

    The paper form is a box with the notice inside it. The conversion drew
    that box as a shape as tall as the page, which a renderer without floating
    gives a line of its own — ten inches of blank paper in the middle of the
    form. A one-cell table is the same box and both renderers draw it.
    """
    last = doc.find("DBB-N (DHCR 10/10)")
    if last is None or doc.parents[last].tag != WNS + "body":
        return 0

    body = doc.body
    end = list(body).index(last)
    start = list(body).index(doc.after(doc.find("1.22")))

    table = ET.Element(WNS + "tbl")
    pr = ET.SubElement(table, WNS + "tblPr")
    width = ET.SubElement(pr, WNS + "tblW")
    width.set(WNS + "w", "11400")
    width.set(WNS + "type", "dxa")
    borders = ET.SubElement(pr, WNS + "tblBorders")
    for side in ("top", "left", "bottom", "right"):
        borders.append(edge(side))
    for side in ("insideH", "insideV"):
        borders.append(edge(side, "nil"))
    ET.SubElement(pr, WNS + "tblLayout").set(WNS + "type", "fixed")
    ET.SubElement(table, WNS + "tblGrid").append(ET.Element(WNS + "gridCol"))
    table.find(WNS + "tblGrid")[0].set(WNS + "w", "11400")

    row = ET.SubElement(table, WNS + "tr")
    trPr = ET.SubElement(row, WNS + "trPr")
    height = ET.SubElement(trPr, WNS + "trHeight")
    # The shape it replaces was 9.89 inches tall. This leaves room under it
    # for the paragraph that has to carry the section break, because a table
    # cannot.
    height.set(WNS + "val", "13900")
    height.set(WNS + "hRule", "atLeast")
    cell = ET.SubElement(row, WNS + "tc")
    size = ET.SubElement(ET.SubElement(cell, WNS + "tcPr"), WNS + "tcW")
    size.set(WNS + "w", "11400")
    size.set(WNS + "type", "dxa")

    moved = list(body)[start:end + 1]
    for paragraph in moved:
        body.remove(paragraph)
        cell.append(paragraph)

    tail = ET.Element(WNS + "p")
    pPr = ET.SubElement(tail, WNS + "pPr")
    spacing = ET.SubElement(pPr, WNS + "spacing")
    spacing.set(WNS + "before", "0")
    spacing.set(WNS + "after", "0")
    spacing.set(WNS + "line", "20")
    spacing.set(WNS + "lineRule", "exact")
    rPr = ET.SubElement(pPr, WNS + "rPr")
    ET.SubElement(rPr, WNS + "sz").set(WNS + "val", "2")

    body.insert(start, table)
    body.insert(start + 1, tail)
    doc.reindex()
    move_section(last, tail)
    return 1


def fix_sprinkler_marks(doc):
    """The sprinkler notice's two options start in the same place (item 6).

    The check mark shared a cell with the words after it, so "Option 1:"
    began where an empty mark left it and "Option 2:" an X further along.
    """
    first = doc.find("{{sprinkler.mark_option1}} Option 1:")
    if first is None:
        return 0
    table = ancestor(doc, first, WNS + "tbl")
    grid = table.find(WNS + "tblGrid")

    mark_width = 560
    grid[0].set(WNS + "w", str(int(grid[0].get(WNS + "w")) - mark_width))
    column = ET.Element(WNS + "gridCol")
    column.set(WNS + "w", str(mark_width))
    grid.insert(0, column)

    for index, row in enumerate(table.findall(WNS + "tr"), start=1):
        label = row.findall(WNS + "tc")[0].find(WNS + "p")
        mark = take(label, "{{sprinkler.mark_option%d}}" % index)
        for node in label.iter(WNS + "t"):
            if node.text and node.text.startswith(" Option"):
                node.text = node.text[1:]
                break

        cell = ET.Element(WNS + "tc")
        size = ET.SubElement(ET.SubElement(cell, WNS + "tcPr"), WNS + "tcW")
        size.set(WNS + "w", str(mark_width))
        size.set(WNS + "type", "dxa")
        paragraph = ET.SubElement(cell, WNS + "p")
        pPr = label.find(WNS + "pPr")
        if pPr is not None:
            paragraph.insert(0, ET.fromstring(ET.tostring(pPr)))
        set_indent(paragraph, left=0, right=0, firstLine=0)
        set_property(paragraph, "jc", {"val": "center"})
        paragraph.append(mark)
        row.insert(0, cell)

        set_cell_borders(cell, left="single", right="nil")
        set_cell_borders(row.findall(WNS + "tc")[1], left="nil")

    doc.reindex()
    return 1


def fix_consent_contact(doc):
    """Section B's three lines, written the way Section A writes them (item 7).

    The tenant's name and email came back from the conversion in a different
    typeface and half again the size, each with a rule drawn to the far margin
    behind it. Section A says the same three things in the document's own
    face, with the value underlined and nothing after it.
    """
    model = doc.find("Name(s): {{owner_rep.name}}")
    if model is None:
        return 0
    reference = runs_of(model)[0]
    size = type_size(reference)

    changed = 0
    for label, field in (("Name(s): ", "tenant.names"),
                         ("Email Address: ", "tenant.email")):
        paragraph = doc.find_after(model, f"{label}{{{{{field}}}}}")
        if paragraph is None:
            continue
        if len(content(paragraph)) == 2 and type_size(runs_of(paragraph)[0]) == size:
            continue
        set_content(paragraph, [
            clone_run(reference, text=label, underline=False),
            clone_run(reference, text=f"{{{{{field}}}}}", underline=True),
        ])
        set_indent(paragraph, left=CONSENT_LEFT, right=0, firstLine=0)
        set_property(paragraph, "jc", {"val": "left"})
        changed += 1
    return changed


def fix_consent_signatures(doc):
    """The three places this notice is signed (item 8).

    Each was a caption with a floating rule somewhere above it and nothing to
    sign on between them. Here the rule is the bottom of the cell the
    signature goes in, and the caption is the cell under it — which is what
    the paper form looks like, and what a signing service needs to find.

    The DHCR form is not part of the lease's clause column: it has a text
    column of its own, 300 twips in, and these tables run the width of it.
    """
    blocks = [
        ("Date\tOwner/Owner Representative Signature(s)",
         ["Date", "Owner/Owner Representative Signature(s)"], None),
        ("Printed Tenant name(s)", ["", "Printed Tenant name(s)"], "tenant.names"),
        ("Date\tTenant Signature(s) (Ink or Electronic)",
         ["Date", "Tenant Signature(s) (Ink or Electronic)"], None),
    ]

    changed = 0
    for text, captions, field in blocks:
        paragraph = doc.find(text)
        # Once rebuilt, the caption lives in a cell of the table it labels.
        if paragraph is None or ancestor(doc, paragraph, WNS + "tc") is not None:
            continue
        model = first_run(paragraph)

        top = []
        rules = set()
        for column, caption in enumerate(captions):
            if not caption:
                top.append([])
                continue
            if field:
                # A value, not a blank: it is underlined the way every other
                # answer on this lease is, and needs no rule under it as well.
                top.append([clone_run(model, text=f"{{{{{field}}}}}", underline=True)])
            else:
                top.append([])
                rules.add((0, column))

        table = make_table(model, [
            top,
            [[clone_run(model, text=caption, underline=False)] if caption else []
             for caption in captions],
        ], [4868, 6232], indent=CONSENT_LEFT, rules=rules)

        set_content(paragraph, [])
        set_tabs(paragraph, [])
        set_indent(paragraph, left=0, right=0, firstLine=0)
        set_property(paragraph, "spacing",
                     {"before": 0, "after": 0, "line": 20, "lineRule": "exact"})
        parent = doc.parents[paragraph]
        parent.insert(list(parent).index(paragraph), table)
        doc.reindex()
        changed += 1
    return changed


def fix_good_cause_spacing(doc):
    """One blank line between question 3 and question 4 (item 9).

    Three floating rules and four spacers sat between them, which read as a
    page break that is not there.
    """
    start = doc.containing("B-1: If the rent is being increased")
    stop = doc.containing("WHAT IS THE GOOD CAUSE FOR NOT RENEWING")
    if None in (start, stop):
        return 0

    first = doc.paragraphs.index(start) + 1
    last = doc.paragraphs.index(stop)
    spare = [p for p in doc.paragraphs[first + 1:last] if not own_text(p).strip()]
    if not spare:
        return 0
    for paragraph in spare:
        move_section(paragraph, doc.paragraphs[first])
        doc.remove(paragraph)
    doc.reindex()
    return 1


def check_boxes():
    """The placeholders that print a check box, from the registry itself."""
    registry = json.loads((ROOT / "lease" / "schema" / "fields.json").read_text())
    return {"{{%s}}" % field["id"] for field in registry["fields"]
            if field["type"] == "checkbox"}


def fix_underlined_marks(doc):
    """A check box is a box, not a blank.

    Twenty-odd of them kept the underline the converter used for the blank
    they replaced, so they printed struck through — "[_X_]" — and, where the
    blank was a tab, the semicolon that ends the sentence landed half an inch
    from it. Which placeholders are boxes is read from the registry, so a
    fill-in blank that is genuinely underlined stays underlined.
    """
    marks = check_boxes()
    changed = 0
    for paragraph in doc.paragraphs:
        for run in runs_of(paragraph):
            text = own_text(run)
            if not any(mark in text for mark in marks):
                continue
            rPr = run.find(WNS + "rPr")
            underline = rPr.find(WNS + "u") if rPr is not None else None
            if underline is None or underline.get(WNS + "val") in (None, "none"):
                continue
            underline.set(WNS + "val", "none")
            for tab in run.findall(WNS + "tab"):
                run.remove(tab)
            for node in run.iter(WNS + "t"):
                if node.text:
                    node.text = " " + node.text.strip() + " "
            changed += 1
    return changed


# The two marks that print as letterhead: big enough to read, anchored at the
# left edge of the page they head. Everything else the conversion anchored is
# either a picture that sits where the text does or a rule with no size at all.
LETTERHEAD = 457200      # half an inch, in EMU
LEFT_EDGE = 457200
CONTENT_WIDTH = 11400    # the page is 12240 twips wide with 420-twip margins


def fix_floating_logos(doc):
    """The two logos Word floats and nothing else does.

    A renderer without floating puts an anchored image where its run happens
    to sit, and the NYC Health mark is anchored to the right-aligned "APPENDIX
    A" — so the preview hung it half off the right edge of the window guard
    notice. Inline at the head of the same paragraph, with the alignment it
    displaces restated as a tab stop, it is top left on the page in both and
    the line is no taller than Word already made it.
    """
    changed = 0
    for paragraph in list(doc.paragraphs):
        for run in list(runs_of(paragraph)):
            anchors = [node for node in run.iter(WPNS + "anchor")
                       if is_letterhead(node)]
            if not anchors:
                continue
            for anchor in anchors:
                make_inline(run, anchor)

            pPr = properties(paragraph)
            indent = pPr.find(WNS + "ind")
            left = int(float((indent.get(WNS + "left") if indent is not None else 0) or 0))
            right = int(float((indent.get(WNS + "right") if indent is not None else 0) or 0))
            aligned = pPr.find(WNS + "jc")

            if aligned is not None and aligned.get(WNS + "val") == "right":
                stop = ("right", CONTENT_WIDTH - right)
                set_indent(paragraph, left=0, right=right, firstLine=0)
                set_property(paragraph, "jc", {"val": "left"})
            else:
                stop = ("left", max(left, 1))
                set_indent(paragraph, left=left, right=right, hanging=left)
            set_tabs(paragraph, [stop])

            paragraph.remove(run)
            # After the properties, before everything the line says.
            opening = list(paragraph).index(pPr) + 1
            paragraph.insert(opening, run)
            paragraph.insert(opening + 1, clone_run(run, tab=True))
            changed += 1
    return changed


def is_letterhead(anchor):
    extent = anchor.find(WPNS + "extent")
    position = anchor.find(WPNS + "positionH")
    offset = position.find(WPNS + "posOffset") if position is not None else None
    if extent is None or offset is None:
        return False
    return (int(extent.get("cx")) >= LETTERHEAD
            and int(extent.get("cy")) >= LETTERHEAD
            and int(offset.text) <= LEFT_EDGE)


def make_inline(run, anchor):
    """The same picture, in the line rather than floating over it."""
    inline = ET.Element(WPNS + "inline")
    for name in ("distT", "distB", "distL", "distR"):
        if anchor.get(name):
            inline.set(name, anchor.get(name))
    for name in ("extent", "effectExtent", "docPr", "cNvGraphicFramePr"):
        found = anchor.find(WPNS + name)
        if found is not None:
            inline.append(found)
    graphic = anchor.find("{http://schemas.openxmlformats.org/drawingml/2006/main}graphic")
    if graphic is not None:
        inline.append(graphic)
    for drawing in run.iter(WNS + "drawing"):
        if anchor in list(drawing):
            drawing.remove(anchor)
            drawing.append(inline)


# ---------------------------------------------------------------- footers

# w:sectPr's children are a sequence too.
SECTPR_ORDER = [
    "headerReference", "footerReference", "footnotePr", "endnotePr", "type",
    "pgSz", "pgMar", "paperSrc", "pgBorders", "lnNumType", "pgNumType", "cols",
    "formProt", "vAlign", "noEndnote", "titlePg", "textDirection", "bidi",
    "rtlGutter", "docGrid", "printerSettings", "sectPrChange",
]

# The line at the foot of the page: the lease's own notice on the left, and on
# the right which document this is and which of its pages, with the Equal
# Housing Opportunity mark closing the line.
FOOTER_NOTICE = "2026 © Star Real Estate, Inc. All Rights Reserved."
# The rest of this document names its font on every run; the line the
# conversion put at the foot of the page did not, so Word fell back to the
# theme's and a browser to whatever `system-ui` is — a different width, which
# is enough to make the longest of these labels fit on one line in one
# renderer and not the other.
FOOTER_SIZE = ('<w:rFonts w:ascii="Times New Roman" w:cs="Times New Roman"'
               ' w:eastAsia="Times New Roman" w:hAnsi="Times New Roman"/>'
               '<w:sz w:val="16"/><w:szCs w:val="16"/>')
PAGE_LABEL = re.compile(r"(.*?)\s*[-–]\s*Page\s*(\d+)\s*$")

# The banner the conversion's footers were really there to carry, which shares
# a paragraph with the page label on four of them.
ESIGNATURE = re.compile(r"Document digitally signed.*?Document ID: \d+")

MARK_IMAGE = "media/image34.png"
# Twelve points of mark beside eight points of text: a line and a half, which
# is as tall as it can be and still read as part of the line rather than as
# something resting on it. An inline image sits on the baseline, so it is
# lowered by half its own height to put its middle where the words' is;
# w:position counts in half-points.
MARK_HEIGHT = 152400            # twelve points, in EMU
MARK_WIDTH = 142672             # the artwork is 176 by 188 pixels
MARK_DROP = -7
MARK = (
    '<w:drawing><wp:inline distB="0" distT="0" distL="0" distR="0">'
    '<wp:extent cx="{width}" cy="{height}"/>'
    '<wp:effectExtent b="0" l="0" r="0" t="0"/>'
    '<wp:docPr id="{id}" name="Equal Housing Opportunity"/>'
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Equal Housing Opportunity"/>'
    '<pic:cNvPicPr preferRelativeResize="0"/></pic:nvPicPr>'
    '<pic:blipFill><a:blip r:embed="rId1"/><a:srcRect b="0" l="0" r="0" t="0"/>'
    '<a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{width}" cy="{height}"/></a:xfrm>'
    '<a:prstGeom prst="rect"/><a:ln/></pic:spPr></pic:pic>'
    '</a:graphicData></a:graphic></wp:inline></w:drawing>'
)

FOOTER = (
    '<w:ftr xmlns:w="{w}" xmlns:r="{r}" xmlns:wp="{wp}" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    '<w:p><w:pPr>'
    '<w:tabs><w:tab w:val="right" w:leader="none" w:pos="{right}"/></w:tabs>'
    '<w:spacing w:after="0" w:before="0" w:line="240" w:lineRule="auto"/>'
    '<w:ind w:left="{left}" w:right="0" w:firstLine="0"/>'
    '<w:jc w:val="left"/><w:rPr>{size}</w:rPr></w:pPr>'
    '<w:r><w:rPr>{size}</w:rPr><w:t xml:space="preserve">{notice}</w:t>'
    '<w:tab/><w:t xml:space="preserve">{label} - Page </w:t></w:r>'
    # A field, so that a rider that grows to a second page numbers itself.
    # The cached result is the number Word would cache: this document's first
    # page. docx-preview cannot evaluate a field and renders that cache, so
    # site/admin/lease-doc.js counts the rest of them the way Word does.
    '<w:r><w:rPr>{size}</w:rPr><w:fldChar w:fldCharType="begin"/></w:r>'
    '<w:r><w:rPr>{size}</w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
    '<w:r><w:rPr>{size}</w:rPr><w:fldChar w:fldCharType="separate"/></w:r>'
    '<w:r><w:rPr>{size}</w:rPr><w:t>1</w:t></w:r>'
    '<w:r><w:rPr>{size}</w:rPr><w:fldChar w:fldCharType="end"/></w:r>'
    '<w:r><w:rPr>{size}</w:rPr><w:t xml:space="preserve"> </w:t></w:r>'
    '<w:r><w:rPr><w:position w:val="{drop}"/>{size}</w:rPr>{mark}</w:r>'
    '</w:p></w:ftr>'
)

BLANK_FOOTER = (
    # Word inherits the section before it where a section names no footer, so
    # the pages the form leaves unlabelled have to say "nothing" out loud.
    '<w:ftr xmlns:w="{w}"><w:p><w:pPr>'
    '<w:spacing w:after="0" w:before="0" w:line="20" w:lineRule="exact"/>'
    '<w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p></w:ftr>'
)

# The room a footer needs, between `w:footer` and `w:bottom`. The conversion
# left less than a line of anything there on every page of the document. It is
# taken from the top margin rather than from the text, so the block of text
# keeps the height it had — and the document keeps its pagination — and sits a
# little higher on the sheet instead.
FOOTER_ROOM = 300

FOOTER_RELS = (
    '<Relationships xmlns="{package}">'
    '<Relationship Id="rId1" Type="{relationships}/image" Target="{target}"/>'
    '</Relationships>'
)


def set_section_property(sect, name, attributes):
    """Replace one w:sectPr child, keeping the schema's element order."""
    for existing in sect.findall(WNS + name):
        sect.remove(existing)
    element = ET.Element(WNS + name)
    for key, value in attributes.items():
        element.set(key if key.startswith("{") else WNS + key, str(value))
    rank = SECTPR_ORDER.index(name) if name in SECTPR_ORDER else len(SECTPR_ORDER)
    position = len(sect)
    for index, existing in enumerate(sect):
        tag = existing.tag.split("}")[-1]
        other = SECTPR_ORDER.index(tag) if tag in SECTPR_ORDER else len(SECTPR_ORDER)
        if other > rank:
            position = index
            break
    sect.insert(position, element)


def page_breaks(doc):
    """Every section, in the order its page comes out, with the paragraph that
    carries the break. The last one is the body's own and carries none."""
    found = []
    for paragraph in doc.body.iter(WNS + "p"):
        sect = section(paragraph)
        if sect is not None:
            found.append((paragraph, sect))
    tail = doc.body.find(WNS + "sectPr")
    if tail is not None:
        found.append((None, tail))
    return found


def page_label(paragraph):
    """"Key Rider - Page 1" — which document this page belongs to, and which
    of its pages it is."""
    text = own_text(paragraph).replace(FOOTER_NOTICE, "").strip()
    found = PAGE_LABEL.fullmatch(text)
    return (found.group(1).strip(), int(found.group(2))) if found else None


def old_footer_labels(doc):
    """The names the conversion kept in footers of its own.

    The paper form labels every page of every rider, two ways: a line of body
    text on the first and last page of one, and a footer on the pages between.
    The conversion anchored those footers nine inches below the paper, so half
    the labels have been invisible ever since — which is why the lease reads
    "Page 1" on page one, nothing for fifteen pages, and "Page 17" at the end.
    Read together the two halves name every page. A footer applies from the
    section that names it until the next section that names one, which is how
    Word reads them.
    """
    package = doc.package
    targets = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"',
                              package.relationships()))
    named, running = {}, None
    for number, (_, sect) in enumerate(page_breaks(doc), 1):
        references = sect.findall(WNS + "footerReference")
        if references:
            running = None
            for reference in references:
                part = targets.get(reference.get("{%s}id" % RELATIONSHIPS))
                if part is None:
                    continue
                said = "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>",
                                          package.read("word/" + part)))
                found = PAGE_LABEL.search(ESIGNATURE.sub("", said))
                running = found.group(1).strip() if found else None
        if running:
            named[number] = running
    return named


def fix_page_footers(doc):
    """The page label belongs in the footer, and the number in a field.

    Half of these were the last paragraph of a section, so on a page that ends
    early the label floated in the middle of the paper; the other half were
    footers the conversion anchored off the page. Both wrote the number by
    hand, which a rider that grows by a page silently makes wrong.

    One footer per document, referenced by every section of it, with the
    number as a `PAGE` field and `w:pgNumType` restarting the count where the
    document does. Word inherits the previous section's footer where a section
    names none, so the pages the paper form leaves unlabelled — the two NYC
    notices bound into the lease, the DHCR consent, the Good Cause notice —
    are given a footer that is deliberately empty, the way the form does it.

    The conversion's own footers go with them. They also held a floating shape
    reading "Document digitally signed using RentCafe eSignature services" —
    the previous landlord's signing service, on every lease this would produce.
    """
    package = doc.package
    if package is None:
        return 0

    sections = page_breaks(doc)
    numbered = {paragraph: number for number, (paragraph, _) in enumerate(sections, 1)
                if paragraph is not None}
    written = [(numbered[paragraph], *found) for paragraph in doc.paragraphs
               if (found := page_label(paragraph)) and paragraph in numbered]
    if not written:
        return 0

    named = old_footer_labels(doc)
    for number, name, _ in written:
        named[number] = name

    # Pages that run together under one name are one document.
    documents = []
    for number in sorted(named):
        if documents and documents[-1][0] == named[number] and documents[-1][2] == number - 1:
            documents[-1][2] = number
        else:
            documents.append([named[number], number, number])

    # Each written label says which page of its document it is, so the two
    # halves check each other.
    for number, name, page in written:
        document = next(d for d in documents if d[1] <= number <= d[2])
        if number - document[1] + 1 != page:
            raise SystemExit(f"{name!r} page {page} is section {number} of {document}")

    # Everything the conversion called a footer, before anything is written:
    # the parts share their names with the ones about to replace them.
    package.drop(lambda name: re.fullmatch(r"word/(_rels/)?footer\d+\.xml(\.rels)?", name))
    package.drop_content_types(lambda name: re.fullmatch(r"word/footer\d+\.xml", name))
    stale = package.unlink(lambda target: re.fullmatch(r"footer\d+\.xml", target)
                           or target.startswith("mailto:")
                           or target in ("media/image40.png", MARK_IMAGE, "media/image2.png"))
    package.drop(lambda name: name in ("word/media/image40.png", "word/media/image2.png"))

    # Where a document's pages start counting is said here and nowhere else;
    # the conversion left three of these behind, restarting the count in the
    # middle of the lease.
    for _, sect in sections:
        for stale_element in (sect.findall(WNS + "footerReference")
                              + sect.findall(WNS + "pgNumType")):
            sect.remove(stale_element)

    def footer(index, body):
        part = f"word/footer{index}.xml"
        package.write(part, DECLARATION + body)
        package.write(f"word/_rels/footer{index}.xml.rels", DECLARATION + FOOTER_RELS.format(
            package=PACKAGE_RELS, relationships=RELATIONSHIPS, target=MARK_IMAGE))
        package.content_type(part, FOOTER_TYPE)
        return package.link(f"footer{index}.xml", "footer")

    def reference(number, link):
        set_section_property(sections[number - 1][1], "footerReference",
                             {"{%s}id" % RELATIONSHIPS: link, "type": "default"})

    for index, (name, first, last) in enumerate(documents, 1):
        link = footer(index, FOOTER.format(
            w=W, r=RELATIONSHIPS, wp=WP, right=TEXT_RIGHT, left=TEXT_LEFT,
            size=FOOTER_SIZE, notice=FOOTER_NOTICE, label=name, drop=MARK_DROP,
            mark=MARK.format(id=index, width=MARK_WIDTH, height=MARK_HEIGHT)))
        for number in range(first, last + 1):
            reference(number, link)
        set_section_property(sections[first - 1][1], "pgNumType", {"start": 1})

    for _, sect in sections:
        margins = sect.find(WNS + "pgMar")
        if margins is None:
            continue
        room = int(margins.get(WNS + "bottom")) - int(margins.get(WNS + "footer"))
        if room >= FOOTER_ROOM:
            continue
        margins.set(WNS + "bottom", str(int(margins.get(WNS + "bottom")) + FOOTER_ROOM - room))
        margins.set(WNS + "top", str(int(margins.get(WNS + "top")) - FOOTER_ROOM + room))

    blank = footer(len(documents) + 1, BLANK_FOOTER.format(w=W))
    for number in range(1, len(sections) + 1):
        if number not in named:
            reference(number, blank)

    for paragraph in doc.paragraphs:
        if page_label(paragraph) is None:
            continue
        drop_drawings(paragraph)
        set_content(paragraph, [])
        set_tabs(paragraph, [])
        set_indent(paragraph, left=0, right=0, firstLine=0)
        set_property(paragraph, "spacing",
                     {"before": 0, "after": 0, "line": 20, "lineRule": "exact"})

    return len(documents) + len(written) + len(stale)


# Where every line this lease is signed on begins: the width of the column
# that holds "Signature:" and "Print Name:" beside it.
SIGNATURE_COLUMN = 1278


def signature_block(table):
    """"Tenant:", "Signature:", "Print Name:" and the lines beside them."""
    labels = [row.findall(WNS + "tc")[0].find(WNS + "p")
              for row in table.findall(WNS + "tr") if row.findall(WNS + "tc")]
    return bool(labels) and all(paragraph is not None
                                and own_text(paragraph).strip() in SIGNATURE_LABELS
                                for paragraph in labels)


def fix_signature_columns(doc):
    """Every line this lease is signed on starts in the same column.

    The conversion measured the label column afresh on every page — 1254 twips
    on one, 1324 on another — and the landlord's block, which this tool builds
    from the tab that used to draw its rule, came out at 1439. An eighth of an
    inch each way, except that the landlord's block sits directly under the
    tenants' and the eye reads the step between them.
    """
    changed = 0
    for table in doc.body.iter(WNS + "tbl"):
        if not signature_block(table):
            continue
        grid = table.find(WNS + "tblGrid")
        columns = grid.findall(WNS + "gridCol")
        widths = [int(float(column.get(WNS + "w"))) for column in columns]
        if widths[0] == SIGNATURE_COLUMN or len(widths) < 2:
            continue

        room = sum(widths) - SIGNATURE_COLUMN
        rest = sum(widths[1:])
        scaled = [SIGNATURE_COLUMN] + [int(round(width * room / rest)) for width in widths[1:]]
        scaled[-1] += sum(widths) - sum(scaled)
        for column, width in zip(columns, scaled):
            column.set(WNS + "w", str(width))
        for row in table.findall(WNS + "tr"):
            for cell, width in cell_width(row, scaled):
                pr = cell.find(WNS + "tcPr")
                size = pr.find(WNS + "tcW") if pr is not None else None
                if size is not None and size.get(WNS + "w"):
                    size.set(WNS + "w", str(width))
        changed += 1
    return changed


# The column the DHCR's seal stands in, and the one its address stands in.
LETTERHEAD_COLUMN = 1701


def fix_consent_letterhead(doc):
    """The DHCR's seal, with the department beside it (item 4).

    The conversion set the seal inline and sent the department's name to a tab
    stop past it. Word puts that stop where the paragraph asks; a renderer that
    lays tab stops out afterwards measured it from a different origin and threw
    the name into the middle of the page, a line above the address it belongs
    with. Two cells say the same thing, and both renderers read a table the
    same way.
    """
    heading = doc.containing("DIVISION OF HOUSING AND COMMUNITY RENEWAL")
    if heading is None or doc.parents[heading].tag == WNS + "tc":
        return 0

    body = doc.body
    start = list(body).index(heading)
    lines = [child for child in list(body)[start:start + 3] if child.tag == WNS + "p"]
    if len(lines) != 3:
        return 0

    seal = next((run for run in runs_of(heading) if run.find(WNS + "drawing") is not None), None)
    if seal is None:
        return 0

    table = make_table(None, [[[], []]],
                       [LETTERHEAD_COLUMN, CONTENT_WIDTH - LETTERHEAD_COLUMN])
    left, right = table.findall(WNS + "tr")[0].findall(WNS + "tc")

    mark = left.find(WNS + "p")
    set_property(mark, "jc", {"val": "left"})
    heading.remove(seal)
    mark.append(seal)

    right.remove(right.find(WNS + "p"))
    for paragraph in lines:
        body.remove(paragraph)
        drop_tabs(paragraph)
        for empty in [run for run in runs_of(paragraph) if not list(run)]:
            paragraph.remove(empty)
        set_tabs(paragraph, [])
        set_indent(paragraph, left=0, right=0, firstLine=0)
        right.append(paragraph)

    body.insert(start, table)
    doc.reindex()
    return 1


# The two agency marks, at the resolution they print at. The conversion's
# copies are 56 and 257 pixels wide, which is 190 dpi at the size they are
# printed, and they read as a smudge on screen at any zoom. `template/logos/`
# holds them rendered at 600 dpi of that size from the official artwork — the
# Equal Housing Opportunity vector logo and the department's own NYC Health
# file — quantised to the few colours each of them actually uses, which makes
# both of them smaller than what they replace.
ARTWORK = {
    "word/media/image34.png": ROOT / "lease" / "template" / "logos" / "equal-housing.png",
    "word/media/image1.png": ROOT / "lease" / "template" / "logos" / "nyc-health.png",
}


def fix_logo_artwork(doc):
    """Both agency marks come from `template/logos/`, not from the PDF."""
    package = doc.package
    if package is None:
        return 0
    changed = 0
    for name, source in ARTWORK.items():
        wanted = source.read_bytes()
        if package.read_bytes(name) == wanted:
            continue
        package.write_bytes(name, wanted)
        changed += 1
    return changed


# Whose document this is. The conversion left the answer to somebody else:
# no author at all in docProps/core.xml, "Aspose Ltd." — the library the
# landlord's e-signature service converted the form with — as the custom
# Creator property, and a Google Docs comment store still holding a colleague's
# email address, their Google account id and the text of editing suggestions
# made on the original. Every one of those travels with each lease sent out.
IDENTITY = "Star Real Estate, Inc."
CORE = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        '<cp:coreProperties'
        ' xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
        ' xmlns:dc="http://purl.org/dc/elements/1.1/"'
        ' xmlns:dcterms="http://purl.org/dc/terms/"'
        ' xmlns:dcmitype="http://purl.org/dc/dcmitype/"'
        ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        '<dc:title>New York Residential Lease Agreement</dc:title>'
        f'<dc:creator>{IDENTITY}</dc:creator>'
        f'<cp:lastModifiedBy>{IDENTITY}</cp:lastModifiedBy>'
        '<dcterms:created xsi:type="dcterms:W3CDTF">2024-07-31T23:14:02Z</dcterms:created>'
        '</cp:coreProperties>')


def fix_document_identity(doc):
    """Name the agency as the author, and drop what the conversion left.

    The created date stays what the form says: this tool writes the same bytes
    every time it runs, and a clock would break that.
    """
    package = doc.package
    if package is None:
        return 0

    changed = 0
    if package.read("docProps/core.xml") != CORE:
        package.write("docProps/core.xml", CORE)
        changed += 1

    # The Google Docs comment store, and the properties the converter stamped.
    for part in ("customXML/", "docProps/custom.xml"):
        if not any(name.startswith(part) for name in package.names()):
            continue
        package.unlink(lambda target, part=part: part.strip("/") in target)
        package.drop(lambda name, part=part: name.startswith(part))
        package.drop_content_types(lambda name, part=part: name.startswith(part))
        changed += 1

    rels = package.read("_rels/.rels")
    trimmed = re.sub(r'<Relationship [^>]*Target="docProps/custom\.xml"[^>]*/>', "", rels)
    if trimmed != rels:
        package.write("_rels/.rels", trimmed)
        changed += 1
    return changed


FIXES = [
    ("sections", fix_sections),
    ("payment details", fix_payment_details),
    ("notice table", fix_notice_table),
    ("key table", fix_key_table),
    ("window guards", fix_window_guards),
    ("bedbug form", fix_bedbug_form),
    ("sprinkler options", fix_sprinkler),
    ("gas provider", fix_gas_provider),
    ("consent title", fix_consent_title),
    ("consent section A", fix_consent_section_a),
    ("consent section B", fix_consent_section_b),
    ("good cause unit block", fix_good_cause_unit),
    ("good cause answers", fix_good_cause_answers),
    ("table grids", fix_table_grids),
    ("ruled cells", fix_ruled_cells),
    ("landlord signature", fix_landlord_signature),
    ("label rules", fix_label_rules),
    ("signature alignment", fix_signature_alignment),
    ("boxed headings", fix_boxed_headings),
    ("binding contract box", fix_binding_box),
    ("empty text boxes", fix_empty_text_boxes),
    ("collapsed shapes", fix_collapsed_shapes),
    ("notice rows", fix_notice_rows),
    ("fee cap line", fix_fee_cap_line),
    ("window guard lines", fix_window_guard_lines),
    ("bedbug premises", fix_bedbug_premises),
    ("sprinkler marks", fix_sprinkler_marks),
    ("consent contact", fix_consent_contact),
    ("consent signatures", fix_consent_signatures),
    ("good cause spacing", fix_good_cause_spacing),
    ("underlined marks", fix_underlined_marks),
    ("floating logos", fix_floating_logos),
    ("consent letterhead", fix_consent_letterhead),
    ("bedbug frame", fix_bedbug_frame),
    ("section padding", fix_section_padding),
    ("table columns", fix_table_columns),
    ("signature columns", fix_signature_columns),
    ("rule widths", fix_rule_widths),
    ("page footers", fix_page_footers),
    ("logo artwork", fix_logo_artwork),
    ("document identity", fix_document_identity),
]


def main():
    if not TEMPLATE.exists():
        sys.exit(f"template not found: {TEMPLATE}")

    with zipfile.ZipFile(TEMPLATE) as archive:
        entries = [(info, archive.read(info.filename)) for info in archive.infolist()]

    package = Package(entries)
    xml_text = package.read("word/document.xml")
    register_namespaces(xml_text)
    doc = Doc(ET.fromstring(xml_text), package)

    total = 0
    for name, fix in FIXES:
        doc.reindex()
        count = fix(doc)
        total += count
        print(f"{name}: {count} change(s)" if count else f"{name}: already applied")

    if total == 0:
        print("nothing to do")
        return 0

    body = ET.tostring(doc.root, encoding="utf-8", xml_declaration=False).decode("utf-8")
    package.write("word/document.xml", DECLARATION + body)

    backup = TEMPLATE.with_suffix(".docx.bak")
    shutil.copy2(TEMPLATE, backup)
    package.save(TEMPLATE)

    print(f"\n{total} change(s) written; backup at {backup.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
