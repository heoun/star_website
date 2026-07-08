# Codex Requirements Intake

This file tracks confirmed requirements before implementation.

## Project Goal
- Build a static Hostinger-compatible real estate site.
- Sync private Google Sheets data into static JSON using backend tooling.

## Locked Decisions
- Data source: private Google Sheets (primary with secondary failover).
- Sync architecture: Python sync job -> `data/listings.json`.
- Hosting model: static site (no VPS required).

## Requirements To Confirm Before UI Changes
1. Navigation labels and order:
   - exact labels
   - exact route targets
2. Properties information architecture:
   - whether to keep category split (`Residential`, `Commercial`)
   - whether to split by transaction type in separate carousels
3. Transaction naming rules:
   - residential occupancy label = `For Rent`
   - commercial occupancy label = `For Lease`
4. Fallback behavior when JSON is unavailable:
   - show empty-state cards
   - show embedded sample cards
5. Visual constraints:
   - sections to keep/remove
   - any copy/text that must stay unchanged

## Change Control Rule
- Do not change navigation or section structure until requirements are confirmed in chat.
