# Property setup structure audit

The requested lease-information table defines one shared sequence for manual creation, previous-lease review and the existing Property settings editor. `property-sections.js` assigns all 129 stored defaults to exactly one of 15 sections. `property-form-layout.js` shares contact labels, paired choices, key categories and the four Good Cause questions.

1. Properties: property name and address parts; unit comes from a listing later.
2. Landlord & Signing: signer name, email, signer mailing address, legal entity, landlord address and phone, in that order.
3. Management & Notices: manager contacts, authorized recipient contacts and emergency contact.
4. Lease Terms, Payments & Policies: end time, rent due day, returned-payment fee, payee, deposit bank, guest limits, fees, insurance, attorney-fee cap and smoking allowance.
5. Utility: the fourteen payment responsibilities, with descriptions for other utilities.
6. Key Rider: six key types, each with quantity and replacement charge.
7. New York Renters Insurance Rider: coverage, waiver and administration fee.
8. Fine Schedule: ten violations.
9. Bedbug: vacancy-date rule and infestation-history answers.
10. Sprinkler System Notice: mutually exclusive system selection and maintenance-date rule.
11. NYC Gas Leak, Carbon Monoxide and Smoke Alarm Rider: provider and emergency number.
12. New York Smoking Policy Rider: restricted areas, exceptions and complaint contact from management.
13. Rent Concession Rider: editable Offer Details default, overridden by a rental's agreed offer.
14. DHCR Electronic Lease Consent: Vacancy/Renewal selection and signer-derived consent contact.
15. Good Cause Eviction Notice: applicability, exemptions, rent-increase justification and nonrenewal reasons, with the existing registered response options.

## Defaults and persistence

New drafts use only the requested starting values: 11:59 PM, rent due day 1, insurance required, smoking not allowed and Vacancy lease. Notice recipient and payee contacts derive from the landlord entity/address/phone. DHCR contacts derive from signer name/email/mailing address. Editing a derived value makes it independent; subsequent source edits do not replace that override. Unselected or conflicting import sources are not used to derive contacts. Imported values stay reviewable in their original section rather than being split into detected/missing sections.

Optional settings such as the spare Other utility and Other key rows, the attorney fee cap amount and other smoking areas may stay blank. The document view prints a blank optional setting as the blank line it will be, names only a required blank, opens on the first required blank and marks optional fields as Optional. Both halves of a spare Other utility row are optional. The payer defaults to N/A while the row has no name, in the draft and when a lease is resolved. Once a name is entered the draft clears the payer for choosing, and a named row with no payer is the one blank that stops lease generation until a payer is chosen. Every value on the review form becomes the new property's default and a blank is left unset; there is no separate selection column. A setting with two different readings starts blank, and the readings are listed under View Source & Alternatives with a Use This Value button. Later changes for one tenancy are made on that rental's lease, not here. Paired choices (renters insurance, smoking, sprinkler) show one View Source because both marks are read from the same sentence.

Existing saved values are preserved. When editing an existing section, absent entries can be prefilled with these defaults, but saving that section is still required. New fields are stored in the existing property settings JSON, not in a tenant or unit record. The four explicit `template: false` fields are property-level settings rather than additional Word placeholders; the template checker validates that these are optional manager-owned settings.

Bedbug vacancy date comes from the individual listing release date at lease preparation, with the existing lease-date fallback. For a maintained sprinkler system, a blank maintenance date defaults to that listing date; no system leaves the date blank. Property creation cannot provide a listing release date. Actual entered maintenance dates and explicit rental overrides are preserved where applicable. Rent concession and DHCR lease-type defaults feed new lease resolution; previously frozen lease snapshots remain unchanged.

## New Property Draft Workspace

New Property supports Expand/Restore. Its document editor opens across the browser viewport and returns to the current form section. Both views share live values, including address components, signer email, nonprinted property defaults and paired choices. A per-account sessionStorage backup retains the draft, current section and creation token through closing the dialog or reloading the tab; Continue Draft restores it. Successful creation clears the backup. Closing the browser tab ends this local backup; it is not a server-saved property or a cross-device draft.

## Checks

- Shared section and block coverage; every setting appears once.
- Contact derivation, explicit overrides and mutually exclusive defaults.
- Concession and lease-type resolution, plus conditional dates.
- Lease import reads the cover-sheet house form and the Yardi form the template descends from, as Word text and as PDF text, from synthetic leases in `scripts/lease-import-fixtures.mjs`; the template itself is filled with known defaults and read back so every printed property default survives an upload of a lease the site generated.
- Upload/manual creation, safe retry, persistence after reload, no existing-property writes, invalid inputs and role restrictions in browser tests.
- Live 15-step/129-field navigation, desktop/mobile layout, six key types and existing-property sections.
- Rental progression, screening gates, demo fixtures, Word generation, registry/template validation and TypeScript checks.
