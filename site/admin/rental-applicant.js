// Full applicant record for the two-column rental workspace. All corrections
// use the existing application endpoint and its role and audit rules.
import {hasMockReport} from './mock-screening-report.js';
export const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const e = escape;
const value = v => v === true ? 'Yes' : v === false ? 'No' : v === null || v === undefined || v === '' ? 'Not provided' : String(v);
const fact = (label,v) => `<div class="rg-fact"><span>${e(label)}</span><b>${e(value(v))}</b></div>`;
const facts = entries => `<div class="rg-fields">${entries.map(([label,v])=>fact(label,v)).join('')}</div>`;
const sub = (title,body) => `<div class="rg-subsection"><h4>${e(title)}</h4>${body}</div>`;
const empty = text => `<p class="rg-empty">${e(text)}</p>`;
const employment = (x={},income) => facts([['Employer',x.employer],['Position',x.position],['Employed since',x.start],...(x.end ? [['Employed until',x.end]] : []),['Annual income',income ?? x.income],['Supervisor',x.supervisor_name],['Supervisor phone',x.supervisor_phone],['Supervisor email',x.supervisor_email]]);
const rental = (x={}) => facts([['Address',x.address],['From',x.start],['Until',x.end],['Monthly rent',x.monthly_rent],['Landlord',x.landlord_name],['Contact',x.contact],['Landlord phone',x.landlord_phone],['Landlord email',x.landlord_email]]);
const contact = x => facts([['Name',x.name],['Relationship',x.relationship],['Phone',x.phone],['Email',x.email]]);
const emergencyContact = (x,i) => `<article class="rg-contact-card" aria-label="Emergency contact ${i+1}"><header><span>Emergency contact ${i+1}</span><h4>${e(x.name || 'Name not provided')}</h4></header>${facts([['Relationship',x.relationship],['Phone',x.phone],['Email',x.email]])}</article>`;
const descriptor = (name,label,v,type='text')=>({name,label,value:v,type});
export function correctionFields(m,key) {
 const d=descriptor;
 if(key==='tenant') return [['first_name','First name'],['last_name','Last name'],['email','Email'],['phone','Phone'],['current_address','Current address']].map(([k,l])=>d(k,l,m[k]));
 if(key==='tenancy') return [d('move_in','Requested start date (MM/DD/YYYY)',m.move_in),d('lease_term_months','Preferred term (months)',m.lease_term_months,'number')];
 if(key==='guards') return [d('children_under_11','Children 10 or younger',m.children_under_11,'boolean'),d('wants_window_guards','Wants window guards anyway',m.wants_window_guards,'boolean')];
 if(key==='identity') return [d('dob','Date of birth (MM/DD/YYYY)',m.dob)];
 if(key==='employment' && m.employment_status!=='student') return [d('income_note','Annual income',m.income_note),...['employer','position','start','supervisor_name','supervisor_phone','supervisor_email'].map(k=>d(`current_employer.${k}`,k.replaceAll('_',' '),m.current_employer?.[k]))];
 return [];
}
export function applicantColumns(m,ctx,summary,money) {
 const canCorrect=!['sent_to_landlord','landlord_approved','lease_sent','lease_signed','declined'].includes(ctx.row.status);
 const summaries={
  tenant:[m.name,m.email].filter(Boolean).join(' · '),
  tenancy:[m.move_in,m.lease_term_months?`${m.lease_term_months} months`:null].filter(Boolean).join(' · '),
  guards:m.children_under_11===true?'Children 10 or younger':m.wants_window_guards===true?'Window guards requested':m.children_under_11===false && m.wants_window_guards===false?'No children 10 or younger · Not requested':'Answer incomplete',
  roommates:`${ctx.row.household.members.length-1} other applicant(s) · ${ctx.row.household.invitations.filter(i=>!i.accepted).length} awaiting submission`,
  pets:(m.pets || []).length?`${m.pets.length} pet(s)`:'No pets listed',
  identity:[m.dob,m.id_type==='passport'?'Passport on file':m.ssn_last4?`SSN ending ${m.ssn_last4}`:'SSN not provided'].filter(Boolean).join(' · '),
  employment:[...(m.employment_status==='student'?['Student',m.student?.school_name]:[m.current_employer?.position,m.current_employer?.employer]),(m.employment_history || []).length?`${m.employment_history.length} previous employment record(s)`:null].filter(Boolean).join(' · '),
  history:`${(m.rental_history || []).length} address record(s)`,
  contacts:`${(m.reference_contacts || []).length} references · ${(m.emergency_contacts || []).length} emergency contact(s)`
 };
 const section=(key,title,body)=>{
  const fields=correctionFields(m,key),can=canCorrect && fields.length && (ctx.session.role==='manager' || key==='tenancy');
  return `<details class="rg-section" data-record-section="${key}" ${key==='tenant'?'open':''}><summary><span><h3>${e(title)}</h3><small>${e(summaries[key] || (key==='documents'?'View required documents and uploaded files':'Not provided'))}</small></span></summary><div class="rg-section-body">${body}${can?`<details class="rg-correction"><summary>Edit ${e(title.toLowerCase())}</summary><form data-applicant-correction="${key}" data-applicant-id="${e(m.id)}" class="cw-form"><div class="rg-fields">${fields.map(f=>`<label>${e(f.label)}${f.type==='boolean'?`<select name="${e(f.name)}"><option value="">Not provided</option><option value="true" ${f.value===true?'selected':''}>Yes</option><option value="false" ${f.value===false?'selected':''}>No</option></select>`:`<input name="${e(f.name)}" type="${f.type}" value="${e(f.value ?? '')}" ${f.type==='number'?'min="1" max="60"':''}>`}</label>`).join('')}</div><p class="cw-note">Corrections are recorded and the application is checked again.</p><div class="cw-actions"><button class="primary" type="submit">Save changes</button><button type="button" data-cancel-correction>Cancel</button></div><p role="status"></p></form></details>`:''}</div></details>`;
 };
 const l=m.listings || ctx.row.listings || {};
 const roommates=[...ctx.row.household.members.filter(x=>x.id!==m.id).map(x=>({name:x.name,email:x.email,status:'Application submitted'})),...ctx.row.household.invitations.filter(x=>!x.accepted).map(x=>({...x,status:'Awaiting application'}))];
 const lease=section('tenant','Tenant',facts([['Legal name',m.name],['First name',m.first_name],['Last name',m.last_name],['Email',m.email],['Phone number',m.phone],['Current address',m.current_address]]))
 +section('tenancy','The tenancy applied for',facts([['Listing',l.title],['Property',l.property_name],['Unit',l.unit],['Requested lease start date',m.move_in],['Preferred term',m.lease_term_months?`${m.lease_term_months} months`:null]])+'<p class="cw-note">As requested by this applicant. Final group terms are managed below.</p>')
 +section('guards','Window guard notice',facts([['Children 10 or younger',m.children_under_11],['Wants window guards anyway',m.wants_window_guards]]))
 +section('roommates','Roommates',roommates.length?roommates.map(x=>sub(x.name,facts([['Email',x.email],['Status',x.status]]))).join(''):empty('No roommates listed.'))
 +section('pets','Pets',(m.pets || []).length?m.pets.map((x,i)=>sub(`Pet ${i+1}`,facts([['Species',x.type],['Breed / description',x.breed || x.species],['Pet name',x.name || 'Not collected on this application']]))).join(''):empty('No pets listed.'));
 const histories=m.rental_history || [],current=histories.find(x=>String(x.address || '').trim().toLowerCase()===String(m.current_address || '').trim().toLowerCase()),previous=histories.filter(x=>x!==current);
 const employmentBody=(m.employment_status==='student'?sub('Education',facts([['School',m.student?.school_name],['Major',m.student?.major],['Entry year',m.student?.entry_year],['Graduation year',m.student?.graduation_year],['Country',m.student?.country]])) : sub('Current employment',employment(m.current_employer,money(m.income_note))))+sub('Previous employment',(m.employment_history || []).length?m.employment_history.map(x=>employment(x,money(x.income))).join(''):empty('No previous employment provided.'));
 const docs=ctx.documentSummary(m,ctx.types);
 summaries.documents=docs?`${docs.requiredMet} of ${docs.required} requirements received${docs.missing?` · ${docs.missing} outstanding`:''}`:'Checklist unavailable';
 const documents=docs?`<p class="cw-note">${m.employment_status==='student'?'Studying':'Working'} · ${docs.requiredMet} of ${docs.required} requirements received</p><div class="rg-documents">${docs.rows.map(({type,files,state})=>`<div class="rg-document"><div><b>${e(type.label)}</b><span class="pill is-${['received','covered'].includes(state)?'good':state==='optional'?'off':'warn'}">${e(({received:'Received',covered:'Alternative received',optional:'Optional',missing:'Missing',partial:`${files.length} / ${type.required} received`})[state])}</span></div>${files.length?files.map(f=>`<a href="/api/admin/documents/${e(f.id)}" target="_blank" rel="noopener">${e(f.file_name)}</a>`).join(''):''}${type.either?'<small>One of the alternatives in this requirement is sufficient.</small>':''}</div>`).join('')}</div>`:empty('Document checklist unavailable.');
 const external=m.workspace?.external_credit_report;
 const sourceFile=(m.application_documents || []).find(doc=>doc.id===external?.document_id && doc.doc_type==='external_source');
 const showExternal=summary.credit_score == null && sourceFile && Number.isInteger(external?.credit_score) && external.credit_score>=300 && external.credit_score<=850;
 const reportLink=showExternal ? `<a class="rg-report-link" href="/api/admin/documents/${e(sourceFile.id)}" target="_blank" rel="noopener">View External Report ↗</a>` : m.workspace?.screening_result?.report_url?.startsWith('https://') && summary.report_status!=='Pending'
  ? `<a class="rg-report-link" href="${e(m.workspace.screening_result.report_url)}" target="_blank" rel="noopener noreferrer">View Report ↗</a>`
  : hasMockReport(m) ? `<button type="button" class="rg-report-link" data-view-mock-report="${e(m.id)}">View Report ↗</button>`
  : '<button type="button" class="rg-report-link" disabled title="Report not available yet">View Report ↗</button>';
 const overview=`<div class="rg-applicant-summary" aria-label="${e(m.name)} summary"><div class="rg-key-data">${fact(showExternal?'External Credit Score':'Credit Score',showExternal ? external.credit_score : summary.credit_score ?? (summary.report_status==='Needs review'?'Needs review':'Awaiting report'))}${fact('Annual Income',money(m.income_note))}</div>${reportLink}${showExternal ? `<p class="rg-source-note">${e(external.provider)} · ${e(external.model)} · External report, pending review${external.date ? ` · ${e(external.date)}` : " · Report date not provided"}</p>` : ""}</div>`;
 const screening=section('identity','Applicant details',facts([['Date of birth',m.dob],[m.id_type==='passport'?'Passport number':'Social Security number',m.ssn_last4?`•••• ${m.ssn_last4}`:'Not provided']]))
 +section('employment','Employment and income',employmentBody)
 +section('history','Rental history',sub("Tenant’s current address",rental(current || {address:m.current_address}))+sub("Tenant’s previous address",previous.length?previous.map(rental).join(''):empty('No previous address history provided.')))
 +section('documents','Documents',documents)
 +section('contacts','References and contacts',sub(`References · ${(m.reference_contacts || []).length} / 2 minimum`,(m.reference_contacts || []).length?m.reference_contacts.map((x,i)=>sub(`Reference ${i+1}`,contact(x))).join(''):empty('References not provided.'))+sub(`Emergency contacts · ${(m.emergency_contacts || []).length}`,(m.emergency_contacts || []).length?`<div class="rg-contact-list">${m.emergency_contacts.map(emergencyContact).join('')}</div>`:empty('Emergency contact not provided.')));
 return {lease,screening,overview};
}
