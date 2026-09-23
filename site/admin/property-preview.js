import {CHOICE_PAIRS} from './property-form-layout.js';
const bindings=new WeakSet();
function update(host,ui,focused='') {
 const frame=host.querySelector('[data-property-preview]');if(!frame)return;
 const ctx=ui.previewContext,building={...ctx.building},values={...ctx.values};
 for(const input of host.querySelectorAll('[data-setting]'))values[input.dataset.setting]=input.type==='checkbox'?input.checked:input.value;
 for(const input of host.querySelectorAll('[data-setting-pair]')){
  const pair=CHOICE_PAIRS.find(p=>p.positive===input.dataset.settingPair);
  if(pair&&['yes','no'].includes(input.value)){values[pair.positive]=input.value==='yes';values[pair.negative]=input.value==='no';}
 }
 for(const [input,key] of [['address-street','street'],['address-city','city'],['address-state','state'],['address-abbr','state_abbr'],['address-zip','zip']])if(host.querySelector('#'+input))building[key]=host.querySelector('#'+input).value;
 if(host.querySelector('#signer-name'))values['landlord.print_name']=host.querySelector('#signer-name').value;
 const addressIds=['street','city','state','state_abbr','zip'];
 for(const id of addressIds)values['property.'+id]=building[id]||'';
 values['property.address_full']=[[building.street,'[Unit Number]'].filter(Boolean).join(', '),building.city,[building.state||building.state_abbr,building.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
 frame.previewPayload={type:'property-preview-values',fields:ctx.fields,ids:ctx.ids,section:ctx.section,values,focused,unsaved:!!(ui.editingGroup||ui.addressOpen||ui.signerOpen)};
 frame.contentWindow?.postMessage(frame.previewPayload,location.origin);
}
if(typeof window!=='undefined')window.addEventListener('message',event=>{
 if(event.origin!==location.origin||event.data?.type!=='property-preview-ready')return;
 for(const frame of document.querySelectorAll('[data-property-preview]'))if(frame.contentWindow===event.source&&frame.previewPayload)frame.contentWindow.postMessage(frame.previewPayload,location.origin);
});
export function syncPropertyPreview(host,ui){
 if(!host.querySelector('[data-property-preview]'))return;
 host.propertyPreviewUi=ui;
 if(!bindings.has(host)){
  const sync=event=>{
   const input=event.target;if(!input.matches('[data-setting],[data-setting-pair],[id^="address-"],#signer-name,#signer-email'))return;
   const address={'address-abbr':'property.state_abbr'};
   const id=input.dataset.setting||input.dataset.settingPair||address[input.id]||(input.id.startsWith('address-')?'property.'+input.id.slice(8):input.id==='signer-name'?'landlord.print_name':'landlord_signer_email');
   update(host,host.propertyPreviewUi,id);
  };
  host.addEventListener('input',sync);host.addEventListener('change',sync);host.addEventListener('focusin',sync);bindings.add(host);
 }
 update(host,ui);
}
