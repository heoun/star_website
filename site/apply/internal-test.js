// Optional UI helper. It fills the real form; normal validation and submission
// remain in charge. No production page loads this module without authorization.
export function attachTestApplication(form,listingId,{groupId=null,pending=false}={}) {
  const key=`star-internal-run:${listingId}`;
  const runId=groupId || sessionStorage.getItem(key) || crypto.randomUUID();
  if(!groupId)sessionStorage.setItem(key,runId);
  const panel=document.createElement('aside');panel.className='internal-test-tools';
  panel.innerHTML='<strong>Internal Test Application</strong><p>Each new run creates a separate application. Payment and screening are simulated; landlord emails and DocuSign invitations are real test deliveries.</p><small data-run></small><div class="test-actions"><button type="button" data-fill>Fill With Sample Data</button> <button type="button" data-new>Start New Test Run</button></div><p role="status"></p>';
  if(groupId){panel.querySelector('strong').textContent='Internal Test Group Application';panel.querySelector('p').textContent='Your application joins the existing case. Fill your own sample answers, then continue to simulated payment and credit screening after submitting.';panel.querySelector('[data-new]').remove();}
  if(groupId && pending)panel.querySelector('p').textContent='Fill your own sample answers now. You can submit before the inviter. Everyone joins the same case and completes their own simulated payment and credit screening. The group waits for all applications before landlord review.';
  form.closest('.app-shell').before(panel);
  const paint=()=>panel.querySelector('[data-run]').textContent=`Run ${runId}`;paint();
  if(!groupId)panel.querySelector('[data-new]').onclick=()=>{sessionStorage.removeItem(key);location.reload();};
  function set(input,value){if(!input)return;if(input instanceof RadioNodeList){input.value=value;input=[...input].find(i=>i.checked);}else input.value=value;input?.dispatchEvent(new Event('input',{bubbles:true}));input?.dispatchEvent(new Event('change',{bubbles:true}));}
  panel.querySelector('[data-fill]').onclick=()=>{
    const n=crypto.getRandomValues(new Uint32Array(1))[0]%9000+1000;
    const date=new Date();date.setUTCMonth(date.getUTCMonth()+1,1);
    // Use realistic synthetic recipient names in DocuSign and rider titles.
    // Keep the test run ID in metadata rather than appending it to the name.
    // Roommates the tester already answered stay as entered: an invitation may
    // have gone out from that step, and clearing it would drop them from the case.
    const answered=String(form.elements.has_roommates?.value || '')!=='';
    const values={...(answered ? {} : {has_roommates:'no'}),first_name:['Avery','Jordan','Morgan','Riley','Casey'][n%5],last_name:['Bennett','Carter','Hayes','Reyes','Sullivan','Walsh','Nakamura'][n%7],phone:'2125550100',dob:'1994-04-15',id_type:'passport',id_number:`TEST${n}XX`,address_street:`${n} Example Test Street`,address_unit:'2A',address_city:'New York',address_state:'NY',address_zip:'10001',move_in:date.toISOString().slice(0,10),lease_term_months:'12',employment_status:'employed',employer:'Example Test Company',employer_position:'Product Analyst',employer_start:'06/2021',income_note:String(140000+n),supervisor_name:'Test Supervisor',supervisor_phone:'2125550110',supervisor_email:'supervisor@example.test',children_under_11:'no',has_pets:'no',message:`Internal test run ${runId}. Synthetic application data.`};
    Object.entries(values).forEach(([name,v])=>set(form.elements[name],v));
    const groups={rental:{landlord_name:'Prior Test Landlord',contact:'Test Property Manager',address:'10 Example Previous Street, New York, NY 10001',landlord_phone:'2125550111',landlord_email:'prior-landlord@example.test',start:'08/2022',monthly_rent:'2500'},references:{name:'Test Reference',relationship:'Colleague',phone:'2125550112',email:'reference@example.test'},emergency:{name:'Test Emergency Contact',relationship:'Friend',phone:'2125550113',email:'emergency@example.test'}};
    Object.entries(groups).forEach(([group,fields])=>form.querySelectorAll(`#rep-${group} > .repeat-card`).forEach((card,index)=>Object.entries(fields).forEach(([field,v])=>set(card.querySelector(`[data-field="${field}"]`),field==='name'?`${v} ${index+1}`:v))));
    form.elements.consent.checked=false;
    panel.querySelector('[role=status]').textContent=`Sample answers filled. Review all ${groupId?'six':'seven'} steps and confirm the application yourself.`;
  };
  return {id:()=>groupId?undefined:runId,complete:()=>{if(!groupId)sessionStorage.removeItem(key);panel.remove();}};
}
