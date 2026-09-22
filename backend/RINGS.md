# Rings

Every ring ends with the system runnable end to end (`dev` + `smoke` + gate all green).
Each ring swaps exactly one thing. If a swap breaks the run, it is fixed before the next
ring starts. Order below is the plan, not a law — rings 4–8 can reorder if a vendor or a
decision lands early, because nothing depends on anything still fake.

| Ring | Swap | Pass condition | Notes |
|---|---|---|---|
| 0 ✅ | Nothing — build the fence | A deliberate bad import fails CI (the canary); `npm run dev` serves `/api/health`; empty smoke passes | Gate config, tsconfig, CI job, smoke runner skeleton |
| 1 ✅ | Nothing — the tracer bullet, all fakes | `smoke` walks: seeded listing → apply (fake principal) → screening-fake returns a random score → staff approve → landlord link approve → **real docx** from the existing lease engine → esign-fake signs all → case `executed`, lease bytes stored | `leasegen` wraps `lease/` — real from day one. db-memory, email-log, storage-memory, auth-fake |
| 2 ✅ | db-memory → db-supabase (dev "Star dev") | Same smoke, data survives a restart | First migrations: cases, case_members, applications, screenings, decisions, lease_versions, rentables (the reservation), events |
| 3 ✅ | auth-fake → auth-real | Smoke logs in for real; staff via Access JWT, applicant via portal cookie, landlord via signed single-use link | All three verifiers already exist in `worker/` — this ring moves them behind the contract |
| 4 ✅ | email-log → email-resend | Landlord decision email actually arrives; Admin picks recipients before send | Resend adapter exists in spirit in `worker/email` paths; dev keeps the log adapter |
| 5 ✅ | storage-memory → storage-r2 | Executed lease lands in the private bucket; smoke fetches it back via signed URL | Buckets already exist |
| 6 | esign-fake → esign-docusign (sandbox) | Real envelope, webhook drives `partially_signed` → `executed` | Tenants sign first, landlord last; docx uploaded as-is |
| 7 | screening-fake → real vendor | Real invite URL, applicant-paid fee at the vendor, webhook returns score + report ref | **Blocked on the vendor call. Blocks nothing else — that is the point of the fake.** |
| 8 ✅ | Fake/minimal admin pages → the Leasing Desk at /admin/v2 (two-tab application detail and portal checklist moved to Ring 9+) | Staff run the whole flow through the UI, not just smoke | UI hardening; document registry starts as a small JSON |
| 9 ✅ | Sandbox listings → the real inventory (`public.listings`) | Desk lists and publishes real listings; the flow starts from one; auto-unpublish flips the real `published` flag | Overlay table `backend.listing_state` for rented/archived; `public.listings` untouched; migration 0002 |
| 10+ | Deferred versions behind unchanged contracts | Each lands as an adapter or module swap | Property-settings trust states and landlord intake page; the ownership watchdog; queues/outbox replacing events-log; per-property agent scoping. All from the design record — none blocks MVP |

## What MVP Deliberately Does Rough

- Lease values come from the **existing** property lease-settings mechanism via the
  `leasegen` contract. The trust-state governance design is Ring 9+, invisible to callers.
- Application fee rides the screening vendor (applicant pays the vendor directly).
  No payment port until a real need appears.
- `events` is a log adapter. Queues, retries and reminders arrive as a later swap.
- Documents-per-applicant-type is a JSON registry read by the portal checklist; the
  conditional logic stays simple until real cases push on it.
