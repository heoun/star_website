import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sectionsFor, readiness} from '../site/admin/property-sections.js';
import {initPropertyDefaults, defaultsMarkup, newDefaultsUi, managerFields, loadLayer, handleDefaultsClick} from '../site/admin/property-defaults.js';
// The save unit test uses a stub host; only simple known group IDs are selected.
globalThis.CSS={escape:value=>{assert.match(value,/^[a-z_]+$/);return value;}};
const registry=JSON.parse(readFileSync(new URL('../lease/schema/fields.json',import.meta.url),'utf8'));
const fields=managerFields(registry), sections=sectionsFor(fields);
assert.equal(sections.length,15);
const ids=sections.flatMap(section=>section.fields.map(field=>field.id));
assert.equal(new Set(ids).size,fields.length,'Every stored property field appears exactly once');
assert.deepEqual([...ids].sort(),fields.map(field=>field.id).sort());
assert.equal(sections.find(s=>s.id==='insurance').fields.some(f=>f.id==='insurance.min_liability'),true);
assert.equal(sections.find(s=>s.id==='payments').fields.some(f=>f.id==='insurance.required_yes'),true);
for (const field of fields.filter(f=>f.required)) {
  const result=readiness({fields,answered:f=>f.id!==field.id,hasSigner:true});
  assert.equal(result.missing,1,`Readiness must still detect ${field.id} after regrouping`);
}
assert.equal(readiness({fields,answered:()=>true,hasSigner:false}).missing,1);
const extended=sectionsFor([...fields,{id:'future.property_field',group:'future',required:true}]);
assert.equal(extended.at(-1).fields[0].id,'future.property_field','New registry fields cannot disappear');
let stored={'insurance.required_yes':true,'insurance.required_no':false,'manager.name':'Example manager'}, lastPatch;
initPropertyDefaults({api:async(path,options)=>{
  if(options?.method==='PUT'){lastPatch=JSON.parse(options.body).field_values;stored={...stored,...lastPatch};return {};}
  return {field_values:stored};
},setStatus:()=>{},escapeHtml:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),isManager:()=>true,buildingOf:()=>({street:'10 Example St',landlord_signer_email:'signer@example.test'})});
const ui=newDefaultsUi();
for (const section of sections) {
  ui.activeSection=section.id;
  const markup=defaultsMarkup({fields,values:stored,ui,buildingId:'test-property'});
  assert(markup.includes(`aria-current="step"`));
  assert(markup.includes(`Step ${sections.indexOf(section)+1} of 15`));
}
await loadLayer('test-property');
ui.activeSection='payments';ui.editingGroup='payments';
const panel={querySelectorAll:selector=>selector==='[data-setting]'?[]:[{dataset:{settingPair:'insurance.required_yes'},value:'no'}]};
const ctx={host:{querySelector:()=>panel},buildingId:'test-property',fields,ui,rerender:async()=>{}};
await handleDefaultsClick({target:{closest:selector=>selector==='[data-settings-save]'?{dataset:{settingsSave:'payments'}}:null,matches:()=>false}},ctx);
assert.deepEqual(lastPatch,{'insurance.required_yes':false,'insurance.required_no':true},'Mutually exclusive answer is saved atomically');
assert.equal(stored['manager.name'],'Example manager','Saving a section preserves unrelated values');
assert.equal(ui.activeSection,'payments');assert.equal(ui.editingGroup,'');
ui.editingGroup='payments';
let redrawn=false;
await handleDefaultsClick({target:{closest:selector=>selector==='[data-property-step]'?{dataset:{propertyStep:'keys'},closest:()=>null}:null}}, {...ctx,host:{querySelector:()=>null},rerender:async()=>{redrawn=true;}});
assert.equal(ui.activeSection,'payments'); assert.equal(redrawn,false,'Step change cannot discard an open edit');
console.log(`PASS property flow: ${fields.length} fields mapped once, 15 steps rendered, required-field coverage, atomic paired choice and scoped save`);
