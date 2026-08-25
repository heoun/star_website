#!/usr/bin/env python3
"""Writes the spreadsheet of what is on the lease and what is not.

Two sheets, one per party, two columns each: what the document prints, and what
we hold that it never mentions.

The grouping lives inside the column rather than beside it — a heading row, then
its items indented under it — so the sheet stays two columns wide while still
saying which part of the lease each value belongs to. Those groups are read off
the template itself: the document each placeholder lands in, and inside the main
lease the clause it sits under. Move a value to another rider and it moves here.

    python3 lease/tools/export-sheet.py [output.xlsx]

Defaults to notes/lease-information.xlsx, which is outside git.
"""

import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
REGISTRY = ROOT / "lease" / "schema" / "fields.json"
TEMPLATE = ROOT / "lease" / "template" / "lease-template.docx"

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
PLACEHOLDER = re.compile(r"\{\{([a-z0-9_.]+)\}\}")

# A clause opens with an ALL-CAPS run ending in a period. Only the main lease is
# read for these: the statutory forms have no clause structure of their own, and
# the last heading of the lease body would otherwise be carried onto them.
CLAUSE = re.compile(r"^\s*([A-Z][A-Z0-9 &/'’,\-]{3,60}?)\.")
MAIN_LEASE = 17

DOCUMENTS = [
    (1, 17, "主租约 RESIDENTIAL LEASE AGREEMENT"),
    (18, 19, "UTILITY ADDENDUM 水电分摊"),
    (20, 20, "PACKAGES RIDER 包裹"),
    (21, 21, "KEY RIDER 钥匙"),
    (22, 23, "RENTERS INSURANCE RIDER 租客保险"),
    (24, 28, "COMMUNITY RULES RIDER 社区规则"),
    (29, 29, "FINE SCHEDULE 罚则表"),
    (30, 30, "WINDOW GUARD NOTICE 防护栏通知"),
    (31, 31, "BEDBUG DISCLOSURE 臭虫披露"),
    (32, 32, "SPRINKLER NOTICE 喷淋通知"),
    (33, 33, "INDOOR ALLERGEN NOTICE 室内过敏原通知"),
    (34, 35, "GAS / CO / SMOKE ALARM RIDER 燃气与警报器"),
    (36, 38, "SMOKING POLICY RIDER 吸烟政策"),
    (39, 39, "RENT CONCESSION RIDER 租金优惠"),
    (40, 41, "DHCR CONSENT DHCR 电子租约同意书"),
    (42, 46, "GOOD CAUSE NOTICE 正当理由驱逐通知"),
]


def document_of(page):
    for first, last, name in DOCUMENTS:
        if first <= page <= last:
            return name
    return ""


def read_template(path):
    """Where every placeholder prints: its pages, and its clause in the lease."""
    body = ET.fromstring(zipfile.ZipFile(path).read("word/document.xml")).find(W + "body")

    pages, current = [], []
    for element in body:
        current.append(element)
        closes = element.tag == W + "sectPr" or (
            element.tag == W + "p" and element.find(W + "pPr/" + W + "sectPr") is not None)
        if closes:
            pages.append(current)
            current = []
    if current:
        pages.append(current)

    found, heading = {}, ""
    for number, elements in enumerate(pages, 1):
        for element in elements:
            text = re.sub(r"\s+", " ", "".join(element.itertext())).strip()
            if not text:
                continue
            opener = CLAUSE.match(text)
            if opener and element.tag == W + "p" and number <= MAIN_LEASE:
                heading = opener.group(1).strip()
            for name in PLACEHOLDER.findall(text):
                place = found.setdefault(
                    name, {"pages": [], "clause": heading if number <= MAIN_LEASE else ""})
                if number not in place["pages"]:
                    place["pages"].append(number)
    return found, len(pages)


def page_range(numbers):
    if not numbers:
        return ""
    spans, start, previous = [], numbers[0], numbers[0]
    for number in numbers[1:]:
        if number == previous + 1:
            previous = number
            continue
        spans.append((start, previous))
        start = previous = number
    spans.append((start, previous))
    return ", ".join(f"p{a}" if a == b else f"p{a}-{b}" for a, b in spans)
# ------------------------------------------------------------ xlsx writing
#
# A small writer rather than a dependency: an .xlsx is an OPC zip like the
# lease template, and this repository ships no runtime dependencies.

STYLES = {
    "title": 1, "subtitle": 2, "head": 3, "cell": 4, "wrap": 5,
    "yes": 6, "no": 7, "mono": 9, "warn": 10, "num": 11,
    # The grouping lives inside the column, so depth is carried by indent:
    # doc opens a group, sub is a clause inside it, item sits under a sub and
    # item1 directly under a doc.
    "part": 8, "doc": 12, "clause": 15, "item": 13, "item1": 16,
}


def styles_xml():
    fonts = [
        '<font><sz val="11"/><name val="Calibri"/></font>',
        '<font><b/><sz val="16"/><color rgb="FF14213D"/><name val="Calibri"/></font>',
        '<font><sz val="10"/><color rgb="FF6B7280"/><name val="Calibri"/></font>',
        '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>',
        '<font><sz val="10"/><name val="Consolas"/></font>',
        '<font><b/><sz val="12"/><color rgb="FF14213D"/><name val="Calibri"/></font>',
        '<font><sz val="11"/><color rgb="FF166534"/><name val="Calibri"/></font>',
        '<font><sz val="11"/><color rgb="FF6B7280"/><name val="Calibri"/></font>',
        '<font><b/><sz val="11"/><color rgb="FF9A3412"/><name val="Calibri"/></font>',
    ]
    fills = [
        '<fill><patternFill patternType="none"/></fill>',
        '<fill><patternFill patternType="gray125"/></fill>',
        '<fill><patternFill patternType="solid"><fgColor rgb="FF14213D"/><bgColor indexed="64"/></patternFill></fill>',
        '<fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill>',
        '<fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill>',
        '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EDF5"/><bgColor indexed="64"/></patternFill></fill>',
        '<fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/><bgColor indexed="64"/></patternFill></fill>',
    ]
    thin = ('<border><left style="thin"><color rgb="FFD1D5DB"/></left>'
            '<right style="thin"><color rgb="FFD1D5DB"/></right>'
            '<top style="thin"><color rgb="FFD1D5DB"/></top>'
            '<bottom style="thin"><color rgb="FFD1D5DB"/></bottom></border>')
    borders = ['<border/>', thin]
    top = '<alignment vertical="top" wrapText="1"/>'
    xfs = [
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
        f'<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
        f'<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">{top}</xf>',
        f'<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>',
        f'<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">{top}</xf>',
        f'<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">{top}</xf>',
        f'<xf numFmtId="0" fontId="6" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" horizontal="center" wrapText="1"/></xf>',
        f'<xf numFmtId="0" fontId="7" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" horizontal="center" wrapText="1"/></xf>',
        f'<xf numFmtId="0" fontId="5" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>',
        f'<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">{top}</xf>',
        f'<xf numFmtId="0" fontId="8" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">{top}</xf>',
        f'<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" horizontal="center"/></xf>',
        f'<xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1" indent="1"/></xf>',
        f'<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1" indent="3"/></xf>',
        f'<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1" indent="1"/></xf>',
        f'<xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1" indent="2"/></xf>',
        f'<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1" indent="2"/></xf>',
    ]
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'<fonts count="{len(fonts)}">{"".join(fonts)}</fonts>'
            f'<fills count="{len(fills)}">{"".join(fills)}</fills>'
            f'<borders count="{len(borders)}">{"".join(borders)}</borders>'
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            f'<cellXfs count="{len(xfs)}">{"".join(xfs)}</cellXfs>'
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
            '</styleSheet>')


def escape(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def column_name(index):
    name = ""
    while index > 0:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name


class Sheet:
    def __init__(self, name, widths):
        self.name = name
        self.widths = widths
        self.rows = []
        self.merges = []
        self.freeze = None
        self.filter = None

    def row(self, cells, height=None):
        self.rows.append((cells, height))
        return len(self.rows)

    def blank(self):
        self.row([])

    def title(self, text, subtitle=None):
        self.row([(text, "title")], 26)
        if subtitle:
            self.row([(subtitle, "subtitle")], 30)
            self.merges.append((len(self.rows), 1, len(self.rows), len(self.widths)))
        self.blank()

    def header(self, labels, filtered=False):
        number = self.row([(label, "head") for label in labels], 30)
        self.freeze = number
        if filtered:
            self.filter = (number, len(labels))

    def part(self, text):
        self.blank()
        number = self.row([(text, "part")], 22)
        self.merges.append((number, 1, number, len(self.widths)))

    def xml(self):
        body = []
        for index, (cells, height) in enumerate(self.rows, 1):
            attributes = f' ht="{height}" customHeight="1"' if height else ""
            if not cells:
                body.append(f'<row r="{index}"{attributes}/>')
                continue
            written = []
            for position, cell in enumerate(cells, 1):
                if cell is None:
                    continue
                value, style = cell if isinstance(cell, tuple) else (cell, "cell")
                if value is None or value == "":
                    continue
                reference = f"{column_name(position)}{index}"
                style_id = STYLES[style]
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    written.append(f'<c r="{reference}" s="{style_id}"><v>{value}</v></c>')
                else:
                    written.append(f'<c r="{reference}" s="{style_id}" t="inlineStr">'
                                   f'<is><t xml:space="preserve">{escape(value)}</t></is></c>')
            body.append(f'<row r="{index}"{attributes}>{"".join(written)}</row>')

        columns = "".join(
            f'<col min="{i}" max="{i}" width="{w}" customWidth="1"/>'
            for i, w in enumerate(self.widths, 1))

        views = '<sheetViews><sheetView workbookViewId="0"'
        if self.name.startswith("1"):
            views += ' tabSelected="1"'
        views += ">"
        if self.freeze:
            views += (f'<pane ySplit="{self.freeze}" topLeftCell="A{self.freeze + 1}" '
                      'activePane="bottomLeft" state="frozen"/>')
        views += "</sheetView></sheetViews>"

        extra = ""
        if self.filter:
            row, count = self.filter
            last = len(self.rows)
            extra = f'<autoFilter ref="A{row}:{column_name(count)}{max(last, row)}"/>'
        if self.merges:
            spans = "".join(
                f'<mergeCell ref="{column_name(c1)}{r1}:{column_name(c2)}{r2}"/>'
                for r1, c1, r2, c2 in self.merges)
            extra += f'<mergeCells count="{len(self.merges)}">{spans}</mergeCells>'

        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                f'<dimension ref="A1:{column_name(len(self.widths))}{max(len(self.rows), 1)}"/>'
                f'{views}<sheetFormatPr defaultRowHeight="15"/>'
                f'<cols>{columns}</cols><sheetData>{"".join(body)}</sheetData>{extra}'
                '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>'
                "</worksheet>")


def save(path, sheets):
    path.parent.mkdir(parents=True, exist_ok=True)
    types = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
             '<Default Extension="xml" ContentType="application/xml"/>',
             '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
             '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>']
    entries = []
    relationships = []
    for index, sheet in enumerate(sheets, 1):
        types.append(f'<Override PartName="/xl/worksheets/sheet{index}.xml" '
                     'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
        entries.append(f'<sheet name="{escape(sheet.name)}" sheetId="{index}" r:id="rId{index}"/>')
        relationships.append(
            f'<Relationship Id="rId{index}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            f'Target="worksheets/sheet{index}.xml"/>')
    relationships.append(
        f'<Relationship Id="rId{len(sheets) + 1}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
        'Target="styles.xml"/>')

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml",
                         '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                         '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                         + "".join(types) + "</Types>")
        package.writestr("_rels/.rels",
                         '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                         '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                         '<Relationship Id="rId1" '
                         'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
                         'Target="xl/workbook.xml"/></Relationships>')
        package.writestr("xl/workbook.xml",
                         '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                         '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                         'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                         f'<sheets>{"".join(entries)}</sheets></workbook>')
        package.writestr("xl/_rels/workbook.xml.rels",
                         '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                         '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                         + "".join(relationships) + "</Relationships>")
        package.writestr("xl/styles.xml", styles_xml())
        for index, sheet in enumerate(sheets, 1):
            package.writestr(f"xl/worksheets/sheet{index}.xml", sheet.xml())








# ------------------------------------------------------------------ the tenant

# The application form and the listing record are not the registry, so the
# right-hand columns are written down. Each entry is (depth, text): "doc" opens
# a group, "item1" sits under it.
TENANT_ON = [
    ("doc", "主租约 RESIDENTIAL LEASE AGREEMENT · p1"),
    ("item1", "Tenant name(s) — every tenant on one line, and the Occupants clause"),
    ("item1", "Move-in date"),
    ("item1", "Lease term — prints as the end date, never as a number of months"),
    ("doc", "WINDOW GUARD NOTICE 防护栏通知 · p30"),
    ("item1", "Whether a child aged 10 or younger lives in the apartment"),
    ("item1", "Whether window guards are wanted anyway"),
    ("doc", "DHCR CONSENT DHCR 电子租约同意书 · p41"),
    ("item1", "Email"),
    ("item1", "Mailing address, when it is not the apartment"),
    ("doc", "每一份文件的签字页 SIGNATURE PAGES"),
    ("item1", "Signature, printed name and date"),
]

TENANT_OFF = [
    ("doc", "身份与联系 IDENTITY AND CONTACT"),
    ("item1", "First name"),
    ("item1", "Last name"),
    ("item1", "Phone"),
    ("item1", "Date of birth"),
    ("item1", "Social Security Number"),
    ("item1", "Current address"),
    ("item1", "Household size"),
    ("doc", "财务 FINANCIAL"),
    ("item1", "Annual income"),
    ("doc", "当前雇主 CURRENT EMPLOYMENT"),
    ("item1", "Employer"),
    ("item1", "Position"),
    ("item1", "Start date"),
    ("item1", "Supervisor name"),
    ("item1", "Supervisor phone"),
    ("item1", "Supervisor email"),
    ("doc", "就业史 EMPLOYMENT HISTORY"),
    ("item1", "Previous employers and positions"),
    ("item1", "Dates held"),
    ("item1", "Supervisors, their phones and emails"),
    ("doc", "租房史 RENTAL HISTORY"),
    ("item1", "Previous addresses"),
    ("item1", "Dates of tenancy"),
    ("item1", "Rent paid"),
    ("item1", "Previous landlord names, phones and emails"),
    ("doc", "推荐人 REFERENCES · 至少 3 条"),
    ("item1", "Name"),
    ("item1", "Relationship"),
    ("item1", "Phone and email"),
    ("doc", "紧急联系人 EMERGENCY CONTACTS · 至少 1 条"),
    ("item1", "Name"),
    ("item1", "Relationship"),
    ("item1", "Phone and email"),
    ("doc", "宠物 PETS"),
    ("item1", "Type"),
    ("item1", "Breed or species"),
    ("item1", "Weight"),
    ("doc", "其他 OTHER"),
    ("item1", "Message to the landlord"),
    ("doc", "后台内部 ADMIN ONLY"),
    ("item1", "Application status"),
    ("item1", "Internal notes"),
    ("item1", "What the applicant originally wrote, before any correction"),
]

# ---------------------------------------------------------------- the landlord

# Who may change a value.
#
# The line is the landlord's own, marked up on their copy of the lease: from the
# payee block onwards, every landlord-side value is "filled once, then the
# default, and only a manager may change it — an agent has no permission". That
# covers the notice table, the utility form, the keys, the fine schedule, the
# bedbug, sprinkler, gas and smoking disclosures, the DHCR lease description and
# the whole Good Cause notice.
#
# What is left for the agent is only what the tenancy itself decides: what this
# tenant pays, when they move in, and what was granted to get them to sign.
PER_DEAL_FIELDS = set()

PER_DEAL_EXTRA = {
    "主租约 RESIDENTIAL LEASE AGREEMENT": [
        "Monthly rent",
        "Security deposit — one month's rent, the New York maximum",
        "Lease start and end dates",
    ],
    "BEDBUG DISCLOSURE 臭虫披露": [
        "Date of vacancy lease — 这一份租约自己的日期（上面的病史勾选归 Manager）",
    ],
    "RENT CONCESSION RIDER 租金优惠": ["Rent concession — the terms of the rider"],
}

DEFAULT_EXTRA = {
    "主租约 RESIDENTIAL LEASE AGREEMENT": [
        "Unit address — street, unit, city, state, ZIP",
        "Signature, printed name and date",
    ],
    "DHCR CONSENT DHCR 电子租约同意书": [
        "Vacancy lease or renewal lease   ← ⚑ 待改代码：注册表里还是 deal 值，"
        "要改成 manager。在那之前没有任何东西会算它，两个框都会印成空的",
    ],
}

# Only where the annotated original says something the label does not.
NOTES = {
    "landlord.entity_name": "§1 PARTIES 里「(the \u201cLandlord\u201d)」前那个蓝色空白就是它。"
                            "同一个值还印在 9 份 rider 的抬头上，填一次、错一次就是九页全错",
    "payee.name": "§4.E · 条款写「Landlord may modify this information from time to time at "
                  "Landlord's sole discretion」",
    "legal_notice.name": "§25 右栏抬头是「Landlord **or** person authorized to receive legal "
                         "service of process」——填房东本身即可，不必另设代理人",
    "manager.name": "§25 左栏「for repairs, billing, building management, questions etc.」",
    "utility.water": "批注：Landlord ＝ 房东付；Tenant ＝ 租客付；N/A ＝ 无此项服务",
    "utility.other1": "⚑ 待改代码：默认值改为 N/A。现在是 Landlord 而名称栏空着，"
                      "每份租约都会印出「Other: ___ ┆ Landlord」——让人为一个空白负责",
    "utility.other2": "⚑ 待改代码：同上，现在默认 Tenant",
    "fee.lptli_monthly": "批注确认保留，$25.00 为默认",
    "fee.renters_insurance_waiver_monthly": "批注确认保留，$25.00 为默认",
    "fee.lptli_admin_monthly": "原件此格留空",
    "fine.smoking_indoors": "批注：整张罚则表以原件金额为默认（已核对，10 条一字不差）",
    "sprinkler.mark_option2": "原件勾 Option 2，检查日 6/28/2024",
    "bedbug.mark_none": "原件勾「无记录」",
    "smoking.inside_units": "原件只勾「Inside of residential units」",
    "gas.provider_name": "原件：Con Edison / 1 (800) 752-6633",
}

GOOD_CAUSE_NOTE = (
    "批注：「这个和这个之后的所有的」都是 Manager's setting。"
    "实际每份新租约只答 2–3 项：是否适用、豁免理由、以及问题 4 的 A 或 B"
)


def landlord_columns(registry, placed):
    """Two parts, each grouped the way the template groups it."""
    default, per_deal = [], []

    for first, last, name in DOCUMENTS:
        in_document = [f for f in registry["fields"]
                       if f["source"] == "manager"
                       and placed.get(f["id"], {}).get("pages")
                       and first <= placed[f["id"]]["pages"][0] <= last]

        for rows, fields, extra in (
            (default, [f for f in in_document if f["id"] not in PER_DEAL_FIELDS],
             DEFAULT_EXTRA.get(name, [])),
            (per_deal, [f for f in in_document if f["id"] in PER_DEAL_FIELDS],
             PER_DEAL_EXTRA.get(name, [])),
        ):
            if not fields and not extra:
                continue
            span = page_range(sorted({p for f in fields
                                      for p in placed[f["id"]]["pages"] if first <= p <= last}))
            rows.append(("doc", f"{name} · {span or page_range([first])}"))
            for line in extra:
                rows.append(("item1", line))

            # Inside the main lease a value belongs to a clause; the statutory
            # forms are one question each and a heading would repeat itself.
            clauses = {}
            for field in fields:
                clauses.setdefault(placed[field["id"]]["clause"], []).append(field)
            for clause, group in clauses.items():
                if clause:
                    where = page_range(sorted({p for f in group
                                               for p in placed[f["id"]]["pages"]
                                               if first <= p <= last}))
                    rows.append(("clause", f"{clause} · {where}"))
                for field in group:
                    note = NOTES.get(field["id"])
                    label = f"{field['label']}   ← {note}" if note else field["label"]
                    rows.append(("item" if clause else "item1", label))
            if name.startswith("GOOD CAUSE") and rows is default:
                rows.append(("item1", f"← {GOOD_CAUSE_NOTE}"))

    return ([("part", "MANAGER'S SETTING · 一次性填，之后默认 — Agent 没有权限改")]
            + [("item1", "⚑ ＝ 已定但代码还没改，见本页三处")] + default
            + [("part", "每笔交易不同 · Agent 可改")] + per_deal)


LANDLORD_OFF = [
    ("part", "从来不进租约 NEVER ON THE LEASE"),
    ("doc", "房源资料 LISTING RECORD"),
    ("item1", "Listing title"),
    ("item1", "Building name"),
    ("item1", "Description"),
    ("item1", "Price as displayed — the lease prints the number, not the wording"),
    ("item1", "Property type"),
    ("item1", "Use type"),
    ("item1", "Size"),
    ("item1", "Term label"),
    ("item1", "Neighbourhood"),
    ("item1", "Bedrooms"),
    ("item1", "Bathrooms"),
    ("item1", "Residential or commercial"),
    ("item1", "Sale or rental"),
    ("doc", "媒体 MEDIA"),
    ("item1", "Photographs"),
    ("item1", "Floor plans"),
    ("item1", "Video"),
    ("item1", "Details link"),
    ("doc", "后台内部 ADMIN ONLY"),
    ("item1", "Published or unpublished"),
    ("item1", "Position in the list"),
    ("item1", "Which settings layer answered each value"),
    ("item1", "State abbreviation — only used to assemble the address line"),
]


# ------------------------------------------------------------------ the sheets

def cell(column, index):
    if index >= len(column):
        return None
    style, text = column[index]
    return (text, style)


def two_columns(name, left, right):
    sheet = Sheet(name, [88, 60])
    sheet.header(["On the lease", "Not on the lease"])
    for index in range(max(len(left), len(right))):
        sheet.row([cell(left, index), cell(right, index)])
    return sheet


def main():
    registry = json.load(open(REGISTRY))
    placed, pages = read_template(TEMPLATE)
    landlord = landlord_columns(registry, placed)

    sheets = [
        two_columns("Tenant", TENANT_ON, TENANT_OFF),
        two_columns("Landlord", landlord, LANDLORD_OFF),
    ]

    output = Path(sys.argv[1]) if len(sys.argv) > 1 \
        else ROOT / "notes" / "lease-information.xlsx"
    save(output, sheets)

    count = lambda rows: sum(1 for style, text in rows
                             if style.startswith("item") and not text.startswith("\u2190"))
    split = [i for i, (style, _) in enumerate(landlord) if style == "part"]
    print(f"{output}  ({output.stat().st_size:,} bytes)")
    print(f"  Tenant     on the lease {count(TENANT_ON):>3}  ·  not {count(TENANT_OFF):>3}")
    print(f"  Landlord   Manager's setting {count(landlord[split[0]:split[1]]):>3}"
          f"  ·  Agent {count(landlord[split[1]:]):>3}"
          f"  ·  not on the lease {count(LANDLORD_OFF):>3}")


if __name__ == "__main__":
    main()
