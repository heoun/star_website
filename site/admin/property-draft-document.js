import {PROPERTY_DOCUMENT_SOURCES} from './property-document-sources.js';
import {sectionsFor} from './property-sections.js';
import {mountDocument,patchValues,fieldsInDocument,scrollToOccurrence} from './lease-doc.js';
import {formatSettingValue,isAnswered} from '../shared/lease-values.js';
let fields=[],values={},ready=false,activeId='';
const status=document.querySelector('#status'),editor=document.querySelector('#editor'),picker=document.querySelector('#document-field');
const send=data=>parent.postMessage(data,location.origin);
let sequence=[];
const canonical=id=>fields.find(f=>f.id===id)?.aliasFor || id;
function highlight(){document.querySelectorAll('[data-lease-slot]').forEach(el=>el.toggleAttribute('data-active-field',canonical(el.dataset.leaseSlot)===canonical(activeId)));}
function goToField(id){const printed=fieldsInDocument().find(key=>canonical(key)===canonical(id));if(printed)scrollToOccurrence(printed,0,{behavior:"instant"});highlight();}

function paint(){
 if(!ready)return;
 const display={},missing={};
 // A required blank is named on the page; an optional blank prints as the blank line it will be.
 for(const field of fields){if(isAnswered(field,values[field.id]))display[field.id]=field.type==='checkbox'?(values[field.id]===true?field.marks?.checked || '☒':field.marks?.unchecked || '☐'):formatSettingValue(field,values[field.id]);else if(field.required || field.readOnly)missing[field.id]=field.label;else display[field.id]='';}
 for(const field of PROPERTY_DOCUMENT_SOURCES){
  missing[field.id]=`${field.label} · ${field.source}`;
  document.querySelectorAll(`[data-lease-slot="${field.id}"]`).forEach(el=>{el.dataset.sourceField=field.source;el.title=`${field.label}: ${field.source}. ${field.detail || 'Added when preparing an individual lease; not editable in Property setup.'}`;});
 }
 // These marks are derived locally from the property-level lease description.
 for(const [id,kind] of [['dhcr.mark_vacancy','Vacancy lease'],['dhcr.mark_renewal','Renewal lease']])if(values['dhcr.lease_type']){display[id]=values['dhcr.lease_type']===kind?'[X]':'[ ]';delete missing[id];}
 patchValues(display,missing);highlight();
 const ids=new Set(fields.filter(f=>!f.readOnly).map(f=>f.id));document.querySelectorAll('[data-lease-slot]').forEach(el=>el.toggleAttribute('data-editable',ids.has(el.dataset.leaseSlot)));
 const input=editor.querySelector('#draft-field');
 if(input && document.activeElement!==input)input.value=String(values[activeId]??'');
}
function edit(id){
 id=canonical(id);const field=fields.find(f=>f.id===id && !f.readOnly);if(!field)return;activeId=id;picker.value=id;
 editor.replaceChildren();const heading=document.createElement('h2');heading.textContent=field.label;editor.append(heading);
 const form=document.createElement('form'),label=document.createElement('label');label.textContent=field.label;
 if(field.required){const star=document.createElement('span');star.className='required-mark';label.append(star);}
 else{const mark=document.createElement('span');mark.className='optional-mark';mark.textContent='Optional';label.append(mark);}
 const input=document.createElement(field.type==='choice' || field.type==='checkbox'?'select':field.type==='multiline'?'textarea':'input');input.id='draft-field';label.htmlFor=input.id;
 if(input.tagName==='SELECT')for(const option of ['',...(field.type==='checkbox'?['true','false']:field.options)]){const el=document.createElement('option');el.value=option;el.textContent=option===''?'Not answered':field.type==='checkbox'?(option==='true'?'Yes':'No'):option;input.append(el);}
 else if(input.tagName==='INPUT')input.type=field.type==='email'?'email':'text';
 input.value=String(values[id]??'');
 const position=document.createElement('p');position.className='field-position';position.textContent=`Field ${sequence.indexOf(id)+1} of ${sequence.length}`;editor.prepend(position);
 const navigation=document.createElement('div');navigation.className='field-navigation';
 for(const [delta,label] of [[-1,'Previous Field'],[1,'Next Field']]){const button=document.createElement('button');button.type='button';button.textContent=label;const target=sequence[sequence.indexOf(id)+delta];button.disabled=!target;button.onclick=()=>edit(target);navigation.append(button);}

 const note=document.createElement('p');note.textContent='Changes sync to the form automatically. Create Property saves the property and its defaults together.';
 form.append(label,input,note);if(field.note){const hint=document.createElement('p');hint.className='field-note';hint.textContent=field.note;form.append(hint);}editor.append(form,navigation);input.focus({preventScroll:true});goToField(id);
 if(!fieldsInDocument().some(key=>canonical(key)===id)){const hint=document.createElement('p');hint.className='field-note';hint.textContent='This property setting is saved with your draft; it is not printed as a separate field in this template.';editor.append(hint);}

 const update=()=>{const v=field.type==='checkbox' && input.value!==''?input.value==='true':input.value;values[id]=v;send({type:'property-draft-change',id,value:v});paint();note.textContent='Synced to your New Property draft.';};
 input.addEventListener('input',update);input.addEventListener('change',update);
 form.onsubmit=event=>{event.preventDefault();update();};
}
picker.addEventListener('change',()=>edit(picker.value));
const zoom=document.querySelector('#document-zoom'),documentHost=document.querySelector('#document');
function fit(){const page=documentHost.querySelector('section.docx');if(!page)return;const width=parseFloat(getComputedStyle(page).width) || 816;document.documentElement.style.setProperty('--document-zoom',zoom.value==='fit'?String(Math.max(.2,Math.min(1.3,(documentHost.clientWidth-40)/width))):zoom.value);}
zoom.addEventListener('change',fit);new ResizeObserver(fit).observe(documentHost);
window.addEventListener('message',event=>{
 if(event.origin!==location.origin || event.source!==parent)return;
 if(event.data?.type==='property-draft-init'){
  fields=event.data.fields;values=event.data.values || {};
  const editable=fields.filter(f=>!f.readOnly && !f.aliasFor),ids=new Set(editable.map(f=>f.id));
  const formOrder=sectionsFor(editable.filter(f=>f.source==='manager')).flatMap(s=>s.fields.map(f=>f.id));
  sequence=[...new Set([...fieldsInDocument().map(canonical).filter(id=>ids.has(id)),...formOrder,...editable.map(f=>f.id)])];
  picker.replaceChildren();for(const id of sequence){const field=editable.find(f=>f.id===id);picker.append(new Option(field.label,id));}
  paint();fit();const first=sequence.find(id=>{const field=fields.find(f=>f.id===id);return field.required && !isAnswered(field,values[id]);}) || sequence[0];if(first)edit(first);

 }
 if(event.data?.type==='property-draft-values'){values=event.data.values || {};paint();}
});
try{await mountDocument(documentHost,{onSlotClick:edit,templatePath:'./lease-template.docx?purpose=property-setup'});ready=true;status.textContent='Blue fields are editable property defaults. Grey fields show their data source and are filled during lease preparation.';send({type:'property-draft-ready'});paint();fit();}
catch(error){status.textContent=error.message;}
