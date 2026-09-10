import assert from 'node:assert/strict';
import {handleAdminRequest} from '../worker/admin.js';
import {createWorkspaceFixtures,ids} from '../backend/tools/workspace-fixtures.mjs';
import {completeDemoState,DEMO_ENCRYPTION_KEY} from './demo-data.mjs';

const fixture=createWorkspaceFixtures();
await completeDemoState(fixture.state);
fixture.env.APP_ENCRYPTION_KEY=DEMO_ENCRYPTION_KEY;
const realFetch=globalThis.fetch;
globalThis.fetch=fixture.fetch;
const mail=[];
fixture.env.LOCAL_EMAIL_SINK={send:async message=>mail.push(message)};
const actors={admin:['manager','admin@example.test'],a:['agent','agent-a@example.test'],b:['agent','agent-b@example.test'],owner:['landlord','owner@example.test']};
const row=id=>fixture.state.applications.find(a=>a.id===id);
const terms={'lease.commencement_date':'2026-10-01','lease.end_date':'2027-09-30','rent.monthly':'3100','deposit.amount':'0','rent.due_day':'1','concession.terms':'None'};
const payload={action:'review_and_recommend',confirmed:true,fee:'paid',screening:'received',documents:'verified',credit_score:'720',reason:'Synthetic report REF-123 reviewed',terms,landlord_email:'owner@example.test'};
let count=0;
const eq=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);count++;};
async function call(actor,id,body,method='POST',suffix='/actions') {
 const [role,email]=actors[actor];
 const request=new Request(`http://localhost/api/admin/cases/${id}${suffix}`,{method,...(method==='POST'?{headers:{'Content-Type':'application/json'},body:JSON.stringify({version:row(id).workspace_version,...body})}:{})});
 const response=await handleAdminRequest(request,{...fixture.env,DEV_ADMIN_ROLE:role,DEV_ADMIN_EMAIL:email},{waitUntil:p=>p.catch(()=>{})},new URL(request.url).pathname);
 return {status:response.status,body:await response.json()};
}
async function rejected(actor,id,patch,status=422) {
 const before=structuredClone(row(id)),emails=mail.length;
 const result=await call(actor,id,{...payload,...patch});
 eq(result.status,status,JSON.stringify(result.body));eq(row(id),before,'failed confirmation is atomic');eq(mail.length,emails,'no email on failure');
}
try {
 row(ids.a).status='new';row(ids.a).workspace={admin_note:'ADMIN-ONLY'};
 await rejected('b',ids.a,{},404);
 await rejected('owner',ids.a,{},404);
 await rejected('a',ids.a,{confirmed:false});
 await rejected('a',ids.a,{screening:'pending'});
 await rejected('a',ids.a,{documents:'pending'});
 await rejected('a',ids.a,{reason:''});
 await rejected('a',ids.a,{credit_score:'900'});
 await rejected('a',ids.a,{terms:{...terms,'deposit.amount':''}});
 await rejected('a',ids.a,{terms:{...terms,'lease.end_date':'2025-01-01'}});
 await rejected('a',ids.a,{terms:{...terms,'landlord.entity_name':'injected'}},403);
 await rejected('a',ids.a,{landlord_email:'agent-b@example.test'});
 await rejected('a',ids.a,{landlord_email:''}); // Two bound landlords: no arbitrary choice.
 const docs=fixture.state.documents;
 fixture.state.documents=docs.filter(d=>d.application_id!==ids.a);
 await rejected('a',ids.a,{});
 fixture.state.documents=docs;
 const version=row(ids.a).workspace_version;
 const sent=await call('a',ids.a,payload);
 eq(sent.status,200,JSON.stringify(sent.body));eq(sent.body.notified,true);
 eq(row(ids.a).status,'sent_to_landlord');eq(row(ids.a).workspace_version,version+1,'one database version for the whole review');
 eq(row(ids.a).workspace.review.by,'agent-a@example.test');eq(row(ids.a).workspace.recommendation.terms,terms);
 eq(row(ids.a).workspace.recommendation.summary.credit_score,720);
 eq(row(ids.a).workspace.activity.slice(-4).map(a=>a.action),['checks','terms','approve','review_and_recommend']);
 eq(JSON.stringify(sent.body).includes('ADMIN-ONLY'),false);
 await rejected('a',ids.a,{version},409); // Retry cannot duplicate a send.
 const landlord=await call('owner',ids.a,null,'GET','');
 eq(landlord.status,200);eq('workspace' in landlord.body.case,false);eq('application_documents' in landlord.body.case,false);
 eq(landlord.body.case.recommendation.terms,terms);
 eq((await call('owner',ids.a,{action:'landlord_accept'})).status,200);
 eq(row(ids.a).status,'landlord_approved');
 const leaseRequest=new Request(`http://localhost/api/admin/lease/document/${ids.a}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'values'})});
 const leaseResponse=await handleAdminRequest(leaseRequest,{...fixture.env,DEV_ADMIN_ROLE:'agent',DEV_ADMIN_EMAIL:'agent-a@example.test'},{waitUntil:p=>p.catch(()=>{})},new URL(leaseRequest.url).pathname);
 eq(leaseResponse.status,200);
 const lease=await leaseResponse.json();
 eq(lease.values['rent.monthly'],'3100','lease inherits the agreed rent');
 eq(lease.values['deposit.amount'],'0','zero deposit is preserved');
 eq(lease.missing,[],'lease resolves all required fields without a second entry form');
 eq((await call('a',ids.a,null,'GET','')).body.case.allowed_actions.includes('prepare_lease'),true);
 await rejected('a',ids.a,{},403);
 // An Admin reviewing an unassigned application owns it on successful send.
 row(ids.unassigned).status='new';row(ids.unassigned).responsible_email=null;row(ids.unassigned).workspace={};
 fixture.state.staff.find(s=>s.email==='other-owner@example.test').property_ids=[];
 const admin=await call('admin',ids.unassigned,{...payload,landlord_email:''});
 eq(admin.status,200,JSON.stringify(admin.body));eq(row(ids.unassigned).responsible_email,'admin@example.test');
 eq(row(ids.unassigned).workspace.recommendation.landlord_email,'owner@example.test','single linked landlord automatically selected');
 // Failure to notify leaves the saved recommendation visible, without claiming email success.
 row(ids.b).status='new';row(ids.b).workspace={};
 fixture.env.LOCAL_EMAIL_SINK={send:async()=>{throw new Error('Synthetic email failure');}};
 const ownerB=fixture.state.staff.find(s=>s.role==='landlord'&&s.property_ids.includes(ids.otherProperty));
 const failedEmail=await call('b',ids.b,{...payload,landlord_email:ownerB.email});
 eq(failedEmail.status,200,JSON.stringify(failedEmail.body));eq(failedEmail.body.notified,false);eq(row(ids.b).status,'sent_to_landlord');
 console.log(`PASS ${count} review checks: atomic save, missing evidence, roles, recipients, stale retries, shared snapshot and landlord confirmation`);
} finally {globalThis.fetch=realFetch;}
