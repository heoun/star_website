import assert from 'node:assert/strict';
import {createWorkspaceFixtures} from '../backend/tools/workspace-fixtures.mjs';
import {completeDemoState} from './demo-data.mjs';import {seedRentalDemo} from './rental-demo-data.mjs';
import {seedJourney,JOURNEY_SCENARIOS} from './demo-journey.mjs';import {rentalWorkflow} from '../worker/rentals.js';
import {screeningIssue} from '../backend/core/screening.ts';
const f=createWorkspaceFixtures();await completeDemoState(f.state);await seedRentalDemo(f.state);const saved=globalThis.fetch;globalThis.fetch=f.fetch;
const env={...f.env,RENTAL_AUTOMATION:'on',RENTAL_SCREENING:'mock',LOCAL_EMAIL_SINK:{async send(m,k){if(!f.state.emails.some(e=>e.demo_key===k))f.state.emails.push({...m,demo_key:k});}}};
const request=new Request('http://127.0.0.1:8792/'),admin={role:'manager',email:'admin@example.test'};
try{
 const prior=new Set(f.state.applications.map(a=>a.id));await seedJourney(f.state,env,request);
 assert.equal(f.state.demo_journey.scenarios.length,JOURNEY_SCENARIOS.length);
 const flow=rentalWorkflow(env,request);
 for(const s of f.state.demo_journey.scenarios){
  const raw=f.state.applications.find(a=>a.id===s.id),view=await flow.get(admin,s.id),members=view.household.members;
  assert(f.state.listings.find(l=>l.id===raw.listing_id).published);
  for(const m of members){assert.equal(m.workspace.checks.fee,'paid');if(m.workspace.screening_result?.credit_score)assert.equal(screeningIssue(m,true),'');}
  if(['unassigned','documents','group-report','no-score'].includes(s.key)){assert(view.household.issues.length);assert.equal(raw.workspace.recommendation,undefined);}
  if(s.key==='unassigned'){assert.equal(raw.responsible_email,null);assert.equal(view.next_step.label,'Assign a Responsible Agent');}
  if(s.key==='documents')assert(view.household.issues.some(i=>/bank/i.test(i)),JSON.stringify(view.household.issues));
  if(s.key==='landlord')assert.equal(raw.status,'sent_to_landlord');
  if(s.key==='declined'){assert.equal(raw.status,'declined');assert.equal(raw.lease_snapshot,null);}
  if(s.key==='draft'){assert(raw.lease_snapshot);assert.equal(raw.workspace.lease_draft.missing.length,0);}
  if(s.key==='missing-default'){assert.equal(raw.status,'landlord_approved');assert(raw.workspace.lease_draft.missing.includes('deposit.bank_address'));assert(!raw.workspace.lease_preparation);}
  if(s.key==='partial-signatures'){assert.equal(Object.keys(raw.workspace.signature_receipts).length,1);assert(!view.allowed_actions.includes('record_landlord_signature'));}
  if(s.key==='landlord-signature')assert(view.allowed_actions.includes('record_landlord_signature'));
  if(s.key==='archive')assert(view.allowed_actions.includes('archive_lease'));
  if(s.key==='completed'){assert.equal(raw.status,'lease_signed');assert(f.state.files[raw.workspace.signed_lease.path].length>1000);}
  console.log('PASS',s.key,raw.name,raw.status);
 }
 for(const id of prior)assert(f.state.applications.some(a=>a.id===id));
 const emails=f.state.applications.map(a=>a.email);assert.equal(new Set(emails).size,emails.length);
 const before=JSON.stringify(f.state);await seedJourney(f.state,env,request);assert.equal(JSON.stringify(f.state),before);
 await completeDemoState(f.state);
 for(const s of f.state.demo_journey.scenarios)await flow.reconcile(s.id);
 assert((await flow.get(admin,f.state.demo_journey.scenarios.find(s=>s.key==='documents').id)).household.issues.some(i=>/bank/i.test(i)));
 assert.equal(f.state.demo_journey.scenarios.length,12);
 console.log('PASS journey publication, report/payment gates, signatures, archive, preserved existing apps, unique emails and restart-safe seeds.');
}finally{globalThis.fetch=saved;}
