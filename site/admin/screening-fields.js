const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function screeningFields(w) {
 const s=w.screening_result?.mock ? {} : w.screening_result || {},received=w.checks?.screening==='received',noScore=s.outcome==='no_score';
 const input=(label,name,value,type='text',extra='')=>`<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" required ${extra}></label>`;
 return `<fieldset data-report-evidence ${received?'':'disabled hidden'}><legend>External credit report</legend><p class="cw-note">Read the actual report and record its details. A payment receipt or verification note does not replace a credit report.</p><div class="cw-form-grid">
 ${input('Report provider','report_provider',s.provider)}${input('Report reference','report_reference',s.reference)}
 ${input('Secure report link','report_url',s.report_url,'url','placeholder="https://"')}${input('Report date','report_date',s.date?.slice(0,10),'date')}
 <label>Credit result<select name="report_outcome"><option value="scored">Credit score returned</option><option value="no_score" ${noScore?'selected':''}>Provider returned no score</option></select></label>
 <label data-scored ${noScore?'hidden':''}>Credit score<input name="credit_score" type="number" min="300" max="850" step="1" value="${esc(s.credit_score)}" ${noScore?'disabled':'required'}></label>
 <label data-scored ${noScore?'hidden':''}>Score model<input name="score_model" value="${esc(s.model)}" ${noScore?'disabled':'required'}></label>
 <label data-no-score ${noScore?'':'hidden'}>Provider’s reason for no score<textarea name="no_score_reason" ${noScore?'required':'disabled'}>${esc(s.no_score_reason)}</textarea></label>
 </div><p data-no-score class="cw-note" ${noScore?'':'hidden'}>This result needs review. It will not be shared automatically for a landlord decision.</p></fieldset>`;
}
document.addEventListener('change',event=>{
 const form=event.target.closest('form'),fields=form?.querySelector('[data-report-evidence]');if(!fields)return;
 if(event.target.name==='fee'){
  const paid=['paid','waived'].includes(event.target.value),screening=form.elements.screening;
  screening.querySelector('option[value="received"]').disabled=!paid;
  if(!paid){screening.value='pending';fields.disabled=true;fields.hidden=true;}
 }
 if(event.target.name==='screening'){fields.disabled=event.target.value!=='received';fields.hidden=fields.disabled;}
 if(event.target.name==='report_outcome'){const noScore=event.target.value==='no_score';fields.querySelectorAll('[data-scored],[data-no-score]').forEach(label=>{const active=label.hasAttribute('data-no-score')===noScore;label.hidden=!active;label.querySelectorAll('input,textarea').forEach(input=>{input.disabled=!active;input.required=active;});});}
});
