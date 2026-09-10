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
console.log(`PASS ${checks} lease import checks: evidence, exclusions, conflicting values, blank fields, typed review, overwrite protection and paired choices`);
export {source};
