import {normalizeDemoNames} from './demo-names.mjs';
// Dedicated synthetic household. Never imported by deployed code.
import { screeningIssue } from '../backend/app/rentals.ts';
import {reportEvidenceIssue} from '../backend/core/screening.ts';
import {ids} from '../backend/tools/workspace-fixtures.mjs';
import {completeDemoState} from './demo-data.mjs';
export async function seedRentalDemo(state) {
 for(const a of state.applications){a.rental_group_id ||= a.id;a.workspace ||= {};a.workspace.rental_flow='automatic';}
 if(state.rental_demo_seed){repairPaymentDemo(state);repairScreeningDemo(state);normalizeDemoNames(state);return;}
 const lead=state.applications.find(a=>a.id===ids.b);
 if(lead){
  lead.workspace={...lead.workspace,rental_flow:'automatic',checks:{fee:'paid',screening:'pending',documents:'verified',reference:'Mock fee receipt',by:'admin@example.test',at:new Date().toISOString()},invitations:[]};
  for(const key of ['recommendation','landlord_decision','lease_preparation','lease_draft','delivery','signature_receipts','tenant_signature','landlord_signature','signed_lease'])delete lead.workspace[key];
  lead.status='review';lead.lease_snapshot=null;lead.roommates=[];
  const mate={...structuredClone(lead),id:'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',rental_group_id:lead.id,name:'Applicant E',first_name:'Applicant',last_name:'E',email:'applicant-e@example.test',income_note:'85000',workspace:{rental_flow:'automatic',checks:{...lead.workspace.checks}},roommates:[],workspace_version:0};
  state.applications.push(mate);
 }
 for(const a of state.applications)if(a.id!==ids.b && a.rental_group_id===a.id && !['landlord_approved','lease_sent','lease_signed','declined'].includes(a.status)) {
  a.workspace.invitations=(a.roommates || []).filter(m=>m.email).map(m=>({id:crypto.randomUUID(),email:m.email,name:`${m.first_name} ${m.last_name}`,expires:new Date(Date.now()+14*86400000).toISOString(),delivery:'preview'}));
  if(a.workspace.invitations.length){delete a.workspace.recommendation;delete a.workspace.landlord_decision;a.status='review';}
 }
 await completeDemoState(state);
 state.rental_demo_seed=true;
 repairPaymentDemo(state);
 repairScreeningDemo(state);
 normalizeDemoNames(state);
}

// Old local snapshots generated reports independently of their payment/checks
// fixtures. Repair only verifiable synthetic reports; never infer real payment.
export function repairPaymentDemo(state) {
 if(state.rental_payment_seed===1)return;
 const now=new Date().toISOString();
 for(const a of state.applications){
  const w=a.workspace,s=w?.screening_result;
  if(!s?.mock || s.reference!==`mock/${a.id}` || reportEvidenceIssue(s,a.id,true))continue;
  if(['paid','waived'].includes(w.checks?.fee) && w.checks?.screening==='received' && w.checks?.credit_score===(s.credit_score ?? null))continue;
  w.checks={documents:'pending',...w.checks,fee:w.checks?.fee==='waived'?'waived':'paid',screening:'received',credit_score:s.credit_score ?? null,
   reference:w.checks?.reference || 'Mock payment completed before credit screening',by:w.checks?.by || 'demo-repair',at:w.checks?.at || s.date};
  w.activity=[...(w.activity || []),{action:'demo_repair',by:'demo-repair',at:now,detail:'Synchronized synthetic payment and report status: payment completed before this mock credit report.'}];
  a.workspace_version=(a.workspace_version || 0)+1;
 }
 state.rental_payment_seed=1;
}

// Versioned local-only repair: never manufacture a score to justify an old approval.
export function repairScreeningDemo(state) {
 if(state.rental_screening_seed===2)return;
 const now=new Date().toISOString();
 // Upgrade only identifiable provider-generated mock reports, retaining their
 // existing score/date. A received checkbox or free-text note never qualifies.
 for(const a of state.applications){const s=a.workspace?.screening_result;
  if(s?.mock===true && s.reference===`mock/${a.id}` && Number.isInteger(s.credit_score) && s.credit_score>=300 && s.credit_score<=850 && Number.isFinite(Date.parse(s.date)))
   Object.assign(s,{application_id:a.id,provider:'Mock screening provider',source:'mock',outcome:'scored'});
 }
 for(const root of state.applications.filter(a=>a.rental_group_id===a.id)) {
  const members=state.applications.filter(a=>a.rental_group_id===root.id);
  const invalid=members.filter(a=>screeningIssue(a,true));
  if(!invalid.length)continue;
  if(['sent_to_landlord','landlord_approved','lease_sent','lease_signed'].includes(root.status)) {
   const before=root.status,w=root.workspace;
   w.activity=[...(w.activity || []),{action:'request_info',by:'demo-repair',at:now,detail:`Mock scenario reset from ${before}: report evidence was incomplete. Previous decisions and signing events above are historical and no longer authorize progression.`}];
   for(const key of ['recommendation','landlord_decision','delivery','lease_preparation','lease_draft','tenant_signature','landlord_signature','signature_receipts','signed_lease','review'])delete w[key];
   root.status='review';root.lease_snapshot=null;root.workspace_version=(root.workspace_version || 0)+1;
   invalid.forEach(a=>a.workspace.demo_screening_status='pending');
  }
  for(const a of invalid){delete a.workspace.screening_result;if(a.workspace.checks){a.workspace.checks.screening='pending';delete a.workspace.checks.credit_score;}}
 }
 // A stable, inspectable missing-report example, rather than an impossible approved case.
 const casey=state.applications.find(a=>a.id===ids.a);
 if(casey && !casey.workspace.screening_result)casey.workspace.demo_screening_status='pending';
 state.rental_screening_seed=2;
}
