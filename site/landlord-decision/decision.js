const host=document.querySelector('#decision'),params=new URLSearchParams(location.hash.slice(1));
const id=params.get('id'),revision=Number(params.get('revision')),token=params.get('token');
let choice=params.get('choice');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=token?'/api/landlord-decision':`/api/admin/cases/${id}`;
const options=()=>({credentials:token?'omit':'same-origin',headers:token?{Authorization:`Bearer ${token}`}:{}});
function recorded(decision){
 host.innerHTML=`<div class="success"><h1>Decision recorded</h1><p>${decision.outcome==='accepted'?'You agreed to proceed. The leasing team can now prepare and review the lease.':'You chose not to proceed.'}</p><p>Your decision has been saved in the leasing team’s workspace. You can close this page.</p></div>`;
}
function signIn(wrong=false){
 host.innerHTML=`<h1>${wrong?'Landlord Account Required':'Confirm Your Rental Decision'}</h1><p>${wrong?'This older link requires the landlord account. Sign in with the email this invitation was sent to, or ask the leasing team for a new secure email link.':'Sign in with the landlord email this summary was sent to. New secure email links do not require sign-in.'}</p><a class="button" href="/login/?return=${encodeURIComponent(location.pathname+location.hash)}">Sign In to Continue</a>`;
}
function render(row){
 const r=row.recommendation;
 if(!r || r.revision!==revision){host.innerHTML='<h1>This email is out of date</h1><p>The application group or terms have changed. Open the latest email to decide.</p>';return;}
 if(row.progression_blocked){host.innerHTML='<h1>Application review on hold</h1><p>The leasing team needs to resolve missing information before this application can progress.</p>';return;}
 if(row.landlord_decision){recorded(row.landlord_decision);return;}
 if(!row.allowed_actions?.includes('landlord_accept')){host.innerHTML='<h1>This request is no longer available</h1><p>Contact the leasing team for an updated decision request.</p>';return;}
 const selected=['accept','decline'].includes(choice),declining=choice==='decline',t=r.terms || {};
 host.innerHTML=`<h1>${selected?(declining?'Confirm Do Not Proceed':'Confirm Agreement to Proceed'):'Review Rental Application'}</h1>
 <p>${token?'No sign-in is needed. Your decision is saved only after you confirm below.':'Review the application and confirm your decision below.'}</p>
 <section><h2>${esc(r.tenant_name)}</h2><p>${esc(row.listings?.title)} · Unit ${esc(row.listings?.unit)}</p><b>Monthly rent: $${esc(t['rent.monthly'])}</b><p>Lease: ${esc(t['lease.commencement_date'])} to ${esc(t['lease.end_date'])}<br>Security deposit: $${esc(t['deposit.amount'])}</p>${t['concession.terms']?`<p>Concessions: ${esc(t['concession.terms'])}</p>`:''}</section>
 <details class="applicant-details" ${choice==='details'?'open':''}><summary>Applicant Summary</summary><div class="people">${(r.members || []).map(m=>`<section><h2>${esc(m.name)}</h2><small>Credit score ${m.mock?'(mock)':''}</small><b class="score">${esc(m.credit_score ?? 'No score returned')}</b><small>${esc(m.score_model)} · ${esc(m.report_date?.slice(0,10))}</small><p>Annual income: <b>${esc(m.annual_income || 'Not stated')}</b><br><small>${esc(m.income_source)}</small></p><p>${esc(m.employment)}</p><small>Report: ${esc(m.report_status)}</small></section>`).join('')}</div></details>
 <form><h2>${selected?(declining?'You selected: Do Not Proceed':'You selected: Agree to Proceed'):'Your Decision'}</h2><p>${declining?'This will mark the application as not proceeding and share your reason with the leasing team.':'Agreeing approves these applicants and the displayed terms for lease preparation. It does not sign the lease.'}</p><label>${declining?'Reason for Not Proceeding':selected?'Comment (optional)':'Comment (required if not proceeding)'}<textarea name="reason" maxlength="2000" rows="3" ${declining?'required':''}></textarea></label>
 ${selected?`<button name="outcome" value="${choice}">${declining?'Confirm Do Not Proceed':'Confirm Agree to Proceed'}</button><button type="button" class="secondary" data-change>Change Decision</button>`:'<button name="outcome" value="accept">Agree to proceed</button><button class="secondary" name="outcome" value="decline">Do not proceed</button>'}
 <p role="status"></p></form>`;
 host.querySelector('[data-change]')?.addEventListener('click',()=>{choice='details';render(row);});
 host.querySelector('form').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget,outcome=event.submitter?.value,reason=form.elements.reason.value.trim(),status=form.querySelector('[role=status]');
  if(!['accept','decline'].includes(outcome))return;
  if(outcome==='decline' && !reason){status.textContent='Add a reason for the leasing team.';form.elements.reason.focus();return;}
  form.querySelectorAll('button').forEach(b=>b.disabled=true);status.textContent='Saving your decision…';
  try{
   const opts=options();const res=await fetch(token?api:api+'/actions',{...opts,method:'POST',headers:{...opts.headers,'Content-Type':'application/json'},body:JSON.stringify(token?{outcome,confirmed:true,version:row.workspace_version,reason}:{action:outcome==='accept'?'landlord_accept':'landlord_decline',revision,version:row.workspace_version,reason})});
   const body=await res.json();if(!res.ok)throw new Error(body.error || 'Your decision could not be saved.');
   recorded(body.case?.landlord_decision || {outcome:outcome==='accept'?'accepted':'declined'});
  }catch(e){status.textContent=e.message;form.querySelectorAll('button').forEach(b=>b.disabled=false);}
 };
}
async function start(){
 if(!/^[0-9a-f-]{36}$/i.test(id || '') || !Number.isInteger(revision) || revision<1){host.textContent='This link is invalid.';return;}
 if(!token){const account=await fetch('/api/auth/workspace/me',{credentials:'same-origin'});if(account.status===401){signIn();return;}}
 const response=await fetch(api,options()),data=await response.json();
 if(!token && [401,403].includes(response.status)){signIn(response.status===403);return;}
 if(!response.ok)throw new Error(data.error || 'This rental is unavailable.');
 render(data.case);
}
start().catch(e=>{host.innerHTML=`<h1>Unable to Open This Request</h1><p class="error">${esc(e.message)}</p>`;});
