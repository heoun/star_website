#!/usr/bin/env python3
"""Turn the filled-in source lease into the clean variable template.

Run once against the lease Yardi/the landlord issued (a real signed lease with
one tenant's data in it) to produce lease/template/lease-template.docx, where
every tenant-, deal-, and building-specific value has become a {{placeholder}}.

    python3 lease/tools/build-template.py "Lease Template (2).docx"

After this has run, the .docx IS the source of truth. To change wording or add
a field, edit the template in Word and register the new field in
lease/schema/fields.json. You only need this script again if the landlord
reissues the base form and the whole template has to be rebuilt from scratch.

The script only rewrites text inside w:t nodes, so every style, table, page
break, and embedded form graphic in the original survives untouched.
"""

import re
import shutil
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
LQ, RQ = "“", "”"  # curly quotes, as they appear in the source
APOS = "’"    # curly apostrophe, likewise

REPO = Path(__file__).resolve().parents[2]
OUT_DOCX = REPO / "lease" / "template" / "lease-template.docx"


# --------------------------------------------------------------------------
# Paragraph-level text surgery
# --------------------------------------------------------------------------

def para_runs_text(p):
    """Concatenated visible text of a paragraph, w:t nodes only.

    Tabs and images live in their own elements, so they are invisible here.
    That is deliberate: it lets a match span a tab (e.g. "NO<tab>X") without
    the tab getting in the way of the search string.
    """
    return "".join(n.text or "" for n in p.iter(W + "t"))


def para_replace(p, find, repl, limit=None):
    """Replace `find` with `repl` inside one paragraph, across run boundaries.

    Word splits a sentence into runs wherever formatting changes, so a value
    like "37-34 33rd Street, ... NY" + " " + "11101" is three runs. This walks
    the w:t nodes the match covers, drops `repl` into the first one, and
    deletes the covered text from the rest.
    """
    done = 0
    while limit is None or done < limit:
        nodes = list(p.iter(W + "t"))
        texts = [n.text or "" for n in nodes]
        idx = "".join(texts).find(find)
        if idx < 0:
            break
        end = idx + len(find)
        pos = 0
        for node, txt in zip(nodes, texts):
            start, stop = pos, pos + len(txt)
            pos = stop
            if stop <= idx or start >= end:
                continue
            a = max(idx, start) - start
            b = min(end, stop) - start
            node.text = txt[:a] + (repl if start <= idx < stop else "") + txt[b:]
            node.set(XML_SPACE, "preserve")
        done += 1
    return done


def set_text(p, new_text):
    """Force a paragraph's text, keeping the first run's formatting."""
    nodes = list(p.iter(W + "t"))
    if not nodes:
        run = ET.SubElement(p, W + "r")
        node = ET.SubElement(run, W + "t")
        nodes = [node]
    nodes[0].text = new_text
    nodes[0].set(XML_SPACE, "preserve")
    for node in nodes[1:]:
        node.text = ""
    return p


def cell_paras(tc):
    return tc.findall(W + "p")


def set_cell(tc, new_text):
    """Force a table cell's text into its first paragraph."""
    paras = cell_paras(tc)
    if not paras:
        return
    set_text(paras[0], new_text)
    for p in paras[1:]:
        for node in p.iter(W + "t"):
            node.text = ""


# --------------------------------------------------------------------------
# Rules
# --------------------------------------------------------------------------

# Values that mean the same thing everywhere they appear. Longest first, so a
# full address is consumed before its street half can match.
GLOBAL = [
    ("37-34 33rd Street, Unit 4E, Long Island City, NY 11101", "{{property.address_full}}"),
    ("60 Cuttermill Road #405, Great Neck, NY 11021", "{{payee.address}}"),
    ("33rd Street Ventures LLC", "{{payee.name}}"),
    ("Solomon Oh and Nan Ni", "{{tenant.names}}"),
    ("honomolos@gmail.com", "{{tenant.email}}"),
    ("6/28/2024 12:00:00 AM", "{{sprinkler.last_inspection}}"),
    ("July 30, 2024", "{{lease.effective_date}}"),
    ("09/13/2025", "{{lease.end_date}}"),
    ("J.P. Morgan Chase", "{{deposit.bank_name}}"),
    ("1 (800) 752-6633", "{{gas.provider_phone}}"),
    ("22 Grace Ave", "{{deposit.bank_address}}"),
    ("Con Edison", "{{gas.provider_name}}"),
    ("11:59 PM", "{{lease.end_time}}"),
    # Every rider repeats this preamble; the landlord slot was left blank or
    # stubbed with underscores depending on which rider it is.
    (f"by and between (the {LQ}Landlord{RQ})",
     f"by and between {{{{landlord.entity_name}}}} (the {LQ}Landlord{RQ})"),
    (f"by and between _________ (the {LQ}Landlord{RQ})",
     f"by and between {{{{landlord.entity_name}}}} (the {LQ}Landlord{RQ})"),
    (f"by and between ________ (the {LQ}Landlord{RQ})",
     f"by and between {{{{landlord.entity_name}}}} (the {LQ}Landlord{RQ})"),
]

# (paragraph anchor, find, replace) — the anchor picks the paragraphs to touch,
# which is what keeps a short value like "1" or "$25.00" from being replaced
# in the wrong clause.
ANCHORED = [
    ("TERM. The term of the rental",
     "09/14/2024", "{{lease.commencement_date}}"),
    ("Monthly Rent. Tenant shall pay to Landlord",
     "$4,250.00", "{{rent.monthly}}"),
    ("Monthly Rent. Tenant shall pay to Landlord",
     "shall be day 1 of each calendar month",
     "shall be day {{rent.due_day}} of each calendar month"),
    ("Returned Checks or Electronic Payment",
     "a processing fee of $25.00",
     "a processing fee of {{fee.returned_payment}}"),
    ("Amount. Upon signing this Lease, Tenant shall deposit",
     "$4,250.00", "{{deposit.amount}}"),
    ("Guests. Persons not expressly identified",
     "more than 3 consecutive days or 5 total days within any 14-day period",
     "more than {{guest.consecutive_days}} consecutive days or "
     "{{guest.total_days}} total days within any {{guest.window_days}}-day period"),
    ("If Tenant breaches the No Advertising Covenant, Landlord reserves",
     "administrative fee of $75.00",
     "administrative fee of {{fee.lock_change_admin}}"),
    ("ANIMALS. Tenant shall not allow any animal",
     "shall not exceed $100.00",
     "shall not exceed {{fee.animal_liability_cap}}"),
    ("RENTERS INSURANCE. Renters insurance",
     "Renters insurance [X] IS or [ ] IS NOT required",
     "Renters insurance {{insurance.required_yes}} IS or "
     "{{insurance.required_no}} IS NOT required"),
    ("RENTERS INSURANCE. Renters insurance",
     "monthly expense of $25.00",
     "monthly expense of {{fee.lptli_monthly}}"),
    ("If checkbox is selected, attorneys",
     "[ ] If checkbox is selected",
     "{{attorney_fees.cap_enabled}} If checkbox is selected"),
    ("If checkbox is selected, attorneys",
     "shall not exceed",
     "shall not exceed {{attorney_fees.cap_amount}}"),
    ("Smoking [ ] IS or [X] IS NOT allowed in the Unit",
     "Smoking [ ] IS or [X] IS NOT allowed",
     "Smoking {{smoking.in_unit_yes}} IS or {{smoking.in_unit_no}} IS NOT allowed"),
    ("In case of a housing emergency",
     "516-829-9401", "{{emergency.phone}}"),
    # The payment block: "Name: / Address: / Phone:" carrying the payee details.
    ("Address: {{payee.address}}",
     "516-829-9401", "{{payee.phone}}"),
    (f"TENANT{APOS}S RESPONSIBILITY. Tenant must obtain",
     "minimum liability coverage of $100,000.00 per occurrence",
     "minimum liability coverage of {{insurance.min_liability}} per occurrence"),
    ("Monthly Renters Insurance Waiver:",
     "$25.00", "{{fee.renters_insurance_waiver_monthly}}"),
    ("Monthly Administrative Fee for Landlord Placed Liability Insurance:",
     "Liability Insurance:",
     "Liability Insurance: {{fee.lptli_admin_monthly}}"),
    ("Date of vacancy lease:",
     "09/14/2024", "{{lease.vacancy_lease_date}}"),
    ("Complaints about smoke drifting",
     "listed here: , .",
     "listed here: {{manager.name}}, {{manager.phone}}."),
    # Window guard notice — the source form has no check boxes at all, so the
    # marks are introduced here. "No children" is replaced first because the
    # other option's text is a suffix of it.
    ("Check one:", "Check one:", "Check one:"),
    ("Children 10 years of age or younger live in my apartment.",
     "No children 10 years of age or younger live in my apartment.",
     "{{window_guard.mark_no_children}} No children 10 years of age or "
     "younger live in my apartment."),
    ("Children 10 years of age or younger live in my apartment.",
     "Children 10 years of age or younger live in my apartment.",
     "{{window_guard.mark_has_children}} Children 10 years of age or "
     "younger live in my apartment."),
    ("I want window guards even though",
     "I want window guards even though",
     "{{window_guard.mark_wants_anyway}} I want window guards even though"),
    # Bedbug disclosure — the five unchecked options carry a literal "[ ]".
    ("During the past year the building had a bedbug infestation history that has been",
     "[ ]", "{{bedbug.mark_building_eradicated}}"),
    ("During the past year the building had a bedbug infestation history on the",
     "[ ]", "{{bedbug.mark_building_not_eradicated}}"),
    ("During the past year the apartment had a bedbug infestation history and eradication measures were employed",
     "[ ]", "{{bedbug.mark_apartment_eradicated}}"),
    ("During the past year the apartment had a bedbug infestation history and eradication measures were not employed",
     "[ ]", "{{bedbug.mark_apartment_not_eradicated}}"),
    ("[ ]Other:", "[ ]", "{{bedbug.mark_other}}"),
    # Sprinkler notice.
    ("Option 1:", "Option 1:", "{{sprinkler.mark_option1}} Option 1:"),
    ("X Option 2", "X Option 2", "{{sprinkler.mark_option2}} Option 2"),
]

# Same as ANCHORED, but the anchor must be the paragraph's entire text. These
# marks sit alone in their own paragraph, and their anchors ("YES", "NO") are
# far too common to match as substrings.
EXACT = [
    ("YES", "YES", "YES\t{{good_cause.mark_yes}}"),
    ("NOX", "X", "{{good_cause.mark_no}}"),
]

# Good Cause exemption checkboxes: a distinctive phrase from each option, and
# the field that decides whether it is marked.
GOOD_CAUSE_EXEMPTIONS = [
    ("has not adopted good cause eviction under section 213", "exempt_not_adopted"),
    ("owns no more than 10 units for small landlords", "exempt_small_landlord"),
    ("owner-occupied housing accommodation with no more than 10 units", "exempt_owner_occupied"),
    ("subject to regulation of rents or evictions pursuant to local", "exempt_rent_regulated"),
    ("affordable to tenants at a specific income level", "exempt_income_restricted"),
    ("owned as a condominium or cooperative", "exempt_condo_coop"),
    ("temporary or permanent certificate of occupancy within the past 30 years", "exempt_new_construction"),
    ("seasonal use dwelling unit", "exempt_seasonal"),
    ("continuing care retirement community", "exempt_institutional"),
    ("manufactured home located on or in a manufactured home park", "exempt_manufactured_home"),
    ("hotel room or other transient use", "exempt_hotel_transient"),
    ("dormitory owned and operated by an institution", "exempt_dormitory"),
    ("within and for use by a religious facility", "exempt_religious"),
    ("greater than the percent of fair market rent", "exempt_high_rent"),
]

# Utility rows, in table order, paired with the field that names who pays.
UTILITY_ROWS = [
    ("Water", "water"), ("Sewer", "sewer"),
    ("Stormwater / Drainage", "stormwater"), ("Gas", "gas"),
    ("Heating Gas or Oil", "heating"), ("Steam Heat", "steam_heat"),
    ("Electricity", "electricity"), ("Domestic Hot Water", "hot_water"),
    ("Trash", "trash"), ("Pest Control", "pest_control"),
    ("Cable / Satellite TV (Service)", "cable"),
    ("Internet Access (Service)", "internet"),
    ("Other:", "other1"), ("Other:", "other2"),
]

KEY_ROWS = [
    ("Unit Key", "unit"), ("Building Key", "building"),
    ("Mailbox Key", "mailbox"), ("Keyless Entry Remote/FOB", "fob"),
    ("Garage Door Remote", "garage"), ("Other:", "other"),
]

FINE_ROWS = [
    "smoking_indoors", "dog_waste", "common_space_cleanliness",
    "hallway_items", "trash_disposal", "furniture_damage",
    "parking", "short_term_rental", "other_violation", "no_insurance",
]

SMOKING_ROWS_T14 = ["inside_units", "outside_unit_areas"]
SMOKING_ROWS_T15 = ["outdoor_common", "within_15_feet", "other_areas"]


# --------------------------------------------------------------------------
# Transform
# --------------------------------------------------------------------------

def strip_comments_and_highlights(root):
    """Drop the review comments and the yellow fill used to flag the blanks.

    The template is a working document, not a marked-up draft, so neither
    belongs in it. Removing the highlight also means a filled lease does not
    ship with yellow blocks behind the tenant's name.
    """
    parents = {c: p for p in root.iter() for c in p}
    for tag in ("commentRangeStart", "commentRangeEnd"):
        for el in list(root.iter(W + tag)):
            parents[el].remove(el)
    # A comment anchor is a run holding only w:commentReference.
    for ref in list(root.iter(W + "commentReference")):
        run = parents.get(parents.get(ref))
        node = parents.get(ref)
        if run is not None and node is not None and node.tag == W + "r":
            run.remove(node)
    for hl in list(root.iter(W + "highlight")):
        parents[hl].remove(hl)
    # Empty <w:sdt> wrappers left behind by the removed anchors.
    for sdt in list(root.iter(W + "sdt")):
        content = sdt.find(W + "sdtContent")
        if content is not None and len(content) == 0:
            parent = parents.get(sdt)
            if parent is not None:
                parent.remove(sdt)


def find_paras(paras, needle):
    return [p for p in paras if needle in para_runs_text(p)]


def transform(root, report):
    body = root.find(W + "body")
    paras = list(body.iter(W + "p"))

    for find, repl in GLOBAL:
        hits = sum(para_replace(p, find, repl) for p in paras)
        report.append(("global", find, repl, hits))

    for anchor, find, repl in ANCHORED:
        if find == repl:
            continue
        hits = 0
        for p in paras:
            if anchor in para_runs_text(p):
                hits += para_replace(p, find, repl, limit=1)
        report.append(("anchored", f"{anchor[:40]} | {find}", repl, hits))

    for anchor, find, repl in EXACT:
        hits = 0
        for p in paras:
            if para_runs_text(p).strip() == anchor:
                hits += para_replace(p, find, repl, limit=1)
        report.append(("exact", f"{anchor} | {find}", repl, hits))

    lone_mark = re.compile(r"^\[[ X]\]\s*;$")
    for phrase, field in GOOD_CAUSE_EXEMPTIONS:
        hits = 0
        for p in find_paras(paras, phrase):
            for token in ("[X]", "[ ]"):
                hits += para_replace(p, token, f"{{{{good_cause.{field}}}}}", limit=1)
                if hits:
                    break
            if hits:
                continue
            # The box trails in a paragraph of its own a line or two down.
            start = paras.index(p)
            for follower in paras[start + 1:start + 5]:
                if lone_mark.match(para_runs_text(follower).strip()):
                    token = "[X]" if "[X]" in para_runs_text(follower) else "[ ]"
                    hits += para_replace(follower, token,
                                         f"{{{{good_cause.{field}}}}}", limit=1)
                    break
        report.append(("good_cause", phrase[:40], field, hits))

    # Good Cause question 3: only the two answers a new lease can use.
    for phrase, field in [
        ("for the reasons stated in response to question 2", "nonrenewal_exempt"),
        ("in connection with a first lease or a renewal lease", "nonrenewal_first_or_renewal"),
    ]:
        hits = 0
        for p in find_paras(paras, phrase):
            token = "[X]" if "[X]" in para_runs_text(p) else "[ ]"
            if token in para_runs_text(p):
                hits += para_replace(p, token, f"{{{{good_cause.{field}}}}}", limit=1)
            else:
                # No box in the source: append one before the trailing semicolon.
                hits += para_replace(p, "CHECKED) ;",
                                     f"CHECKED) {{{{good_cause.{field}}}}} ;", limit=1)
        report.append(("good_cause_q3", phrase[:40], field, hits))

    # Bedbug option 1 is a numbered list item in the source (the "[I]" bullet
    # is how Word renders the mark). Demote it to a plain paragraph so all six
    # options carry the same kind of check box.
    for p in find_paras(paras, "There is no history of any bedbug infestation"):
        ppr = p.find(W + "pPr")
        if ppr is not None:
            num = ppr.find(W + "numPr")
            if num is not None:
                ppr.remove(num)
        para_replace(p, "There is no history",
                     "{{bedbug.mark_none}} There is no history", limit=1)
        report.append(("bedbug", "option 1 delisted", "bedbug.mark_none", 1))

    transform_tables(body, report)
    transform_blank_fields(paras, report)
    return report


def transform_tables(body, report):
    tbls = list(body.iter(W + "tbl"))

    def rows(tbl):
        return tbl.findall(W + "tr")

    def cells(tr):
        return tr.findall(W + "tc")

    # Notice addresses: property manager and agent for service of process.
    for tbl in tbls:
        head = para_runs_text(rows(tbl)[0].findall(W + "tc")[0])
        if "Property Manager (for repairs" not in head:
            continue
        body_cells = cells(rows(tbl)[1])
        for tc, group in zip(body_cells, ("manager", "legal_notice")):
            for p in cell_paras(tc):
                for label, field in (("Name:", "name"), ("Address:", "address"),
                                     ("Phone:", "phone")):
                    if para_runs_text(p).strip().startswith(label):
                        set_text(p, f"{label} {{{{{group}.{field}}}}}")
        report.append(("table", "notice addresses", "manager/legal_notice", 1))

    for tbl in tbls:
        head = para_runs_text(rows(tbl)[0].findall(W + "tc")[0])

        if head.strip() == "UTILITY OR SERVICE":
            for tr, (label, field) in zip(rows(tbl)[1:], UTILITY_ROWS):
                tcs = cells(tr)
                if label == "Other:":
                    set_cell(tcs[0], f"Other: {{{{utility.{field}_label}}}}")
                set_cell(tcs[1], f"{{{{utility.{field}}}}}")
            report.append(("table", "utilities", f"{len(UTILITY_ROWS)} rows", 1))

        elif head.strip() == "Key Description":
            for tr, (label, field) in zip(rows(tbl)[1:], KEY_ROWS):
                tcs = cells(tr)
                if label == "Other:":
                    set_cell(tcs[0], f"Other: {{{{key.{field}_label}}}}")
                set_cell(tcs[1], f"{{{{key.{field}_qty}}}}")
                set_cell(tcs[2], f"{{{{key.{field}_charge}}}}")
            report.append(("table", "keys", f"{len(KEY_ROWS)} rows", 1))

        elif head.strip() == "Violation":
            for tr, field in zip(rows(tbl)[1:], FINE_ROWS):
                set_cell(cells(tr)[1], f"{{{{fine.{field}}}}}")
            report.append(("table", "fine schedule", f"{len(FINE_ROWS)} rows", 1))

        elif head.strip() == "Select:":
            data_rows = rows(tbl)[1:]
            fields = (SMOKING_ROWS_T14 if len(data_rows) == len(SMOKING_ROWS_T14)
                      else SMOKING_ROWS_T15)
            for tr, field in zip(data_rows, fields):
                tcs = cells(tr)
                set_cell(tcs[0], f"{{{{smoking.{field}}}}}")
                if field == "other_areas":
                    set_cell(tcs[1], "Other areas/exceptions: {{smoking.other_areas_text}}")
            report.append(("table", "smoking policy", f"{len(data_rows)} rows", 1))


def transform_blank_fields(paras, report):
    """Fill in the form blanks that hold no value in the source document."""
    # NYC indoor allergen certification — the owner prints their name twice.
    for p in find_paras(paras, "(owner or representative name in print)"):
        para_replace(p, "I,", "I, {{landlord.print_name}} ", limit=1)
        report.append(("blank", "allergen certification", "landlord.print_name", 1))

    # DHCR consent form, owner side. The tenant side is already filled from the
    # application, so only the owner's three lines need placeholders.
    owner_section = False
    for p in paras:
        text = para_runs_text(p)
        if "Owner/Owner Representative Contact Information" in text:
            owner_section = True
            continue
        if "Tenant Contact Information" in text:
            owner_section = False
        if not owner_section:
            continue
        for label, field in (("Name(s):", "name"), ("Email Address:", "email"),
                             ("Mailing Address:", "mailing_address")):
            if text.strip().startswith(label):
                set_text(p, f"{label} {{{{owner_rep.{field}}}}}")
                report.append(("blank", f"DHCR owner {label}", f"owner_rep.{field}", 1))

    # DHCR consent, lease description. Both marks sit alone in their own
    # paragraph, and a bare "[X]" paragraph also appears in the smoking policy
    # table, so they are located by walking forward from the question.
    for p in find_paras(paras, "Lease Description: (Please select only one)"):
        start = paras.index(p)
        for follower in paras[start + 1:start + 6]:
            text = para_runs_text(follower).strip()
            if text in ("[X]", "[ ]"):
                set_text(follower, "{{dhcr.mark_vacancy}}")
                report.append(("blank", "DHCR vacancy mark", "dhcr.mark_vacancy", 1))
            elif "Renewal lease" in text:
                para_replace(follower, "[ ]", "{{dhcr.mark_renewal}}", limit=1)
                report.append(("blank", "DHCR renewal mark", "dhcr.mark_renewal", 1))

    # Window guard notice: where the tenant returns the form.
    for p in find_paras(paras, "Name of landlord (owner or managing agent):"):
        set_text(p, "Name of landlord (owner or managing agent): {{landlord.entity_name}}")
        report.append(("blank", "window guard landlord name", "landlord.entity_name", 1))
    for p in find_paras(paras, "Address of landlord (owner or managing agent):"):
        set_text(p, "Address of landlord (owner or managing agent): {{landlord.address}}")
        report.append(("blank", "window guard landlord address", "landlord.address", 1))

    # Bedbug disclosure address block. "Long Island City 4E" in the source is a
    # data-entry slip: the unit number does not belong on the city line.
    for p in find_paras(paras, "Apt. #:"):
        para_replace(p, "Unit 4E", "{{property.unit}}", limit=1)
    for p in find_paras(paras, "37-34 33rd Street Unit 4E,"):
        set_text(p, "{{property.street}} Unit {{property.unit}},")
    for p in find_paras(paras, "Long Island City 4E"):
        set_text(p, "{{property.city}}")
    # Tabs are separate elements, so the searchable text here is "NY11101".
    # Replace the two values in place to keep the tabs that space the line out.
    for p in find_paras(paras, "NY11101"):
        para_replace(p, "11101", "{{property.zip}}", limit=1)
        para_replace(p, "NY", "{{property.state_abbr}}", limit=1)
    report.append(("blank", "bedbug address block", "property.*", 1))

    # Good Cause notice unit block: one field per labelled line.
    for needle, repl in (
        ("4E CITY/TOWN/VILLAGE:", ("4E", "{{property.unit}}")),
        ("Long Island City STATE:", ("Long Island City", "{{property.city}}")),
        ("New York ZIP CODE:", ("New York", "{{property.state}}")),
    ):
        for p in find_paras(paras, needle):
            para_replace(p, repl[0], repl[1], limit=1)
    for p in find_paras(paras, "37-34 33rd Street"):
        if para_runs_text(p).strip() == "37-34 33rd Street":
            set_text(p, "{{property.street}}")
    for p in paras:
        if para_runs_text(p).strip() == "11101":
            set_text(p, "{{property.zip}}")
    report.append(("blank", "good cause unit block", "property.*", 1))

    # Tenant's address line on the window guard notice ends with the bare unit.
    for p in find_paras(paras, "Apartment Number:"):
        para_replace(p, "Apartment Number: 4E",
                     "Apartment Number: {{property.unit}}", limit=1)
        report.append(("blank", "window guard apartment number", "property.unit", 1))


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else REPO / "Lease Template (2).docx")
    if not src.exists():
        sys.exit(f"source lease not found: {src}")

    with zipfile.ZipFile(src) as zin:
        parts = {n: zin.read(n) for n in zin.namelist()}

    # ElementTree renames every namespace prefix to ns0, ns1, ... unless the
    # original prefixes are registered first. The result is still valid XML,
    # but OOXML consumers are happier seeing the prefixes they wrote, so keep
    # them: pull every xmlns declaration off the source root and re-register it.
    head = parts["word/document.xml"][:4096].decode("utf-8", "ignore")
    for prefix, uri in re.findall(r'xmlns:([\w.-]+)="([^"]+)"', head):
        ET.register_namespace(prefix, uri)
    root = ET.fromstring(parts["word/document.xml"])
    report = []
    transform(root, report)
    strip_comments_and_highlights(root)
    parts["word/document.xml"] = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        + ET.tostring(root, encoding="UTF-8", xml_declaration=False))

    # Drop the comment parts entirely, along with the relationship and
    # content-type entries that point at them. Leaving either behind makes Word
    # offer to "repair" the file on open.
    for part in ("word/comments.xml", "word/commentsExtended.xml"):
        parts.pop(part, None)
    parts["[Content_Types].xml"] = re.sub(
        rb"<Override[^>]*PartName=\"/word/comments(?:Extended)?\.xml\"[^>]*/>",
        b"", parts["[Content_Types].xml"])
    parts["word/_rels/document.xml.rels"] = re.sub(
        rb"<Relationship[^>]*Target=\"comments(?:Extended)?\.xml\"[^>]*/>",
        b"", parts["word/_rels/document.xml.rels"])

    OUT_DOCX.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT_DOCX, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in parts.items():
            zout.writestr(name, data)

    misses = [r for r in report if r[3] == 0]
    placeholders = sorted(set(re.findall(
        r"\{\{([a-z0-9_.]+)\}\}",
        parts["word/document.xml"].decode("utf-8"))))
    print(f"wrote {OUT_DOCX.relative_to(REPO)}")
    print(f"{len(placeholders)} distinct placeholders")
    if misses:
        print(f"\n{len(misses)} rule(s) matched nothing:")
        for kind, what, repl, _ in misses:
            print(f"  [{kind}] {what} -> {repl}")
    print("\n".join(placeholders))


if __name__ == "__main__":
    main()
