// Screen-only overlays: never write into the DOCX or change its layout.
// Each box is drawn on the field's anchor token as the renderer laid it out,
// with the same offsets and sizes the DocuSign tab gets, so what the screen
// shows is what the converted document will carry.
import {signingFields,signingFieldLabel} from '../shared/lease-signing-layout.js';
let layer=null;
export function clearSigningFields(){layer?.remove();layer=null;}
export function showSigningFields(host,signers,selectedId,layoutId='lease',options={}){
 clearSigningFields();
 const fields=signingFields(signers,layoutId,options.values);
 if(!fields.length)return {selected:null,count:0};
 const spans=[...host.querySelectorAll('section.docx span')];
 const targets=fields.map(field=>({field,element:spans.filter(s=>s.textContent===field.anchor)}));
 if(targets.some(t=>t.element.length!==1))throw new Error('The signing anchors could not be located in this document. Prepare the package again.');
 const selected=targets.find(t=>t.field.id===selectedId) || targets[0];
 selected.element[0].scrollIntoView({block:'center',inline:'nearest'});
 host.style.position='relative';
 layer=document.createElement('div');layer.className='signing-field-layer';layer.setAttribute('aria-label','Signing Field Preview');
 const base=host.getBoundingClientRect(),scale=base.width/host.offsetWidth || 1;
 for(const {field,element} of targets){
  const r=element[0].getBoundingClientRect(),box=document.createElement('div');
  box.className=`signing-field-box ${field.role}${field.id===selected.field.id?' current':''}`;
  box.dataset.signingField=field.id;box.dataset.kind=field.kind;box.dataset.recipient=field.recipientId;
  // The tab's bottom-left sits on the token's bottom-left plus the offsets;
  // the box drawn here is the ink DocuSign centres inside that tab.
  box.style.cssText=`left:${(r.left-base.left)/scale+field.xOffset}px;top:${(r.bottom-base.top)/scale+field.yOffset+field.height-field.anchorHeight-field.inkLift-field.inkHeight}px;width:${field.width}px;height:${field.inkHeight}px`;
  const tenantIndex=(options.tenantOrder || signers.filter(s=>s.role==='tenant').map(s=>s.recipientId)).indexOf(field.recipientId)+1;
  const who=field.role==='tenant'?`T${tenantIndex}`:'Landlord';
  box.textContent=field.kind==='full_name'?field.name:field.kind==='date_signed'?'Date Signed':`${who} · ${signingFieldLabel(field.kind)}`;
  box.title=`${field.name} · ${field.email} · ${signingFieldLabel(field.kind)}${field.kind==='date_signed'?' — set when this person signs':''}`;
  layer.append(box);
 }
 host.append(layer);
 return {selected:selected.field.id,count:fields.length};
}
