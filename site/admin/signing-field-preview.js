// Screen-only overlays: never write into the DOCX or change its layout.
import {signingFields,SIGNING_DOCUMENTS,LOCAL_TABLE_BASE,signingFieldLabel} from '../shared/lease-signing-layout.js';
let layer=null;
export function clearSigningFields(){layer?.remove();layer=null;}
export function showSigningFields(host,signers,selectedId,layoutId='lease',options={}){
 clearSigningFields();
 const fields=signingFields(signers,layoutId,options.values),layout=SIGNING_DOCUMENTS.find(d=>d.id===layoutId),tables=host.querySelectorAll('table');
 if(!fields.length)return {selected:null,count:0};
 const tableBase=options.standalone?LOCAL_TABLE_BASE[layoutId]:0;
 const initials=[...host.querySelectorAll('section.docx p')].filter(p=>/^Tenant\(s\)[’'] initials:/.test(p.textContent.trim()));
 const isUnderlined=span=>{for(let e=span;e && e.tagName!=='P';e=e.parentElement)if(getComputedStyle(e).textDecorationLine.includes('underline'))return true;return false;};
 function target(field){
  if(field.target){
   const t=field.target;
   if(t.paragraph){
    const p=[...host.querySelectorAll('section.docx p')].find(p=>p.textContent.trim()===t.paragraph);
    return t.next?p?.nextElementSibling:p;
   }
   const p=tables[t.table+(options.standalone?0:LOCAL_TABLE_BASE[layoutId])]?.querySelectorAll('p')[t.p];
   return t.tab===undefined?p:[...(p?.querySelectorAll('.docx-tab-stop') || [])].filter(isUnderlined)[t.tab];
  }
  if(field.kind==='initial')return [...(initials[field.section==='38'?0:1]?.querySelectorAll('.docx-tab-stop') || [])].filter(isUnderlined)[field.slot];
  const table=tables[(field.role==='tenant'?layout.tenantTable:layout.landlordTable)-tableBase];
  const index=field.role==='landlord'?(field.kind==='signature'?1:3):(layout.tenantParagraphOffset || 0)+(field.slot<4?0:10)+(field.kind==='signature'?3:8)+field.slot%4;
  return table?.querySelectorAll('p')[index];
 }
 const targets=fields.map(field=>({field,element:target(field)}));
 if(targets.some(t=>!t.element))throw new Error('The original signature lines could not be located.');
 const selected=targets.find(t=>t.field.id===selectedId) || targets[0];
 selected.element.scrollIntoView({block:'center',inline:'nearest'});
 host.style.position='relative';
 layer=document.createElement('div');layer.className='signing-field-layer';layer.setAttribute('aria-label','Signing Field Preview');
 const base=host.getBoundingClientRect(),scale=base.width/host.offsetWidth || 1;
 for(const {field,element} of targets){
  const r=element.getBoundingClientRect(),box=document.createElement('div');
  const bottom=(r.bottom-base.top)/scale-1,height=field.height;
  box.className=`signing-field-box ${field.role}${field.id===selected.field.id?' current':''}`;
  box.dataset.signingField=field.id;box.dataset.kind=field.kind;box.dataset.recipient=field.recipientId;
  box.style.cssText=`left:${(r.left-base.left)/scale}px;top:${bottom-height}px;width:${r.width/scale}px;height:${height}px`;
  const tenantIndex=(options.tenantOrder || signers.filter(s=>s.role==='tenant').map(s=>s.recipientId)).indexOf(field.recipientId)+1;
  const who=field.role==='tenant'?`T${tenantIndex}`:'Landlord';
  box.textContent=field.kind==='full_name'?field.name:field.kind==='date_signed'?'Date Signed':`${who} · ${signingFieldLabel(field.kind)}`;
  box.title=`${field.name} · ${field.email} · ${signingFieldLabel(field.kind)}${field.kind==='date_signed'?' — set when this person signs':''}`;
  layer.append(box);
 }
 host.append(layer);
 return {selected:selected.field.id,count:fields.length};
}
