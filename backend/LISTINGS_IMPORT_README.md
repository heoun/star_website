# Listings Import Reference

This document explains the current listings import pipeline and identifies the files to reference if you want to maintain it or extend it for real CSV/Excel uploads.

## Current State

The repository does **not** currently include a direct CSV or Excel upload endpoint.

The current flow is:

1. Listings live in private Google Sheets.
2. A Python sync job reads those sheets.
3. The sync job normalizes rows into a stable JSON format.
4. The site reads the generated JSON from `data/listings.json`.

So if someone says "CSV/Excel upload" in the context of this repo, the practical meaning today is:

- either the spreadsheet is being edited manually
- or a CSV/XLSX file is first imported into Google Sheets
- then this repo pulls from Google Sheets into JSON

## Files To Reference

### Core backend import logic

- [sync_listings.py](/Users/heoun/Documents/GitHub/star_website/backend/sync_listings.py:1)
  The main import script. This is the most important file.
  It authenticates with Google Sheets, reads sheet rows, normalizes fields, validates required columns, rejects duplicate `listing_id` values, and writes the final JSON output.

- [requirements.txt](/Users/heoun/Documents/GitHub/star_website/backend/requirements.txt:1)
  Python dependencies for the import job.

- [sheets_config.example.json](/Users/heoun/Documents/GitHub/star_website/backend/sheets_config.example.json:1)
  Example local config for primary and secondary sheet IDs, ranges, output paths, and required fields.

### Triggering and automation

- [google_sheets_push.gs](/Users/heoun/Documents/GitHub/star_website/backend/google_sheets_push.gs:1)
  Optional Google Apps Script used inside Google Sheets.
  It can manually dispatch the GitHub Actions sync workflow and can also auto-dispatch on sheet edits with cooldown protection.

- [sync-listings.yml](/Users/heoun/Documents/GitHub/star_website/.github/workflows/sync-listings.yml:1)
  GitHub Actions workflow that runs the Python sync, mirrors JSON into `dist/data/`, commits changed output files, and fails the job after commit if the sync itself failed.

### Generated outputs

- [listings.json](/Users/heoun/Documents/GitHub/star_website/data/listings.json:1)
  The generated dataset consumed by the website.

- [listings_meta.json](/Users/heoun/Documents/GitHub/star_website/data/listings_meta.json:1)
  Metadata about the last sync, including status, source, listing count, and errors.

### Frontend consumers

- [buy/index.html](/Users/heoun/Documents/GitHub/star_website/buy/index.html:820)
  Fetches `../data/listings.json`, normalizes the payload in-browser, and renders sale listings.

- [rental/index.html](/Users/heoun/Documents/GitHub/star_website/rental/index.html:820)
  Fetches `../data/listings.json`, normalizes the payload in-browser, and renders rental listings.

- [build.js](/Users/heoun/Documents/GitHub/star_website/scripts/build.js:1)
  Copies the `data/` folder into `dist/` during the static build. It does not transform listing data.

## What `sync_listings.py` Actually Does

The main script is organized around a few responsibilities:

### 1. Load credentials and config

It reads:

- `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_FILE`
- `PRIMARY_SHEET_ID`
- `SECONDARY_SHEET_ID`
- optional sheet ranges and output paths

Config can come from environment variables or from a local JSON config file.

### 2. Pull rows from Google Sheets

The script reads a row-based range such as `Listings!A:Z` from:

- the primary spreadsheet first
- the secondary spreadsheet if the primary fails

### 3. Normalize incoming columns

The script supports alias matching, so sheet headers do not need to be exact.

Examples:

- `listing_id` can also be `id` or `listingid`
- `details_url` can also be `url`, `link`, or `details`
- `transaction_group` can also be `transaction_type`, `deal_type`, or `listing_transaction`

### 4. Validate and clean rows

The script:

- skips empty rows
- skips rows without a valid category
- skips rows without a title
- rejects rows with invalid transaction values
- fails the sync if duplicate non-empty `listing_id` values exist

### 5. Derive transaction and status values

Canonical backend transaction values are:

- `sale`
- `occupancy`

Status labels are derived from those values:

- residential + `occupancy` -> `For Rent`
- commercial + `occupancy` -> `For Lease`
- any + `sale` -> `For Sale`

### 6. Write output files

On success, the script writes:

- `data/listings.json`
- `data/listings_meta.json`

If both sheets fail, it preserves the last known good `listings.json` when available and only updates metadata to indicate stale cache status.

## Data Contract

Minimum required columns are:

- `category`
- `title`
- `transaction_group`

Useful optional columns include:

- `listing_id`
- `price`
- `property_type`
- `location`
- `neighborhood`
- `bedrooms`
- `bathroom`
- `details_url`
- `kind_label`
- `image_label`
- `image_url`

## Important Behavior Difference: Backend vs Frontend

The backend uses `transaction_group = occupancy`.

The frontend pages normalize occupancy-like values into their own display bucket:

- `sale`
- `rental`

That means the backend and frontend are intentionally using slightly different internal labels, and the pages handle that by normalizing the payload again in browser code.

## Local Run Reference

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
python3 backend/sync_listings.py
```

## If You Want Real CSV/XLSX Upload Support

These are the files you would most likely change first:

- [sync_listings.py](/Users/heoun/Documents/GitHub/star_website/backend/sync_listings.py:1)
  Keep the normalization and validation logic, but replace or supplement the Google Sheets fetch step with CSV/XLSX parsing.

- [requirements.txt](/Users/heoun/Documents/GitHub/star_website/backend/requirements.txt:1)
  Add a parser dependency if needed, such as one for `.xlsx` support.

- [sync-listings.yml](/Users/heoun/Documents/GitHub/star_website/.github/workflows/sync-listings.yml:1)
  Update the workflow if the source changes from Sheets secrets to uploaded files or a storage bucket.

- [buy/index.html](/Users/heoun/Documents/GitHub/star_website/buy/index.html:820)
- [rental/index.html](/Users/heoun/Documents/GitHub/star_website/rental/index.html:820)
  Usually these do not need major changes if the output JSON shape stays the same.

## Recommended Reference Order

If you are reviewing the system from top to bottom, read files in this order:

1. [sync_listings.py](/Users/heoun/Documents/GitHub/star_website/backend/sync_listings.py:1)
2. [sync-listings.yml](/Users/heoun/Documents/GitHub/star_website/.github/workflows/sync-listings.yml:1)
3. [google_sheets_push.gs](/Users/heoun/Documents/GitHub/star_website/backend/google_sheets_push.gs:1)
4. [sheets_config.example.json](/Users/heoun/Documents/GitHub/star_website/backend/sheets_config.example.json:1)
5. [buy/index.html](/Users/heoun/Documents/GitHub/star_website/buy/index.html:820)
6. [rental/index.html](/Users/heoun/Documents/GitHub/star_website/rental/index.html:820)
7. [build.js](/Users/heoun/Documents/GitHub/star_website/scripts/build.js:1)

## Summary

For this repo, the main file to reference is `backend/sync_listings.py`.

If you want to understand the full pipeline, reference:

- `backend/sync_listings.py`
- `.github/workflows/sync-listings.yml`
- `backend/google_sheets_push.gs`
- `backend/sheets_config.example.json`
- `buy/index.html`
- `rental/index.html`
- `scripts/build.js`

If you want to convert the system into a true CSV/XLSX upload workflow, keep the JSON output contract stable and change the input layer first.
