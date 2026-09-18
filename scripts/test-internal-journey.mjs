import assert from 'node:assert/strict';
import http from 'node:http';
import worker from '../worker/index.js';
import {simulatorHandler} from './screening-simulator.mjs';
import {createIdentityFixture} from './identity-fixtures.mjs';
import {completeDemoState,DEMO_ENCRYPTION_KEY} from './demo-data.mjs';
import {ids} from '../backend/tools/workspace-fixtures.mjs';
import {rentalWorkflow} from '../worker/rentals.js';
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
 const materials=async(id)=>{
  for(const [type,count] of [['government_id_front',1],['government_id_back',1],['job_offer_letter',1],['bank_statement',2]])for(let i=0;i<count;i++){
   const form=new FormData();form.set('doc_type',type);form.set('file',new Blob(['%PDF-1.4 INTERNAL TEST ONLY'],{type:'application/pdf'}),`test-${type}-${i}.pdf`);
   const r=await call(`/api/portal/applications/${id}/documents`,form,cookie);if(r.status!==201)console.error(await r.clone().text());eq(r.status,201);await flush();
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
 env.INTERNAL_TESTING='off';eq((await action(second,'payment',{outcome:'paid'})).status,403);
 eq((await(await call('/api/apply/options?id='+ids.listing,null,cookie)).json()).internal_testing,false);
 console.log(`PASS ${checks} internal journey checks: authenticated repeat runs, idempotent intake/payment, HTTP provider processing, required materials/consent, real rental reconciliation, one landlord packet, approval/draft, no-score/failure holds, production and account isolation.`);
} finally {await Promise.allSettled(pending);restore();server.closeAllConnections();await new Promise(r=>server.close(r));}
