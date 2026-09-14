# Local rental journey scenarios

Open `http://127.0.0.1:8792/__demo/scenarios` or use **Demo scenarios** in the local admin toolbar. Sign in as the demo Admin to inspect every case. The scenario catalogue resolves actual persisted applicant names, so names remain unique when older demo identities are already allocated.

`scripts/demo-journey.mjs` publishes the local Property C/D listings and adds twelve independent groups. New units isolate later signing/completion scenarios; competing pre-decision applications can share a unit. Existing applications are preserved. The seed runs once per state file and never resets subsequent user decisions. The local demo's original data was backed up in the system temporary directory before the first rollout.

| Property / Unit | Scenario |
| --- | --- |
| A / 2A | No preferred Agent selected; paid, report pending, needs assignment |
| A / 2A | Bank statements require replacement; report received; recorded request for information |
| B / 4B | Two submitted and paid applicants; one report still pending |
| C / 1A | Provider returned no score; automatic sharing blocked |
| C / 1A | Complete single application waiting for landlord decision |
| C / 1A | Landlord declined; no lease draft |
| C / 2A | Landlord accepted; complete frozen lease and downloadable DOCX |
| C / 3A | Landlord accepted; Unit override leaves deposit bank address missing |
| D / 2A | One of two tenant signature receipts recorded |
| D / 3A | Both tenant receipts recorded; landlord signature next |
| D / 4A | Tenant and landlord receipts recorded; PDF archive pending |
| D / 5A | Signing complete and mock archive file downloadable |

The existing A-E applications retain the original pending-report, pending-roommate and complete-group examples. The catalogue adds cases rather than renaming or reusing these people.

## Data and behavior

All submitted scenario members have synthetic payment receipts before screening. Report generation, landlord decisions, draft generation and signature transitions run through the existing rental workflow. Missing documents and no-score results block sharing. Missing lease defaults do not invalidate an accepted decision, but do block final lease preparation. No real messages, payment requests, credit checks or signature requests are sent.

The missing-default example uses a deliberately blank **unit** override for `deposit.bank_address`, avoiding changes to other units' property defaults. Correct this unit's setting and refresh its incomplete draft to continue.

The archived file is `scripts/demo-assets/executed-lease-mock.pdf`, a visibly marked archive-control fixture, not a full signed contract. `build-executed-lease-mock.py` reproduces it with ReportLab. The case's actual populated lease is available through the existing Word lease generator. Real credit-provider failures, payment checkout states and signature callbacks still depend on integrations not yet implemented; these are not represented as working production flows. Unsubmitted drafts are not fabricated as submitted Rentals cases.

## Validation

`npm run test:demo` includes `test-demo-journey.mjs`: publication, payment/report gates, missing documents/defaults, landlord rejection, ordered signatures, PDF archive, unique emails, existing-case preservation and idempotent seeding. The local browser verification covers all twelve detail views, Word download, missing-default download blocking, archived PDF access, mobile catalogue layout and JavaScript errors. Existing rental workflow, intake and screening-gate suites remain passing.
