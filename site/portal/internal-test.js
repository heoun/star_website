const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function testSteps(app,complete) {
  if(!app.test_run)return '';
  const paid=app.payment?.status==='paid',submitted=app.screening?.submitted,locked=['sent_to_landlord','landlord_approved','lease_sent','lease_signed','declined'].includes(app.status);
  const report=app.screening?.status==='complete'?(app.screening.outcome==='no_score'?'No Score — Staff Review Required':'Complete'):app.screening?.status==='failed'?'Provider Failed':submitted?'Processing':'Not Started';
  return `<aside class="internal-test-tools" data-test-panel="${esc(app.id)}"><strong>Internal Test · ${esc(app.id.slice(0,8))}</strong><p>Payment and credit screening are simulated. No card or real identity documents are needed. Landlord emails and DocuSign invitations go to the designated test inboxes.</p><ol><li>Application Form — Submitted</li><li>Application Fee — ${paid?'Paid (Simulated $20)':app.payment?.status==='failed'?'Payment Failed — Retry Available':'Pending'}</li><li>Supporting Documents — ${complete?'Complete':'Required'}</li><li>Credit Screening — ${report}</li><li>Landlord Decision — ${['landlord_approved','lease_sent','lease_signed'].includes(app.status)?'Approved':app.status==='sent_to_landlord'?'Email Sent / Awaiting Decision':app.status==='declined'?'Not Proceeding':'Waiting for Screening'}</li><li>Lease Signing — ${esc(app.signing_phase || 'Not Started')}</li></ol>
  ${!locked&&!paid?'<div class="test-actions"><button type="button" data-test-action="payment" data-outcome="paid">Pay $20 — Simulation</button><button type="button" data-test-action="payment" data-outcome="failed">Simulate Payment Failure</button></div>':''}
  ${!locked&&paid&&!submitted?`<div class="test-actions"><button type="button" data-test-action="documents">Upload Sample Documents</button></div><p>Sample files are visibly marked as test documents and use the normal upload endpoint.</p><label>Screening Scenario <select data-scenario><option value="scored">Completed Report With Score</option><option value="no_score">No Credit Score Returned</option><option value="failed">Provider Processing Failure</option></select></label><label class="test-consent"><input type="checkbox" data-screening-consent> I consent to this simulated screening using the submitted test materials.</label><button type="button" data-test-action="screening" ${!complete?'disabled':''}>Submit Screening Materials</button>`:''}
  <div class="test-actions"><button type="button" data-test-action="refresh">Refresh Status</button><a href="/apply/?id=${encodeURIComponent(app.listing_id)}">Start Another Application</a></div><p role="status"></p></aside>`;
}
// A valid small PDF with visible TEST labels, not fabricated financial evidence.
function samplePdf(type,id) {
  const lines=['INTERNAL TEST DOCUMENT - NOT VALID EVIDENCE',`Document: ${type}`,`Application: ${id}`,'Synthetic fixture. No personal or financial records.'];
  const stream=`BT /F1 12 Tf 45 740 Td ${lines.map((s,i)=>`${i?'0 -24 Td ':''}(${s}) Tj`).join('\n')} ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((o,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});const xref=pdf.length;
  pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([pdf],{type:'application/pdf'});
}
export async function testAction(button,app,api,types) {
  const panel=button.closest('[data-test-panel]'),action=button.dataset.testAction,path=`/applications/${app.id}`;
  const post=(suffix,body)=>api(path+suffix,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(action==='payment')return post('/payment',{outcome:button.dataset.outcome});
  if(action==='screening')return post('/screening',{consent:panel.querySelector('[data-screening-consent]').checked,scenario:panel.querySelector('[data-scenario]').value});
  if(action==='refresh')return post('/refresh',{});
  if(action==='documents') {
    const required=types.filter(t=>t.required && (!t.either || t.id==='job_offer_letter'));
    for(const type of required)for(let count=app.documents.filter(d=>d.doc_type===type.id).length;count<type.required;count++) {
      const body=new FormData();body.set('doc_type',type.id);body.set('file',samplePdf(type.id,app.id),`TEST-${type.id}-${count+1}.pdf`);
      await api(path+'/documents',{method:'POST',body});
    }
  }
}
