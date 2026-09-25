// Review a lease by business topic; edits use the lease screen's existing controls.
import { endDateFor, parseDate } from '../shared/lease-dates.js';
import { DOCUMENTS } from '../shared/lease-documents.js';
import { formatSettingValue, moneyInputValue } from '../shared/lease-values.js';
let escapeHtml = value => String(value ?? '');
export function initWorkspace(deps) { escapeHtml = deps.escapeHtml; }
const esc = value => escapeHtml(value);
const LABELS = {
  'tenant.names':'Legal Name', 'tenant.email':'Email', 'tenant.mailing_address':'Mailing Address',
  'lease.effective_date':'Agreement Date', 'lease.commencement_date':'Lease Start', 'lease.end_date':'Lease End',
  'rent.monthly':'Monthly Rent', 'rent.due_day':'Rent Due Day', 'deposit.amount':'Security Deposit',
  'concession.terms':'Concessions', 'landlord.entity_name':'Landlord Entity', 'landlord.print_name':'Signer Name',
  'landlord.address':'Notice Address', 'property.address_full':'Property Address',
  'lease.vacancy_lease_date':'Bedbug Disclosure Date', 'dhcr.mark_vacancy':'New Lease', 'dhcr.mark_renewal':'Renewal'
};
const TENANT = ['tenant.names','tenant.email','tenant.mailing_address'];
const LEASE_TYPE = ['dhcr.mark_vacancy','dhcr.mark_renewal'];
const DATES = ['lease.effective_date','lease.commencement_date','lease.end_date','lease.end_time'];
const MONEY = ['rent.monthly','rent.due_day','deposit.amount','concession.terms'];
const OWNER = ['landlord.entity_name','landlord.print_name','landlord.address'];
const GROUPS = [
  ['Utilities', ['utility.']], ['Payments & Deposit Account', ['payee.','deposit.bank']],
  ['Management & Notices', ['manager.','legal_notice.','emergency.','owner_rep.','landlord.']],
  ['Fees & Insurance', ['fee.','fine.','insurance.','attorney_fees.']],
  ['Property Rules & Disclosures', []]
];
const title = value => String(value).replace(/\b[a-z]/g, c => c.toUpperCase());
const label = field => LABELS[field.id] || title(field.label);
export function tenantSigners(state) {
  if (state.caseRow?.household?.members) return state.caseRow.household.members.map(m => ({id:m.id,name:m.name,email:m.email}));
  if (state.application) return [{id:state.application.id,name:state.values['tenant.names'] || state.application.name,email:state.values['tenant.email'] || state.application.email}];
  return state.values['tenant.names'] ? [{name:state.values['tenant.names'],email:state.values['tenant.email'] || ''}] : [];
}
export function reviewIssues(state) {
  const issues=[...state.missing].map(id=>({id,label:`Add ${label(state.byId.get(id) || {id,label:id})}`}));
  if(LEASE_TYPE.every(id=>state.byId.has(id)) && state.checked.has(LEASE_TYPE[0])===state.checked.has(LEASE_TYPE[1]))issues.push({id:LEASE_TYPE[0],label:'Choose New Lease or Renewal'});
  for(const tenant of tenantSigners(state))if(!tenant.email)issues.push({tab:'recipients',label:`Add an email for ${tenant.name || 'the tenant'}`});
  if(state.signing?.configuration?.enabled && !state.landlordEmail)issues.push({tab:'recipients',label:'Assign a landlord signer email'});
  const emails=[...tenantSigners(state).map(t=>t.email),state.landlordEmail].filter(Boolean).map(e=>String(e).toLowerCase());
  if(emails.some(e=>!/^\S+@[^\s@]+\.[^\s@]+$/.test(e)))issues.push({tab:'recipients',label:'Check signer email addresses'});
  if(!state.signing?.configuration?.reviewOnly && new Set(emails).size!==emails.length)issues.push({tab:'recipients',label:'Each signer needs a different email address'});
  for(const id of state.dirty){
    const field=state.byId.get(id),v=state.values[id];
    if(field?.type==='date' && v && !parseDate(v))issues.push({id,label:`Check ${label(field)}`});
    if(['rent.monthly','deposit.amount','rent.due_day'].includes(id) && v){const n=Number(String(v).replace(/[$,\s]/g,''));if(!Number.isFinite(n) || n<0 || (id==='rent.monthly' && n===0) || (id==='rent.due_day' && (!Number.isInteger(n) || n<1 || n>31)))issues.push({id,label:`Check ${label(field)}`});}
  }
  const start=parseDate(state.values['lease.commencement_date']),end=parseDate(state.values['lease.end_date']);
  if(start && end && Date.UTC(end.year,end.month-1,end.day)<Date.UTC(start.year,start.month-1,start.day))issues.push({id:'lease.end_date',label:'Lease End must follow Lease Start'});
  return issues;
}
function reviewSummary(state) {
  const issues=reviewIssues(state), dirty=state.dirty.size;
  return `<div class="ws-review-summary${issues.length?' has-issues':''}" data-ws-review-summary>
    <strong>${issues.length?`${issues.length} Item${issues.length===1?'':'s'} to Resolve`:dirty?'Changes to Save':'Lease Details Complete'}</strong>
    <p>${issues.length?'Select an item to review it.':dirty?'Save corrections before reviewing the signing package.':'Check the details below, then review the signing package.'}</p>
    ${issues.length?`<ul>${issues.map(i=>`<li><button type="button" ${i.id?`data-ws-issue="${esc(i.id)}"`:`data-ws-tab="${i.tab}"`}>${esc(i.label)}</button></li>`).join('')}</ul>`:''}
    ${state.frozen?'<p>Approved version. Saving corrections requires a new landlord approval.</p>':''}
    ${state.readOnly && state.mode==='lease'?'<p>This lease is locked for signing. Review its status under E-sign Recipients.</p>':''}
  </div>`;
}
export function renderWorkspace(host,state) {
  host.innerHTML=`<div class="ws-tabs" role="tablist" aria-label="Lease Review">${[['information','Lease Information'],['documents','Documents'],['recipients','E-sign Recipients']].map(([id,name])=>`<button type="button" class="ws-tab" role="tab" data-ws-tab="${id}" aria-selected="${state.tab===id}">${name}</button>`).join('')}</div><div class="ws-body" id="ws-body">${panelFor(state)}</div>`;
  annotateWorkspace(host,state);
}
export function renderTab(host,state) {
  host.querySelector('#ws-body').innerHTML=panelFor(state);
  for(const tab of host.querySelectorAll('[data-ws-tab][role="tab"]'))tab.setAttribute('aria-selected',String(tab.dataset.wsTab===state.tab));
  annotateWorkspace(host,state);
}
function panelFor(state) {return state.tab==='documents'?documentsPanel(state):state.tab==='recipients'?recipientsPanel(state):informationPanel(state);}
function section(name,body,note='') {return `<section class="ws-section ws-review-section"><header class="ws-section-head"><h3>${name}</h3>${note?`<p>${note}</p>`:''}</header>${body}</section>`;}
function textRow(name,value,extra='',valueAttribute='') {return `<div class="ws-review-row"><span class="ws-label">${esc(name)}</span><div class="ws-review-value" ${valueAttribute}>${esc(value || 'Not Set')}${extra}</div></div>`;}
function leaseTerm(state) {
  const months=state.application?.lease_term_months;
  return months ? (endDateFor(state.values['lease.commencement_date'],months)===state.values['lease.end_date'] ? `${months} Months` : 'Custom Term') : '';
}
function informationPanel(state) {
  const members=tenantSigners(state),multiple=members.length>1;
  const tenantRows=multiple?members.map((m,i)=>`<div class="ws-tenant-card"><b>Tenant ${i+1}</b>${textRow('Legal Name',m.name)}${textRow('Email',m.email)}<a class="ws-text-link" href="#/applications/${esc(m.id)}">Review Application</a></div>`).join(''):TENANT.map(id=>row(id,state)).join('');
  const phone=state.application?.phone;
  const listing=state.listings.find(l=>l.id===state.listingId);
  return `${reviewSummary(state)}
    ${section(multiple?'Tenants':'Tenant',tenantRows+(!multiple && state.application && !state.readOnly?`<a class="ws-text-link" href="#/applications/${esc(state.application.id)}">Edit Applicant Details</a>`:'')+(phone?`<details class="ws-contact"><summary>Contact Details</summary>${textRow('Phone',phone)}</details>`:''))}
    ${section('Property & Lease Terms',(state.canPickUnit?`<div class="ws-review-row"><label class="ws-label" for="lease-listing">Apartment</label><select id="lease-listing"><option value="">Select Apartment</option>${state.listings.map(l=>`<option value="${esc(l.id)}"${l.id===state.listingId?' selected':''}>${esc(l.title || l.unit || l.id)}</option>`).join('')}</select></div>`:textRow('Apartment',listing?[listing.property_name,listing.unit && `Unit ${listing.unit}`].filter(Boolean).join(' · '):state.targetLabel))+row('property.address_full',state,true)+DATES.map(id=>row(id,state)).join('')+leaseTypeRow(state)+textRow('Lease Term',leaseTerm(state),'','data-ws-term'))}
    ${section('Rent & Deposit',MONEY.map(id=>row(id,state)).join(''))}
    ${section('Landlord & Signer',OWNER.map(id=>row(id,state)).join('')+textRow('Signer Email',state.landlordEmail,state.signing?.configuration?.enabled && !state.landlordEmail?'<a class="ws-text-link" href="#/properties">Assign in Property Settings</a>':''))}
    ${propertyTerms(state)}`;
}
function leaseTypeValue(state){return state.checked.has(LEASE_TYPE[0])===state.checked.has(LEASE_TYPE[1])?'':state.checked.has(LEASE_TYPE[0])?'new':'renewal';}
function leaseTypeRow(state){
  const fields=LEASE_TYPE.map(id=>state.byId.get(id));if(fields.some(f=>!f))return '';
  const value=leaseTypeValue(state),editable=fields.every(f=>state.editable(f));
  const summary=`<span class="ws-label">Lease Type</span><span class="ws-review-value" data-ws-lease-type-value>${value==='new'?'New Lease':value==='renewal'?'Renewal':'Choose Lease Type'}</span>`;
  const locate=`<button type="button" data-ws-type-locate data-lease-locate="${value==='renewal'?LEASE_TYPE[1]:LEASE_TYPE[0]}">Locate</button>`;
  if(!editable)return `<div class="ws-review-row">${summary}<span class="ws-row-action">${locate}</span></div>`;
  return `<details class="ws-review-field" data-ws-row="${LEASE_TYPE[0]}" data-lease-row="${LEASE_TYPE[0]}"><summary>${summary}<span class="ws-row-action">Edit</span></summary><div class="ws-inline-editor ws-value"><label class="ws-label" for="lease-type">Lease Type</label><select id="lease-type" data-ws-lease-type>${!value?'<option value="" selected disabled>Choose Lease Type</option>':''}<option value="new"${value==='new'?' selected':''}>New Lease</option><option value="renewal"${value==='renewal'?' selected':''}>Renewal</option></select><div class="ws-editor-actions">${locate}<button type="button" data-ws-done="${LEASE_TYPE[0]}">Done</button></div></div></details>`;
}
function valueText(field,state) {
  const value=state.values[field.id];
  if(field.type==='checkbox')return state.checked.has(field.id)?'Yes':'No';
  return value===undefined || value===null || value===''?'Not Set':formatSettingValue(field,value);
}
function row(id,state,derived=false) {
  const field=state.byId.get(id);if(!field)return '';
  const editable=!derived && state.editable(field);
  const missing=state.missing.has(id),shown=valueText(field,state);
  const locate=state.occurrences[id]>0;
  const summary=`<span class="ws-label">${esc(label(field))}</span><span class="ws-review-value" data-ws-value="${esc(id)}">${esc(shown)}</span>`;
  const attrs=`data-ws-row="${esc(id)}" data-lease-row="${esc(id)}"`;
  if(!editable)return `<div class="ws-review-row${missing?' is-missing':''}" ${attrs}>${summary}<span class="ws-row-action">${locate?`<button type="button" data-lease-locate="${esc(id)}" aria-label="Find ${esc(label(field))} in Document">Locate</button>`:''}</span></div>`;
  return `<details class="ws-review-field${missing?' is-missing':''}" ${attrs}><summary>${summary}<span class="ws-row-action">Edit</span></summary><div class="ws-inline-editor ws-value">
    <label class="ws-label" for="lease-input-${esc(id)}">${esc(label(field))}</label>${control(field,state)}
    <p class="ws-status" data-lease-status="${esc(id)}"></p>
    ${field.note?`<details class="ws-field-help"><summary>About This Field</summary><p class="ws-hint">${esc(field.note)}</p></details>`:''}
    <div class="ws-editor-actions">${locate?`<button type="button" data-lease-locate="${esc(id)}">Locate in Document</button>`:''}<button type="button" data-ws-done="${esc(id)}">Done</button></div>
    </div></details>`;
}
function control(field,state) {
  const value=state.values[field.id]??'',attrs=`id="lease-input-${esc(field.id)}" data-lease-input="${esc(field.id)}"`;
  if(field.type==='checkbox')return `<label class="ws-check"><input type="checkbox" ${attrs}${state.checked.has(field.id)?' checked':''}><span>Yes</span></label>`;
  if(field.type==='choice')return `<select ${attrs}>${['',...field.options].map(v=>`<option value="${esc(v)}"${v===value?' selected':''}>${esc(v || 'Select')}</option>`).join('')}</select>`;
  if(field.type==='multiline')return `<textarea ${attrs} rows="3">${esc(value)}</textarea>`;
  if(field.type==='money')return `<div class="ws-money-input"><span aria-hidden="true">$</span><input type="text" inputmode="decimal" aria-label="${esc(label(field))} (USD)" ${attrs} value="${esc(moneyInputValue(value))}"></div>`;
  return `<input type="${field.type==='integer'?'number':'text'}" ${attrs} value="${esc(value)}">`;
}
function propertyTerms(state) {
  const used=new Set([...TENANT,...DATES,...LEASE_TYPE,...MONEY,...OWNER,'property.address_full']);
  const remaining=state.fields.filter(f=>!used.has(f.id) && f.template!==false && !f.id.startsWith('property.') && !f.id.startsWith('tenant.'));
  const assigned=new Set();
  return section('Property Terms & Disclosures',GROUPS.map(([name,prefixes])=>{
    const fields=remaining.filter(f=>!assigned.has(f.id) && (!prefixes.length || prefixes.some(p=>f.id.startsWith(p))));
    fields.forEach(f=>assigned.add(f.id));if(!fields.length)return '';
    const missing=fields.filter(f=>state.missing.has(f.id)).length;
    const short=fields.filter(f=>f.type!=='checkbox' || state.checked.has(f.id)).slice(0,2).map(f=>`${label(f)}: ${valueText(f,state)}`).join(' · ');
    return `<details class="ws-fold ws-review-fold"${missing?' open':''}><summary><span class="ws-fold-title">${name}</span><span class="ws-fold-note">${missing?`${missing} Missing`:esc(short)}</span></summary><div class="ws-fold-body">${fields.map(f=>row(f.id,state)).join('')}</div></details>`;
  }).join(''),`Corrections here apply to this lease only.${state.isManager()?` <a href="#/properties">Manage Property Defaults</a>`:''}`);
}
// The selected document opens in place: its signing fields are drawn on the
// document itself and listed in a detail panel directly beneath its entry,
// which the lease screen fills (it owns the signing package and the frame).
function documentsPanel(state) {
  const detail=state.mode==='lease';
  return section('Lease Documents',`<div class="ws-docs">${state.documents.map(d=>{const on=state.activeDocument===d.id;return `<button type="button" class="ws-doc${on?' is-on':''}" data-ws-doc="${esc(d.id)}" aria-pressed="${on}"><span class="ws-doc-name">${esc(d.name)}</span><span class="ws-doc-why">Sections ${d.from+1}–${d.to+1}${d.conditionalOn && !(state.values[d.conditionalOn])?' · Review Required':''}</span></button>${on && detail?`<div class="ws-doc-detail" data-workspace-document-preview data-document="${esc(d.id)}"></div>`:''}`;}).join('')}</div>`,`${state.documents.length} documents included. Select a document to review it${detail?' and its signing fields':''}.`);
}
function recipientsPanel(state) {
  return `<div data-workspace-recipients>${signingRecipients(state)}</div>`+
    carbonCopyEditor(state)+
    `<div data-workspace-signing></div>`;
}
export function carbonCopyEditor(state){
  const record=state.signing?.signing,locked=state.readOnly || (record && !['voided','declined'].includes(record.phase));
  const copies=record?.carbonCopies || state.carbonCopies || [];
  return `<div data-cc-editor>${section('CC Recipients',locked?copies.map(c=>textRow(c.name,c.email)).join('') || '<p>No CC recipients.</p>':`${copies.map(c=>`<div class="ws-review-row" data-cc-row><label>Name<input data-cc-name value="${esc(c.name)}" maxlength="100"></label><label>Email<input type="email" data-cc-email value="${esc(c.email)}"></label><button type="button" data-cc-action="remove">Remove</button></div>`).join('')}<div class="ws-editor-actions"><button type="button" data-cc-action="add">Add CC Recipient</button><button type="button" data-cc-action="save">Save CC Recipients</button></div>`,'Receives a copy after every tenant and the landlord have signed. No signature required.')}</div>`;
}
export function signingRecipients(state,signers) {
  const entity=state.values['landlord.entity_name'];
  const rows=signers || [...tenantSigners(state).map(t=>({...t,role:'tenant'})),{role:'landlord',name:state.values['landlord.print_name'],email:state.landlordEmail}];
  return section('Signing Order',rows.map(s=>`<div class="ws-signer"><span class="ws-signer-order">${s.role==='tenant'?1:2}</span><div><b>${esc(s.name || 'Name Missing')}</b><p class="ws-hint">${esc(s.email || 'Email Missing')}</p>${s.role==='landlord' && entity?`<p class="ws-hint">${esc(entity)}</p>`:''}${s.deliveryIssue?`<p class="ws-hint">${esc(s.deliveryIssue)}</p>`:''}${s.status?`<p class="ws-hint">${esc(s.status==='completed'?'Signed':s.status==='declined'?'Declined':s.role==='landlord' && rows.some(t=>t.role==='tenant' && t.status!=='completed')?'Waiting for all tenants':({sent:'Invitation Sent',delivered:'Signing Link Opened',pending:'Waiting to Send',created:'Waiting to Send',delivery_failed:'Email Delivery Failed'})[s.status] || s.status)}</p>`:''}</div><span class="ws-signer-role">${s.role==='tenant'?'Tenant':'Landlord'}</span></div>`).join(''),'All tenants sign first. The landlord receives the invitation after every tenant has signed.');
}
export function annotateWorkspace(host,state) {
  for(const field of state.fields) {
    const id=field.id,selector=CSS.escape(id);
    const status=host.querySelector(`[data-lease-status="${selector}"]`);
    if(status){status.textContent=state.missing.has(id)?'Required before sending.':'';status.classList.toggle('is-missing',state.missing.has(id));}
    const row=host.querySelector(`[data-ws-row="${selector}"]`);
    if(row){row.classList.toggle('is-missing',state.missing.has(id));row.classList.toggle('is-dirty',state.dirty.has(id));}
    const value=host.querySelector(`[data-ws-value="${selector}"]`);if(value)value.textContent=valueText(field,state);
    const input=host.querySelector(`[data-lease-input="${selector}"]`);
    if(input && input!==document.activeElement){
      if(field.type==='checkbox')input.checked=state.checked.has(id);
      else input.value=field.type==='money'?moneyInputValue(state.values[id]):state.values[id]??'';
    }
  }
  const term=host.querySelector('[data-ws-term]');if(term)term.textContent=leaseTerm(state) || 'Not Set';
  const type=leaseTypeValue(state),typeValue=host.querySelector('[data-ws-lease-type-value]');
  if(typeValue)typeValue.textContent=type==='new'?'New Lease':type==='renewal'?'Renewal':'Choose Lease Type';
  const typeInput=host.querySelector('[data-ws-lease-type]');if(typeInput)typeInput.value=type;
  const typeLocate=host.querySelector('[data-ws-type-locate]');if(typeLocate)typeLocate.dataset.leaseLocate=type==='renewal'?LEASE_TYPE[1]:LEASE_TYPE[0];
  const summary=host.querySelector('[data-ws-review-summary]');if(summary)summary.outerHTML=reviewSummary(state);
}
export function recomputeEndDate(state) {return endDateFor(state.values['lease.commencement_date'],state.application?.lease_term_months);}
export { DOCUMENTS };
