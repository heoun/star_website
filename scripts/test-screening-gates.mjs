import assert from 'node:assert/strict';
import {createWorkspaceFixtures,ids} from '../backend/tools/workspace-fixtures.mjs';
import {reportFields,reportFixture} from '../backend/tools/screening-fixtures.mjs';
import {completeDemoState} from './demo-data.mjs';
import {seedRentalDemo,repairScreeningDemo,repairPaymentDemo} from './rental-demo-data.mjs';
import {makeRentalScreening} from '../backend/adapters/rental-screening/index.ts';
import {rentalWorkflow} from '../worker/rentals.js';
import {handleAdminRequest} from '../worker/admin.js';
const fixture=createWorkspaceFixtures();await completeDemoState(fixture.state);await seedRentalDemo(fixture.state);
const original=globalThis.fetch;globalThis.fetch=fixture.fetch;
const request=new Request('http://127.0.0.1/api/admin/cases');
const env={...fixture.env,RENTAL_AUTOMATION:'on',RENTAL_SCREENING:'external',LOCAL_EMAIL_SINK:{async send(m){fixture.state.emails.push(m);}}};
const admin={role:'manager',email:'admin@example.test'},flow=rentalWorkflow(env,request);
const root=()=>fixture.state.applications.find(a=>a.id===ids.b),members=()=>fixture.state.applications.filter(a=>a.rental_group_id===ids.b),mate=()=>members().find(a=>a.id!==ids.b);
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};const rejects=async fn=>{await assert.rejects(fn,e=>[403,409,422].includes(e.status));checks++;};
const reset=()=>{for(const a of members()){a.status='review';a.workspace={rental_flow:'automatic',terms:{'lease.commencement_date':'2026-10-01','lease.end_date':'2027-09-30','rent.monthly':'3000','deposit.amount':'3000'},checks:{fee:'paid',documents:'verified',screening:'received',reference:'A note is not a report'},invitations:[]};a.lease_snapshot=null;}fixture.state.emails=[];};
const record=(member,extra={})=>flow.execute(admin,ids.b,{action:'checks',version:root().workspace_version,member_id:member.id,fee:'paid',documents:'verified',screening:'received',reason:'External report reviewed; fee receipt verified',...reportFields(member.id),...extra});
const landlord=()=>{const email=root().workspace.recommendation.landlord_email;return {role:'landlord',email,property_ids:fixture.state.staff.find(s=>s.email===email).property_ids};};
const decide=()=>flow.execute(landlord(),ids.b,{action:'landlord_accept',version:root().workspace_version,revision:root().workspace.recommendation.revision});
try {
 reset();
 // Payment precedes screening, including direct adapter calls and external reports.
 root().workspace.checks.fee='pending';
 eq((await makeRentalScreening(true).check(root())).status,'pending');
 await flow.reconcile(ids.b);eq(root().workspace.screening_result,undefined);eq(fixture.state.emails.length,0);
 const unpaidWrites=fixture.writes.length;
 await rejects(()=>record(root(),{fee:'pending'}));
 await rejects(()=>record(root(),{fee:'pending',screening:'pending',credit_score:720}));
 eq(fixture.writes.length,unpaidWrites);
 reset();
 // A legacy boolean or numeric score without evidence cannot pass the group gate.
 root().workspace.checks.credit_score=750;
 await flow.reconcile(ids.b);eq(root().status,'review');eq(fixture.state.emails.length,0);
 eq((await flow.get(admin,ids.b)).household.summary[0].credit_score,null);
 const before=fixture.writes.length;
 for(const incomplete of [{report_reference:''},{report_url:''},{report_url:'javascript:alert(1)'},{report_url:'https://name:secret@reports.example.test/a'},{report_provider:''},{report_date:'2099-01-01'},{credit_score:''},{score_model:''}]) await rejects(()=>record(root(),incomplete));
 eq(fixture.writes.length,before);
 // No-score is a documented outcome, not a completed eligibility gate.
 await record(root(),{report_outcome:'no_score',credit_score:'',no_score_reason:'Provider returned an insufficient credit file.'});
 let view=await flow.get(admin,ids.b);eq(view.household.summary[0].report_status,'Needs review');eq(fixture.state.emails.length,0);
 await rejects(()=>record(root(),{report_outcome:'no_score',credit_score:'',no_score_reason:''}));
 // One complete member is insufficient, then all complete members cause exactly one packet.
 await record(root());eq(fixture.state.emails.length,0);eq(root().status,'review');
 const paidWrites=fixture.writes.length;
 await rejects(()=>record(root(),{fee:'pending',screening:'pending',credit_score:''}));
 eq(fixture.writes.length,paidWrites);eq(root().workspace.checks.fee,'paid');
 // Imported contradictory records are flagged, not displayed as a usable score.
 root().workspace.checks.fee='pending';
 view=await flow.get(admin,ids.b);eq(view.household.summary[0].credit_score,null);
 eq(view.household.summary[0].report_status,'Needs review');
 root().workspace.checks.fee='paid';
 await record(mate());eq(root().status,'sent_to_landlord');eq(fixture.state.emails.length,1);
 eq(root().workspace.recommendation.members.every(m=>m.credit_score===720 && m.report_status==='Complete'),true);
 // Revalidate even after a packet exists, including retries and stale email decisions.
 const report=structuredClone(mate().workspace.screening_result);
 mate().workspace.screening_result={status:'complete'};
 await rejects(decide);eq(root().status,'sent_to_landlord');
 eq((await flow.get(landlord(),ids.b)).progression_blocked,true);eq((await flow.get(landlord(),ids.b)).allowed_actions,[]);
 root().workspace.delivery.status='failed';await rejects(()=>flow.reconcile(ids.b));eq(fixture.state.emails.length,1);
 mate().workspace.screening_result={...report,application_id:root().id};await rejects(decide);
 mate().workspace.screening_result={...report,mock:true,source:'mock',reference:'mock/test'};await rejects(decide);
 mate().workspace.screening_result=report;
 await decide();eq(root().status,'landlord_approved');eq(root().workspace.lease_draft.missing,[]);
 // An old approved state never bypasses missing evidence at draft/signature endpoints.
 delete mate().workspace.screening_result;
 view=await flow.get(admin,ids.b);eq(view.progression_blocked,true);eq(view.allowed_actions.includes('reopen_review'),true);
 await rejects(()=>flow.execute(admin,ids.b,{action:'refresh_draft',version:root().workspace_version}));
 await rejects(()=>flow.execute(admin,ids.b,{action:'tenant_signed',version:root().workspace_version,member_id:root().id,reason:'Receipt'}));
 const http=await handleAdminRequest(new Request(`http://127.0.0.1/api/admin/lease/document/${ids.b}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'final'})}),env,{},`/api/admin/lease/document/${ids.b}`);eq(http.status,409);
 await flow.execute(admin,ids.b,{action:'reopen_review',version:root().workspace_version});eq(root().status,'review');eq(root().workspace.landlord_decision,undefined);eq(root().lease_snapshot,null);
 await record(mate());eq(root().status,'sent_to_landlord');await decide();eq(root().status,'landlord_approved');
 // A missing member document or unresolved roommate invitation also blocks a decision.
 reset();for(const a of members())a.workspace.screening_result=reportFixture(a.id);
 root().workspace.invitations=[{id:crypto.randomUUID(),name:'Invited applicant',email:'pending@example.test',expires:'2099-01-01'}];
 await flow.reconcile(ids.b);eq(fixture.state.emails.length,0);
 root().workspace.invitations=[];
 const docs=fixture.state.documents;fixture.state.documents=docs.filter(d=>d.application_id!==mate().id);
 await flow.reconcile(ids.b);eq(fixture.state.emails.length,0);fixture.state.documents=docs;
 await flow.reconcile(ids.b);eq(fixture.state.emails.length,1);
 // Legacy (automation-off) action endpoints also reject a plain received marker.
 env.RENTAL_AUTOMATION='off';const old=root();delete old.workspace.screening_result;
 const legacy=await handleAdminRequest(new Request(`http://127.0.0.1/api/admin/cases/${old.id}/actions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'landlord_accept',version:old.workspace_version})}),{...env,DEV_ADMIN_ROLE:'landlord',DEV_ADMIN_EMAIL:old.workspace.recommendation.landlord_email},{},`/api/admin/cases/${old.id}/actions`);eq(legacy.status,409);
 // Persisted mock approvals are repaired once, without inventing a score or dropping history.
 old.status='landlord_approved';old.workspace.landlord_decision={outcome:'accepted',at:'2026-09-09',revision:1};old.workspace.activity=[{action:'landlord_accept',at:'2026-09-09'}];
 delete fixture.state.rental_screening_seed;repairScreeningDemo(fixture.state);
 eq(old.status,'review');eq(old.workspace.screening_result,undefined);eq(old.workspace.demo_screening_status,'pending');eq(old.workspace.activity[0].action,'landlord_accept');
 const snapshot=JSON.stringify(fixture.state);repairScreeningDemo(fixture.state);eq(JSON.stringify(fixture.state),snapshot);
 const mock=structuredClone(mate());mock.workspace.screening_result=await makeRentalScreening(true).check(mock);delete mock.workspace.checks;
 const real=structuredClone(mock);real.id='real-report';real.workspace.screening_result=reportFixture(real.id);
 const repair={applications:[mock,real]};repairPaymentDemo(repair);
 eq(mock.workspace.checks.fee,'paid');eq(mock.workspace.checks.screening,'received');eq(mock.workspace.checks.credit_score,mock.workspace.screening_result.credit_score);
 eq(real.workspace.checks,undefined);
 const repaired=JSON.stringify(repair);repairPaymentDemo(repair);eq(JSON.stringify(repair),repaired);
 console.log(`PASS ${checks} screening gate checks: evidence, no-score, full group, stale packet, approval, draft/signature guards, legacy routes and persisted mock repair`);
}finally{globalThis.fetch=original;}
