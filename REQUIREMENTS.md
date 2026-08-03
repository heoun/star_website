# Project Requirements Intake

This file tracks confirmed requirements before implementation.

## Project Goal
- Build a static real estate site with listing data managed by staff.

## Locked Decisions
- Data source: Supabase Postgres, edited through the `/admin/` page.
- Feed architecture: the Worker serves `/data/listings.json` from the database, with the bundled JSON as offline fallback.
- Hosting model: Cloudflare Workers (static assets plus a small Worker).

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
