import { readLeaseFile } from './lease-import-reader.js';
import { extractLeaseDefaults, buildImportPatch } from './lease-import-extract.js';
import { sectionsFor } from './property-sections.js';
import { isAnswered, formatSettingValue } from '../shared/lease-values.js';

// Draft state and file text live only for the lifetime of this dialog. The
// existing authenticated settings endpoint is the sole persistence boundary.
export function openNewProperty({fields, api, escapeHtml: esc, onSaved, setStatus}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'property-import new-property-import';
  dialog.setAttribute('aria-labelledby','import-title');
  let draft = null, fileName = '', busy = false, generation = 0;
  const baseline = {}, rows = new Map();
  const creationToken = crypto.randomUUID();
  let submittedPayload = null;
  const fieldById = new Map(fields.map(field=>[field.id,field]));
  dialog.innerHTML = `<header class="import-head"><div><span class="k">Properties & settings</span><h2 id="import-title">New property</h2><p>Start from a lease or enter the property details yourself.</p></div><button type="button" data-import-close aria-label="Close lease import">Close</button></header>
    <div class="import-body"><ol class="import-progress"><li aria-current="step">1. Choose lease</li><li>2. Review fields</li><li>3. Create property</li></ol>
    <section class="import-upload"><label for="lease-import-file"><b>Choose a previous lease</b><span>PDF or DOCX · Up to 20 MB</span></label><input id="lease-import-file" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"><p>Reads text locally in your browser. Scanned pages need an OCR text copy. Review everything before creating the property.</p><button type="button" data-import-manual>Enter manually</button></section>
    <p class="import-message" role="status" aria-live="polite"></p><div class="import-review"></div></div>
    <footer class="import-footer"><span data-import-count>Choose a lease to begin.</span><div><button type="button" data-import-close>Cancel</button><button type="button" class="primary" data-import-save disabled>Create property</button></div></footer>`;
  document.body.append(dialog);
  const previous = document.activeElement;
  dialog.addEventListener('close',()=>{generation++;dialog.remove();if(previous?.isConnected) previous.focus();},{once:true});
  dialog.addEventListener('cancel',event=>{if(busy) event.preventDefault();});
  dialog.addEventListener('submit',event=>{event.preventDefault();dialog.querySelector('[data-import-save]').click();});
  const message = (text, error=false) => {
    const el = dialog.querySelector('.import-message'); el.textContent = text; el.dataset.tone = error ? 'error' : '';
  };
  const refreshCount = () => {
    const count = [...rows.values()].filter(row=>row.selected).length;
    dialog.querySelector('[data-import-count]').textContent = draft ? `${count} field${count===1?'':'s'} selected · New property draft` : 'Choose a lease to begin.';
    dialog.querySelector('[data-import-save]').disabled = busy || !draft || !dialog.querySelector('[data-import-confirm]')?.checked;
  };
  const setBusy = value => {
    busy = value;
    dialog.querySelector('#lease-import-file').disabled = value || Boolean(submittedPayload);
    dialog.querySelectorAll('[data-import-close]').forEach(el=>el.disabled=value);
    dialog.querySelector('.import-review').inert = value || Boolean(submittedPayload);
    refreshCount();
  };
  const control = (field, value) => {
    const attrs = `data-import-value="${esc(field.id)}" id="import-value-${esc(field.id)}" aria-label="Proposed ${esc(field.label)}"`;
    if (field.type === 'checkbox') return `<select ${attrs}><option value="">Not found</option><option value="true"${value===true?' selected':''}>Marked</option><option value="false"${value===false?' selected':''}>Not marked</option></select>`;
    if (field.type === 'choice') return `<select ${attrs}><option value="">Not found</option>${field.options.map(option=>`<option${option===value?' selected':''}>${esc(option)}</option>`).join('')}</select>`;
    return `<${field.type==='multiline'?'textarea':'input'} ${attrs}${field.type==='multiline'?` rows="2">${esc(value ?? '')}</textarea>`:` type="${field.type==='email'?'email':'text'}" value="${esc(value ?? '')}" placeholder="Enter after reviewing the lease">`}`;
  };
  const rowMarkup = field => {
    const row=rows.get(field.id), hasOld=isAnswered(field,baseline[field.id]), detected=row.detected;
    return `<tr data-import-row="${esc(field.id)}"><td><input type="checkbox" data-import-select="${esc(field.id)}" aria-label="Import ${esc(field.label)}"${row.selected?' checked':''}></td><th scope="row"><label for="import-value-${esc(field.id)}">${esc(field.label)}</label>${row.conflict?'<span class="import-flag">Conflicting values</span>':detected && hasOld && row.value!==baseline[field.id]?'<span class="import-flag">Replaces existing value</span>':detected?'<span class="import-detected">Detected</span>':'<span class="import-muted">Not found · Enter manually</span>'}</th><td>${control(field,row.value)}<div class="import-source">${detected?`<details><summary>View source${row.conflict?' & alternatives':''}</summary><p>${esc(row.evidence)}</p><small>${esc(row.location)}</small>${row.alternatives.map(item=>`<p><b>Also found: ${esc(formatSettingValue(field,item.value))}</b><br>${esc(item.evidence)}</p>`).join('')}</details>`:'No matching value found in this lease.'}</div></td></tr>`;
  };
  const table = own => `<div class="import-table-wrap"><table class="import-table"><thead><tr><th><span class="sr-only">Import</span></th><th>Property setting</th><th>Value to save · Editable</th></tr></thead><tbody>${own.map(rowMarkup).join('')}</tbody></table></div>`;
  const propertyForm = address => {
    const parts = address.split(',').map(value=>value.trim());
    const region = /^(.*?)[ ]+(\d{5}(?:-\d{4})?)$/.exec(parts.at(-1) || '');
    const state = region?.[1] || '', abbr = ({'New York':'NY','New Jersey':'NJ','Connecticut':'CT'})[state] || (/^[A-Z]{2}$/.test(state)?state:'NY');
    const input = (name,label,value='',extra='') => `<label>${label}<input name="${name}" value="${esc(value)}" maxlength="200" ${extra}></label>`;
    return `<section class="import-property-details"><h3>Property details</h3><form data-new-property-form><div class="import-property-grid">
      ${input('name','Property name',parts[0] || '', 'required')}
      ${input('street','Street',parts[0] || '', 'required')}
      ${input('city','City',parts.length>=3?parts[1]:'', 'required')}
      ${input('state_abbr','State',abbr, 'required pattern="[A-Za-z]{2}"')}
      ${input('zip','ZIP code',region?.[2] || '', 'required pattern="[0-9]{5}(-[0-9]{4})?"')}
      ${input('landlord_signer_email','Landlord signature email (optional)','', 'type="email"')}
      </div></form></section>`;
  };
  const prepareRows = () => {
    rows.clear();
    for (const field of fields) {
      const candidate=draft.candidates.find(item=>item.id===field.id);
      rows.set(field.id,{id:field.id,value:candidate?.value ?? '',detected:!!candidate,selected:!!candidate && !candidate.conflict,evidence:'',location:'',alternatives:[],...candidate});
    }
  };
  const renderReview = () => {
    const detected = draft.candidates.length, groups=sectionsFor(fields);
    dialog.querySelector('.import-upload').hidden = true;
    dialog.querySelector('.import-progress').innerHTML='<li>1. Choose lease ✓</li><li aria-current="step">2. Review fields</li><li>3. Create property</li>';
    dialog.querySelector('.import-review').innerHTML=`<div class="import-summary"><div><h3>${detected} of ${fields.length} settings detected</h3><p>${esc(fileName)}</p></div><div class="import-file-actions"><button type="button" data-import-change>Change lease</button><button type="button" data-import-select-detected>Select detected fields</button></div></div>
      ${propertyForm(draft.sourceAddress)}
      ${draft.warnings.length?`<ul class="import-warnings">${draft.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>`:''}
      <details class="import-scope"><summary>What will be saved?</summary><p>Selected values become this property's shared lease defaults. Reconfirm dated disclosures before reusing them.</p></details>
      ${groups.filter(group=>group.fields.some(field=>rows.get(field.id).detected)).map(group=>`<section class="import-group"><h3>${esc(group.label)}</h3>${table(group.fields.filter(field=>rows.get(field.id).detected))}</section>`).join('')}
      <details class="import-missing"><summary>${fields.length-detected} settings not found · Review or enter manually</summary>${groups.filter(group=>group.fields.some(field=>!rows.get(field.id).detected)).map(group=>`<section class="import-group"><h3>${esc(group.label)}</h3>${table(group.fields.filter(field=>!rows.get(field.id).detected))}</section>`).join('')}</details>
      <label class="import-confirm"><input type="checkbox" data-import-confirm><span>I have reviewed this new property’s details and selected default settings.</span></label>`;
    refreshCount();
  };
  dialog.addEventListener('change',async event=>{
    if (event.target.id==='lease-import-file') {
      const file=event.target.files[0]; if (!file) return;
      const ticket=++generation; draft=null; rows.clear();
      dialog.querySelector('.import-upload').hidden = false;
      dialog.querySelector('.import-review').innerHTML=''; setBusy(true); message('Reading lease text…');
      try {
        const {text,warnings}=await readLeaseFile(file,progress=>message(progress));
        if (!dialog.isConnected || ticket!==generation) return;
        draft=extractLeaseDefaults(text,fields);draft.warnings.push(...warnings); fileName=file.name;
        prepareRows();
        renderReview(); message(draft.candidates.length?'Review the property details and selected defaults, then create the property.':'No matching settings were detected. Enter the property details and any defaults manually.');
      } catch(error) { message(error.message || 'This file could not be read. Try another PDF or DOCX.',true); }
      finally { if(dialog.isConnected && ticket===generation) setBusy(false); }
    }
    if (event.target.matches('[data-import-select]')) rows.get(event.target.dataset.importSelect).selected=event.target.checked;
    if (event.target.matches('[data-import-value]')) {
      const row=rows.get(event.target.dataset.importValue),field=fieldById.get(row.id);
      row.value=field.type==='checkbox' && event.target.value!==''?event.target.value==='true':event.target.value;
    }
    refreshCount();
  });
  // Capture typing immediately, including a save clicked before a blur event.
  dialog.addEventListener('input',event=>{
    if(event.target.matches('input[data-import-value],textarea[data-import-value]')) rows.get(event.target.dataset.importValue).value=event.target.value;
  });
  dialog.addEventListener('click',async event=>{
    if(event.target.closest('[data-import-manual]') && !busy) {
      draft={candidates:[],warnings:[],sourceAddress:''}; fileName='Manual entry'; prepareRows(); renderReview(); message('Enter the property details. Add default settings now or after creation.');
    }
    if(event.target.closest('[data-import-change]') && !busy) dialog.querySelector('#lease-import-file').click();
    if(event.target.closest('[data-import-close]') && !busy) dialog.close();
    if(event.target.closest('[data-import-select-detected]') && !busy) {
      for(const row of rows.values()) if(row.detected && !row.conflict) row.selected=true;
      dialog.querySelectorAll('[data-import-select]').forEach(el=>el.checked=rows.get(el.dataset.importSelect).selected);refreshCount();
    }
    if(!event.target.closest('[data-import-save]') || busy || !dialog.querySelector('[data-import-confirm]')?.checked) return;
    const form = dialog.querySelector('[data-new-property-form]');
    if (!submittedPayload && !form.reportValidity()) return;
    try {
      if (!submittedPayload) {
        const selected = [...rows.values()].filter(row=>row.selected);
        const patch = selected.length ? buildImportPatch(selected,fields,{},baseline) : {};
        submittedPayload = {...Object.fromEntries(new FormData(form)),creation_token:creationToken,initial_settings:patch};
      }
      setBusy(true); message('Creating property and initial settings…');
      const {building} = await api('/buildings',{method:'POST',body:JSON.stringify(submittedPayload)});
      dialog.close();
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
