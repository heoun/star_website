const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const phaseLabel={preparing:'Preparing to send',sending:'Sending invitations',in_progress:'Signatures in progress',archiving:'Saving signed documents',completed:'Lease completed',declined:'Signing declined',voided:'Envelope voided',needs_attention:'Signing needs attention'};
export const signingPhaseLabel=phase=>phaseLabel[phase] || phase || 'Not sent';
import {SIGNING_TEMPLATE_VERSION} from '../shared/lease-signing-layout.js';
// Previews stay in memory only, scoped to the exact rental revision.
const previews = new Map();
export function signingPreview(ctx) {
 const entry=previews.get(ctx.id);
 if(entry && entry.version===ctx.row.workspace_version && entry.preview.template_version===SIGNING_TEMPLATE_VERSION)return entry;
 previews.delete(ctx.id);return null;
}
export function invalidateSigningReview(id) { previews.delete(id); }
export async function prepareSigningPackage(ctx) {
 const prior=signingPreview(ctx);if(prior)return prior;
 const result=await ctx.api(`/cases/${ctx.id}/signing`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'prepare',version:ctx.row.workspace_version})});
 if(result.reserved)return null;
 const entry={preview:result.signing,version:ctx.row.workspace_version,reviewed:false};
 previews.set(ctx.id,entry);return entry;
}
export async function sendSigningPackage(ctx,entry) {
 if(signingPreview(ctx)!==entry)throw new Error('The lease changed. Prepare a new signing package.');
 if(!ctx.signing?.configuration?.canSend)throw new Error(ctx.signing?.configuration?.message || 'DocuSign sending is unavailable.');
 if(ctx.signing?.configuration?.placementReviewRequired)throw new Error('Confirm the signing positions for all 15 documents before sending.');
 if(entry.sending)return false;
 entry.sending=true;
 try {
  if(!entry.reviewed) {
   const action=await confirmUnreviewedSend(ctx,entry);
   if(action==='review') {
    if(ctx.openReview)await ctx.openReview(entry);
    else location.hash=`#/leases/${encodeURIComponent(ctx.id)}`;
    return false;
   }
   if(action!=='send')return false;
  }
  // The custom dialog is asynchronous; recheck the package after it closes.
  if(signingPreview(ctx)!==entry)throw new Error('The lease changed. Prepare a new signing package.');
  if(!ctx.signing?.configuration?.canSend)throw new Error('DocuSign sending is unavailable.');
  await ctx.api(`/cases/${ctx.id}/signing`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'send',packageId:entry.preview.id,version:entry.version})});
  invalidateSigningReview(ctx.id);return true;
 } finally {entry.sending=false;}
}
function confirmUnreviewedSend(ctx,entry) {
 return new Promise(resolve=>{
  const dialog=document.createElement('dialog'),trigger=document.activeElement;
  dialog.className='signing-confirm';dialog.setAttribute('aria-labelledby','signing-confirm-title');dialog.setAttribute('aria-describedby','signing-confirm-description');
  dialog.innerHTML=`<header class="signing-confirm-header"><div><span class="signing-confirm-eyebrow">DOCUSIGN · ${ctx.signing?.configuration?.environment==='demo'?'SANDBOX':'LEASE SIGNING'}</span><h2 id="signing-confirm-title">Send Without Reviewing?</h2></div><button type="button" class="signing-confirm-close" data-choice="cancel" aria-label="Close Confirmation">×</button></header>
   <div class="signing-confirm-body"><p id="signing-confirm-description">You haven’t opened this signing package for review. You can review the lease first, or send it to the people below.</p><h3>Signing Recipients</h3>${recipientsMarkup(entry.preview.signers)}<p class="signing-confirm-note">Tenants receive their invitations first. The landlord is invited after all tenants have signed.</p></div>
   <footer class="signing-confirm-actions"><button type="button" data-choice="review" autofocus>Back to Review</button><button type="button" class="primary" data-choice="send">Skip Review &amp; Send</button></footer>`;
  const cancel=()=>dialog.close('cancel');
  dialog.addEventListener('click',event=>{const button=event.target.closest('[data-choice]');if(button)dialog.close(button.dataset.choice);else if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom)cancel();}});
  dialog.addEventListener('close',()=>{
   window.removeEventListener('hashchange',cancel);dialog.remove();
   requestAnimationFrame(()=>{if(trigger?.isConnected)trigger.focus();});
   resolve(dialog.returnValue || 'cancel');
  },{once:true});
  window.addEventListener('hashchange',cancel);document.body.append(dialog);dialog.showModal();
 });
}
function recipientsMarkup(signers) {
 return `<ul class="signing-recipients">${signers.map(s=>`<li><span class="signing-recipient-role">${s.role==='tenant'?'Tenant':'Landlord'}</span><div><strong>${esc(s.name)}</strong><span>${esc(s.email)}</span></div></li>`).join('')}</ul>`;
}
function previewMarkup(entry,ctx) {
 if(!entry)return '';
 return `<section class="signing-package"><div class="signing-package-heading"><h4>Signing Recipients</h4><span class="signing-status">Not Sent</span></div>${recipientsMarkup(entry.preview.signers)}<div class="signing-next"><p>${entry.reviewed?'Lease opened for review. Ready when you are.':'Review the lease before sending. Skipping review requires confirmation.'}</p><div class="signing-actions"><button type="button" class="signing-action" data-signing-review>Review Lease Draft</button><button type="button" class="signing-action primary" data-signing-send ${!ctx.signing?.configuration?.canSend || ctx.signing?.configuration?.placementReviewRequired?'disabled':''}>Send With DocuSign</button></div></div></section>`;
}
export function signingMarkup(ctx) {
 const record=ctx.signing?.signing,config=ctx.signing?.configuration;
 const active=record && !['voided','declined'].includes(record.phase);
 const entry=signingPreview(ctx);
 const canPrepare=!ctx.row.progression_blocked && ctx.row.status==='landlord_approved' && ctx.w.lease_preparation && !active;
 const progress=active?`<p><strong>${esc(phaseLabel[record.phase] || record.phase)}</strong></p>${record.issue?`<p role="status">${esc(record.issue)}</p>`:''}${ctx.workspaceReview?'':'<ul>'+record.signers.map(s=>`<li><b>${esc(s.name)}</b> · ${esc(s.role)} · ${esc(s.email)}<br>${esc(s.status==='delivery_failed'?'Email Delivery Failed':s.status==='completed'?'Signed':s.status==='declined'?'Declined':s.role==='landlord' && !record.signers.filter(p=>p.role==='tenant').every(p=>p.status==='completed')?'Waiting for all tenants':s.status || 'Waiting to send')}${s.deliveryIssue?`<br>${esc(s.deliveryIssue)}`:''}</li>`).join('')+'</ul>'}${record.completed?`<p><a class="desk-button" href="/api/admin/cases/${esc(ctx.id)}/signing?file=signed">Download signed lease</a> <a class="desk-button" href="/api/admin/cases/${esc(ctx.id)}/signing?file=certificate">Completion certificate</a></p>`:record.void_requested?'<p>Cancellation requested. Waiting for DocuSign confirmation.</p>':`<details><summary>Cancel this signing request</summary><form data-signing-void class="cw-form"><label>Reason<input name="reason" required maxlength="200"></label><button type="submit" ${!config?.canSend?'disabled':''}>Void envelope</button></form></details>`}`:'';
 return `<div class="signing-panel" data-rental-signing><div class="signing-panel-heading"><h3>DocuSign Signing</h3>${config?.environment==='demo'?'<span class="signing-environment">Sandbox</span>':''}</div>${ctx.workspaceReview?'':'<p class="signing-intro">All tenants sign first. The landlord receives their invitation after every tenant has signed.</p>'}${!active && !canPrepare?'<p>Complete the application evidence, landlord approval and lease draft before preparing a signing package.</p>':''}${!config?.canSend?`<p class="cw-note">${esc(config?.message || 'DocuSign is unavailable.')}</p>`:''}${!active && config?.placementReviewRequired?'<p class="cw-note">Signing positions are being reviewed document by document. Sending is paused until all 15 documents are confirmed.</p>':''}${progress}${active?`<p class="signing-progress-detail">${record.phase==='preparing'?'Preparing your documents in DocuSign. This can take a few minutes. Invitations have not been sent yet.':record.phase==='sending'?'Checking signing fields and sending invitations. Please keep this signing request.':record.phase==='in_progress'?'DocuSign has accepted the invitations. Tenants sign first; the landlord is invited after all tenants finish.':''}</p>${record.updated_at?`<p class="signing-status">Last updated: ${esc(new Date(record.updated_at).toLocaleString())}</p>`:''}`:''}${record && !active?`<p>Previous signing request: ${esc(phaseLabel[record.phase])}. ${canPrepare?'The approved lease is ready for a new signing package.':'Review the application and obtain a new landlord approval before sending a replacement.'}</p>`:''}${!ctx.workspaceReview && canPrepare && !entry?`<button type="button" class="signing-action" data-signing-prepare ${!config?.enabled?'disabled':''}>Review Signing Package</button>`:''}<div data-signing-preview>${!ctx.workspaceReview && canPrepare?previewMarkup(entry,ctx):''}</div><p data-signing-feedback role="status" aria-live="polite"></p></div>`;
}
export function bindSigning(host,ctx,reload) {
 const panel=host.querySelector('[data-rental-signing]');if(!panel)return;
 const feedback=panel.querySelector('[data-signing-feedback]');let busy=false;
 panel.addEventListener('click',async event=>{
  const button=event.target.closest('[data-signing-prepare],[data-signing-review],[data-signing-send]');if(!button || busy)return;
  busy=true;button.disabled=true;feedback.textContent='';
  try {
   if(button.hasAttribute('data-signing-prepare')) {
    feedback.textContent='Preparing…';
    const entry=await prepareSigningPackage(ctx);
    if(!entry){await reload();return;}
    panel.querySelector('[data-signing-preview]').innerHTML=previewMarkup(entry,ctx);
    button.hidden=true;feedback.textContent='';
    panel.querySelector('[data-signing-review]')?.focus();
   } else if(button.hasAttribute('data-signing-review')) {
    const entry=signingPreview(ctx);if(!entry)throw new Error('Prepare a new signing package.');
    if(ctx.openReview)await ctx.openReview(entry);
    else location.hash=`#/leases/${encodeURIComponent(ctx.id)}`;
   } else {
    const entry=signingPreview(ctx);if(!entry)throw new Error('Prepare a new signing package.');
    if(await sendSigningPackage(ctx,entry))await reload();
   }
  }catch(e){feedback.textContent=e.message;}finally{busy=false;if(button.isConnected)button.disabled=button.hasAttribute('data-signing-send') && (!ctx.signing?.configuration?.canSend || ctx.signing?.configuration?.placementReviewRequired);}
 });
 const post=body=>ctx.api(`/cases/${ctx.id}/signing`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 panel.addEventListener('submit',async event=>{
  if(!event.target.matches('[data-signing-void]'))return;
  event.preventDefault();event.stopPropagation();const button=event.target.querySelector('button');button.disabled=true;
  try{await post({action:'void',packageId:ctx.signing.signing.id,reason:new FormData(event.target).get('reason')});await reload();}catch(e){feedback.textContent=e.message;button.disabled=false;}
 });
}
