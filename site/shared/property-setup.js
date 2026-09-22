// Only defaults explicitly requested for property setup. Existing values win.
export const PROPERTY_INITIAL_DEFAULTS = {
  'lease.end_time':'11:59 PM', 'rent.due_day':'1',
  'insurance.required_yes':true, 'insurance.required_no':false,
  'smoking.in_unit_yes':false, 'smoking.in_unit_no':true,
  'dhcr.lease_type':'Vacancy lease'
};
export const PROPERTY_CONTACT_LINKS = {
  'legal_notice.name':'landlord.entity_name', 'legal_notice.address':'landlord.address', 'legal_notice.phone':'landlord.phone',
  'payee.name':'landlord.entity_name', 'payee.address':'landlord.address', 'payee.phone':'landlord.phone',
  'owner_rep.name':'landlord.print_name', 'owner_rep.email':'landlord_signer_email', 'owner_rep.mailing_address':'landlord.signer_mailing_address'
};
// The registry's idle_unless rules as a draft applies them: a spare Other
// utility row nobody has named reads N/A, and needs a payer once it is named.
export const PROPERTY_IDLE_ROWS = { 'utility.other1':'utility.other1_label', 'utility.other2':'utility.other2_label' };
export function propertySetupDefaults(values={}, signerEmail='') {
  const result={...values};
  for(const [id,value] of Object.entries(PROPERTY_INITIAL_DEFAULTS))if(!Object.hasOwn(result,id))result[id]=value;
  for(const [id,source] of Object.entries(PROPERTY_CONTACT_LINKS))if(!Object.hasOwn(result,id)){
    const value=source==='landlord_signer_email'?signerEmail:result[source];
    if(value!==undefined && value!==null && value!=='')result[id]=value;
  }
  for(const [payer,name] of Object.entries(PROPERTY_IDLE_ROWS))if(!Object.hasOwn(result,payer) && String(result[name] ?? '').trim()==='')result[payer]='N/A';
  for(const [yes,no] of [['insurance.required_yes','insurance.required_no'],['smoking.in_unit_yes','smoking.in_unit_no']]){
    if(Object.hasOwn(values,yes) && !Object.hasOwn(values,no) && typeof values[yes]==='boolean')result[no]=!values[yes];
    if(Object.hasOwn(values,no) && !Object.hasOwn(values,yes) && typeof values[no]==='boolean')result[yes]=!values[no];
  }
  return result;
}
