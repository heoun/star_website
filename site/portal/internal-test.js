// The applicant's view of an internal test run: the fee, documents and
// screening steps as they will look once a screening provider is connected.
// Payment and screening go to the local simulator; nothing here reaches a
// card network or a credit bureau. The module is loaded only for the
// allowlisted test account, so every page it renders is a rehearsal.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const FEE='$20.00';
const CARDS={approved:'4242 4242 4242 4242',declined:'4000 0000 0000 0002'};
const LOCKED=['sent_to_landlord','landlord_approved','lease_sent','lease_signed','declined'];
const LANDLORD_EMAIL={sent:'Landlord notified, awaiting decision',failed:'Landlord email not sent, delivery failed',preview:'Landlord email preview only, not sent',sending:'Sending the landlord email',pending:'Landlord email pending'};

function stageOf(app,complete) {
  const paid=app.payment?.status==='paid',status=app.screening?.status;
  if(!paid)return 'fee';
  if(!app.screening?.submitted)return complete?'screening':'documents';
  if(status==='complete')return 'report';
  if(status==='failed')return 'failed';
  return 'processing';
}

function stepsBar(app,stage,complete) {
  const approved=['landlord_approved','lease_sent','lease_signed'].includes(app.status);
  const reportDone=app.screening?.status==='complete';
  const steps=[
    ['Application',{state:'done',note:'Submitted'}],
    ['Fee',stage==='fee'?{state:'current',note:app.payment?.status==='failed'?'Declined':'Due'}:{state:'done',note:'Paid'}],
    ['Documents',complete?{state:'done',note:'Received'}:stage==='fee'?{state:'todo',note:'After payment'}:{state:'current',note:'Required'}],
    ['Screening',reportDone?{state:'done',note:app.screening.outcome==='no_score'?'No score':'Complete'}:stage==='failed'?{state:'failed',note:'Not completed'}:stage==='processing'?{state:'current',note:'Processing'}:stage==='screening'?{state:'current',note:'Authorize'}:{state:'todo',note:'Pending'}],
    ['Landlord',approved?{state:'done',note:'Approved'}:app.status==='declined'?{state:'failed',note:'Not proceeding'}:app.status==='sent_to_landlord'?{state:'current',note:'Reviewing'}:{state:'todo',note:'Pending'}],
    ['Lease',app.status==='lease_signed'?{state:'done',note:'Signed'}:app.status==='lease_sent'?{state:'current',note:'Sent for signing'}:{state:'todo',note:app.signing_phase || 'Pending'}]
  ];
  return `<ol class="flow-steps" aria-label="Application progress">${steps.map(([label,s],i)=>`<li class="is-${s.state}"${s.state==='current'?' aria-current="step"':''}><span class="flow-step-index">${i+1}</span><span class="flow-step-label">${label}</span><span class="flow-step-note">${esc(s.note)}</span></li>`).join('')}</ol>`;
}

function feePage(app,listing) {
  const declined=app.payment?.status==='failed';
  return `<section class="flow-stage" aria-labelledby="flow-fee-title">
    <h3 id="flow-fee-title">Application Fee</h3>
    <p class="flow-lede">A ${FEE} screening fee is charged for each applicant before the credit and background report is ordered. It is paid to the screening provider and is not refundable once the report is ordered.</p>
    ${declined?'<p class="flow-alert" role="alert">Your card was declined. Check the card details and try again.</p>':''}
    <div class="flow-grid">
      <form class="flow-form" data-fee-form novalidate autocomplete="off">
        <label>Name on Card<input name="card_name" value="${esc(app.name)}" maxlength="120"></label>
        <label>Card Number<input name="card_number" inputmode="numeric" value="${CARDS.approved}" maxlength="23"></label>
        <div class="flow-row">
          <label>Expiration<input name="card_exp" inputmode="numeric" value="12 / 29" maxlength="7"></label>
          <label>Security Code<input name="card_cvc" inputmode="numeric" value="123" maxlength="4"></label>
          <label>Billing ZIP<input name="card_zip" inputmode="numeric" value="10001" maxlength="10"></label>
        </div>
        <p class="flow-error" data-flow-error hidden></p>
        <button type="button" class="submit" data-test-action="payment">Pay ${FEE}</button>
        <p class="flow-note">Payment is processed by the screening provider. Star Real Estate never stores card details.</p>
      </form>
      <aside class="flow-summary" aria-label="Order summary">
        <h4>Order Summary</h4>
        <dl>
          <div><dt>Credit and Background Screening</dt><dd class="flow-amount">${FEE}</dd></div>
          <div><dt>Applicant</dt><dd>${esc(app.name)}</dd></div>
          <div><dt>Property</dt><dd>${esc(listing)}</dd></div>
        </dl>
        <p class="flow-total"><span>Total Due</span><b>${FEE}</b></p>
      </aside>
    </div>
  </section>`;
}

function receiptLine(app) {
  return `<p class="flow-receipt"><b>Application fee paid</b> ${FEE} <span class="flow-receipt-ref">Receipt ${esc(app.payment?.id || '')}</span></p>`;
}

function documentsPage(app,progress,docsHtml,requestHtml) {
  return `${receiptLine(app)}${requestHtml}
  <section class="flow-stage" aria-labelledby="flow-docs-title">
    <h3 id="flow-docs-title">Supporting Documents</h3>
    <p class="portal-progress${progress.met===progress.total?' is-done':''}">${progress.met===progress.total?'All required documents received. Thank you':`Required documents · ${progress.met} of ${progress.total} complete`}</p>
    <div class="doc-list">${docsHtml}</div>
  </section>`;
}

function screeningPage(app,complete) {
  return `<section class="flow-stage" aria-labelledby="flow-screening-title">
    <h3 id="flow-screening-title">Credit Screening</h3>
    <p class="flow-lede">${complete?'Confirm your identity and authorize the screening provider to prepare your credit and background report. The report goes to the leasing team, and you will be notified when it is complete.':'Once every required document is in, confirm your identity here and authorize the screening provider to prepare your report.'}</p>
    <form class="flow-form" data-screening-form novalidate autocomplete="off">
      <div class="flow-row">
        <label>Legal Name<input name="legal_name" value="${esc(app.name)}" readonly></label>
        <label>Date of Birth<input name="dob" inputmode="numeric" placeholder="MM/DD/YYYY" value="04/15/1994" maxlength="10"${complete?'':' disabled'}></label>
        <label>Last Four of SSN<input name="ssn_last4" inputmode="numeric" placeholder="0000" value="0000" maxlength="4"${complete?'':' disabled'}></label>
      </div>
      <label class="flow-consent"><input type="checkbox" data-screening-consent${complete?'':' disabled'}><span>I authorize the screening provider to obtain my consumer credit report and background records for this rental application, and I confirm the information above is accurate.</span></label>
      <p class="flow-error" data-flow-error hidden></p>
      <button type="button" class="submit" data-test-action="screening"${complete?'':' disabled'}>Authorize and Submit</button>
      ${complete?'':'<p class="flow-note">Upload every required document above to enable this step.</p>'}
    </form>
  </section>`;
}

function outcomePage(app,stage) {
  const next=`<div class="flow-next"><h4>What Happens Next</h4><ul>
    <li><b>Landlord Decision</b><span>${esc(['landlord_approved','lease_sent','lease_signed'].includes(app.status)?'Approved':app.status==='declined'?'Not proceeding':app.status==='sent_to_landlord'?LANDLORD_EMAIL[app.landlord_email_status] || LANDLORD_EMAIL.pending:'Waiting for the screening report')}</span></li>
    <li><b>Lease Signing</b><span>${esc(app.status==='lease_signed'?'Signed':app.status==='lease_sent'?'Sent for signing':app.signing_phase || 'Not started')}</span></li>
  </ul></div>`;
  const card=stage==='processing'
    ?`<div class="flow-status is-processing"><span class="flow-spinner" aria-hidden="true"></span><div><b>Preparing Your Report</b><p>The screening provider is processing your materials. This page refreshes on its own, and you can leave and come back.</p></div></div>`
    :stage==='failed'
      ?`<div class="flow-status is-failed"><span class="flow-mark" aria-hidden="true">!</span><div><b>Screening Not Completed</b><p>The screening provider could not complete your report. The leasing team has been notified and will follow up with you.</p></div></div>`
      :app.screening?.outcome==='no_score'
        ?`<div class="flow-status is-review"><span class="flow-mark" aria-hidden="true">?</span><div><b>Report Complete, Manual Review</b><p>The screening provider could not produce a credit score. A member of the leasing team will review your file and contact you.</p></div></div>`
        :`<div class="flow-status is-done"><span class="flow-mark" aria-hidden="true">✓</span><div><b>Report Complete</b><p>Your screening report has been delivered to the leasing team. No action is needed from you.</p></div></div>`;
  return `${receiptLine(app)}<section class="flow-stage" aria-labelledby="flow-outcome-title"><h3 id="flow-outcome-title">Credit Screening</h3>${card}${stage==='processing'?'':next}</section>`;
}

function demoControls(app,stage,locked) {
  const scenario=`<label class="demo-field">Screening Scenario<select data-scenario><option value="scored">Completed report with score</option><option value="no_score">No credit score returned</option><option value="failed">Provider processing failure</option></select></label>`;
  const byStage={
    fee:`<button type="button" data-test-action="fill-card" data-card="approved">Use Approved Test Card</button><button type="button" data-test-action="fill-card" data-card="declined">Use Declined Test Card</button><span class="demo-note">Card details never leave the browser. Only the outcome reaches the payment simulator.</span>`,
    documents:`<button type="button" data-test-action="documents">Upload Sample Documents</button><span class="demo-note">Sample files are visibly marked as test documents and use the normal upload endpoint.</span>`,
    screening:`<button type="button" data-test-action="documents">Upload Sample Documents</button>${scenario}<span class="demo-note">Date of birth and SSN digits are checked in the browser only and are never transmitted.</span>`,
    processing:'',report:'',failed:''
  };
  return `<aside class="demo-controls" aria-label="Internal test controls">
    <p class="demo-head"><span class="demo-tag">Internal Test</span><span class="demo-run">Run ${esc(app.id.slice(0,8))}</span><span class="demo-note">Payment and credit screening are simulated. Landlord emails and DocuSign invitations go to the designated test inboxes.</span></p>
    <div class="test-actions">${locked?'':byStage[stage]}<button type="button" data-test-action="refresh">Refresh Status</button><a href="/apply/?id=${encodeURIComponent(app.listing_id)}">Start Another Application</a></div>
    <p role="status"></p>
  </aside>`;
}

// Everything under the application heading for a test run: the step bar, the
// current step's page, and the demo controls. `docsHtml` is the ordinary
// document checklist the portal already renders.
export function testRunBody(app,{progress,docsHtml,requestHtml,listing}) {
  if(!app.test_run)return '';
  const complete=progress.met===progress.total,stage=stageOf(app,complete),locked=LOCKED.includes(app.status);
  let page;
  if(stage==='fee')page=feePage(app,listing);
  else if(stage==='documents' || stage==='screening')page=documentsPage(app,progress,docsHtml,requestHtml)+screeningPage(app,complete);
  else page=outcomePage(app,stage)+requestHtml+`<section class="flow-stage" aria-labelledby="flow-files-title"><h3 id="flow-files-title">Your Documents</h3><div class="doc-list">${docsHtml}</div></section>`;
  return `<div data-test-panel="${esc(app.id)}">${stepsBar(app,stage,complete)}${page}${demoControls(app,stage,locked)}</div>`;
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

class FormError extends Error {}
const digits=v=>String(v || '').replace(/\D/g,'');

// The card form never leaves the browser. The number only picks the outcome
// the simulator is asked for: the declined test card fails, anything else pays.
function paymentOutcome(panel) {
  const form=panel.querySelector('[data-fee-form]'),v=n=>form.elements[n].value.trim();
  if(!v('card_name'))throw new FormError('Enter the name on the card.');
  const number=digits(v('card_number'));
  if(number.length<13 || number.length>19)throw new FormError('Enter a valid card number.');
  const exp=digits(v('card_exp'));
  if(exp.length!==4 || Number(exp.slice(0,2))<1 || Number(exp.slice(0,2))>12)throw new FormError('Enter the expiration as MM / YY.');
  if(digits(v('card_cvc')).length<3)throw new FormError('Enter the security code.');
  if(digits(v('card_zip')).length<5)throw new FormError('Enter the billing ZIP.');
  return number.endsWith(digits(CARDS.declined).slice(-4)) && number.startsWith('4000')?'failed':'paid';
}

function screeningMaterials(panel) {
  const form=panel.querySelector('[data-screening-form]');
  const dob=form.elements.dob.value.trim();
  if(!/^\d{2}\/\d{2}\/\d{4}$/.test(dob))throw new FormError('Enter your date of birth as MM/DD/YYYY.');
  if(digits(form.elements.ssn_last4.value).length!==4)throw new FormError('Enter the last four digits of your SSN.');
  if(!panel.querySelector('[data-screening-consent]').checked)throw new FormError('Authorize the screening to continue.');
  return {consent:true,scenario:panel.querySelector('[data-scenario]').value};
}

// One click on any demo or step button. Local form problems show next to the
// form without a reload; anything that reached the Worker reloads the portal.
export async function handleTestAction(button,app,{api,types,reload,setError}) {
  const panel=button.closest('[data-test-panel]'),action=button.dataset.testAction,path=`/applications/${app.id}`;
  const post=(suffix,body)=>api(path+suffix,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const inline=panel.querySelector('[data-flow-error]'),status=panel.querySelector('[role=status]');
  if(inline){inline.hidden=true;inline.textContent='';}
  if(action==='fill-card'){panel.querySelector('[name=card_number]').value=CARDS[button.dataset.card];panel.querySelector('[name=card_name]').focus();return;}
  let body;
  try {
    if(action==='payment')body={outcome:paymentOutcome(panel)};
    if(action==='screening')body=screeningMaterials(panel);
  } catch(error) {
    if(!(error instanceof FormError))throw error;
    if(inline){inline.textContent=error.message;inline.hidden=false;}else setError(error.message);
    return;
  }
  panel.querySelectorAll('button').forEach(b=>b.disabled=true);
  if(status)status.textContent='Processing…';
  try {
    if(action==='payment')await post('/payment',body);
    else if(action==='screening')await post('/screening',body);
    else if(action==='refresh')await post('/refresh',{});
    else if(action==='documents') {
      const required=types.filter(t=>t.required && (!t.either || t.id==='job_offer_letter'));
      for(const type of required)for(let count=app.documents.filter(d=>d.doc_type===type.id).length;count<type.required;count++) {
        const form=new FormData();form.set('doc_type',type.id);form.set('file',samplePdf(type.id,app.id),`TEST-${type.id}-${count+1}.pdf`);
        await api(path+'/documents',{method:'POST',body:form});
      }
    }
    await reload();
  } catch(error) {
    await reload();
    setError(error.message);
  }
}
