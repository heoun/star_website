// Dedicated synthetic household. Never imported by deployed code.
import {ids} from '../backend/tools/workspace-fixtures.mjs';
import {completeDemoState} from './demo-data.mjs';
export async function seedRentalDemo(state) {
 for(const a of state.applications){a.rental_group_id ||= a.id;a.workspace ||= {};a.workspace.rental_flow='automatic';}
 if(state.rental_demo_seed)return;
 const lead=state.applications.find(a=>a.id===ids.b);
 if(lead){
  lead.workspace={...lead.workspace,rental_flow:'automatic',checks:{fee:'paid',screening:'pending',documents:'verified',reference:'Mock fee receipt',by:'admin@example.test',at:new Date().toISOString()},invitations:[]};
  for(const key of ['recommendation','landlord_decision','lease_preparation','lease_draft','delivery','signature_receipts','tenant_signature','landlord_signature','signed_lease'])delete lead.workspace[key];
  lead.status='review';lead.lease_snapshot=null;lead.roommates=[];
  const mate={...structuredClone(lead),id:'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',rental_group_id:lead.id,name:'Morgan Example',first_name:'Morgan',last_name:'Example',email:'morgan.roommate@example.test',income_note:'85000',workspace:{rental_flow:'automatic',checks:{...lead.workspace.checks}},roommates:[],workspace_version:0};
  state.applications.push(mate);
 }
 for(const a of state.applications)if(a.id!==ids.b && a.rental_group_id===a.id && !['landlord_approved','lease_sent','lease_signed','declined'].includes(a.status)) {
  a.workspace.invitations=(a.roommates || []).filter(m=>m.email).map(m=>({id:crypto.randomUUID(),email:m.email,name:`${m.first_name} ${m.last_name}`,expires:new Date(Date.now()+14*86400000).toISOString(),delivery:'preview'}));
  if(a.workspace.invitations.length){delete a.workspace.recommendation;delete a.workspace.landlord_decision;a.status='review';}
 }
 await completeDemoState(state);
 state.rental_demo_seed=true;
}
