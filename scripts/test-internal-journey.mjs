import assert from 'node:assert/strict';
import http from 'node:http';
import worker from '../worker/index.js';
import {simulatorHandler} from './screening-simulator.mjs';
import {createIdentityFixture} from './identity-fixtures.mjs';
import {completeDemoState,DEMO_ENCRYPTION_KEY} from './demo-data.mjs';
import {ids} from '../backend/tools/workspace-fixtures.mjs';
import {rentalWorkflow} from '../worker/rentals.js';
import {invitedTestRun} from '../worker/internal-testing.js';
const nativeFetch=globalThis.fetch;
let providerState={},clock=Date.now()-60000;
const server=http.createServer(simulatorHandler({token:'test-only-secret',read:()=>structuredClone(providerState),save:s=>{providerState=s;},now:()=>clock}));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const identity=createIdentityFixture(),{fixture,env,user,restore}=identity;
await completeDemoState(fixture.state);
const account=user('internal@example.test'),other=user('other@example.test');
Object.assign(env,{APP_ENCRYPTION_KEY:DEMO_ENCRYPTION_KEY,RENTAL_AUTOMATION:'on',RENTAL_SCREENING:'external',INTERNAL_TESTING:'on',INTERNAL_TEST_DATABASE_HOST:new URL(env.SUPABASE_URL).hostname,INTERNAL_TEST_USER_ID:account.id,INTERNAL_TEST_EMAIL:account.email,INTERNAL_TEST_LISTING_IDS:ids.listing,DOCUSIGN_ENVIRONMENT:'demo',SCREENING_SIMULATOR_URL:origin,SCREENING_SIMULATOR_TOKEN:'test-only-secret',LOCAL_EMAIL_SINK:{async send(m){fixture.state.emails.push(m);}}});
const baseFetch=globalThis.fetch;
globalThis.fetch=async(input,init={})=>{
 const u=new URL(input);
 if(u.origin===origin)return nativeFetch(input,init);
 // Match the database's primary-key/ON CONFLICT behavior, not the old fixture
 // RPC which intentionally forbids a second normal application per listing.
 if(u.pathname==='/rest/v1/applications' && init.method==='POST'){
  const b=JSON.parse(init.body),existing=fixture.state.applications.find(a=>a.id===b.id);
  if(existing)return Response.json([]);
  const row={workspace_version:0,created_at:new Date().toISOString(),collaborator_emails:[],application_documents:[],...b};fixture.state.applications.push(row);return Response.json([row]);
 }
 return baseFetch(input,init);
};
const pending=[];let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const call=(path,body,cookie='',host='http://127.0.0.1')=>worker.fetch(new Request(host+path,{method:body?'POST':'GET',headers:{Cookie:cookie,...(!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})}),env,{waitUntil:p=>pending.push(p)});
const flush=async()=>{await Promise.all(pending.splice(0));};
const login=async(email)=>{const r=await call('/api/auth/login',{email,password:'testing-password'});eq(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
try {
 const cookie=await login(account.email),wrong=await login(other.email);
 eq((await(await call('/api/apply/options?id='+ids.listing,null,cookie)).json()).internal_testing,true);
 eq((await(await call('/api/apply/options?id='+ids.listing,null,wrong)).json()).internal_testing,false);
 eq((await(await call('/api/apply/options?id='+ids.listing,null,cookie,'https://example.com')).json()).internal_testing,false);
 const payload={...fixture.state.applications[0],listing_id:ids.listing,id_number:'TEST123456',id_type:'passport',roommates:[],sales_person:'',first_name:'Internal',last_name:'Applicant'};
 const submit=async(id,c=cookie)=>{const r=await call('/api/apply',{...payload,test_run_id:id},c);await flush();return r;};
 const id=crypto.randomUUID();eq((await submit(id,wrong)).status,403);
 let r=await submit(id);eq(r.status,201);eq((await r.json()).application_id,id);
 eq((await submit(id)).status,200);eq(fixture.state.applications.filter(a=>a.id===id).length,1);
 const second=crypto.randomUUID();eq((await submit(second)).status,201);eq(fixture.state.applications.filter(a=>a.email===account.email).length,2);
 const action=async(id,kind,body={})=>{const r=await call(`/api/portal/applications/${id}/${kind}`,body,cookie);await flush();return r;};
 eq((await call(`/api/portal/applications/${id}/payment`,{outcome:'paid'},wrong)).status,403);
 eq((await action(id,'screening',{consent:true,scenario:'scored'})).status,409);
 eq((await action(id,'payment',{outcome:'failed'})).status,200);
 eq(fixture.state.applications.find(a=>a.id===id).workspace.checks.fee,'pending');
 eq((await action(id,'payment',{outcome:'paid'})).status,200);
 const payment=fixture.state.applications.find(a=>a.id===id).workspace.test_payment.id;
 eq((await action(id,'payment',{outcome:'paid'})).status,200);eq(fixture.state.applications.find(a=>a.id===id).workspace.test_payment.id,payment);
 eq((await action(id,'screening',{consent:true,scenario:'scored'})).status,409);
 const materials=async(id,applicantCookie=cookie)=>{
  for(const [type,count] of [['government_id_front',1],['government_id_back',1],['job_offer_letter',1],['bank_statement',2]])for(let i=0;i<count;i++){
   const form=new FormData();form.set('doc_type',type);form.set('file',new Blob(['%PDF-1.4 INTERNAL TEST ONLY'],{type:'application/pdf'}),`test-${type}-${i}.pdf`);
   const r=await call(`/api/portal/applications/${id}/documents`,form,applicantCookie);if(r.status!==201)console.error(await r.clone().text());eq(r.status,201);await flush();
  }
 };
 await materials(id);
 eq((await action(id,'screening',{consent:false,scenario:'scored'})).status,422);
 eq((await action(id,'screening',{consent:true,scenario:'scored'})).status,200);
 eq(fixture.state.applications.find(a=>a.id===id).workspace.screening_result.status,'pending');
 const landlordMail=()=>fixture.state.emails.filter(m=>m.subject.includes('Application ready'));
 eq(landlordMail().length,0);
 clock+=6000;await action(id,'refresh');
 let row=fixture.state.applications.find(a=>a.id===id);eq(row.workspace.screening_result.status,'complete');eq(row.status,'sent_to_landlord');eq(landlordMail().length,1);
 await action(id,'refresh');eq(landlordMail().length,1);
 eq(fixture.state.applications.find(a=>a.id===second).workspace.screening_result,undefined);
 const flow=rentalWorkflow(env,new Request('http://127.0.0.1')),owner=fixture.state.staff.find(s=>s.email===row.workspace.recommendation.landlord_email);
 const landlord={role:'landlord',email:owner.email,property_ids:owner.property_ids};
 await assert.rejects(()=>flow.execute(landlord,id,{action:'landlord_accept',revision:0,version:row.workspace_version}),e=>e.status===409);checks++;
 const approved=await flow.execute(landlord,id,{action:'landlord_accept',revision:row.workspace.recommendation.revision,version:row.workspace_version});eq(approved.status,'landlord_approved');eq(row.workspace.lease_draft.missing,[]);eq(row.lease_snapshot['tenant.names'],'Internal Applicant');
 eq((await action(id,'payment',{outcome:'failed'})).status,409);
 for(const scenario of ['no_score','failed']){
  const run=crypto.randomUUID();eq((await submit(run)).status,201);await action(run,'payment',{outcome:'paid'});await materials(run);await action(run,'screening',{consent:true,scenario});clock+=6000;await action(run,'refresh');
  const blocked=fixture.state.applications.find(a=>a.id===run);eq(blocked.workspace.recommendation,undefined);eq(blocked.workspace.screening_result.status,scenario==='failed'?'failed':'complete');eq(landlordMail().length,1);
 }
 const portal=await(await call('/api/portal/applications',null,cookie)).json();eq(portal.internal_testing,true);eq(portal.applications.filter(a=>a.test_run).length,4);assert(!JSON.stringify(portal).includes('ssn_encrypted'));checks++;
 if(process.argv.includes('--ui')){const {runJourneyBrowser}=await import('./journey-browser-checks.mjs');await runJourneyBrowser({env,fixture,pending,advance:()=>{clock+=6000;}});}
 // Roommates in internal runs: allowlisted inboxes only, the home's capacity,
 // invitations that wait for the lead's fee, and joining without the link.
 const mate=user('roommate@example.test'),early=user('early-roommate@example.test'),stranger=user('stranger@example.test');
 env.INTERNAL_TEST_ROOMMATE_EMAILS=`${mate.email}, ${early.email}`;
 const mateCookie=await login(mate.email),earlyCookie=await login(early.email);
 const roommate=(email,name)=>({first_name:name,last_name:'Roommate',phone:'2125550199',email});
 const mailTo=email=>fixture.state.emails.filter(m=>JSON.stringify(m.to || '').includes(email) && /invit/i.test(m.subject || ''));
 const lead=crypto.randomUUID();
 // The early email binds this test run even before the lead submits it.
 r=await call('/api/apply/invite',{listing_id:ids.listing,test_run_id:lead,roommates:[roommate(mate.email,'Mate')]},cookie);eq(r.status,200);
 const earlyMail=mailTo(mate.email).at(-1),earlyLink=new URL(earlyMail.text.match(/http[^\s]+\/apply\/\?[^\s]+/)[0]);
 eq(earlyLink.searchParams.get('group'),lead);eq(earlyLink.searchParams.get('invited'),mate.email);
 assert(earlyMail.html.includes(earlyLink.href.replaceAll('&','&amp;')));checks++;
 // The early invitation is durable and authorizes this specific account.
 const earlyOptions=async(c=mateCookie,extra=`group=${lead}`,host='http://127.0.0.1')=>(await call(`/api/apply/options?id=${ids.listing}&${extra}`,null,c,host)).json();
 eq((await earlyOptions()).internal_test_group,lead);eq((await earlyOptions()).internal_test_pending,true);
 eq((await earlyOptions()).internal_testing,false);
 eq((await earlyOptions(wrong)).internal_test_group,null);
 eq((await earlyOptions(cookie)).internal_test_group,null);
 eq((await earlyOptions(mateCookie,'group=invalid')).internal_test_group,null);
 eq((await earlyOptions(mateCookie,`invite=${lead}.${crypto.randomUUID()}`)).internal_test_group,null);
 eq((await earlyOptions(mateCookie,`group=${lead}`,'https://example.com')).internal_test_group,null);
 eq((await invitedTestRun(env,new Request('http://127.0.0.1'),{subject:mate.id,email:mate.email},ids.listing,'',lead)).id,lead);
 r=await call('/api/apply',{...payload,group_root:lead},wrong);eq(r.status,409);
 eq(fixture.state.applications.some(a=>a.email===mate.email),false);
 fixture.state.emails.splice(fixture.state.emails.indexOf(earlyMail),1);
 eq((await call('/api/apply',{...payload,test_run_id:lead,roommates:[roommate(stranger.email,'Stranger')]},cookie)).status,422);
 eq((await call('/api/apply',{...payload,test_run_id:lead,roommates:[roommate(mate.email,'Mate'),roommate(early.email,'Early')]},cookie)).status,422);
 r=await call('/api/apply',{...payload,test_run_id:lead,roommates:[roommate(mate.email,'Mate')]},cookie);await flush();eq(r.status,201);
 let leadRow=fixture.state.applications.find(a=>a.id===lead);
 const inviteOptions=(c=mateCookie,extra=`group=${lead}`,host='http://127.0.0.1')=>call(`/api/apply/options?id=${ids.listing}&${extra}`,null,c,host).then(r=>r.json());
 const inviteToken=`${lead}.${leadRow.workspace.invitations.find(i=>i.email===mate.email).id}`;
 eq((await inviteOptions()).internal_test_group,lead);
 eq((await inviteOptions()).internal_test_pending,false);
 eq((await inviteOptions()).internal_testing,false);
 eq((await inviteOptions(mateCookie,`invite=${inviteToken}`)).internal_test_group,lead);
 eq((await inviteOptions(wrong)).internal_test_group,null);
 eq((await inviteOptions(cookie)).internal_test_group,null);
 eq((await inviteOptions(mateCookie,`invite=${lead}.${crypto.randomUUID()}`)).internal_test_group,null);
 eq((await inviteOptions(mateCookie,`group=${lead}`,'https://example.com')).internal_test_group,null);
 eq((await inviteOptions(mateCookie,'')).internal_test_group,null);
 eq(leadRow.workspace.invitations.filter(i=>!i.role).map(i=>[i.email,i.delivery]),[[mate.email,'sent']]);eq(mailTo(mate.email).length,0);
 eq((await action(lead,'payment',{outcome:'paid'})).status,200);
 leadRow=fixture.state.applications.find(a=>a.id===lead);eq(['sent','preview'].includes(leadRow.workspace.invitations.find(i=>i.email===mate.email).delivery),true);eq(mailTo(mate.email).length,0);
 // Multiple test cases can invite the same inbox. A generic link must not
 // silently pick the first one; the early email selects the exact run.
 const competing=crypto.randomUUID();
 r=await call('/api/apply',{...payload,test_run_id:competing,roommates:[roommate(mate.email,'Mate')]},cookie);await flush();eq(r.status,201);
 const matePayload={...payload,roommates:[]};delete matePayload.test_run_id;
 r=await call('/api/apply',matePayload,mateCookie);eq(r.status,409);
 r=await call('/api/apply',{...matePayload,group_root:crypto.randomUUID()},mateCookie);eq(r.status,409);
 r=await call('/api/apply',{...matePayload,group_root:earlyLink.searchParams.get('group'),invited_email:mate.email},mateCookie);eq(r.status,201);
 const mateResult=await r.json();eq(mateResult.test_run_id,mateResult.application_id);
 // The immediate portal read must expose the simulator, before waitUntil runs.
 const immediatePortal=await(await call('/api/portal/applications',null,mateCookie)).json();
 eq(immediatePortal.applications.find(a=>a.id===mateResult.application_id).test_run.id,lead);
 await flush();
 const mateRow=fixture.state.applications.find(a=>a.email===mate.email && a.listing_id===ids.listing);
 eq(mateRow.rental_group_id,lead);eq(mateRow.workspace.test_run.member_of,lead);
 eq(fixture.state.applications.find(a=>a.id===competing).workspace.invitations[0].accepted,undefined);
 eq(fixture.state.applications.find(a=>a.id===lead).workspace.invitations.find(i=>i.email===mate.email).accepted,mateRow.id);
 eq((await call(`/api/portal/applications/${mateRow.id}/payment`,{outcome:'paid'},mateCookie)).status,200);await flush();
 eq(fixture.state.applications.find(a=>a.id===mateRow.id).workspace.checks.fee,'paid');
 eq((await(await call('/api/portal/applications',null,mateCookie)).json()).internal_testing,true);
 eq((await call(`/api/portal/applications/${mateRow.id}/payment`,{outcome:'paid'},wrong)).status,403);
 eq((await inviteOptions()).internal_test_group,null);
 eq((await call(`/api/portal/applications/${mateRow.id}/screening`,{consent:true,scenario:'scored'},mateCookie)).status,409);
 await materials(mateRow.id,mateCookie);
 eq((await call(`/api/portal/applications/${mateRow.id}/screening`,{consent:false,scenario:'scored'},mateCookie)).status,422);
 eq((await call(`/api/portal/applications/${mateRow.id}/screening`,{consent:true,scenario:'scored'},mateCookie)).status,200);await flush();
 clock+=6000;
 eq((await call(`/api/portal/applications/${mateRow.id}/refresh`,{},mateCookie)).status,200);await flush();
 eq(fixture.state.applications.find(a=>a.id===mateRow.id).workspace.screening_result.status,'complete');
 eq(fixture.state.applications.find(a=>a.id===lead).workspace.test_screening,undefined);
 // A roommate who applied first is adopted when the lead names them, and an
 // invitation the form already emailed is not sent again.
 r=await call('/api/apply',matePayload,earlyCookie);await flush();eq(r.status,201);
 const earlyRow=()=>fixture.state.applications.find(a=>a.email===early.email && a.listing_id===ids.listing);
 eq(earlyRow().rental_group_id,earlyRow().id);
 const lead2=crypto.randomUUID();
 r=await call('/api/apply',{...payload,test_run_id:lead2,roommates:[roommate(early.email,'Early')],invited_emails:[early.email]},cookie);await flush();eq(r.status,201);
 eq(earlyRow().rental_group_id,lead2);eq(earlyRow().workspace.test_run.member_of,lead2);
 const lead2Row=fixture.state.applications.find(a=>a.id===lead2);eq(lead2Row.workspace.invitations[0].accepted,earlyRow().id);eq(lead2Row.workspace.invitations[0].delivery,'sent');
 eq((await action(lead2,'payment',{outcome:'paid'})).status,200);eq(mailTo(early.email).length,0);
 // Roommate submits and completes their checks while the inviter is still
 // filling out the form. Neither checks nor retries create a second case.
 const ahead=user('ahead@example.test');env.INTERNAL_TEST_ROOMMATE_EMAILS+=`,${ahead.email}`;
 const aheadCookie=await login(ahead.email),aheadGroup=crypto.randomUUID();
 r=await call('/api/apply/invite',{listing_id:ids.listing,test_run_id:aheadGroup,roommates:[roommate(ahead.email,'Ahead')]},cookie);eq(r.status,200);
 r=await call('/api/apply',{...matePayload,group_root:aheadGroup,invited_email:ahead.email},aheadCookie);eq(r.status,201);
 const aheadId=(await r.json()).application_id;eq(aheadId,aheadGroup);await flush();
 const aheadRoot=()=>fixture.state.applications.find(a=>a.id===aheadGroup);
 eq(aheadRoot().workspace.invitations.find(i=>i.role==='inviter').accepted,undefined);
 eq((await call(`/api/portal/applications/${aheadId}/payment`,{outcome:'paid'},aheadCookie)).status,200);await flush();
 await materials(aheadId,aheadCookie);
 eq((await call(`/api/portal/applications/${aheadId}/screening`,{consent:true,scenario:'scored'},aheadCookie)).status,200);await flush();clock+=6000;
 eq((await call(`/api/portal/applications/${aheadId}/refresh`,{},aheadCookie)).status,200);await flush();
 eq(aheadRoot().workspace.screening_result.status,'complete');eq(aheadRoot().workspace.recommendation,undefined);
 r=await call('/api/apply',{...matePayload,group_root:aheadGroup,invited_email:ahead.email},aheadCookie);eq(r.status,200);eq((await r.json()).application_id,aheadId);
 r=await call('/api/apply',{...payload,test_run_id:aheadGroup,roommates:[roommate(ahead.email,'Ahead')]},cookie);eq(r.status,201);
 const laterId=(await r.json()).application_id;assert.notEqual(laterId,aheadId);checks++;await flush();
 eq(fixture.state.applications.find(a=>a.id===laterId).rental_group_id,aheadGroup);
 eq(aheadRoot().workspace.invitations.every(i=>!!i.accepted),true);
 eq(fixture.state.applications.filter(a=>a.rental_group_id===aheadGroup).length,2);
 eq((await call(`/api/portal/applications/${laterId}/payment`,{outcome:'paid'},cookie)).status,200);await flush();
 env.INTERNAL_TESTING='off';eq((await action(second,'payment',{outcome:'paid'})).status,403);
 eq((await inviteOptions(earlyCookie,`group=${lead2}`)).internal_test_group,null);
 eq((await(await call('/api/apply/options?id='+ids.listing,null,cookie)).json()).internal_testing,false);
 // The same durable invitations work with internal testing disabled.
 const ordinary=user('ordinary@example.test'),ordinaryMate=user('ordinary-mate@example.test');
 const ordinaryCookie=await login(ordinary.email),ordinaryMateCookie=await login(ordinaryMate.email),ordinaryGroup=crypto.randomUUID();
 r=await call('/api/apply/invite',{listing_id:ids.listing,draft_group_id:ordinaryGroup,roommates:[roommate(ordinaryMate.email,'Ordinary')]},ordinaryCookie);eq(r.status,200);
 const ordinaryLink=new URL(mailTo(ordinaryMate.email).at(-1).text.match(/http[^\s]+\/apply\/\?[^\s]+/)[0]);
 eq(ordinaryLink.searchParams.get('group'),ordinaryGroup);
 r=await call('/api/apply',{...matePayload,group_root:ordinaryGroup,group_invite:ordinaryLink.searchParams.get('invite'),invited_email:ordinaryMate.email},ordinaryMateCookie);eq(r.status,201);await flush();
 eq(fixture.state.applications.find(a=>a.id===ordinaryGroup).workspace.test_run,undefined);
 r=await call('/api/apply',{...payload,draft_group_id:ordinaryGroup,roommates:[roommate(ordinaryMate.email,'Ordinary')]},ordinaryCookie);eq(r.status,201);await flush();
 eq(fixture.state.applications.filter(a=>a.rental_group_id===ordinaryGroup).length,2);
 eq(fixture.state.applications.find(a=>a.id===ordinaryGroup).workspace.invitations.every(i=>i.accepted),true);
 console.log(`PASS ${checks} internal journey checks: authenticated repeat runs, idempotent intake/payment, HTTP provider processing, required materials/consent, real rental reconciliation, one landlord packet, approval/draft, no-score/failure holds, roommate invitations and joining, production and account isolation.`);
} finally {await Promise.allSettled(pending);restore();server.closeAllConnections();await new Promise(r=>server.close(r));}
