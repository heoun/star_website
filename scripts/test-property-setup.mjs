import assert from 'node:assert/strict';
import {propertySetupDefaults} from '../site/shared/property-setup.js';
import {sectionsFor} from '../site/admin/property-sections.js';
import {sectionBlocks} from '../site/admin/property-form-layout.js';
import {LEASE_REGISTRY,resolveValues} from '../worker/lease.js';
const source={'landlord.entity_name':'Landlord A LLC','landlord.print_name':'Signer A','landlord.signer_mailing_address':'Signer Address','landlord.address':'Office Address','landlord.phone':'212-555-0199'};
const defaults=propertySetupDefaults(source,'signer@example.test');
assert.equal(defaults['lease.end_time'],'11:59 PM');assert.equal(defaults['rent.due_day'],'1');
assert.equal(defaults['insurance.required_yes'],true);assert.equal(defaults['insurance.required_no'],false);
assert.equal(defaults['smoking.in_unit_yes'],false);assert.equal(defaults['smoking.in_unit_no'],true);
for(const prefix of ['legal_notice','payee']){assert.equal(defaults[prefix+'.name'],'Landlord A LLC');assert.equal(defaults[prefix+'.address'],'Office Address');assert.equal(defaults[prefix+'.phone'],'212-555-0199');}
assert.equal(defaults['owner_rep.name'],'Signer A');assert.equal(defaults['owner_rep.email'],'signer@example.test');assert.equal(defaults['owner_rep.mailing_address'],'Signer Address');
assert.equal(propertySetupDefaults({...source,'payee.name':'Custom'})['payee.name'],'Custom');
assert.equal(propertySetupDefaults({...source,'payee.name':null})['payee.name'],null);
assert.equal(propertySetupDefaults({'insurance.required_no':true})['insurance.required_yes'],false);
assert.equal(propertySetupDefaults({'smoking.in_unit_yes':true})['smoking.in_unit_no'],false);
assert.equal(Object.keys(source).length,5);
const sections=sectionsFor(LEASE_REGISTRY.fields.filter(f=>f.source==='manager'));
assert.deepEqual(sections.map(s=>s.id),['property','signing','management','payments','utilities','keys','insurance','fines','bedbug','sprinkler','gas','smoking','concession','dhcr','good_cause']);
for(const section of sections)assert.deepEqual(sectionBlocks(section).flatMap(b=>b.fields.map(f=>f.id)).sort(),section.fields.map(f=>f.id).sort());
assert.equal(sections.find(s=>s.id==='concession').fields[0].id,'concession.default_terms');
assert.equal(sections.find(s=>s.id==='dhcr').fields[0].id,'dhcr.lease_type');
const resolve=(settings,deal={},overrides={})=>resolveValues({layers:{building:settings},deal,overrides}).values;
assert.equal(resolve({'concession.default_terms':'One month free'})['concession.terms'],'One month free');
assert.equal(resolve({'concession.default_terms':'One month free'},{'concession.terms':'Agreed offer'})['concession.terms'],'Agreed offer');
assert.equal(resolve({'concession.default_terms':'One month free'},{},{'concession.terms':''})['concession.terms'],'');
const renewal=resolve({'dhcr.lease_type':'Renewal lease'});assert.notEqual(renewal['dhcr.mark_renewal'],renewal['dhcr.mark_vacancy']);
assert.equal(resolve({'sprinkler.mark_option2':true},{'lease.vacancy_lease_date':'09/14/2026'})['sprinkler.last_inspection'],'');
assert.equal(resolve({'sprinkler.mark_option2':true,'sprinkler.last_inspection':'08/01/2026'},{'lease.vacancy_lease_date':'09/14/2026'})['sprinkler.last_inspection'],'08/01/2026');
assert.equal(resolve({'sprinkler.mark_option1':true},{},{'sprinkler.last_inspection':'08/01/2026'})['sprinkler.last_inspection'],'');
// A spare Other utility row parks at N/A until it is named; a named row needs a payer.
assert.equal(defaults['utility.other1'],'N/A');assert.equal(defaults['utility.other2'],'N/A');
assert.equal(propertySetupDefaults({'utility.other1_label':'Bicycle storage'})['utility.other1'],undefined);
assert.equal(propertySetupDefaults({'utility.other1':'Tenant'})['utility.other1'],'Tenant');
assert.equal(propertySetupDefaults({'utility.other1':null})['utility.other1'],null);
const parked=resolveValues({layers:{building:{}},deal:{}});
assert.equal(parked.values['utility.other1'],'N/A');assert.equal(parked.missing.includes('utility.other1'),false);
const named=resolveValues({layers:{building:{'utility.other1_label':'Bicycle storage'}},deal:{}});
assert.equal(named.values['utility.other1'],'');assert.equal(named.missing.includes('utility.other1'),true);
assert.equal(resolveValues({layers:{building:{'utility.other2':'Landlord'}},deal:{}}).values['utility.other2'],'Landlord');
assert.equal(resolveValues({layers:{building:{'utility.other1_label':'Bicycle storage','utility.other1':'Tenant'}},deal:{}}).missing.includes('utility.other1'),false);
assert.equal(LEASE_REGISTRY.fields.filter(f=>['utility.other1','utility.other2'].includes(f.id)).every(f=>!f.required && f.default==='N/A'),true);
console.log('PASS property setup: 15 sections, full layout coverage, initial choices, linked contacts, overrides, concession and lease-type defaults, conditional dates, spare utility rows parked at N/A.');

for(const [toggle,dependent] of [['bedbug.mark_building_eradicated','bedbug.building_eradicated_floors'],['bedbug.mark_building_not_eradicated','bedbug.building_not_eradicated_floors'],['bedbug.mark_other','bedbug.other_details'],['sprinkler.mark_option2','sprinkler.last_inspection']]) {
 const check=values=>resolveValues({layers:{building:values,unit:{}},deal:{'lease.vacancy_lease_date':'09/14/2026'}});
 assert(check({[toggle]:true}).missing.includes(dependent),'Selected disclosure requires its detail in final lease validation');
 assert(!check({[toggle]:false}).missing.includes(dependent),'Unselected disclosure does not require details');
 assert(!check({[toggle]:true,[dependent]:'09/01/2026'}).missing.includes(dependent),'Completed disclosure is accepted');
}
