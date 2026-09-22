// Shared field layout for new-property drafts and the saved-property editor.
export const PROPERTY_LABELS = {
 'landlord.print_name':"Landlord signer's name",'landlord.entity_name':'Landlord legal entity','landlord.address':'Landlord address',
 'manager.name':"Property Manager's Name",'manager.contact_name':'Property Management Contact','manager.email':'Property Management Email','manager.address':"Property Management's Address",'manager.phone':"Property Management's Phone",
 'legal_notice.name':"Landlord / Authorized Recipient's Name",'legal_notice.address':"Landlord / Authorized Recipient's Address",'legal_notice.phone':"Landlord / Authorized Recipient's Phone Number",'emergency.phone':'Housing Emergency Contact'
};
export const CHOICE_PAIRS = [
 {positive:'insurance.required_yes',negative:'insurance.required_no',label:'Renters Insurance',yes:'IS required',no:'IS NOT required'},
 {positive:'smoking.in_unit_yes',negative:'smoking.in_unit_no',label:'Smoking Allowance',yes:'IS allowed',no:'IS NOT allowed'},
 {positive:'sprinkler.mark_option2',negative:'sprinkler.mark_option1',label:'Sprinkler System',yes:'Present and maintained',no:'No sprinkler system in the unit'}
];
export const KEY_TYPES=[['unit','Unit Key'],['building','Building Key'],['mailbox','Mailbox Key'],['fob','Keyless Entry Remote / FOB'],['garage','Garage Door Remote'],['other','Other']];
export const GOOD_CAUSE_QUESTIONS=[
 ['1. Is this unit subject to Good Cause Eviction?',f=>['good_cause.mark_yes','good_cause.mark_no'].includes(f.id)],
 ['2. If exempt, why is it exempt?',f=>f.id.startsWith('good_cause.exempt_')],
 ['3. If the rent increase exceeds the threshold, what is the justification?',f=>f.id.startsWith('good_cause.increase_')],
 ['4. If the lease is not being renewed, what is the reason?',f=>f.id.startsWith('good_cause.nonrenewal_')]
];
export function sectionBlocks(section){
 if(section.id==='keys')return KEY_TYPES.map(([id,label])=>({label,fields:section.fields.filter(f=>f.id.startsWith(`key.${id}_`)).map(f=>({...f,label:f.id.endsWith('_qty')?'Quantity Issued':f.id.endsWith('_charge')?'Replacement Charge per Key / FOB':f.label}))}));
 if(section.id==='good_cause')return GOOD_CAUSE_QUESTIONS.map(([label,match])=>({label,fields:section.fields.filter(match)}));
 if(section.id==='smoking')return [{label:'Locations Where Smoking Is Not Allowed',fields:section.fields}];
 return [{label:'',fields:section.fields}];
}
