import {composeAddress} from '../shared/lease-address.js';
export const PROPERTY_FORM_FIELDS=[
 {id:'property.name',name:'name',label:'Property Name'},
 {id:'property.street',name:'street',label:'Street'},
 {id:'property.city',name:'city',label:'City'},
 {id:'property.state_abbr',name:'state_abbr',label:'State'},
 {id:'property.zip',name:'zip',label:'ZIP Code'},
 {id:'landlord_signer_email',name:'landlord_signer_email',label:"Landlord Signer's Email",type:'email'}
].map(f=>({...f,type:f.type || 'text',required:true}));
const STATES={NY:'New York',NJ:'New Jersey',CT:'Connecticut'};
export function documentDraftValues(selected,property){
 const values={...selected};
 for(const field of PROPERTY_FORM_FIELDS)values[field.id]=property[field.name] || '';
 values['property.state']=STATES[property.state_abbr] || property.state_abbr || '';
 values['property.address_full']=composeAddress(values);
 values['concession.terms']=values['concession.default_terms'] || '';
 return values;
}
export function draftStore(owner,storage){
 const key=owner?`star.new-property.v1:${encodeURIComponent(owner)}`:null;
 return {
  load(){try{const s=key?JSON.parse(storage.getItem(key)):null;return s?.version===1 && Array.isArray(s.rows) && ['manual','lease'].includes(s.mode)?s:null;}catch{return null;}},
  save(value){if(!key)return false;try{storage.setItem(key,JSON.stringify({...value,version:1}));return true;}catch{return false;}},
  clear(){try{if(key)storage.removeItem(key);}catch{}}
 };
}
