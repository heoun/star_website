#!/usr/bin/env python3
"""Open the signature tables so the e-signature stamp clears the text above it.

DocuSign's signature stamp is 25pt tall and rests 1.5pt below its line, so
every signature line needs 26.5pt clear above it. Measured on the converted
PDF, the "Tenant:" heading left 14pt, "Landlord or Landlord's Representative:"
12.8pt, and the first row's Print Name line left 18.9pt above the second
row's signature line. Three edits, all on the section 47 style tables the
riders share, give each of those about 4pt of clearance:

- the tenant table's heading row grows from 265 to 600 twips;
- the tenant table's first Print Name row grows from 320 to 560 twips, so a
  second row of signatures no longer reaches the names above it;
- the landlord heading paragraph gains 360 twips after it.

Only the signature areas move; no text or placeholder changes. Idempotent;
run after reflow-template.py.
"""
import re, sys, zipfile
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parents[1] / "template" / "lease-template.docx"
HEADING_ROW = ('<w:trHeight w:val="265" w:hRule="atLeast" />', '<w:trHeight w:val="600" w:hRule="atLeast" />')
NAME_ROW = ('<w:trHeight w:val="320" w:hRule="atLeast" />', '<w:trHeight w:val="560" w:hRule="atLeast" />')
HEADING = 'Landlord or Landlord’s Representative:'
HEADING_SPACING = ('<w:spacing w:before="125" w:lineRule="auto" />', '<w:spacing w:before="125" w:after="360" w:lineRule="auto" />')


def tenant_table(t: str) -> bool:
    rows = re.findall(r"<w:tr\b[\s\S]*?</w:tr>", t)
    return len(rows) == 5 and "Tenant:" in rows[0] and "Signature:" in rows[1] and "Print Name:" in rows[2]


def rewrite(xml: str) -> tuple[str, dict[str, int]]:
    counts = {"heading rows": 0, "name rows": 0, "landlord headings": 0}

    def table(m):
        t = m.group(0)
        if not tenant_table(t):
            return t
        rows = re.findall(r"<w:tr\b[\s\S]*?</w:tr>", t)
        if HEADING_ROW[0] in rows[0]:
            counts["heading rows"] += 1
            t = t.replace(rows[0], rows[0].replace(HEADING_ROW[0], HEADING_ROW[1], 1), 1)
        if NAME_ROW[0] in rows[2]:
            counts["name rows"] += 1
            # Row 3 carries the same height; only the first Print Name row grows.
            start = t.index(rows[2], t.index(rows[1]) + len(rows[1]))
            t = t[:start] + rows[2].replace(NAME_ROW[0], NAME_ROW[1], 1) + t[start + len(rows[2]):]
        return t

    xml = re.sub(r"<w:tbl\b[\s\S]*?</w:tbl>", table, xml)

    def paragraph(m):
        p = m.group(0)
        if HEADING not in p or HEADING_SPACING[0] not in p:
            return p
        counts["landlord headings"] += 1
        return p.replace(HEADING_SPACING[0], HEADING_SPACING[1], 1)

    xml = re.sub(r"<w:p\b[^>]*>[\s\S]*?</w:p>", paragraph, xml)
    return xml, counts


def main() -> int:
    with zipfile.ZipFile(TEMPLATE) as z:
        entries = [(i, z.read(i.filename)) for i in z.infolist()]
    xml = next(d for i, d in entries if i.filename == "word/document.xml").decode("utf-8")
    new, counts = rewrite(xml)
    if not any(counts.values()):
        print("already spaced; nothing to do")
        return 0
    bad = {k: v for k, v in counts.items() if v not in (0, 12)}
    if bad:
        print(f"expected 12 of each edit (or none), found {counts}; template not written")
        return 1
    tmp = TEMPLATE.with_suffix(".docx.tmp")
    with zipfile.ZipFile(tmp, "w") as out:
        for info, data in entries:
            if info.filename == "word/document.xml":
                data = new.encode("utf-8")
            out.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
    tmp.replace(TEMPLATE)
    print("spaced " + ", ".join(f"{v} {k}" for k, v in counts.items() if v))
    return 0


if __name__ == "__main__":
    sys.exit(main())
