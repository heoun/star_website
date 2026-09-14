import {mountDocument,patchValues} from './lease-doc.js';
import {formatSettingValue,isAnswered} from '../shared/lease-values.js';
let fields=[],values={},ready=false;
const status=document.querySelector('#status'),editor=document.querySelector('#editor');
const send=data=>parent.postMessage(data,location.origin);
function paint(){
 if(!ready)return;
 const display={},missing={};
 for(const field of fields){if(isAnswered(field,values[field.id]))display[field.id]=formatSettingValue(field,values[field.id]);else missing[field.id]=field.label;}
 patchValues(display,missing);
 const ids=new Set(fields.map(f=>f.id));document.querySelectorAll('[data-lease-slot]').forEach(el=>el.toggleAttribute('data-editable',ids.has(el.dataset.leaseSlot)));
}
function edit(id){
 const field=fields.find(f=>f.id===id);if(!field)return;
 editor.replaceChildren();const heading=document.createElement('h2');heading.textContent=field.label;editor.append(heading);
 const form=document.createElement('form'),label=document.createElement('label');label.textContent=field.label;
 if(field.required){const star=document.createElement('span');star.className='required-mark';label.append(star);}
 const input=document.createElement(field.type==='choice' || field.type==='checkbox'?'select':field.type==='multiline'?'textarea':'input');input.id='draft-field';label.htmlFor=input.id;
 if(input.tagName==='SELECT')for(const option of ['',...(field.type==='checkbox'?['true','false']:field.options)]){const el=document.createElement('option');el.value=option;el.textContent=option===''?'Not answered':field.type==='checkbox'?(option==='true'?'Yes':'No'):option;input.append(el);}
 else if(input.tagName==='INPUT')input.type=field.type==='email'?'email':'text';
 input.value=String(values[id]??'');
 const button=document.createElement('button');button.textContent='Use in new property';button.type='submit';
 const note=document.createElement('p');note.textContent='Saved to this draft only. Create property to save the new property and its defaults together.';
 form.append(label,input,button,note);editor.append(form);input.focus();
 form.onsubmit=event=>{event.preventDefault();const v=field.type==='checkbox' && input.value!==''?input.value==='true':input.value;values[id]=v;paint();send({type:'property-draft-change',id,value:v});note.textContent='Added to the new property draft.';};
}
window.addEventListener('message',event=>{
 if(event.origin!==location.origin || event.source!==parent)return;
 if(event.data?.type==='property-draft-init'){fields=event.data.fields;values=event.data.values || {};paint();}
 if(event.data?.type==='property-draft-values'){values=event.data.values || {};paint();}
});
try{await mountDocument(document.querySelector('#document'),{onSlotClick:edit});ready=true;status.textContent='Blue fields are property defaults. Changes stay in your new property draft.';send({type:'property-draft-ready'});paint();}
catch(error){status.textContent=error.message;}
