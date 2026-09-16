import {splitImportedAddress} from './lease-import-context.js';
import {PROPERTY_FORM_FIELDS,documentDraftValues,draftStore} from './property-draft-state.js';
import { readLeaseFile } from './lease-import-reader.js';
import { extractLeaseDefaults, buildImportPatch } from './lease-import-extract.js';
import { PROPERTY_LABELS, CHOICE_PAIRS, sectionBlocks } from './property-form-layout.js';
import { propertySetupDefaults, PROPERTY_CONTACT_LINKS } from '../shared/property-setup.js';
import { sectionsFor } from './property-sections.js';
import { isAnswered, formatSettingValue } from '../shared/lease-values.js';

// Form and document share one draft. An account-scoped tab backup survives reload;
// only Create Property writes the reviewed values to the authenticated backend.
export function openNewProperty({draftOwner, fields, api, escapeHtml: esc, onSaved, setStatus}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'property-import new-property-import is-choosing';
  dialog.setAttribute('aria-labelledby','import-title');
  let draft = null, fileName = '', busy = false, generation = 0, mode = '';
  const baseline = {}, rows = new Map();
  let creationToken = crypto.randomUUID(), completed=false;
  let browserStorage;try{browserStorage=sessionStorage;}catch{}
  const storage=draftStore(draftOwner,browserStorage);
  let savedDraft=storage.load();
  let submittedPayload = null, activeSection = 'property', formExpanded=false, documentOpen=false;
  const explicit = new Set();
  const fieldById = new Map(fields.map(field=>[field.id,field]));
  dialog.innerHTML = `<header class="import-head"><div><span class="k">Properties & Settings</span><h2 id="import-title">New Property</h2><p data-import-intro>Choose how you would like to add this property.</p></div><div class="import-window-actions"><button type="button" data-import-expand aria-label="Expand New Property" aria-pressed="false">Expand</button><button type="button" data-import-close aria-label="Close lease import">Close</button></div></header>
    <div class="import-body">
    <section class="draft-resume" hidden><p>A saved New Property draft is available in this browser tab.</p><button type="button" data-draft-resume>Continue Draft</button><button type="button" data-draft-discard>Discard Draft</button></section>
    <section class="import-methods" aria-label="Choose a Property Setup Method">
      <button type="button" data-import-method="manual" aria-label="Enter Manually"><strong>Enter Manually</strong><span>Enter the property details and set its lease defaults yourself.</span></button>
      <button type="button" data-import-method="lease" aria-label="Autoread from a Previous Lease"><strong>Autoread from a Previous Lease</strong><span>Upload a PDF or DOCX, then review the extracted property details and defaults.</span></button>
    </section>
    <ol class="import-progress" hidden></ol>
    <section class="import-upload" hidden><button type="button" class="link" data-import-back>← Back to Setup Options</button><label for="lease-import-file"><b>Choose a Previous Lease</b><span>PDF or DOCX · Up to 20 MB</span></label><p class="import-drop-hint" id="lease-drop-hint">Drag and drop a PDF or DOCX here, or choose a file below.</p><input aria-describedby="lease-drop-hint" id="lease-import-file" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"><p>Only property details and shared lease settings are extracted. Review them before creating the property. Scanned pages need a searchable text copy.</p></section>
    <p class="import-message" role="status" aria-live="polite"></p><div class="import-review"></div></div>
    <footer class="import-footer"><div><span data-import-count>Choose a setup method to begin.</span><small data-draft-saved role="status"></small></div><div><button type="button" data-import-close>Cancel</button><button type="button" class="primary" data-import-save hidden disabled>Create property</button></div></footer>`;
  dialog.insertAdjacentHTML('beforeend',`<section class="draft-document-workspace" hidden><header><button type="button" data-draft-back>← Back to Form</button><b>New Property · Document</b><small data-draft-saved role="status"></small><button type="button" data-import-close>Close</button></header><div data-draft-document-host></div></section>`);
  document.body.append(dialog);
  dialog.querySelector('.draft-resume').hidden=!savedDraft;
  const previous = document.activeElement;
  dialog.addEventListener('close',()=>{saveDraft();generation++;dialog.remove();if(previous?.isConnected) previous.focus();},{once:true});
  dialog.addEventListener('cancel',event=>{if(busy || documentOpen)event.preventDefault();if(documentOpen && !busy)setDocumentView(false);});
  dialog.addEventListener('submit',event=>{event.preventDefault();dialog.querySelector('[data-import-save]').click();});
  const message = (text, error=false) => {
    const el = dialog.querySelector('.import-message'); el.textContent = text; el.dataset.tone = error ? 'error' : '';
  };
  const refreshCount = () => {
    const count = [...rows.values()].filter(row=>row.selected).length;
    dialog.querySelector('[data-import-count]').textContent = draft ? `${count} setting${count===1?'':'s'} entered · New property draft` : mode === 'lease' ? 'Choose a previous lease to begin.' : 'Choose a setup method to begin.';
    dialog.querySelector('[data-import-save]').disabled = busy || !draft || !dialog.querySelector('[data-import-confirm]')?.checked;
  };
  const setBusy = value => {
    busy = value;
    dialog.querySelector('#lease-import-file').disabled = value || Boolean(submittedPayload);
    dialog.querySelectorAll('[data-import-close], [data-import-back]').forEach(el=>el.disabled=value);
    dialog.querySelector('.import-review').inert = value || Boolean(submittedPayload);
    dialog.querySelector('.draft-document-workspace').inert = value || Boolean(submittedPayload);
    refreshCount();
  };
  const control = (field, value) => {
    const attrs = `data-import-value="${esc(field.id)}" id="import-value-${esc(field.id)}" aria-label="Proposed ${esc(field.label)}"`;
    if (field.type === 'checkbox') return `<select ${attrs}><option value="">Choose One</option><option value="true"${value===true?' selected':''}>Marked</option><option value="false"${value===false?' selected':''}>Not marked</option></select>`;
    if (field.type === 'choice') return `<select ${attrs}><option value="">Choose One</option>${field.options.map(option=>`<option${option===value?' selected':''}>${esc(option)}</option>`).join('')}</select>`;
    return `<${field.type==='multiline'?'textarea':'input'} ${attrs}${field.type==='multiline'?` rows="2">${esc(value ?? '')}</textarea>`:` type="${field.type==='email'?'email':'text'}" value="${esc(value ?? '')}" placeholder="${mode==='manual'?'Enter a value':'Enter after reviewing the lease'}">`}`;
  };
  // Whatever the form holds is what the new property gets: a value is saved and a blank is left unset.
  const selectByValue=(row,field)=>{row.selected=isAnswered(field,row.value);};
  const rowMarkup = field => {
    if(field.id==='landlord_signer_email')return `<tr><th><label for="draft-signer-email">Landlord signer's email<span class="required-mark" aria-hidden="true"></span></label></th><td><input id="draft-signer-email" form="new-property-details" name="landlord_signer_email" type="email" required></td></tr>`;
    const row=rows.get(field.id),detected=row.detected;
    return `<tr data-import-row="${esc(field.id)}"><th scope="row"><label for="import-value-${esc(field.id)}">${esc(PROPERTY_LABELS[field.id] || field.label)}${field.required?'<span class="required-mark" aria-hidden="true"></span>':''}</label>${mode==='manual'?'':row.conflict?'<span class="import-flag">Conflicting values · Choose one</span>':detected?'<span class="import-detected">Detected</span>':field.required?'<span class="import-muted">Enter or confirm the default</span>':'<span class="import-muted">Optional</span>'}</th><td>${control(field,row.value)}${PROPERTY_CONTACT_LINKS[field.id]?'<small class="draft-default-hint">Defaults to the landlord contact above; you can override it.</small>':''}${field.note?`<small class="draft-default-hint">${esc(field.note)}</small>`:''}${detected?`<details class="import-source"${row.conflict?' open':''}><summary>View Source${row.conflict?' & Alternatives':''}</summary>${row.conflict?row.alternatives.map((item,index)=>`<div><b>${esc(formatSettingValue(field,item.value))}</b><p>${esc(item.location || '')}</p><blockquote>${esc(item.evidence)}</blockquote><button type="button" data-import-choice="${esc(field.id)}" data-import-option="${index}">Use This Value</button></div>`).join(''):`<p>${esc(row.evidence)}</p><small>${esc(row.location)}</small>`}</details>`:''}</td></tr>`;
  };
  const pairMarkup = pair => {
    const yes=rows.get(pair.positive),no=rows.get(pair.negative),value=yes.value===true && no.value!==true?'yes':no.value===true && yes.value!==true?'no':'';
    // Both marks usually come from one sentence, so the pair shows one source.
    const sources=[];
    for(const row of [yes,no])for(const item of row.detected?[row,...(row.alternatives || [])]:[])if(!sources.some(s=>s.evidence===item.evidence))sources.push({evidence:item.evidence,location:item.location || row.location || ''});
    const conflict=yes.conflict || no.conflict;
    return `<tr class="draft-pair"><th><label for="draft-pair-${pair.positive}">${esc(pair.label)}</label>${mode==='manual'?'':conflict?'<span class="import-flag">Conflicting imported choices · Select one</span>':sources.length?'<span class="import-detected">Detected</span>':''}</th><td><select id="draft-pair-${pair.positive}" data-import-pair="${pair.positive}"><option value="">Choose One</option><option value="yes"${value==='yes'?' selected':''}>${pair.yes}</option><option value="no"${value==='no'?' selected':''}>${pair.no}</option></select><small class="draft-default-hint">Selecting one clears the other mark.</small>${[yes,no].map(row=>`<input hidden data-import-value="${row.id}" value="${esc(String(row.value))}">`).join('')}${sources.length?`<details class="import-source"><summary>View Source${conflict?' & Alternatives':''}</summary>${sources.map(s=>`<p>${esc(s.evidence)}</p>${s.location?`<small>${esc(s.location)}</small>`:''}`).join('')}</details>`:''}</td></tr>`;
  };
  const table = own => `<div class="import-table-wrap"><table class="import-table"><thead><tr><th>Property Setting</th><th>Value</th></tr></thead><tbody>${own.map(field=>{const pair=CHOICE_PAIRS.find(p=>[p.positive,p.negative].includes(field.id));return pair ? field.id===pair.positive?pairMarkup(pair):'':rowMarkup(field);}).join('')}</tbody></table></div>`;
  const propertyForm = address => {
    const parsed=splitImportedAddress(address);
    const input = (name,label,value='',extra='') => `<label>${label}<input name="${name}" value="${esc(value)}" maxlength="200" ${extra}></label>`;
    return `<section class="import-property-details"><h3>Property Address</h3><form id="new-property-details" data-new-property-form><div class="import-property-grid">
      ${input('name','Property name',parsed.street || '', 'required')}
      ${input('street','Street',parsed.street || '', 'required')}
      ${input('city','City',parsed.city, 'required')}
      ${input('state_abbr','State',parsed.state_abbr || 'NY', 'required pattern="[A-Za-z]{2}"')}
      ${input('zip','ZIP code',parsed.zip, 'required pattern="[0-9]{5}(-[0-9]{4})?"')}
      </div></form>${mode==='lease' && draft.addressReview?.candidates?.length?`<details class="import-address-evidence"${draft.addressReview.value?'':' open'}><summary>${draft.addressReview.value?'View Address Source':'Review Possible Property Addresses'}</summary>${draft.addressReview.candidates.map((candidate,index)=>`<div><b>${esc(candidate.value)}</b><p>${esc(candidate.reason)} · ${esc(candidate.location)}</p><blockquote>${esc(candidate.evidence)}</blockquote><button type="button" data-import-address="${index}">Use This Property Address</button></div>`).join('')}</details>`:''}</section>`;
  };
  const prepareRows = () => {
    rows.clear();explicit.clear();
    for (const field of fields) {
      const candidate=draft.candidates.find(item=>item.id===field.id);
      const row={id:field.id,value:'',detected:!!candidate,evidence:'',location:'',alternatives:[],conflict:false,...candidate};
      // Two different readings start blank; both are listed for choosing.
      if(row.conflict){row.alternatives=[{value:row.value,evidence:row.evidence,location:row.location},...row.alternatives];row.value='';}
      row.selected=isAnswered(field,row.value);rows.set(field.id,row);
      if(candidate)explicit.add(field.id);
    }
  };
  const syncDefaults = () => {
    const values=Object.fromEntries([...rows.values()].filter(r=>explicit.has(r.id)).map(r=>[r.id,r.selected && !r.conflict?r.value:null]));
    const defaults=propertySetupDefaults(values,dialog.querySelector('[name="landlord_signer_email"]')?.value || '');
    for(const row of rows.values())if(!explicit.has(row.id)){
      row.value=defaults[row.id] ?? '';row.selected=isAnswered(fieldById.get(row.id),row.value);
      const input=dialog.querySelector(`[data-import-value="${CSS.escape(row.id)}"]`);if(input)input.value=String(row.value);
    }
    dialog.querySelectorAll('[data-draft-complaint]').forEach(el=>el.textContent=[rows.get('manager.name')?.value,rows.get('manager.phone')?.value].filter(Boolean).join(' · ') || 'Enter the property manager’s name and phone in Management & Notices.');
  };
  const alignStep = () => {
    const nav=dialog.querySelector('.draft-steps'),current=nav?.querySelector('[aria-current="step"]');if(!current)return;
    const box=nav.getBoundingClientRect(),item=current.getBoundingClientRect();
    if(nav.scrollWidth>nav.clientWidth)nav.scrollLeft+=item.left-box.left-8;
    else if(item.top<box.top)nav.scrollTop+=item.top-box.top-8;
    else if(item.bottom>box.bottom)nav.scrollTop+=item.bottom-box.bottom+8;
  };
  const layoutObserver=new ResizeObserver(alignStep);
  dialog.addEventListener('close',()=>layoutObserver.disconnect(),{once:true});
  const showSection = id => {
    const groups=sectionsFor(fields),index=groups.findIndex(g=>g.id===id);if(index<0)return;
    activeSection=id;
    dialog.querySelectorAll('[data-draft-section]').forEach(el=>el.hidden=el.dataset.draftSection!==id);
    dialog.querySelectorAll('[data-draft-step]').forEach(el=>{if(el.dataset.draftStep===id)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');});
    dialog.querySelector('[data-draft-position]').textContent=`Step ${index+1} of ${groups.length}`;
    const prev=dialog.querySelector('[data-draft-prev]'),next=dialog.querySelector('[data-draft-next]');prev.disabled=index===0;next.hidden=index===groups.length-1;
    dialog.querySelector('[data-draft-finish]').hidden=index!==groups.length-1;
    dialog.querySelector('[data-import-save]').hidden=index!==groups.length-1;
    alignStep();
  };
  const renderReview = () => {
    syncDefaults();
    const detected=draft.candidates.length,groups=sectionsFor(fields);
    dialog.querySelector('.import-upload').hidden=true;
    dialog.querySelector('.import-progress').innerHTML=mode==='manual'?'<li aria-current="step">1. Enter Details</li><li>2. Create Property</li>':'<li>1. Upload Lease ✓</li><li aria-current="step">2. Review Fields</li><li>3. Create Property</li>';
    const context = id => id==='bedbug'?'<p class="import-guidance"><b>Date of Vacancy Lease</b><br>Defaults to the listing release date when a lease is prepared. A new property does not have a listing release date yet.</p><h4>Bedbug Infestation History</h4>':id==='sprinkler'?'<p class="import-guidance">If a maintained sprinkler system is selected and no date is entered, the listing release date is used when preparing the lease. Otherwise the date stays blank.</p>':id==='smoking'?'<div class="import-guidance"><b>Complaint Procedure</b><p data-draft-complaint></p></div>':'';

    const content=group=>{
      if(group.id==='property')return propertyForm(draft.sourceAddress);
      if(group.id==='signing')return table([group.fields[0],{id:'landlord_signer_email'},...group.fields.slice(1)]);
      return context(group.id)+sectionBlocks(group).map(block=>`${block.label?`<h4>${esc(block.label)}</h4>`:''}${table(block.fields)}`).join('');
    };
    dialog.querySelector('.import-review').innerHTML=`<div class="import-summary"><div><h3>${mode==='manual'?'Property Setup':`${detected} Settings Detected`}</h3>${mode==='manual'?'':`<p>${esc(fileName)}</p>`}</div>${mode==='manual'?'':'<div class="import-file-actions"><button type="button" data-import-change>Change Lease</button></div>'}</div>
      ${draft.warnings.length?`<ul class="import-warnings">${draft.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>`:''}
      <div class="draft-layout"><nav class="draft-steps" aria-label="Property Setup Sections">${groups.map((g,i)=>`<button type="button" data-draft-step="${g.id}"><small>${String(i+1).padStart(2,'0')}</small><span>${esc(g.label)}</span></button>`).join('')}</nav><div class="draft-content"><p data-draft-position tabindex="-1"></p>${groups.map(group=>`<section data-draft-section="${group.id}"><h3>${esc(group.title || group.label)}</h3><p class="draft-section-note">${esc(group.note)}</p>${content(group)}</section>`).join('')}
      <div data-draft-finish hidden><p>Review all sections before creating this property. Only this new property and the defaults entered here will be saved.</p><label class="import-confirm"><input type="checkbox" data-import-confirm><span>I have reviewed this new property’s details and default settings.</span></label></div>
      <div class="draft-navigation"><button type="button" data-draft-prev>← Previous</button><button type="button" data-draft-next>Next →</button></div></div></div>
      <section class="import-document"><button type="button" data-draft-document>Fill these in on the document</button><p>Changes stay in this new property draft until you create it.</p></section>`;
    layoutObserver.disconnect();layoutObserver.observe(dialog.querySelector('.draft-steps'));syncDefaults();showSection('property');refreshCount();saveDraft();
  };
  const importFile=async file=>{
      if (!file || busy || submittedPayload || mode!=='lease') return;
      const ticket=++generation; draft=null; rows.clear();
      dialog.querySelector('.import-upload').hidden = false;
      dialog.querySelector('.import-review').innerHTML=''; setBusy(true); message('Reading lease text…');
      try {
        const {text,warnings}=await readLeaseFile(file,progress=>message(progress));
        if (!dialog.isConnected || ticket!==generation) return;
        draft=extractLeaseDefaults(text,fields);draft.warnings.push(...warnings); fileName=file.name;
        prepareRows();
        renderReview(); message(draft.candidates.length?'Review the property details and defaults, then create the property.':'No matching settings were detected. Enter the property details and any defaults manually.');
      } catch(error) { message(error.message || 'This file could not be read. Try another PDF or DOCX.',true); }
      finally { if(dialog.isConnected && ticket===generation) setBusy(false); }
  };
  const uploadZone=dialog.querySelector('.import-upload');
  let dragDepth=0;
  const fileDrag=event=>Array.from(event.dataTransfer?.types || []).includes('Files');
  const canDrop=()=>mode==='lease' && !busy && !submittedPayload && !uploadZone.hidden;
  const clearDrag=()=>{dragDepth=0;uploadZone.classList.remove('is-dragover');};
  // Catch file drops inside the dialog so a missed target cannot navigate away.
  dialog.addEventListener('dragover',event=>{if(fileDrag(event))event.preventDefault();});
  dialog.addEventListener('drop',event=>{if(fileDrag(event))event.preventDefault();clearDrag();});
  uploadZone.addEventListener('dragenter',event=>{if(!fileDrag(event))return;event.preventDefault();if(canDrop()){dragDepth++;uploadZone.classList.add('is-dragover');}});
  uploadZone.addEventListener('dragover',event=>{if(!fileDrag(event))return;event.preventDefault();event.dataTransfer.dropEffect=canDrop()?'copy':'none';});
  uploadZone.addEventListener('dragleave',event=>{if(!fileDrag(event))return;if(--dragDepth<=0)clearDrag();});
  uploadZone.addEventListener('drop',async event=>{
    if(!fileDrag(event))return;event.preventDefault();clearDrag();if(!canDrop())return;
    const files=event.dataTransfer.files;
    if(files.length!==1){message('Drop one PDF or DOCX lease at a time.',true);return;}
    dialog.querySelector('#lease-import-file').files=files;
    await importFile(files[0]);
  });
  dialog.addEventListener('change',async event=>{
    if (event.target.id==='lease-import-file') await importFile(event.target.files[0]);
    if (event.target.matches('[data-import-value]')) {
      const row=rows.get(event.target.dataset.importValue),field=fieldById.get(row.id);
      row.value=field.type==='checkbox' && event.target.value!==''?event.target.value==='true':event.target.value;row.conflict=false;explicit.add(row.id);selectByValue(row,field);
    }
    if(event.target.matches('[data-import-pair]')){const pair=CHOICE_PAIRS.find(p=>p.positive===event.target.dataset.importPair);for(const id of [pair.positive,pair.negative]){const row=rows.get(id);row.value=event.target.value?(id===pair.positive?event.target.value==='yes':event.target.value==='no'):'';row.selected=!!event.target.value;row.conflict=false;explicit.add(id);}}
    syncDefaults();refreshCount();
  });
  // Capture typing immediately, including a save clicked before a blur event.
  dialog.addEventListener('input',event=>{
    if(event.target.matches('input[data-import-value],textarea[data-import-value]')){const row=rows.get(event.target.dataset.importValue);row.value=event.target.value;row.conflict=false;explicit.add(row.id);selectByValue(row,fieldById.get(row.id));}
    syncDefaults();refreshCount();
  });
  const propertyValues=()=>Object.fromEntries(PROPERTY_FORM_FIELDS.map(f=>[f.name,dialog.querySelector(`[name="${f.name}"]`)?.value || '']));
  const frameFields=[...fields,...PROPERTY_FORM_FIELDS,{id:'property.address_full',label:'Property Address',type:'text',readOnly:true},{id:'property.state',label:'State Name',type:'text',readOnly:true},{id:'concession.terms',label:'Offer Details',type:'multiline',aliasFor:'concession.default_terms'}];
  const frameValues=()=>documentDraftValues(Object.fromEntries([...rows.values()].filter(r=>r.selected).map(r=>[r.id,r.value])),propertyValues());
  const saveDraft=()=>{
    if(completed || !draft || !dialog.isConnected)return;
    const success=storage.save({mode,fileName,draft,rows:[...rows.values()],explicit:[...explicit],property:propertyValues(),activeSection,creationToken,submittedPayload,confirmed:!!dialog.querySelector('[data-import-confirm]')?.checked,expanded:formExpanded,documentOpen});
    dialog.querySelectorAll('[data-draft-saved]').forEach(el=>el.textContent=success?'Draft saved in this browser tab':'Draft kept open · Browser backup unavailable');
  };
  window.addEventListener('pagehide',saveDraft);
  dialog.addEventListener('close',()=>window.removeEventListener('pagehide',saveDraft),{once:true});
  dialog.addEventListener('input',saveDraft);dialog.addEventListener('change',saveDraft);dialog.addEventListener('click',saveDraft);
  const setDocumentView=open=>{
    documentOpen=open;dialog.classList.toggle('is-document-view',open);dialog.classList.toggle('is-expanded',open || formExpanded);
    dialog.querySelector('.draft-document-workspace').hidden=!open;
    if(open){const host=dialog.querySelector('[data-draft-document-host]');if(!host.querySelector('iframe'))host.innerHTML='<iframe title="New property lease defaults" src="./property-draft-document.html"></iframe>';syncDocument();dialog.querySelector('[data-draft-back]').focus();}
    else {syncDefaults();dialog.querySelector('[data-draft-document]')?.focus({preventScroll:true});}
    saveDraft();
  };
  const syncDocument=()=>dialog.querySelector('iframe')?.contentWindow?.postMessage({type:'property-draft-values',values:frameValues()},location.origin);
  const onDocumentMessage=event=>{
    const frame=dialog.querySelector('iframe');if(event.origin!==location.origin || event.source!==frame?.contentWindow)return;
    if(event.data?.type==='property-draft-ready')frame.contentWindow.postMessage({type:'property-draft-init',fields:frameFields,values:frameValues()},location.origin);
    if(event.data?.type==='property-draft-change' && !busy && !submittedPayload){
      const formField=PROPERTY_FORM_FIELDS.find(f=>f.id===event.data.id);
      if(formField){dialog.querySelector(`[name="${formField.name}"]`).value=String(event.data.value ?? '');}
      else {
        const id=frameFields.find(f=>f.id===event.data.id)?.aliasFor || event.data.id;
        const row=rows.get(id);if(!row)return;
        row.value=event.data.value;row.selected=isAnswered(fieldById.get(id),row.value);row.conflict=false;explicit.add(row.id);
        const pair=CHOICE_PAIRS.find(p=>[p.positive,p.negative].includes(id));
        if(pair){
          const other=rows.get(id===pair.positive?pair.negative:pair.positive);other.value=typeof row.value==='boolean'?!row.value:'';other.selected=typeof row.value==='boolean';other.conflict=false;explicit.add(other.id);
          dialog.querySelector(`[data-import-pair="${pair.positive}"]`).value=other.selected?(rows.get(pair.positive).value?'yes':'no'):'';
        }
        for(const r of rows.values())if(explicit.has(r.id)){
          const control=dialog.querySelector(`[data-import-value="${CSS.escape(r.id)}"]`);if(control)control.value=String(r.value ?? '');
        }
      }
      syncDefaults();refreshCount();syncDocument();saveDraft();
    }
  };
  window.addEventListener('message',onDocumentMessage);
  dialog.addEventListener('close',()=>window.removeEventListener('message',onDocumentMessage),{once:true});
  dialog.addEventListener('input',syncDocument);dialog.addEventListener('change',syncDocument);
  dialog.addEventListener('click',async event=>{
    const step=event.target.closest('[data-draft-step]'),previousStep=event.target.closest('[data-draft-prev]'),nextStep=event.target.closest('[data-draft-next]');
    if((step || previousStep || nextStep) && !busy){const groups=sectionsFor(fields),index=groups.findIndex(g=>g.id===activeSection);showSection(step?step.dataset.draftStep:groups[index+(previousStep?-1:1)]?.id);dialog.querySelector('[data-draft-position]').focus({preventScroll:true});saveDraft();}

    const addressChoice=event.target.closest('[data-import-address]');
    if(addressChoice && !busy && !submittedPayload){const candidate=draft.addressReview?.candidates[Number(addressChoice.dataset.importAddress)];if(candidate){const parts=splitImportedAddress(candidate.value);for(const [name,value] of Object.entries(parts))dialog.querySelector(`[name="${name}"]`).value=value;if(!dialog.querySelector('[name="name"]').value)dialog.querySelector('[name="name"]').value=parts.street;syncDocument();saveDraft();}}
    if(event.target.closest('[data-import-expand]')){formExpanded=!formExpanded;dialog.classList.toggle('is-expanded',formExpanded);const button=dialog.querySelector('[data-import-expand]');button.textContent=formExpanded?'Collapse':'Expand';button.setAttribute('aria-label',formExpanded?'Collapse New Property':'Expand New Property');button.setAttribute('aria-pressed',String(formExpanded));saveDraft();}
    if(event.target.closest('[data-draft-document]'))setDocumentView(true);
    if(event.target.closest('[data-draft-back]'))setDocumentView(false);
    if(event.target.closest('[data-draft-discard]')){storage.clear();savedDraft=null;dialog.querySelector('.draft-resume').hidden=true;}
    if(event.target.closest('[data-draft-resume]') && savedDraft){
      const saved=savedDraft;mode=saved.mode;draft=saved.draft;fileName=saved.fileName;creationToken=saved.creationToken || crypto.randomUUID();
      prepareRows();for(const row of saved.rows)if(fieldById.has(row.id))rows.set(row.id,{...row,selected:isAnswered(fieldById.get(row.id),row.value)});explicit.clear();for(const id of saved.explicit || [])if(fieldById.has(id))explicit.add(id);
      dialog.classList.remove('is-choosing');dialog.querySelector('.import-methods').hidden=true;dialog.querySelector('.draft-resume').hidden=true;dialog.querySelector('.import-progress').hidden=false;
      renderReview();for(const f of PROPERTY_FORM_FIELDS)dialog.querySelector(`[name="${f.name}"]`).value=String(saved.property?.[f.name] || '');
      syncDefaults();showSection(saved.activeSection || 'property');submittedPayload=saved.submittedPayload || null;dialog.querySelector('[data-import-confirm]').checked=!!saved.confirmed;
      if(submittedPayload)dialog.querySelector('[data-import-save]').textContent='Retry creation';setBusy(false);
      formExpanded=!!saved.expanded;dialog.classList.toggle('is-expanded',formExpanded);const expand=dialog.querySelector('[data-import-expand]');expand.textContent=formExpanded?'Collapse':'Expand';expand.setAttribute('aria-label',formExpanded?'Collapse New Property':'Expand New Property');expand.setAttribute('aria-pressed',String(formExpanded));
      dialog.querySelector('[data-import-intro]').textContent=mode==='manual'?'Enter the property details and its shared lease defaults.':'Review the extracted settings, then create your property.';
      if(saved.documentOpen)setDocumentView(true);saveDraft();
    }
    const method=event.target.closest('[data-import-method]');
    if(method && !busy && !submittedPayload) {
      mode=method.dataset.importMethod;dialog.querySelector('.draft-resume').hidden=true;
      dialog.classList.remove('is-choosing');
      dialog.querySelector('.import-methods').hidden=true;
      dialog.querySelector('.import-progress').hidden=false;
      dialog.querySelector('[data-import-intro]').textContent=mode==='manual'?'Enter the property details and its shared lease defaults.':'Upload a previous lease, review the extracted settings, then create your property.';
      if(mode==='manual') {
        draft={candidates:[],warnings:[],sourceAddress:''};fileName='';prepareRows();renderReview();message('');
        dialog.querySelector('[name="name"]').focus();
      } else {
        dialog.querySelector('.import-upload').hidden=false;
        dialog.querySelector('.import-progress').innerHTML='<li aria-current="step">1. Upload Lease</li><li>2. Review Fields</li><li>3. Create Property</li>';
        dialog.querySelector('#lease-import-file').focus();refreshCount();
      }
    }
    if(event.target.closest('[data-import-back]') && !busy && !draft && !submittedPayload) {
      mode='';generation++;dialog.classList.add('is-choosing');
      dialog.querySelector('.import-methods').hidden=false;dialog.querySelector('.import-progress').hidden=true;dialog.querySelector('.import-upload').hidden=true;
      dialog.querySelector('#lease-import-file').value='';dialog.querySelector('[data-import-save]').hidden=true;
      dialog.querySelector('[data-import-intro]').textContent='Choose how you would like to add this property.';
      message('');refreshCount();dialog.querySelector('[data-import-method="lease"]').focus();
    }
    if(event.target.closest('[data-import-change]') && !busy) dialog.querySelector('#lease-import-file').click();
    if(event.target.closest('[data-import-close]') && !busy) dialog.close();
    const choice=event.target.closest('[data-import-choice]');
    if(choice && !busy && !submittedPayload){
      const row=rows.get(choice.dataset.importChoice),field=fieldById.get(row.id),option=row.alternatives[Number(choice.dataset.importOption)];
      if(option){row.value=option.value;row.conflict=false;explicit.add(row.id);selectByValue(row,field);const control=dialog.querySelector(`[data-import-value="${CSS.escape(row.id)}"]`);if(control)control.value=String(row.value ?? '');choice.closest('[data-import-row]')?.querySelector('.import-flag')?.remove();choice.closest('details').open=false;syncDefaults();refreshCount();syncDocument();saveDraft();}
    }
    if(!event.target.closest('[data-import-save]') || busy || !dialog.querySelector('[data-import-confirm]')?.checked) return;
    const form = dialog.querySelector('[data-new-property-form]');
    if(!submittedPayload){const invalid=[...form.elements].find(el=>el.willValidate && !el.validity.valid);if(invalid){showSection(invalid.closest('[data-draft-section]').dataset.draftSection);invalid.reportValidity();return;}}
    try {
      if (!submittedPayload) {
        const selected = [...rows.values()].filter(row=>row.selected);
        const patch = selected.length ? buildImportPatch(selected,fields,{},baseline) : {};
        submittedPayload = {...Object.fromEntries(new FormData(form)),creation_token:creationToken,initial_settings:patch};
      }
      saveDraft();setBusy(true); message('Creating property and initial settings…');
      const {building} = await api('/buildings',{method:'POST',body:JSON.stringify(submittedPayload)});
      completed=true;storage.clear();dialog.close();
      try {
        await onSaved(building); setStatus(`Created ${building.name} with ${Object.keys(submittedPayload.initial_settings).length} reviewed defaults.`);
      } catch {
        setStatus(`Created ${building.name}. Refresh Properties to see it.`, 'error');
      }
    } catch(error) {
      message(submittedPayload ? `${error.message || 'Could not confirm creation.'} Retry to check the same creation request, or close and check Properties.` : error.message,true);
      if(submittedPayload) dialog.querySelector('[data-import-save]').textContent='Retry creation';
    }
    finally {if(dialog.isConnected) setBusy(false);}
  });
  dialog.showModal();
}
