# Listings Sync Backend

This folder contains a Python sync job that pulls private Google Sheets data into static JSON for the frontend.

## What it does

1. Reads listings from a primary sheet.
2. Falls back to a secondary sheet if the primary fails.
3. Keeps the last known good `data/listings.json` if both fail.
4. Writes sync metadata to `data/listings_meta.json`.

## Required environment variables

- `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_FILE`
- `PRIMARY_SHEET_ID`
- `SECONDARY_SHEET_ID`

Optional:

- `PRIMARY_SHEET_RANGE` (default: `Listings!A:Z`)
- `SECONDARY_SHEET_RANGE` (default: `Listings!A:Z`)
- `SHEETS_CONFIG_PATH`
- `LISTINGS_OUTPUT_PATH`
- `LISTINGS_META_PATH`

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
python3 backend/sync_listings.py
```

## Notes

- Share both spreadsheets with your service account email as Viewer.
- Use read-only Sheets scope in credentials.
