import assert from 'node:assert/strict';
import {createWorkspaceFixtures,ids} from '../backend/tools/workspace-fixtures.mjs';
import {completeDemoState} from './demo-data.mjs';
import {seedRentalDemo} from './rental-demo-data.mjs';
import {rentalWorkflow} from '../worker/rentals.js';
import {handleAdminRequest} from '../worker/admin.js';
const fixture=createWorkspaceFixtures();await completeDemoState(fixture.state);await seedRentalDemo(fixture.state);
const original=globalThis.fetch;globalThis.fetch=fixture.fetch;
const request=new Request('http://127.0.0.1:8792/api/admin/cases'),keys=new Set();
const env={...fixture.env,RENTAL_AUTOMATION:'on',RENTAL_SCREENING:'mock',LOCAL_EMAIL_SINK:{async send(m,key){if(!keys.has(key)){keys.add(key);fixture.state.emails.push(m);}}}};
const flow=rentalWorkflow(env,request),admin={role:'manager',email:'admin@example.test'},agent={role:'agent',email:'agent-b@example.test'},wrong={role:'agent',email:'agent-a@example.test'};
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};const rejects=async(fn,status)=>{await assert.rejects(fn,e=>e.status===status);checks++;};
try{
 const raw=()=>fixture.state.applications.find(a=>a.id===ids.b),mate=()=>fixture.state.applications.find(a=>a.rental_group_id===ids.b && a.id!==ids.b);
 eq((await flow.list(agent)).length,1);await rejects(()=>flow.get(wrong,ids.b),404);
 let row=await flow.get(admin,ids.b);eq(row.household.members.length,2);eq(row.allowed_actions.includes('review_and_recommend'),false);
 mate().workspace.checks.fee='pending';await flow.reconcile(ids.b);eq(fixture.state.emails.length,0);eq(raw().workspace.recommendation,undefined);
 row=await flow.get(admin,ids.b);
 await flow.execute(admin,ids.b,{action:'checks',version:row.workspace_version,member_id:mate().id,fee:'paid',screening:'received',documents:'verified',credit_score:728,score_model:'VantageScore 3.0',reason:'Mock external provider receipt'});
 eq(raw().status,'sent_to_landlord');eq(fixture.state.emails.length,1);eq(raw().workspace.recommendation.members.length,2);
 assert(fixture.state.emails[0].text.includes('728'));checks++;
 assert(fixture.state.emails[0].text.includes('Agree to proceed:'));checks++;
 assert(!fixture.state.emails[0].text.includes('ADMIN-ONLY'));checks++;
 await flow.reconcile(ids.b);eq(fixture.state.emails.length,1);
 const recipient=raw().workspace.recommendation.landlord_email,landlord=fixture.state.staff.find(s=>s.email===recipient);
 const owner={role:'landlord',email:recipient,property_ids:landlord.property_ids};
 row=await flow.get(owner,ids.b);eq(row.household,undefined);eq(row.recommendation.members[1].annual_income,'85000');
 for(const secret of ['ADMIN-ONLY','TEAM-ONLY','ssn_last4','ssn_encrypted','government_id']){assert(!JSON.stringify(row).includes(secret));checks++;}
 const version=row.workspace_version,revision=row.recommendation.revision;
 const writesBefore=fixture.writes.length;
 for(let i=0;i<2;i++)await flow.get(owner,ids.b);eq(fixture.writes.length,writesBefore);
 await rejects(()=>flow.execute(owner,ids.b,{action:'landlord_accept',version,revision:revision-1}),409);
 const accepted=await flow.execute(owner,ids.b,{action:'landlord_accept',version,revision});eq(accepted.status,'landlord_approved');
 eq(raw().workspace.lease_draft.missing,[]);assert(raw().lease_snapshot['tenant.names'].includes('Morgan Example'));checks++;
 await rejects(()=>flow.execute(owner,ids.b,{action:'landlord_accept',version,revision}),409);
 row=await flow.get(agent,ids.b);
 row=await flow.execute(agent,ids.b,{action:'tenant_signed',version:row.workspace_version,member_id:raw().id,reason:'Mock signed receipt A'});
 eq(row.status,'lease_sent');eq(row.allowed_actions.includes('record_landlord_signature'),false);
 row=await flow.execute(agent,ids.b,{action:'tenant_signed',version:row.workspace_version,member_id:mate().id,reason:'Mock signed receipt B'});
 eq(row.status,'lease_sent');eq(row.allowed_actions.includes('record_landlord_signature'),true);
 await rejects(()=>flow.invite(agent,ids.b,{version:row.workspace_version,name:'Late',email:'late@example.test'}),403);
 row=await flow.execute(agent,ids.b,{action:'record_landlord_signature',version:row.workspace_version,reason:'Mock owner receipt'});eq(!!row.workspace.landlord_signature,true);
 // Recipient choice and closed decisions are still denied through the real HTTP adapter.
 const response=await handleAdminRequest(new Request(`http://127.0.0.1/api/admin/cases/${ids.b}/actions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'review_and_recommend',version:row.workspace_version})}),env,{},`/api/admin/cases/${ids.b}/actions`);eq(response.status,403);
 // Independent applications remain separate until an authorized, explicit join.
 const fresh=createWorkspaceFixtures();await completeDemoState(fresh.state);
 Object.assign(fixture.state,fresh.state);
 for(const a of fixture.state.applications){a.rental_group_id=a.id;a.workspace.rental_flow='automatic';a.workspace.invitations=[];a.roommates=[];a.status='review';delete a.workspace.recommendation;}
 let lead=await flow.get(admin,ids.a),source=await flow.get(admin,ids.unassigned);
 await rejects(()=>flow.execute({role:'agent',email:'agent-a@example.test'},ids.a,{action:'merge',version:lead.workspace_version,application_id:source.id,source_version:source.workspace_version,confirmed:true}),404);
 await rejects(()=>flow.execute(admin,ids.a,{action:'merge',version:lead.workspace_version,application_id:source.id,source_version:source.workspace_version,confirmed:false}),422);
 let joined=await flow.execute(admin,ids.a,{action:'merge',version:lead.workspace_version,application_id:source.id,source_version:source.workspace_version,confirmed:true});
 eq(joined.household.members.length,2);eq(fixture.state.applications.find(a=>a.id===source.id).responsible_email,'agent-a@example.test');
 eq((await flow.list({role:'agent',email:'agent-a@example.test'})).filter(r=>r.id===source.id).length,0);
 await rejects(()=>flow.execute(admin,ids.a,{action:'checks',version:lead.workspace_version,fee:'paid',screening:'received',documents:'verified',reason:'Stale attempt'}),409);
 // Missing or unconfigured reports never become a fabricated production score.
 const realEnv={...env,RENTAL_SCREENING:'external'},realFlow=rentalWorkflow(realEnv,request);
 for(const a of fixture.state.applications.filter(a=>a.rental_group_id===ids.a)){a.workspace.checks={fee:'paid',screening:'pending',documents:'verified'};delete a.workspace.screening_result;}
 await realFlow.reconcile(ids.a);eq(fixture.state.applications.find(a=>a.id===ids.a).workspace.screening_result.status,'not_connected');eq(fixture.state.emails.length,0);
 // A failed outbound message remains visible and retries without another packet revision.
 let fail=true;env.LOCAL_EMAIL_SINK.send=async m=>{if(fail)throw new Error('Mock transport failure');fixture.state.emails.push(m);};
 const retryFlow=rentalWorkflow(env,request);await retryFlow.reconcile(ids.a);
 let groupRow=fixture.state.applications.find(a=>a.id===ids.a),packet=groupRow.workspace.recommendation;
 eq(groupRow.workspace.delivery.status,'failed');fail=false;await retryFlow.reconcile(ids.a);eq(groupRow.workspace.delivery.status,'preview');eq(groupRow.workspace.recommendation.revision,packet.revision);
 const groupOwner={role:'landlord',email:packet.landlord_email,property_ids:[ids.property]},before=await retryFlow.get(groupOwner,ids.a);
 await rejects(()=>retryFlow.get({...groupOwner,property_ids:[]},ids.a),404);
 const declined=await retryFlow.execute(groupOwner,ids.a,{action:'landlord_decline',version:before.workspace_version,revision:packet.revision,reason:'Mock decision'});
 eq(declined.status,'declined');eq(groupRow.lease_snapshot,null);eq((await retryFlow.get(groupOwner,ids.a)).landlord_decision.outcome,'declined');
 await rejects(()=>retryFlow.execute(admin,ids.a,{action:'checks',member_id:source.id,version:groupRow.workspace_version,fee:'paid',screening:'received',documents:'verified',reason:'Closed edit'}),403);
 let invitationRow=await retryFlow.get(admin,ids.b);
 await retryFlow.invite(admin,ids.b,{version:invitationRow.workspace_version,name:'Optional roommate',email:'optional@example.test'});
 invitationRow=await retryFlow.get(admin,ids.b);eq(invitationRow.household.invitations.length,1);
 invitationRow=await retryFlow.execute(admin,ids.b,{action:'cancel_invite',version:invitationRow.workspace_version,invitation_id:invitationRow.household.invitations[0].id,confirmed:true});eq(invitationRow.household.invitations.length,0);
 console.log(`PASS ${checks} rental workflow checks: whole-group readiness, role isolation, automatic email, repeat delivery, safe reads, decision revision, complete multi-tenant lease, ordered signatures`);
}finally{globalThis.fetch=original;}
