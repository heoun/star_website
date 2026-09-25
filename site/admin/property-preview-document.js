import {mountDocument,patchField,showSections,clearHighlight} from './lease-doc.js';
import {formatSettingValue,isAnswered} from '../shared/lease-values.js';
import {CHOICE_PAIRS} from './property-form-layout.js';
import {PROPERTY_DOCUMENT_SOURCES} from './property-document-sources.js';
const host=document.querySelector('#document'),picker=document.querySelector('#field'),count=document.querySelector('#count'),position=document.querySelector('#position'),empty=document.querySelector('#empty'),status=document.querySelector('#status');
let registry=[],payload=null,active='',index=0,ready=false,section='',matches=[];
const field=id=>registry.find(f=>f.id===id)||{id,label:id,type:'text'};
const canonical=id=>field(id).aliasFor||id;
const addressParts=['property.street','property.city','property.state','property.state_abbr','property.zip'];
let cachedSlots=[],lastDisplay={},lastMissing={},lastIds='';
const slots=()=>cachedSlots;
function fit(){const page=host.querySelector('section.docx:not([data-doc-hidden])');if(!page)return;const width=parseFloat(getComputedStyle(page).width)||816;document.documentElement.style.setProperty('--preview-zoom',document.querySelector('#zoom').value==='fit'?String(Math.max(.2,Math.min(1.2,(host.clientWidth-34)/width))):document.querySelector('#zoom').value);}
function locate(){
 matches=slots().filter(el=>(active==='concession.default_terms'?el.dataset.leaseSlot==='concession.terms':active==='dhcr.lease_type'?['dhcr.mark_vacancy','dhcr.mark_renewal'].includes(el.dataset.leaseSlot):(canonical(el.dataset.leaseSlot)===canonical(active)||(addressParts.includes(active)&&el.dataset.leaseSlot==='property.address_full'))));
 index=Math.max(0,Math.min(index,matches.length-1));
 count.textContent=matches.length?`${index+1} / ${matches.length}`:'0 locations';
 document.querySelector('#previous').disabled=index===0;document.querySelector('#next').disabled=index>=matches.length-1;
 clearHighlight();slots().forEach(el=>el.classList.remove('is-current-match'));
 const target=matches[index];empty.hidden=!!target;host.hidden=!target;
 empty.textContent='This setting is not printed as a separate field in the lease template.';
 const describe=el=>`Template Section ${Number(el.dataset.leaseSection)+1} · ${el.dataset.leaseHeading||field(active).label}`;
 position.textContent=target?describe(target):field(active).label;
 const list=document.querySelector('#locations');list.replaceChildren();
 matches.forEach((el,n)=>{const button=document.createElement('button');button.textContent=`${n+1}. ${describe(el)}`;button.onclick=()=>{index=n;locate();};list.append(button);});
 if(target){showSections(Number(target.dataset.leaseSection),Number(target.dataset.leaseSection));target.classList.add('is-current-match');fit();host.scrollTo({top:host.scrollTop+target.getBoundingClientRect().top-host.getBoundingClientRect().top-host.clientHeight/2,behavior:'instant'});}
}
function paint(data){
 if(!ready)return;payload=data;
 const display={},missing={};
 for(const f of registry){const value=data.values[f.id];if(isAnswered(f,value))display[f.id]=f.type==='checkbox'?(value===true?f.marks?.checked||'☒':f.marks?.unchecked||'☐'):formatSettingValue(f,value);else missing[f.id]=f.label;}
 for(const f of PROPERTY_DOCUMENT_SOURCES)if(!Object.hasOwn(data.values,f.id))missing[f.id]=`${f.label} · ${f.source}`;
 for(const [id,kind] of [['dhcr.mark_vacancy','Vacancy lease'],['dhcr.mark_renewal','Renewal lease']])if(data.values['dhcr.lease_type']){display[id]=data.values['dhcr.lease_type']===kind?'[X]':'[ ]';delete missing[id];}
 if(data.values['concession.default_terms']){display['concession.terms']=data.values['concession.default_terms'];delete missing['concession.terms'];}
 for(const id of new Set([...Object.keys(display),...Object.keys(missing),...Object.keys(lastDisplay),...Object.keys(lastMissing)])){
  if(display[id]!==lastDisplay[id]||missing[id]!==lastMissing[id])patchField(id,display[id]||'',missing[id]||null);
 }
 lastDisplay=display;lastMissing=missing;
 const previousActive=active,previousSection=section;
 if(section!==data.section){
  active=data.ids[0]||'';
  const pair=CHOICE_PAIRS.find(pair=>[pair.positive,pair.negative].includes(active));
  if(pair&&data.values[pair.positive]!==data.values[pair.negative]){
   if(data.values[pair.positive]===true)active=pair.positive;
   else if(data.values[pair.negative]===true)active=pair.negative;
  }
  index=0;section=data.section;document.querySelector('details').open=false;
 }
 if(data.focused&&data.focused!==active){active=data.focused;index=0;}
 const ids=[...new Set([...data.ids,...(active?[active]:[])])];
 if(lastIds!==JSON.stringify(ids)){picker.replaceChildren();for(const id of ids)picker.append(new Option(field(id).label,id));lastIds=JSON.stringify(ids);}
 picker.value=active;
 status.textContent=(data.unsaved?'Unsaved Preview':'Property Settings Preview')+' · Applicant and listing details are filled for each rental. Template sections may differ from final PDF pages.';
 if(previousActive!==active||previousSection!==section)locate();
}
picker.onchange=()=>{active=picker.value;index=0;locate();};
document.querySelector('#previous').onclick=()=>{index--;locate();};document.querySelector('#next').onclick=()=>{index++;locate();};
document.querySelector('#zoom').onchange=fit;new ResizeObserver(fit).observe(host);
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='property-preview-values')return;payload=event.data;paint(payload);});
try{
 const response=await fetch('/api/admin/lease/fields',{credentials:'same-origin'});if(!response.ok)throw Error('Lease fields could not be loaded.');registry=(await response.json()).registry.fields;
 await mountDocument(host,{onSlotClick:id=>{if(payload?.ids.includes(canonical(id))){active=canonical(id);index=0;picker.value=active;locate();}}});cachedSlots=[...host.querySelectorAll('[data-lease-slot]')];ready=true;
 parent.postMessage({type:'property-preview-ready'},location.origin);if(payload)paint(payload);
}catch(error){status.textContent=error.message;host.hidden=true;}
