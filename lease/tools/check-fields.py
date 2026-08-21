#!/usr/bin/env python3
"""Check that the template and the field registry still agree.

    python3 lease/tools/check-fields.py

Every {{placeholder}} in lease/template/lease-template.docx must have an entry
in lease/schema/fields.json, and every entry must appear in the template. Run
this after editing either one. A placeholder nobody registered would render as
literal "{{...}}" text in a signed lease; a registered field that no longer
exists in the template would silently collect data that goes nowhere.

Exits non-zero when they disagree, so it can gate a deploy.
"""

import json
import re
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TEMPLATE = REPO / "lease" / "template" / "lease-template.docx"
REGISTRY = REPO / "lease" / "schema" / "fields.json"
ADDRESS = REPO / "site" / "shared" / "lease-address.js"

PLACEHOLDER = re.compile(r"\{\{([a-z0-9_.]+)\}\}")
VALID_SOURCES = {"deal", "manager", "agent"}


def composed_parts():
    """Fields that earn their place by feeding a value the template does print.

    The one-line address is composed from its parts, and the parts are read
    from the module that composes it so the two cannot drift. A part that no
    longer prints on its own — the state's abbreviation, once the bedbug form
    stopped spelling the address out a second way — is still needed.
    """
    text = ADDRESS.read_text()
    block = re.search(r"ADDRESS_PARTS\s*=\s*\[(.*?)\]", text, re.S)
    return set(re.findall(r'"([a-z0-9_.]+)"', block.group(1))) if block else set()


def template_placeholders(path):
    with zipfile.ZipFile(path) as z:
        parts = [n for n in z.namelist()
                 if n.startswith("word/") and n.endswith(".xml")]
        found = set()
        for name in parts:
            found |= set(PLACEHOLDER.findall(z.read(name).decode("utf-8")))
    return found


def main():
    if not TEMPLATE.exists():
        sys.exit(f"template not found: {TEMPLATE}")
    if not REGISTRY.exists():
        sys.exit(f"registry not found: {REGISTRY}")

    registry = json.loads(REGISTRY.read_text())
    fields = registry["fields"]
    ids = [f["id"] for f in fields]
    groups = {g["id"] for g in registry["groups"]}

    problems = []

    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        problems.append(f"duplicate field ids: {duplicates}")

    in_template = template_placeholders(TEMPLATE)
    in_registry = set(ids)

    for missing in sorted(in_template - in_registry):
        problems.append(f"in the template but not registered: {{{{{missing}}}}}")
    for orphan in sorted(in_registry - in_template - composed_parts()):
        problems.append(f"registered but absent from the template: {orphan}")

    for field in fields:
        if field["source"] == "manager" and field.get("scope") not in ("company", "building"):
            problems.append(f"{field['id']}: manager field without a company/building scope")
        if field["source"] not in VALID_SOURCES:
            problems.append(f"{field['id']}: unknown source {field['source']!r}")
        if field["group"] not in groups:
            problems.append(f"{field['id']}: unknown group {field['group']!r}")
        if field["type"] == "checkbox" and "marks" not in field:
            problems.append(f"{field['id']}: checkbox without checked/unchecked marks")
        if field["type"] == "choice" and not field.get("options"):
            problems.append(f"{field['id']}: choice without options")
        if field.get("required") and field["source"] == "manager" \
                and field.get("default") in (None, "") \
                and not field.get("needs_setup"):
            problems.append(f"{field['id']}: required manager setting with no default; "
                            "give it one or mark it needs_setup")

    if problems:
        print(f"{len(problems)} problem(s):")
        for p in problems:
            print(f"  - {p}")
        return 1

    print(f"OK: {len(fields)} fields, all present in the template and registered.")
    pending = [f["id"] for f in fields if f.get("needs_setup")]
    if pending:
        print(f"\n{len(pending)} setting(s) still need a value before the first "
              "lease can be generated:")
        for field_id in pending:
            print(f"  - {field_id}")
    per_building = [f["id"] for f in fields if f.get("scope") == "building"]
    print(f"\n{len(per_building)} setting(s) are per-building: their defaults came "
          "from one specific building and need reviewing before reuse.")
    by_source = {}
    for field in fields:
        by_source[field["source"]] = by_source.get(field["source"], 0) + 1
    print("  " + ", ".join(f"{k}: {v}" for k, v in sorted(by_source.items())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
