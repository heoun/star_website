#!/usr/bin/env python3
"""Sync listing data from Google Sheets into static JSON files.

Priority order:
1. Primary sheet
2. Secondary sheet
3. Last known good cache (if both fail)
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from google.oauth2 import service_account
from googleapiclient.discovery import build

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = ROOT / "backend" / "sheets_config.json"
DEFAULT_OUTPUT_PATH = ROOT / "data" / "listings.json"
DEFAULT_META_PATH = ROOT / "data" / "listings_meta.json"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

FIELD_ALIASES = {
    "category": ["category", "group", "type", "listing_type"],
    "status": ["status", "listing_status"],
    "title": ["title", "name", "property_name"],
    "price": ["price", "list_price", "rent"],
    "property_type": ["property_type", "propertytype"],
    "location": ["location", "address"],
    "neighborhood": ["neighborhood", "area"],
    "bedrooms": ["bedrooms", "beds", "bedroom"],
    "bathroom": ["bathroom", "bathrooms", "bath"],
    "details_url": ["details_url", "url", "link", "details"],
    "kind_label": ["kind_label", "project_kind", "kind"],
    "image_label": ["image_label", "photo_label"],
    "image_url": ["image_url", "photo_url", "image"],
}

REQUIRED_FIELDS = ["category", "title", "status"]


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalize_key(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "_", value)
    return value.strip("_")


def read_json_file(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_file(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")


def get_service_account_credentials() -> service_account.Credentials:
    raw_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
    file_path = os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE", "").strip()

    if raw_json:
        info = json.loads(raw_json)
        return service_account.Credentials.from_service_account_info(info, scopes=SCOPES)

    if file_path:
        return service_account.Credentials.from_service_account_file(file_path, scopes=SCOPES)

    raise RuntimeError(
        "Missing service account credentials. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE."
    )


def load_config() -> dict[str, Any]:
    config_path = Path(os.getenv("SHEETS_CONFIG_PATH", str(DEFAULT_CONFIG_PATH)))
    data: dict[str, Any] = {}
    if config_path.exists():
        data = json.loads(config_path.read_text(encoding="utf-8"))

    primary = {
        "spreadsheet_id": os.getenv("PRIMARY_SHEET_ID", data.get("primary", {}).get("spreadsheet_id", "")),
        "sheet_range": os.getenv("PRIMARY_SHEET_RANGE", data.get("primary", {}).get("sheet_range", "Listings!A:Z")),
    }
    secondary = {
        "spreadsheet_id": os.getenv("SECONDARY_SHEET_ID", data.get("secondary", {}).get("spreadsheet_id", "")),
        "sheet_range": os.getenv("SECONDARY_SHEET_RANGE", data.get("secondary", {}).get("sheet_range", "Listings!A:Z")),
    }

    output_path = Path(os.getenv("LISTINGS_OUTPUT_PATH", data.get("output_path", str(DEFAULT_OUTPUT_PATH))))
    meta_path = Path(os.getenv("LISTINGS_META_PATH", data.get("meta_output_path", str(DEFAULT_META_PATH))))

    required_fields = data.get("required_fields", REQUIRED_FIELDS)

    return {
        "primary": primary,
        "secondary": secondary,
        "output_path": output_path,
        "meta_path": meta_path,
        "required_fields": required_fields,
    }


def fetch_sheet_rows(service: Any, spreadsheet_id: str, sheet_range: str) -> list[list[str]]:
    response = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=sheet_range, majorDimension="ROWS")
        .execute()
    )
    return response.get("values", [])


def map_header_to_index(header_row: list[str]) -> dict[str, int]:
    indexed: dict[str, int] = {}
    for idx, raw in enumerate(header_row):
        key = normalize_key(raw)
        if key:
            indexed[key] = idx
    return indexed


def pick_value(row: list[str], header_index: dict[str, int], aliases: list[str]) -> str:
    for alias in aliases:
        key = normalize_key(alias)
        idx = header_index.get(key)
        if idx is not None and idx < len(row):
            return str(row[idx]).strip()
    return ""


def normalize_category(value: str) -> str:
    lowered = value.strip().lower()
    if "comm" in lowered:
        return "commercial"
    if "res" in lowered:
        return "residential"
    return ""


def normalize_rows(rows: list[list[str]], required_fields: list[str]) -> list[dict[str, str]]:
    if not rows:
        raise RuntimeError("Sheet returned no rows.")

    header = rows[0]
    header_index = map_header_to_index(header)

    missing_fields = []
    for field in required_fields:
        aliases = FIELD_ALIASES.get(field, [field])
        if not any(normalize_key(alias) in header_index for alias in aliases):
            missing_fields.append(field)

    if missing_fields:
        raise RuntimeError(f"Missing required columns: {', '.join(missing_fields)}")

    listings: list[dict[str, str]] = []

    for raw_row in rows[1:]:
        if not any(str(cell).strip() for cell in raw_row):
            continue

        item: dict[str, str] = {}
        for field, aliases in FIELD_ALIASES.items():
            item[field] = pick_value(raw_row, header_index, aliases)

        item["category"] = normalize_category(item["category"])
        if not item["category"]:
            continue
        if not item["title"]:
            continue

        listings.append(item)

    if not listings:
        raise RuntimeError("No valid listing rows were found after normalization.")

    return listings


def sync_once(service: Any, source_name: str, source: dict[str, str], required_fields: list[str]) -> list[dict[str, str]]:
    spreadsheet_id = source.get("spreadsheet_id", "").strip()
    sheet_range = source.get("sheet_range", "Listings!A:Z").strip() or "Listings!A:Z"

    if not spreadsheet_id:
        raise RuntimeError(f"{source_name} spreadsheet_id is empty.")

    rows = fetch_sheet_rows(service, spreadsheet_id, sheet_range)
    return normalize_rows(rows, required_fields)


def main() -> int:
    config = load_config()
    output_path: Path = config["output_path"]
    meta_path: Path = config["meta_path"]
    required_fields: list[str] = config["required_fields"]

    errors: list[str] = []

    try:
        creds = get_service_account_credentials()
        service = build("sheets", "v4", credentials=creds, cache_discovery=False)
    except Exception as exc:  # pragma: no cover
        errors.append(f"auth: {exc}")
        return handle_full_failure(output_path, meta_path, errors)

    for source_name in ["primary", "secondary"]:
        source = config[source_name]
        try:
            listings = sync_once(service, source_name, source, required_fields)
            payload = {
                "synced_at": now_iso(),
                "source": source_name,
                "listings": listings,
            }
            meta = {
                "synced_at": payload["synced_at"],
                "source": source_name,
                "listing_count": len(listings),
                "status": "ok",
                "errors": errors,
            }
            write_json_file(output_path, payload)
            write_json_file(meta_path, meta)
            print(f"Sync success via {source_name}: {len(listings)} listings")
            return 0
        except Exception as exc:  # pragma: no cover
            message = f"{source_name}: {exc}"
            errors.append(message)
            print(f"Sync warning - {message}", file=sys.stderr)

    return handle_full_failure(output_path, meta_path, errors)


def handle_full_failure(output_path: Path, meta_path: Path, errors: list[str]) -> int:
    cached = read_json_file(output_path)
    if cached:
        listing_count = len(cached.get("listings", []))
        meta = {
            "synced_at": now_iso(),
            "source": "cache",
            "listing_count": listing_count,
            "status": "stale_cache",
            "errors": errors,
        }
        write_json_file(meta_path, meta)
        print("Sync failed for primary/secondary; keeping last known good cache.", file=sys.stderr)
        return 1

    meta = {
        "synced_at": now_iso(),
        "source": "none",
        "listing_count": 0,
        "status": "failed",
        "errors": errors,
    }
    write_json_file(meta_path, meta)
    print("Sync failed and no cached listings.json exists.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
