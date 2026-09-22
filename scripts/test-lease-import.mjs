import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {extractLeaseDefaults,extractPropertyAddress,buildImportPatch,normalizeImportValue,MAX_TEXT} from '../site/admin/lease-import-extract.js';
const fields=JSON.parse(readFileSync(new URL('../lease/schema/fields.json',import.meta.url))).fields;
const source=`Tenant Names: Private Tenant
Address: 10 Example Road, Example City, NY 10001
This Lease is made by and between Example Holdings LLC (the "Landlord") and the following tenants: Private Tenant.
1. Property. Apartment Unit 7B, located at 10 Example Road 7A, Example City, New York 10001.
2. Term. Start Date 01/01/2025 and Termination Date 12/31/2025.
3. Management. The Tenant is hereby notified that Example Management LLC is the property manager of the Property.
Address: 20 Example Avenue, New York 10002
Telephone: ___________
Email: manager@example.test
4. Rent. Tenant pays $9000, payable in advance on the 1st day of each month.
Payment address: 20 Example Avenue, New York 10002, or at such other place as Landlord may designate.
For ACH, wire and direct deposit:
Bank Name: Payment Bank
Account Name: Example Holdings LLC
Account Number: 999999999
7. Non-Sufficient Funds. Tenant will be charged a monetary fee of $25.00 as reimbursement.
19. Smoking. Smoking is prohibited in any area in or on the Property, both private and common, whether enclosed or outdoors.
22. Utilities and Services. Tenant will pay directly for all other utilities, except for the following, which will be paid by Landlord:
-
Water
-
Gas
Tenant acknowledges the services.
38. Disclosures. The tenant must maintain insurance with coverage of at least $500,000 for general liability and $50,000 for personal property.
39. Notice.
Landlord:
Example Holdings LLC
20 Example Avenue, New York 10002
Property Manager:
Example Management LLC
20 Example Avenue, New York 10002
40. Other terms.
[X]
There is no history of any bedbug infestation within the past year in the building or in any apartment.
The Leased Premises is NOT serviced by a maintained and operative sprinkler system.
`;
const result=extractLeaseDefaults(source,fields), values=Object.fromEntries(result.candidates.map(row=>[row.id,row.value]));
let checks=0;const equal=(a,b)=>{assert.deepEqual(a,b);checks++;};
equal(values['landlord.entity_name'],'Example Holdings LLC');equal(values['manager.name'],'Example Management LLC');equal(values['fee.returned_payment'],'$25.00');equal(values['rent.due_day'],'1');equal(values['insurance.min_liability'],'$500,000.00');equal(values['insurance.required_yes'],true);equal(values['insurance.required_no'],false);equal(values['sprinkler.mark_option1'],true);equal(values['sprinkler.mark_option2'],false);equal(values['smoking.in_unit_no'],true);equal(values['bedbug.mark_none'],true);equal(values['utility.water'],'Landlord');equal(values['utility.gas'],'Landlord');
for(const id of ['tenant.names','rent.monthly','lease.commencement_date','deposit.amount','deposit.bank_name','manager.phone','owner_rep.email','landlord.print_name','good_cause.mark_yes']) equal(values[id],undefined);
equal(result.warnings.length,0); // Different unit numbers and former tenant details are silently ignored.
equal(extractPropertyAddress('Tenant Names: Previous Tenant\nAddress: 99 Personal Street, New York, NY 10001'), '');
equal(extractPropertyAddress('Tenant address: 99 Personal Street\nProperty address: 10 Example Road, Unit 7B, New York, NY 10001'), '10 Example Road, New York, NY 10001');
equal(extractPropertyAddress('1. Property. Unit 7B, located at 10 Example Road 7A, New York, NY 10001 (the "Building").\n2. Term.'), '10 Example Road, New York, NY 10001');
equal(extractLeaseDefaults('3. Management.\nTelephone:\nEmail: personal@example.test\n4. Rent.', fields).candidates.length,0);
equal(result.candidates.every(row=>row.evidence && fields.find(f=>f.id===row.id)?.source==='manager'),true);
equal(result.candidates.find(row=>row.id==='insurance.required_yes').location,result.candidates.find(row=>row.id==='insurance.required_no').location);
const conflicts=extractLeaseDefaults(source+'\nLandlord legal entity: Different Holdings LLC\n',fields).candidates.find(row=>row.id==='landlord.entity_name');equal(conflicts.conflict,true);
equal(extractLeaseDefaults('[ ] There is no history of any bedbug infestation within the past year in the building or in any apartment.',fields).candidates.length,0);
equal(extractLeaseDefaults('Landlord legal entity\nTable Holdings LLC',fields).candidates[0].value,'Table Holdings LLC');
equal(extractLeaseDefaults('Landlord legal entity: {{landlord.entity_name}}',fields).candidates.length,0);
equal(normalizeImportValue(fields.find(f=>f.id==='utility.water'),'N/A'),'N/A');
equal(normalizeImportValue(fields.find(f=>f.id==='rent.due_day'),'99'),null);
const selected=[{id:'fee.returned_payment',value:'35',selected:true},{id:'manager.name',value:'Ignored replacement',selected:false}];
equal(buildImportPatch(selected,fields,{'manager.name':'Original'},{'manager.name':'Original'}),{'fee.returned_payment':'$35.00'});
for(const [rows,current,baseline] of [
  [[{id:'tenant.names',value:'Private',selected:true}],{},{}],
  [[{id:'fee.returned_payment',value:'',selected:true}],{},{}],
  [selected,{'fee.returned_payment':'$50'},{}],
  [[{id:'smoking.in_unit_no',value:true,selected:true}],{'smoking.in_unit_yes':true},{'smoking.in_unit_yes':true}],
]) {assert.throws(()=>buildImportPatch(rows,fields,current,baseline));checks++;}
equal(buildImportPatch([{id:'smoking.in_unit_no',value:true,selected:true},{id:'smoking.in_unit_yes',value:false,selected:true}],fields,{'smoking.in_unit_yes':true},{'smoking.in_unit_yes':true}),{'smoking.in_unit_no':true,'smoking.in_unit_yes':false});
assert.throws(()=>extractLeaseDefaults('x'.repeat(MAX_TEXT+1),fields));checks++;
const contacts=extractLeaseDefaults("Landlord signer's mailing address: 123 Example Lane\nLandlord phone number: 212-555-0199",fields);
equal(Object.fromEntries(contacts.candidates.map(row=>[row.id,row.value])),{'landlord.signer_mailing_address':'123 Example Lane','landlord.phone':'212-555-0199'});
console.log(`PASS ${checks} lease import checks: evidence, exclusions, conflicting values, blank fields, typed review, overwrite protection and paired choices`);
export {source};
// Layout and role regressions use synthetic addresses, not customer documents.
const cover='New York City\nResidential Lease Agreement\nTenant Names: ______\nAddress: _81-07 Kew Gardens Rd, Kew Gardens, NY 11415_____\nTelephone Number: 555-0100';
equal(extractPropertyAddress(cover),'81-07 Kew Gardens Rd, Kew Gardens, NY 11415');
equal(extractPropertyAddress(cover.replace('Tenant Names: ______','Tenant Names: Former Tenant')),'');
const roleSample=cover+'\nLandlord Details:\nName: Landlord LLC\nAddress:\n20 Landlord Road\nBrooklyn, NY 11201\nProperty Manager:\nName: Manager LLC\nAddress: 30 Manager Avenue\nQueens, NY 11101\nTelephone: 212-555-0199\nTenant:\nAddress: 40 Former Street, Bronx, NY 10451';
const roleResult=extractLeaseDefaults(roleSample,fields),roleValues=Object.fromEntries(roleResult.candidates.map(c=>[c.id,c.value]));
equal(roleResult.sourceAddress,'81-07 Kew Gardens Rd, Kew Gardens, NY 11415');
equal(roleValues['landlord.address'],'20 Landlord Road Brooklyn, NY 11201');
equal(roleValues['manager.address'],'30 Manager Avenue Queens, NY 11101');
equal(roleValues['manager.name'],'Manager LLC');
equal(roleValues['landlord.entity_name'],'Landlord LLC');
equal(roleResult.candidates.some(c=>c.conflict),false);
const alternatives=extractLeaseDefaults('Property Address: 10 First Road, Brooklyn, NY 11201\nPremises Address: 20 Second Avenue, Queens, NY 11101',fields);
equal(alternatives.sourceAddress,'');equal(alternatives.addressReview.conflict,true);equal(alternatives.addressReview.candidates.length,2);
equal(extractPropertyAddress('Property Manager is located at 30 Office Road, Queens, NY 11101'),'');
equal(extractPropertyAddress('The dwelling is situated at\n10 Example Road, Unit 2A, Brooklyn, NY 11201'),'10 Example Road, Brooklyn, NY 11201');
equal(extractPropertyAddress('Premises Address:\n10 Example Road\nBrooklyn, NY 11201'),'10 Example Road Brooklyn, NY 11201');
equal(extractPropertyAddress(cover+'\nProperty Address: 81-07 Kew Gardens Road, Kew Gardens, New York 11415'),'81-07 Kew Gardens Road, Kew Gardens, New York 11415');
equal(extractLeaseDefaults('NSF Fee:\t$45\nProperty Management\'s Phone:\t212-555-0100',fields).candidates.find(c=>c.id==='fee.returned_payment')?.value,'$45.00');
equal(extractLeaseDefaults('A rekeying fee of $80 applies.',fields).warnings.length,1);
equal(extractLeaseDefaults('A rekeying fee of $80 applies.',fields).candidates.length,0);
console.log(`PASS ${checks} total lease import checks including cover/multiline/role-scoped addresses, aliases and conflicts`);

// ---- Real-world layouts with made-up parties: the cover-sheet house form and
// the Yardi form the site's template descends from, each as Word text and as a
// PDF reader emits it. Every expected value below is one a reviewer would see.
import {coverLease, formLease, asPdfText, docxText} from './lease-import-fixtures.mjs';
import {splitImportedAddress} from '../site/admin/lease-import-context.js';
import {readEntries, readEntryText} from '../worker/zip.js';
const valuesOf = result => Object.fromEntries(result.candidates.map(row => [row.id, row.value]));
const pick = (values, keys) => Object.fromEntries(keys.map(key => [key, values[key]]));
const office = '14222 37th Avenue, 5 Floor, Flushing, New York 11354';
const expectedCover = {
  'manager.name': 'Sample Management LLC', 'manager.address': office, 'landlord.entity_name': 'Sample Owner LLC', 'landlord.address': office,
  'legal_notice.name': 'Sample Owner LLC', 'legal_notice.address': office, 'payee.name': 'Sample Owner LLC', 'payee.address': office,
  'rent.due_day': '1', 'fee.returned_payment': '$25.00', 'insurance.min_liability': '$500,000.00', 'insurance.required_yes': true, 'insurance.required_no': false,
  'smoking.in_unit_no': true, 'smoking.in_unit_yes': false, 'utility.water': 'Landlord', 'utility.trash': 'Landlord', 'utility.gas': 'Landlord', 'utility.electricity': 'Tenant',
  'bedbug.mark_none': true, 'bedbug.mark_building_eradicated': false, 'bedbug.mark_other': false, 'sprinkler.mark_option1': true, 'sprinkler.mark_option2': false
};
for (const text of [coverLease, asPdfText(coverLease)]) {
  const result = extractLeaseDefaults(text, fields), values = valuesOf(result);
  equal(result.sourceAddress, '81-07 Sample Gardens Road, Kew Gardens, New York 11415');
  equal([result.addressReview.conflict, result.addressReview.candidates.length], [false, 1]);
  equal(splitImportedAddress(result.sourceAddress), {street: '81-07 Sample Gardens Road', city: 'Kew Gardens', state_abbr: 'NY', zip: '11415'});
  equal(result.warnings, ['A rekeying fee appears in the lease. Confirm whether it is a lock-change fee or a per-key replacement charge before entering it.']);
  equal(result.candidates.filter(row => row.conflict).map(row => row.id), []);
  equal(pick(values, Object.keys(expectedCover)), expectedCover);
  // Blank labels, the ACH bank, definitions, sub-headings and the tenant's own address never become defaults.
  for (const id of ['manager.phone', 'landlord.print_name', 'payee.phone', 'deposit.bank_name', 'tenant.names', 'owner_rep.name']) equal(values[id], undefined);
  equal(Object.values(values).some(value => /Bank|Broker|means|Former Street|^one\)$/.test(String(value))), false);
}
const expectedForm = {
  'payee.name': 'Sample Ventures LLC', 'payee.address': '10 Sample Plaza #300, Great Neck, NY 11021', 'payee.phone': '516-555-0100',
  'manager.name': 'Sample Management Co', 'manager.address': '20 Manager Lane, Flushing, NY 11354', 'manager.phone': '718-555-0101',
  'legal_notice.name': 'Sample Legal Agent', 'legal_notice.address': '30 Counsel Road, Suite 5, Mineola, NY 11501', 'legal_notice.phone': '516-555-0102',
  'landlord.entity_name': 'Sample Ventures LLC', 'landlord.address': '40 Owner Street, Great Neck, NY 11021', 'landlord.print_name': 'Sample Signer',
  'owner_rep.name': 'Sample Signer', 'owner_rep.email': 'owner@example.test', 'owner_rep.mailing_address': '40 Owner Street, Great Neck, NY 11021',
  'emergency.phone': '516-555-0199', 'gas.provider_name': 'National Grid', 'gas.provider_phone': '1 (718) 643-4050',
  'rent.due_day': '1', 'lease.end_time': '11:59 PM', 'deposit.bank_name': 'Sample Savings Bank', 'deposit.bank_address': '5 Bank Street, Astoria, NY 11105',
  'guest.consecutive_days': '4', 'guest.total_days': '7', 'guest.window_days': '30',
  'fee.returned_payment': '$30.00', 'fee.lock_change_admin': '$80.00', 'fee.animal_liability_cap': '$150.00', 'fee.lptli_monthly': '$27.00', 'fee.renters_insurance_waiver_monthly': '$28.00', 'fee.lptli_admin_monthly': '$9.50',
  'attorney_fees.cap_enabled': true, 'attorney_fees.cap_amount': '$2,500.00', 'insurance.min_liability': '$300,000.00', 'insurance.required_yes': true, 'insurance.required_no': false,
  'smoking.in_unit_yes': false, 'smoking.in_unit_no': true,
  'utility.water': 'Landlord', 'utility.sewer': 'Landlord', 'utility.stormwater': 'Landlord', 'utility.gas': 'N/A', 'utility.heating': 'N/A', 'utility.steam_heat': 'N/A', 'utility.electricity': 'Tenant', 'utility.hot_water': 'Tenant', 'utility.trash': 'Landlord', 'utility.pest_control': 'Landlord', 'utility.cable': 'Tenant', 'utility.internet': 'Tenant', 'utility.other1': 'Landlord', 'utility.other1_label': 'Bicycle storage', 'utility.other2': undefined, 'utility.other2_label': undefined,
  'key.unit_qty': '2', 'key.unit_charge': '$50.00', 'key.building_qty': '1', 'key.building_charge': '$75.00', 'key.mailbox_qty': '1', 'key.mailbox_charge': '$25.00', 'key.fob_qty': '2', 'key.fob_charge': '$100.00', 'key.garage_qty': undefined, 'key.garage_charge': undefined, 'key.other_label': 'Storage key', 'key.other_qty': '1', 'key.other_charge': '$10.00',
  'fine.smoking_indoors': '$100', 'fine.dog_waste': '$100', 'fine.common_space_cleanliness': '$100', 'fine.hallway_items': '$50', 'fine.trash_disposal': '$50', 'fine.furniture_damage': 'Responsible for paying for fix or replacement', 'fine.parking': 'Responsible for charge schedule of towing company', 'fine.short_term_rental': 'Strictly prohibited. Fines per city guidelines and permitted under NYC law.', 'fine.other_violation': '$50', 'fine.no_insurance': '$25 per month of noncompliance',
  'bedbug.mark_none': false, 'bedbug.mark_building_eradicated': true, 'bedbug.mark_building_not_eradicated': false, 'bedbug.mark_apartment_eradicated': false, 'bedbug.mark_apartment_not_eradicated': false, 'bedbug.mark_other': false,
  'sprinkler.mark_option1': false, 'sprinkler.mark_option2': true, 'sprinkler.last_inspection': '6/28/2024',
  'smoking.inside_units': true, 'smoking.outside_unit_areas': true, 'smoking.outdoor_common': false, 'smoking.within_15_feet': true, 'smoking.other_areas': true, 'smoking.other_areas_text': 'Rooftop deck',
  'dhcr.lease_type': 'Vacancy lease', 'good_cause.mark_yes': false, 'good_cause.mark_no': true,
  'good_cause.exempt_not_adopted': false, 'good_cause.exempt_small_landlord': false, 'good_cause.exempt_owner_occupied': true, 'good_cause.exempt_rent_regulated': false, 'good_cause.exempt_condo_coop': false, 'good_cause.exempt_high_rent': false,
  'good_cause.increase_below_threshold': true, 'good_cause.increase_above_threshold': false, 'good_cause.increase_justification': 'Not applicable this year',
  'good_cause.nonrenewal_exempt': true, 'good_cause.nonrenewal_first_or_renewal': false, 'good_cause.nonrenewal_sublet': false, 'good_cause.nonrenewal_employment': false, 'good_cause.nonrenewal_unpaid_rent': false, 'good_cause.nonrenewal_demolition': true, 'good_cause.nonrenewal_refused_terms': false
};
for (const text of [formLease, asPdfText(formLease)]) {
  const result = extractLeaseDefaults(text, fields), values = valuesOf(result);
  equal(result.sourceAddress, '22-11 45th Street, Astoria, New York 11105');
  equal([result.addressReview.conflict, result.addressReview.candidates.length, result.warnings], [false, 1, []]);
  equal(splitImportedAddress(result.sourceAddress), {street: '22-11 45th Street', city: 'Astoria', state_abbr: 'NY', zip: '11105'});
  equal(result.candidates.filter(row => row.conflict).map(row => row.id), []);
  equal(pick(values, Object.keys(expectedForm)), expectedForm);
  for (const id of ['tenant.names', 'tenant.email', 'rent.monthly', 'deposit.amount', 'property.unit']) equal(values[id], undefined);
  equal(result.candidates.every(row => row.evidence && /^Text line \d+$/.test(row.location)), true);
}
console.log(`PASS ${checks} total lease import checks including the cover-sheet and form layouts as Word and PDF text`);

// ---- The site's own template, filled in and read back the way an uploaded
// .docx is read: every manager default that prints must come back unchanged.
const escapeXml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const template = readFileSync(new URL('../lease/template/lease-template.docx', import.meta.url));
const templateXml = await readEntryText(readEntries(template.buffer.slice(template.byteOffset, template.byteOffset + template.byteLength)), 'word/document.xml');
const printed = new Set([...templateXml.matchAll(/\{\{([a-z0-9_.]+)\}\}/g)].map(item => item[1]));
const roundTrip = (() => {
  const marked = new Set(['insurance.required_yes', 'smoking.in_unit_no', 'sprinkler.mark_option2', 'good_cause.mark_no', 'bedbug.mark_building_eradicated', 'smoking.inside_units', 'smoking.within_15_feet', 'smoking.other_areas', 'good_cause.exempt_owner_occupied', 'good_cause.increase_below_threshold', 'good_cause.nonrenewal_exempt', 'good_cause.nonrenewal_demolition', 'attorney_fees.cap_enabled']);
  const text = {
    'landlord.entity_name': 'Sample Ventures LLC', 'landlord.print_name': 'Sample Signer', 'landlord.address': '40 Owner Street, Great Neck, NY 11021',
    'payee.name': 'Sample Ventures LLC', 'payee.address': '10 Sample Plaza #300, Great Neck, NY 11021', 'payee.phone': '516-555-0100',
    'manager.name': 'Sample Management Co', 'manager.address': '20 Manager Lane, Flushing, NY 11354', 'manager.phone': '718-555-0101',
    'legal_notice.name': 'Sample Legal Agent', 'legal_notice.address': '30 Counsel Road, Suite 5, Mineola, NY 11501', 'legal_notice.phone': '516-555-0102',
    'emergency.phone': '516-555-0199', 'owner_rep.name': 'Sample Signer', 'owner_rep.mailing_address': '40 Owner Street, Great Neck, NY 11021',
    'deposit.bank_name': 'Sample Savings Bank', 'deposit.bank_address': '5 Bank Street, Astoria, NY 11105', 'lease.end_time': '11:59 PM',
    'gas.provider_name': 'National Grid', 'gas.provider_phone': '1 (718) 643-4050', 'smoking.other_areas_text': 'Rooftop deck', 'key.other_label': 'Storage key',
    'utility.other1_label': 'Bicycle storage', 'utility.other2_label': 'Laundry', 'good_cause.increase_justification': 'Not applicable this year'
  };
  const deal = {
    'property.address_full': '22-11 45th Street, Unit 4E, Astoria, NY 11105', 'property.street': '22-11 45th Street', 'property.unit': '4E', 'property.city': 'Astoria', 'property.state': 'New York', 'property.state_abbr': 'NY', 'property.zip': '11105',
    'tenant.names': 'Sample Tenant and Second Tenant', 'tenant.email': 'tenant@example.test', 'tenant.mailing_address': '', 'concession.terms': 'One month free',
    'lease.effective_date': '07/30/2024', 'lease.commencement_date': '09/14/2024', 'lease.end_date': '09/13/2025', 'lease.vacancy_lease_date': '09/14/2024', 'rent.monthly': '$4,250.00', 'deposit.amount': '$4,250.00'
  };
  const print = {}, expect = {};
  fields.forEach((field, n) => {
    if (field.source !== 'manager') { print[field.id] = field.type === 'checkbox' ? (field.id === 'dhcr.mark_renewal' || field.id === 'window_guard.mark_no_children' ? field.marks.checked : field.marks.unchecked) : deal[field.id] ?? ''; return; }
    let value;
    if (field.type === 'checkbox') value = marked.has(field.id);
    else if (field.type === 'choice') value = field.id === 'dhcr.lease_type' ? 'Renewal lease' : field.options[n % field.options.length];
    else if (field.type === 'money') value = `$${(n * 7 + 5).toLocaleString('en-US')}.${n % 2 ? '50' : '00'}`;
    else if (field.type === 'integer') value = String(field.id === 'rent.due_day' ? 5 : (n % 6) + 1);
    else if (field.type === 'date') value = '6/28/2024';
    else if (field.type === 'email') value = 'owner@example.test';
    else value = text[field.id] ?? `Sample ${field.label.replace(/[^A-Za-z ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()}`;
    print[field.id] = field.type === 'checkbox' ? (value ? field.marks.checked : field.marks.unchecked) : value;
    expect[field.id] = normalizeImportValue(field, value);
  });
  return {print, expect};
})();
const filledXml = templateXml.replace(/\{\{([a-z0-9_.]+)\}\}/g, (placeholder, id) => id in roundTrip.print ? escapeXml(roundTrip.print[id]) : placeholder);
equal(filledXml.includes('{{'), false);
const readBack = extractLeaseDefaults(docxText(filledXml), fields), readValues = valuesOf(readBack);
const managerPrinted = [...printed].filter(id => fields.find(field => field.id === id)?.source === 'manager');
const misses = managerPrinted.filter(id => readValues[id] !== roundTrip.expect[id]).map(id => `${id}: expected ${JSON.stringify(roundTrip.expect[id])}, read ${JSON.stringify(readValues[id])}`);
equal(misses, []);
equal(readBack.sourceAddress, '22-11 45th Street, Astoria, New York 11105');
equal([readBack.addressReview.conflict, readBack.warnings, readBack.candidates.filter(row => row.conflict).map(row => row.id)], [false, [], []]);
console.log(`PASS ${checks} total lease import checks including a round trip of all ${managerPrinted.length} printed property defaults through the lease template`);
