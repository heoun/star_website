# Lease import matching and review

Lease import reads local PDF/DOCX text and proposes property-level defaults. It does not use a cloud AI service or upload the source lease. It cannot guarantee complete extraction from arbitrary wording or scanned pages; all proposals remain reviewable before creation.

## What changed

- Address matching reads the lease as blocks: a heading such as Landlord, Property Manager or the payee paragraph opens a contact block, and the Name, Address and Phone lines under it belong to that party until a numbered clause, a rider title, a signature line or prose ends the block. A side-by-side contact table that a PDF prints column by column is read column by column. A plain Address next to filled tenant details is offered for confirmation, not automatically treated as the property.
- The premises address is scored from every place the lease names it: a Property or Subject Premises label, the unit information block of the Good Cause notice, a located-at clause, an address the lease calls the Unit or the Leased Premises, and a cover headed Residential Lease Agreement with blank Tenant Names. Mentions of one building are compared the USPS way, so 81-07 and 8107, Rd and Road, 37th Avenue and a unit suffix all describe the same building and count once; the hyphenated Queens house number is kept for display. An address that also belongs to the manager or the payee is treated as an office.
- Two different buildings both named strongly are shown with their evidence and location; no winner is chosen automatically. A reviewer can select the correct property address.
- Role-prefixed landlord and management addresses stay separate. Contact labels and common aliases are matched without depending on the output template. DOCX tabs, line breaks, label/value tables and side-by-side contact columns retain useful structure.
- The form lease the site's own template descends from is read in full: the payee paragraph, the manager and legal-notice columns, the emergency number, guest limits, the deposit bank, the lock-change and animal-liability amounts, renters insurance and its monthly charges, the attorneys' fee cap, the utility table, the key rider, the fine schedule, bedbug and sprinkler disclosures, the gas provider, the smoking policy boxes, the DHCR lease description and owner representative, and every Good Cause answer, identified by the statute each box cites. Sentences are matched across the line breaks a PDF introduces.
- Registry types still validate money, integers, dates, emails and choices. Tenant details, monthly rent, deposit amount and unit identifiers cannot become property defaults.
- Regression cover: synthetic leases in both layouts as Word and PDF text, plus the template filled with known defaults and read back so every printed property default survives an upload of a lease the site generated.

## Warning and error conditions

| Message | Exact trigger | Review action |
| --- | --- | --- |
| Rekeying fee | The readable text contains “rekeying fee”, case-insensitively. This term does not establish whether the amount is a lock-change administration fee or a charge for each replacement key. | Check the clause and enter the amount in the matching field. The generic phrase alone does not populate either fee. |
| Conflicting choices | Both opposite options are explicitly marked true for insurance, smoking, sprinkler status or Good Cause applicability. | Select the applicable answer. |
| Conflicting values on a field | Two different normalized values are found for the same setting. | The row starts blank. Choose a listed reading with Use This Value or enter the value. |
| Unnamed Other utility row | The utility table prints Landlord or Tenant beside an Other row with no name. | The payer is not imported; the draft parks the row at N/A until a name is entered. |
| Different property addresses | More than one distinct strong premises-address candidate is found. | Select the address in Properties; none is automatically filled. |
| Possible address near tenant details | Only a lower-confidence cover address is available near populated tenant details. | Confirm it is the rented property before using it. |
| PDF page has little readable text | A page yields fewer than 25 non-whitespace text characters. | Review that page; scanned images or handwriting need an OCR/searchable copy. This importer does not perform OCR. |
| No readable lease text | The extracted document has fewer than 40 non-whitespace characters. | Supply a text/searchable lease or enter manually. |
| No matching settings | Extraction succeeds but produces no manager-setting candidates. | Fill the defaults manually; an address may still have been identified separately. |
| File rejected | Unsupported extension, empty file, file over 20 MB, incorrect PDF/DOCX header, protected/unreadable PDF, PDF over 100 pages, extracted text over 500,000 characters, or Word XML/inflated entry over 8 MB. | Use a valid smaller/unlocked file. |
| Multiple files dropped | A drop contains other than one file. | Drop one lease at a time. |

## Document workspace

The New Property document workspace displays one lease-preparation explanation instead of repeated demo badges. This exception is confined to that workspace; generated demo rental leases retain their mock markings. Blue fields edit shared property defaults. Grey fields show Application Form, Listing or Lease Preparation sources and cannot be edited as property settings. The first unanswered editable field opens automatically; Previous/Next Field follows document order, then includes settings not printed as separate template fields.
