# Listings Sync Backend

This folder contains a Python sync job that pulls private Google Sheets data into static JSON for the frontend.

## What it does

1. Reads listings from a primary sheet.
2. Falls back to a secondary sheet if the primary fails.
3. Keeps the last known good `data/listings.json` if both fail.
4. Writes sync metadata to `data/listings_meta.json`.
5. Fails sync if duplicate non-empty `listing_id` values are detected.
6. Uses `transaction_group` (`sale` or `occupancy`) as canonical transaction logic.
7. Derives display status labels:
   - Residential + occupancy -> `For Rent`
   - Commercial + occupancy -> `For Lease`
   - Any + sale -> `For Sale`

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
- If duplicate `listing_id` values exist, sync exits with failure and keeps the previous JSON cache.
- Required sheet columns should include at least `category`, `title`, and `transaction_group`.

## Trigger Modes

- Automatic pull: GitHub Actions schedule runs hourly (`0 * * * *`).
- Manual pull: GitHub Actions `workflow_dispatch` can be run anytime.
- Sheets push: optional Apps Script button can dispatch the workflow from Google Sheets.
- Sheets auto-push: optional installable `onEdit` trigger can dispatch on edits with cooldown/debounce.

## Google Sheets Push Setup (Manual + Auto)

1. Open your Google Sheet, then open Extensions -> Apps Script.
2. Paste `backend/google_sheets_push.gs` into the script project.
3. In Apps Script Project Settings -> Script Properties, set:
   - `GH_TOKEN` (required)
   - `GH_OWNER` (optional, default `heoun`)
   - `GH_REPO` (optional, default `star_website`)
   - `GH_WORKFLOW_FILE` (optional, default `sync-listings.yml`)
   - `GH_REF` (optional, default `main`)
   - `AUTO_COOLDOWN_SECONDS` (optional, default `300`)
4. Reload the sheet and use `Listings -> Publish Now` for a force dispatch.
5. Optional auto-push:
   - In Apps Script, open Triggers.
   - Add trigger for function `autoPublishOnEdit`.
   - Event source: `From spreadsheet`.
   - Event type: `On edit`.

## GitHub Token Requirements For Apps Script

- Use a Fine-grained PAT scoped to repo `heoun/star_website`.
- Required permissions:
  - Actions: Read and write
  - Contents: Read and write

## Workflow Reliability Behavior

- Sync always runs through the Python backend script.
- Workflow always attempts to commit changed data/meta even if sync fails.
- If `dist/` exists, workflow mirrors `data/listings*.json` into `dist/data/`.
- Workflow marks job as failed after commit when Python sync returns non-zero.
