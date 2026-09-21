import {propertyGroups, compareNames} from './property-groups.js';
import { applicantColumns, correctionFields } from './rental-applicant.js';
import {openMockReport} from './mock-screening-report.js';
import {signingMarkup,bindSigning} from './rental-signing.js';
const selectedApplicants = new Map();
const rentalViews = new Map();
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>{if(v===null || v===undefined || v==='')return 'Not stated';const n=Number(String(v).replace(/[$,]/g,''));return Number.isFinite(n)?n.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}):String(v);};
const form=(action,body,label)=>`<form class="case-action-form cw-form" data-action="${action}">${body}<button type="submit" class="primary">${label}</button><p role="status"></p></form>`;
export function groupedQueue(rows,rowMarkup,{expanded=false}={}) {
 const count=rows=>`${rows.length} application group${rows.length===1?'':'s'}`;
 const attention=rows=>`${rows.filter(r=>r.next_step?.bucket==='attention').length} need attention`;
 return propertyGroups(rows,row=>row.listings).map(g=>`<details class="rg-property" ${expanded?'open':''}><summary><span><b class="property-list-name">${esc(g.name)}</b></span><span>${g.units.size} unit${g.units.size===1?'':'s'}</span><span>${count(g.rows)}</span><span>${attention(g.rows)}</span></summary><div class="rg-property-units">${[...g.units.values()].sort((a,b)=>compareNames(a.name,b.name)).map(unit=>`<details class="rg-unit" ${expanded?'open':''}><summary><span><b>Unit ${esc(unit.name)}</b></span><span>${count(unit.rows)}</span><span>${attention(unit.rows)}</span></summary><div class="rg-unit-apps"><table class="rg-group-table" aria-label="${esc(g.name)} · Unit ${esc(unit.name)} application groups"><thead><tr><th scope="col">Application Group</th><th scope="col">Current Progress</th><th scope="col">Responsible Agent</th><th scope="col">Time in Stage</th></tr></thead><tbody>${unit.rows.map(rowMarkup).join('')}</tbody></table></div></details>`).join('')}</div></details>`).join('');
}
export function rentalGroupMarkup(ctx,h) {
 const {row,w,id,session}=ctx,group=row.household,members=group.members;
 const viewKey=ctx.viewKey || id;
 const activeView=rentalViews.get(viewKey) || 'applicants';
 const closed=['lease_sent','lease_signed','declined'].includes(row.status),editable=!closed && !['sent_to_landlord','landlord_approved'].includes(row.status);
 const draft=w.lease_draft;
 const attention=group.issues.length ? `<details class="rg-issues"><summary>${group.issues.length} outstanding item${group.issues.length===1?'':'s'}</summary><ul>${group.issues.map(i=>`<li>${esc(i)}</li>`).join('')}</ul></details>`:'';
 const blocked=row.progression_blocked===true;
 const approved=!blocked && (row.status==='landlord_approved' || (row.status==='lease_sent' && !w.tenant_signature));
 const signatures=approved && w.lease_preparation ? `<div class="rg-signers">${members.map(m=>`<div><b>${esc(m.name)}</b>${w.signature_receipts?.[m.id] ? '<span class="pill is-good">Signature recorded</span>' : form('tenant_signed',`<input type="hidden" name="member_id" value="${esc(m.id)}"><label>Signing provider receipt<input name="reason" required maxlength="2000"></label>`,'Record this tenant’s signature')}</div>`).join('')}</div><p class="cw-note">Record a receipt for each tenant. The landlord signs after everyone listed above has signed.</p>`:'';
 const progression=blocked && ['sent_to_landlord','landlord_approved','lease_sent','lease_signed'].includes(row.status) ? `<p>Progression is blocked because the application evidence is incomplete. Any earlier approval cannot be used to prepare or sign a lease.</p>${attention}${ctx.allowed.includes('reopen_review')?form('reopen_review','<p>This clears the previous approval and draft. The landlord must decide again after all evidence is complete.</p>','Reopen for review'):''}` : approved ? `<p>${!draft ? 'Generate the lease draft before arranging signatures.' : draft?.error ? esc(draft.error) : draft?.missing?.length ? 'The lease draft needs property information before signing.' : 'The lease draft is ready. Review it before sending for signatures.'}</p><div class="cw-actions"><a class="desk-button" href="#/leases/${esc(id)}">Review Lease Draft</a>${w.lease_preparation ? '<button class="primary" data-download-lease>Download lease draft</button>' : form('refresh_draft','','Refresh lease draft')}</div>${draft?.missing?.length ? `<details><summary>${draft.missing.length} missing lease fields</summary><ul>${draft.missing.map(f=>`<li>${esc(f)}</li>`).join('')}</ul></details>`:''}${signatures}`
  : row.status==='sent_to_landlord' ? `<p>The whole application group is with the landlord. Their decision will appear here automatically.</p><p class="cw-note">Email: ${esc(w.delivery?.status || 'Pending')} · ${esc(w.recommendation?.landlord_email || '')}</p>${w.delivery?.status==='failed' ? form('retry_delivery','','Retry email') : ''}`
  : closed ? h.primaryFor(ctx) : `<p>Each applicant completes their own documents and credit check. The system sends one email to the landlord when the whole group is ready.</p>${attention}<p class="cw-note">${members.some(m=>m.workspace?.screening_result?.status==='not_connected') ? 'Credit-check provider not connected. Automatic screening is unavailable.' : 'No manual recommendation is required.'}</p>${form('retry_delivery','','Check progress')}`;
 const person=(m,i)=>{
  const summary=group.summary.find(s=>s.id===m.id) || {};
  const columns=applicantColumns(m,{...ctx,documentSummary:h.documentSummary},summary,money);
  const selected=selectedApplicants.get(viewKey) || members[0]?.id;
  return `<section class="rg-person" data-person-panel="${esc(m.id)}" ${m.id!==selected?'hidden':''} aria-label="${esc(m.name)}">${columns.overview}<div class="rg-pair">
    ${h.panel('Lease Details','Information included in the lease.',columns.lease)}
    ${h.panel('Application & Screening','Credit, income and supporting records.',columns.screening)}
   </div></section>`;
 };
 const pending=group.invitations.filter(i=>!i.accepted);
 if(!members.some(m=>m.id===selectedApplicants.get(viewKey)))selectedApplicants.set(viewKey,members[0]?.id);
 const signingStage=w.signing && ({preparing:'Preparing lease invitations',sending:'Sending lease invitations',in_progress:'Signatures in progress',archiving:'Saving signed documents',completed:'Lease completed',needs_attention:'Signing needs attention'}[w.signing.phase]);
 const stageLabel=signingStage || (blocked && ['sent_to_landlord','landlord_approved','lease_sent','lease_signed'].includes(row.status) ? 'Blocked · application evidence incomplete' : {sent_to_landlord:'Awaiting landlord decision',landlord_approved:!w.lease_preparation || draft?.missing?.length || draft?.error?'Lease needs information':'Lease ready for review',lease_sent:'Signatures in progress',lease_signed:'Lease completed',declined:'Not proceeding'}[row.status] || 'Collecting applications');
 const notice=pending.length?`Waiting for ${pending.map(i=>i.name).join(', ')} to submit.`:group.issues.length?group.issues[0]:row.status==='sent_to_landlord'?'The landlord’s response will appear here.':row.status==='landlord_approved'?'Review the lease draft and arrange tenant signatures.':row.status==='lease_sent'?'Track tenant signatures, then the landlord’s signature.':row.status==='declined'?'This rental is closed. The decision and application records are retained.':row.status==='lease_signed'?'All signatures are recorded. The lease is available in Lease & Decision.':'All received application information is available below.';
 const membershipLocked=closed || members.some(m=>m.workspace?.signed_lease || m.workspace?.tenant_signature || m.workspace?.landlord_signature || Object.keys(m.workspace?.signature_receipts || {}).length || (m.workspace?.signing && !['voided','declined'].includes(m.workspace.signing.phase)));
 const memberTools=members.length>1 && session.role!=='landlord' ? h.panel('Separate or remove an applicant','Change one applicant without deleting the rest of the group.',membershipLocked?'<p>Void the active signing request before changing applicants. Signed or closed applications must be retained.</p>':members.map(m=>`<details class="cw-edit"><summary>${esc(m.name)}${m.id===id?' · Primary applicant':''}</summary><p>Previous group approval and lease drafts will be cleared. Payment and screening records remain with each applicant. ${m.id===id?'The remaining group will use another applicant as its primary record.':''}</p>${form('split_member',`<input type="hidden" name="member_id" value="${esc(m.id)}"><label>Reason<textarea name="reason" required maxlength="2000"></textarea></label><label class="cw-check"><input type="checkbox" name="confirmed" required><span>Keep ${esc(m.name)} as a separate application for this unit.</span></label>`,'Split into separate application')}${session.role==='manager' && !m.workspace?.signing?form('remove_member',`<input type="hidden" name="member_id" value="${esc(m.id)}"><p>This permanently deletes only ${esc(m.name)}’s application and uploaded files. Their login account remains. This does not refund any paid fee.</p><label>Reason<textarea name="reason" required maxlength="2000"></textarea></label><label>Type the applicant’s full name<input name="confirm_name" required autocomplete="off" placeholder="${esc(m.name)}"></label><label class="cw-check"><input type="checkbox" name="confirmed" required><span>I confirm this applicant is withdrawing and this deletion cannot be undone.</span></label>`,'Delete this applicant'):''}</details>`).join('')):'';
 // Another independent application for this unit can join at any stage
 // before signing starts. The server names the reason when it cannot.
 const joinable=session.role!=='landlord' && !closed && !group.join_lock;
 const inviteTools=editable ? `<details class="cw-edit"><summary>Invite a roommate</summary><form data-rental-invite class="cw-form"><label>Full name<input name="name" required maxlength="160"></label><label>Email<input name="email" type="email" required></label><button type="submit" class="primary">Send invitation</button><p role="status"></p></form></details>` : '';
 const joinTools=joinable ? `<details class="cw-edit"><summary>Join an existing application</summary><div data-merge-options>Loading eligible applications…</div></details>` : '';
 const invitationTools=editable ? group.invitations.filter(i=>!i.accepted).map(i=>`<details class="cw-edit"><summary>Pending invitation: ${esc(i.name)}</summary>${form('cancel_invite',`<input type="hidden" name="invitation_id" value="${esc(i.id)}"><label class="cw-check"><input type="checkbox" name="confirmed" required><span>This person will not join this lease.</span></label>`,'Cancel invitation')}</details>`).join('') : '';
 const groupTools=editable || joinable ? h.panel('Application group',editable ? 'Only join applicants who intend to share this lease.' : 'Joining another applicant clears the landlord approval and lease draft. The landlord decides again on the combined household.',`${inviteTools}${joinTools}${invitationTools}`) : '';
 const screens={
  applicants:`<div class="rg-applicant-toolbar"><nav class="rg-members" aria-label="Applicants">${members.map((m,i)=>`<button type="button" data-person="${esc(m.id)}" aria-pressed="${m.id===selectedApplicants.get(viewKey)}"><small>Member ${i+1}</small><b>${esc(m.name)}</b></button>`).join('')}${pending.map((i,n)=>`<div class="rg-invited"><small>Awaiting submission</small><b>${esc(i.name)}</b></div>`).join('')}</nav><div class="rg-reading-tools"><button type="button" data-expand-record>Expand all sections</button>${groupTools || memberTools?'<button type="button" data-toggle-members>Manage applicants</button>':''}</div></div><div data-member-tools hidden>${groupTools}${memberTools}</div><div class="rg-household"><div class="rg-people">${members.map(person).join('')}</div></div>`,
  lease:`<div class="rg-lease-workspace">${h.panel('Landlord Decision & Signing','',ctx.signing?.configuration?.enabled || w.signing ? `${row.status==='sent_to_landlord'?progression:''}${signingMarkup(ctx)}` : progression + signingMarkup(ctx))}${h.termsPanel(ctx)}</div>`,
  activity:`<div class="rg-activity-workspace">${h.notesPanel(ctx)}${session.role==='manager'?h.privateNotePanel(ctx):''}${h.activityPanel(ctx)}</div>`
 };
 return `<a class="link" href="#/applications">← All rentals</a><div class="rg-page-header"><div><h1>${esc(row.listings?.property_name || 'Rental application')} <span>· Unit ${esc(row.listings?.unit || '—')}</span></h1><p>${row.workspace?.test_run?`Internal Test · ${esc(row.id.slice(0,8))} <span class="rg-header-divider">|</span> `:''}${members.length} submitted${pending.length?` · ${pending.length} awaiting submission`:''} <span class="rg-header-divider">|</span> ${esc(money(ctx.terms['rent.monthly']))} / month</p></div><details class="rg-team-menu"><summary>Agent: ${esc(row.responsible_email || 'Unassigned')}</summary>${ctx.allowed.includes('assign')?h.assignForm(row,ctx.people):h.teamPanel(ctx)}</details></div>
 <div class="rg-case-status"><div><strong>${esc(stageLabel)}</strong><p>${esc(notice)}</p></div>${['sent_to_landlord','landlord_approved','lease_sent','lease_signed','declined'].includes(row.status)?'<button type="button" data-rental-goto="lease">View Lease & Decision →</button>':group.issues.length?'<button type="button" data-show-issues>View outstanding items →</button>':''}</div>
 <div class="rg-status-line" data-outstanding hidden>${attention}</div>
 <nav class="rg-work-tabs" role="tablist" aria-label="Rental workspace">${[['applicants','Applicants'],['lease','Lease & Decision'],['activity','Activity']].map(([key,label])=>`<button type="button" role="tab" data-rental-view="${key}" id="rental-tab-${key}" aria-controls="rental-view-${key}" aria-selected="${activeView===key}" tabindex="${activeView===key?0:-1}">${label}</button>`).join('')}</nav>
 ${Object.entries(screens).map(([key,html])=>`<section id="rental-view-${key}" role="tabpanel" aria-labelledby="rental-tab-${key}" data-rental-panel="${key}" ${activeView!==key?'hidden':''}>${html}</section>`).join('')}`;
}
export async function bindRentalGroup(host,ctx,reload,current) {
 bindSigning(host,ctx,reload);
 const priorClick=host.onclick,priorSubmit=host.onsubmit,priorKey=host.onkeydown;
 const viewKey=ctx.viewKey || ctx.id;
 const changeView=key=>{
  rentalViews.set(viewKey,key);
  host.querySelectorAll('[data-rental-view]').forEach(b=>{b.setAttribute('aria-selected',String(b.dataset.rentalView===key));b.tabIndex=b.dataset.rentalView===key?0:-1;});
  host.querySelectorAll('[data-rental-panel]').forEach(p=>p.hidden=p.dataset.rentalPanel!==key);
 };
 host.onkeydown=event=>{
  if(event.target.matches('[data-rental-view]') && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
   event.preventDefault();const tabs=[...host.querySelectorAll('[data-rental-view]')],i=tabs.indexOf(event.target),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
   changeView(tabs[next].dataset.rentalView);tabs[next].focus();return;
  }return priorKey?.(event);
 };
 host.onclick=event=>{
  const reportButton=event.target.closest('[data-view-mock-report]');
  if(reportButton){const member=ctx.row.household.members.find(m=>m.id===reportButton.dataset.viewMockReport);if(member)openMockReport(member);return;}
  const tab=event.target.closest('[data-rental-view], [data-rental-goto]');
  if(tab){changeView(tab.dataset.rentalView || tab.dataset.rentalGoto);return;}
  if(event.target.closest('[data-show-issues]')){const box=host.querySelector('[data-outstanding]');box.hidden=!box.hidden;const details=box.querySelector('details');if(details)details.open=true;return;}
  if(event.target.closest('[data-toggle-members]')){const box=host.querySelector('[data-member-tools]');box.hidden=!box.hidden;return;}
  const expand=event.target.closest('[data-expand-record]');
  if(expand){const sections=[...host.querySelectorAll('[data-person-panel]:not([hidden]) [data-record-section]')],open=sections.some(s=>!s.open);sections.forEach(s=>s.open=open);expand.textContent=open?'Collapse all sections':'Expand all sections';return;}

  if(event.target.closest('[data-cancel-correction]')){const details=event.target.closest('details');details.querySelector('form').reset();details.open=false;return;}
  const button=event.target.closest('[data-person]');if(button){selectedApplicants.set(viewKey,button.dataset.person);host.querySelector('[data-expand-record]').textContent='Expand all sections';button.scrollIntoView({block:'nearest',inline:'nearest'});host.querySelectorAll('[data-person]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));host.querySelectorAll('[data-person-panel]').forEach(p=>p.hidden=p.dataset.personPanel!==button.dataset.person);return;}return priorClick?.(event);};
 host.onsubmit=async event=>{
  const form=event.target;
  if(form.matches('[data-applicant-correction]')) {
   event.preventDefault();const member=ctx.row.household.members.find(m=>m.id===form.dataset.applicantId);if(!member)return;
   const fields=correctionFields(member,form.dataset.applicantCorrection),input=new FormData(form),body={};
   for(const f of fields){let v=input.get(f.name);if(f.type==='boolean'){if(v==='')continue;v=v==='true';}const [parent,key]=f.name.split('.');if(key){body[parent] ||= {...member[parent]};body[parent][key]=v;}else body[parent]=v;}
   const button=form.querySelector('[type=submit]'),status=form.querySelector('[role=status]');button.disabled=true;status.textContent='Saving…';
   try{await ctx.api(`/applications/${member.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});await reload();}catch(e){status.textContent=e.message;button.disabled=false;}return;
  }
  if(!form.matches('[data-rental-invite]')) return priorSubmit?.(event);
  event.preventDefault();const button=form.querySelector('button'),status=form.querySelector('[role=status]');button.disabled=true;
  try{const result=await ctx.api(`/cases/${ctx.id}/invite`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...Object.fromEntries(new FormData(form)),version:ctx.row.workspace_version})});await reload();const p=document.createElement('p');p.className='cw-saved';p.textContent=`Invitation saved · email ${result.delivery}`;host.prepend(p);}catch(e){status.textContent=e.message;button.disabled=false;}
 };
 if(host.querySelector('[data-merge-options]')) {
  try {
   const {cases}=await ctx.api('/cases');if(!current())return;
   // One applicant, nothing pending, and not signing, signed or closed. The
   // stage is shown because a case the landlord already approved may join too.
   const eligible=cases.filter(r=>r.id!==ctx.id && r.listing_id===ctx.row.listing_id && r.household?.members.length===1 && !r.household.invitations.some(i=>!i.accepted) && !r.household.join_lock && !['lease_sent','lease_signed','declined'].includes(r.status));
   const stage={needs_info:'Information requested',sent_to_landlord:'Awaiting landlord decision',landlord_approved:'Landlord approved'};
   host.querySelector('[data-merge-options]').innerHTML=eligible.length ? eligible.map(r=>`<div class="rg-merge-choice"><b>${esc(r.name)}</b><p>${esc(r.email)} · ${esc(r.move_in)} · ${esc(r.responsible_email || 'Unassigned')} · ${esc(stage[r.status] || 'Collecting application')}</p>${form('merge',`<input type="hidden" name="application_id" value="${esc(r.id)}"><input type="hidden" name="source_version" value="${r.workspace_version}"><label class="cw-check"><input type="checkbox" name="confirmed" required><span>These applicants intend to share one lease. Use this group’s agent, rent and dates. Any landlord approval or lease draft on either application is cleared and the landlord decides again.</span></label>`,'Join this application')}</div>`).join(''):'<p>No eligible independent applications for this unit.</p>';
  }catch(e){if(current())host.querySelector('[data-merge-options]').textContent=e.message;}
 }
}
