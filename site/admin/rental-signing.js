const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const phaseLabel={preparing:'Preparing to send',sending:'Sending invitations',in_progress:'Signatures in progress',archiving:'Saving signed documents',completed:'Lease completed',declined:'Signing declined',voided:'Envelope voided',needs_attention:'Signing needs attention'};
export function signingMarkup(ctx) {
 const record=ctx.signing?.signing,config=ctx.signing?.configuration;
 const active=record && !['voided','declined'].includes(record.phase);
 const canPrepare=!ctx.row.progression_blocked && ctx.row.status==='landlord_approved' && ctx.w.lease_preparation && !active;
 const progress=active?`<p><strong>${esc(phaseLabel[record.phase] || record.phase)}</strong></p>${record.issue?`<p role="status">${esc(record.issue)}</p>`:''}<ul>${record.signers.map(s=>`<li><b>${esc(s.name)}</b> · ${esc(s.role)} · ${esc(s.email)}<br>${esc(s.status==='completed'?'Signed':s.status==='declined'?'Declined':s.role==='landlord' && !record.signers.filter(p=>p.role==='tenant').every(p=>p.status==='completed')?'Waiting for all tenants':s.status || 'Waiting to send')}</li>`).join('')}</ul>${record.completed?`<p><a class="desk-button" href="/api/admin/cases/${esc(ctx.id)}/signing?file=signed">Download signed lease</a> <a class="desk-button" href="/api/admin/cases/${esc(ctx.id)}/signing?file=certificate">Completion certificate</a></p>`:record.void_requested?'<p>Cancellation requested. Waiting for DocuSign confirmation.</p>':`<details><summary>Cancel this signing request</summary><form data-signing-void class="cw-form"><label>Reason<input name="reason" required maxlength="200"></label><button type="submit" ${!config?.canSend?'disabled':''}>Void envelope</button></form></details>`}`:'';
 return `<div data-rental-signing><h3>DocuSign signing</h3><p>All tenants sign first. The landlord receives their invitation after every tenant has signed.</p>${!active && !canPrepare?'<p>Complete the application evidence, landlord approval and lease draft before preparing a signing package.</p>':''}${config?.environment==='demo'?'<p class="cw-note">Sandbox · invitations go to the email addresses shown below.</p>':''}${!config?.canSend?`<p class="cw-note">${esc(config?.message || 'DocuSign is unavailable.')}</p>`:''}${progress}${record && !active?`<p>Previous signing request: ${esc(phaseLabel[record.phase])}. Review the application and obtain a new landlord approval before sending a replacement.</p>`:''}${canPrepare?`<button type="button" data-signing-prepare ${!config?.enabled?'disabled':''}>Review signing package</button>`:''}<div data-signing-preview></div><p data-signing-feedback role="status" aria-live="polite"></p></div>`;
}
export function bindSigning(host,ctx,reload) {
 const panel=host.querySelector('[data-rental-signing]');if(!panel)return;
 const feedback=panel.querySelector('[data-signing-feedback]');let preview;
 const post=body=>ctx.api(`/cases/${ctx.id}/signing`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 panel.addEventListener('click',async event=>{
  const button=event.target.closest('[data-signing-prepare],[data-signing-send]');if(!button)return;
  button.disabled=true;feedback.textContent='Preparing…';
  try {
   if(button.hasAttribute('data-signing-prepare')) {
    const result=await post({action:'prepare',version:ctx.row.workspace_version});
    if(result.reserved){await reload();return;}
    preview=result.signing;
    panel.querySelector('[data-signing-preview]').innerHTML=`<h4>Review before sending</h4><p><a class="desk-button" href="/api/admin/cases/${esc(ctx.id)}/signing?package=${esc(preview.id)}&file=source">Download this exact lease for review</a></p><ol>${preview.signers.map(s=>`<li>${esc(s.role==='tenant'?'Tenant':'Landlord')} — ${esc(s.name)} · ${esc(s.email)}</li>`).join('')}</ol><label class="cw-check"><input type="checkbox" data-signing-reviewed><span>I reviewed this lease and all signer names and email addresses.</span></label><button type="button" class="primary" data-signing-send disabled>Send with DocuSign</button>`;
    feedback.textContent='Review the saved contract and recipients. Nothing has been sent.';
   } else {
    if(!preview || !panel.querySelector('[data-signing-reviewed]')?.checked)return;
    feedback.textContent='Saving signing request…';
    await post({action:'send',packageId:preview.id,version:ctx.row.workspace_version});await reload();
   }
  }catch(e){feedback.textContent=e.message;}finally{if(button.isConnected)button.disabled=button.hasAttribute('data-signing-send') && !ctx.signing?.configuration?.canSend;}
 });
 panel.addEventListener('change',event=>{if(event.target.matches('[data-signing-reviewed]'))panel.querySelector('[data-signing-send]').disabled=!event.target.checked || !ctx.signing?.configuration?.canSend;});
 panel.addEventListener('submit',async event=>{
  if(!event.target.matches('[data-signing-void]'))return;
  event.preventDefault();event.stopPropagation();const button=event.target.querySelector('button');button.disabled=true;
  try{await post({action:'void',packageId:ctx.signing.signing.id,reason:new FormData(event.target).get('reason')});await reload();}catch(e){feedback.textContent=e.message;button.disabled=false;}
 });
}
