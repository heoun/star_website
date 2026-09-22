#!/usr/bin/env python3
"""One-off. Two changes to lease/template/lease-template.docx.

1. Underline every text placeholder, the way a filled-in blank is underlined on
   a paper lease. The runs carrying placeholders inherited w:u val="none" from
   the landlord's filled copy, so a filled value printed as plain body text,
   indistinguishable from the clause around it.

   A placeholder usually does NOT have a run to itself: 51 of the 166 runs that
   carry one also carry prose. Underlining the whole run underlines the clause,
   so each such run is split and only the placeholder half is underlined. What
   the prose half should go back to is read from the landlord's original file,
   because this document does use real underlines in places (316 runs) and
   guessing would erase them.

   Check boxes are excluded: an underlined "[X]" is just wrong.

2. Replace the form's footer credit line.

Idempotent. Run it, then verify with check-fields.py and test-lease.mjs.

    python3 lease/tools/restyle-template.py
"""

import copy
import json
import pathlib
import re
import shutil
import sys
import zipfile
import xml.etree.ElementTree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WNS = "{%s}" % W
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"

ROOT = pathlib.Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "lease" / "template" / "lease-template.docx"
REGISTRY = ROOT / "lease" / "schema" / "fields.json"
ORIGINAL = ROOT / "Lease Template (2).docx"

OLD_CREDIT = "2024 © Yardi Systems, Inc. All Rights Reserved."
NEW_CREDIT = "2026 © Star Real Estate, Inc. All Rights Reserved."

PLACEHOLDER = re.compile(r"\{\{[a-z0-9_.]+\}\}")


def register_namespaces(xml_text):
    """Keep Word's own prefixes; ElementTree renames them to ns0/ns1 otherwise."""
    for prefix, uri in re.findall(r'xmlns:([A-Za-z0-9]+)="([^"]+)"', xml_text[:4000]):
        ET.register_namespace(prefix, uri)


def run_text(run):
    return "".join(node.text or "" for node in run.findall(WNS + "t"))


def underline_of(run):
    """'single' / 'none' / None, where None means the run said nothing."""
    props = run.find(WNS + "rPr")
    if props is None:
        return None
    node = props.find(WNS + "u")
    if node is None:
        return None
    return node.get(WNS + "val") or "single"


def set_underline(props, value):
    node = props.find(WNS + "u")
    if value is None:
        if node is not None:
            props.remove(node)
        return
    if node is None:
        node = ET.SubElement(props, WNS + "u")
    node.set(WNS + "val", value)


def prose_underlines():
    """Map a distinctive prose fragment to the underline the landlord's file used.

    Restoring the prose half of a split run needs the value the run had before
    this script first touched it, and that only survives in the original.
    """
    if not ORIGINAL.exists():
        return None

    with zipfile.ZipFile(ORIGINAL) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))

    table = []
    for run in root.iter(WNS + "r"):
        text = run_text(run)
        if len(text.strip()) >= 8:
            table.append((text, underline_of(run)))
    return table


def lookup(table, fragments):
    """Find the original underline using the longest CONTIGUOUS prose fragment.

    Concatenating the prose either side of a placeholder produces a string that
    never occurs in the original, because the value sat between them.
    """
    if table is None:
        return None, False
    for needle in sorted((f.strip() for f in fragments), key=len, reverse=True):
        if len(needle) < 8:
            break
        for text, value in table:
            if needle in text:
                return value, True
    return None, False


def tokenize(text):
    """[(piece, is_placeholder)] preserving order and every character."""
    out = []
    last = 0
    for match in PLACEHOLDER.finditer(text):
        if match.start() > last:
            out.append((text[last:match.start()], False))
        out.append((match.group(0), True))
        last = match.end()
    if last < len(text):
        out.append((text[last:], False))
    return out or [(text, False)]


def rebuild_run(run, prose_value):
    """Split one run so only its placeholder pieces are underlined.

    Returns the replacement runs, or None when the run needs no splitting.
    """
    props = run.find(WNS + "rPr")
    pieces = []  # (is_placeholder, element)

    for child in run:
        if child.tag == WNS + "rPr":
            continue
        if child.tag != WNS + "t":
            pieces.append((None, child))
            continue
        for piece, is_placeholder in tokenize(child.text or ""):
            if piece == "":
                continue
            node = ET.Element(WNS + "t")
            node.text = piece
            node.set(XML_SPACE, "preserve")
            pieces.append((is_placeholder, node))

    if not any(flag is True for flag in (p[0] for p in pieces)):
        return None

    # Anything that is not a placeholder keeps the prose formatting, including
    # tabs and drawings, which must stay in place.
    groups = []
    for is_placeholder, node in pieces:
        want = bool(is_placeholder)
        if groups and groups[-1][0] == want:
            groups[-1][1].append(node)
        else:
            groups.append((want, [node]))

    runs = []
    for want, nodes in groups:
        clone = ET.Element(WNS + "r")
        if props is not None:
            new_props = copy.deepcopy(props)
            set_underline(new_props, "single" if want else prose_value)
            clone.append(new_props)
        elif want:
            new_props = ET.SubElement(clone, WNS + "rPr")
            set_underline(new_props, "single")
        for node in nodes:
            clone.append(node)
        runs.append(clone)
    return runs


def para_replace(paragraph, find, repl):
    """Replace `find` with `repl` inside one paragraph, across run boundaries."""
    changed = 0
    while True:
        nodes = list(paragraph.iter(WNS + "t"))
        texts = [n.text or "" for n in nodes]
        start = "".join(texts).find(find)
        if start < 0:
            return changed
        end = start + len(find)
        cursor = 0
        for node, text in zip(nodes, texts):
            first, last = cursor, cursor + len(text)
            cursor = last
            if last <= start or first >= end:
                continue
            a = max(start, first) - first
            b = min(end, last) - first
            node.text = text[:a] + (repl if first <= start < last else "") + text[b:]
            node.set(XML_SPACE, "preserve")
        changed += 1


def main():
    if not TEMPLATE.exists():
        sys.exit(f"{TEMPLATE} is missing.")

    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    boxes = {f["id"] for f in registry["fields"] if f["type"] == "checkbox"}
    box_only = re.compile(r"\{\{(" + "|".join(re.escape(i) for i in boxes) + r")\}\}")

    table = prose_underlines()
    if table is None:
        print("note: the landlord's original is not here, so prose falls back to no underline")

    with zipfile.ZipFile(TEMPLATE) as archive:
        entries = [(i, archive.read(i.filename)) for i in archive.infolist()]

    xml_text = next(d for i, d in entries if i.filename == "word/document.xml").decode("utf-8")
    register_namespaces(xml_text)
    root = ET.fromstring(xml_text)

    split = 0
    plain = 0
    skipped = 0
    guessed = 0

    for paragraph in root.iter(WNS + "p"):
        children = list(paragraph)
        for index, run in enumerate(children):
            if run.tag != WNS + "r":
                continue
            text = run_text(run)
            if not PLACEHOLDER.search(text):
                continue
            if not PLACEHOLDER.sub("", box_only.sub("", text)).strip() and box_only.search(text):
                skipped += 1
                continue

            fragments = [piece for piece, is_ph in tokenize(text) if not is_ph and piece.strip()]
            if fragments:
                value, found = lookup(table, fragments)
                if not found:
                    value = "none"
                    guessed += 1
            else:
                value = underline_of(run)

            replacement = rebuild_run(run, value)
            if replacement is None:
                continue

            position = list(paragraph).index(run)
            paragraph.remove(run)
            for offset, clone in enumerate(replacement):
                paragraph.insert(position + offset, clone)
            if len(replacement) > 1:
                split += 1
            else:
                plain += 1

    credits = 0
    for paragraph in root.iter(WNS + "p"):
        credits += para_replace(paragraph, OLD_CREDIT, NEW_CREDIT)

    body = ET.tostring(root, encoding="utf-8", xml_declaration=False).decode("utf-8")
    body = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + body

    backup = TEMPLATE.with_suffix(".docx.bak")
    shutil.copy2(TEMPLATE, backup)

    with zipfile.ZipFile(TEMPLATE, "w", zipfile.ZIP_DEFLATED) as out:
        for info, data in entries:
            out.writestr(info, body.encode("utf-8") if info.filename == "word/document.xml" else data)

    print(f"{plain} run(s) were placeholder only and were underlined whole")
    print(f"{split} run(s) held prose as well and were split")
    print(f"{skipped} check-box run(s) left alone")
    print(f"{guessed} prose fragment(s) had no match in the original and fell back to no underline")
    print(f"replaced {credits} credit line(s)")
    print(f"backup at {backup.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
