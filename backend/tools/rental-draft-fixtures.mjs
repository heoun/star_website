// HTTP-fixture counterpart. Transaction/permission invariants are tested against
// the real PostgreSQL migration in scripts/test-rental-drafts.mjs.
export function rentalDraftFixture(state,table,body,query,response) {
 state.rental_drafts ||= [];
 if(table==='rental_drafts')return response(state.rental_drafts.filter(d=>!query.has('id') || `eq.${d.id}`===query.get('id')));
 if(!['save_rental_draft','submit_draft_application','record_draft_invite_delivery'].includes(table))return null;
 const id=body.p_group || body.p_id,root=state.applications.find(a=>a.id===id && a.rental_group_id===id);
 let draft=state.rental_drafts.find(d=>d.id===id);
 const failed=()=>response({error:'Invalid or closed invitation'},409);
 const invitation=(email,name,role)=>({id:crypto.randomUUID(),email,name,delivery:role?'sent':'pending',expires:new Date(Date.now()+14*86400000).toISOString(),...(role?{role}:{})});
 if(table==='save_rental_draft'){
  if(!draft){if(state.applications.some(a=>a.id===id))return failed();draft={id,listing_id:body.p_listing,owner_id:body.p_owner,owner_email:body.p_email,invitations:[invitation(body.p_email,body.p_email,'inviter')],test_run:body.p_test,activated:false};}
  if(draft.owner_id!==body.p_owner || draft.owner_email!==body.p_email || draft.listing_id!==body.p_listing)return failed();
  if(draft.activated && (!root || ['sent_to_landlord','landlord_approved','lease_sent','lease_signed','declined'].includes(root.status)))return failed();
  const entries=structuredClone(root?.workspace.invitations || draft.invitations);
  if(!entries.some(i=>i.role==='inviter' && !i.accepted))return failed();
  for(const mate of body.p_roommates){if(mate.email===body.p_email)return failed();if(!entries.some(i=>i.email===mate.email))entries.push(invitation(mate.email,mate.name));}
  const cap=Math.max(1,Math.min(5,state.listings.find(l=>l.id===body.p_listing)?.bedrooms ?? 2));
  if(entries.length>cap)return failed();
  draft.invitations=entries;if(root){root.workspace.invitations=structuredClone(entries);root.workspace_version++;}
  if(!state.rental_drafts.includes(draft))state.rental_drafts.push(draft);
  return response(draft);
 }
 if(!draft || (draft.activated && !root))return failed();
 const entries=root?.workspace.invitations || draft.invitations;
 if(table==='record_draft_invite_delivery'){
  entries.forEach(i=>{if(body.p_sent.includes(i.email))i.delivery='sent';});draft.invitations=structuredClone(entries);return response(true);
 }
 const values=body.p_application,i=entries.find(i=>i.email===values.email && (!body.p_invite || i.id===body.p_invite));
 if(!i || draft.listing_id!==values.listing_id || (i.role==='inviter' && body.p_actor!==draft.owner_id))return failed();
 if(i.accepted){const prior=state.applications.find(a=>a.id===i.accepted && a.rental_group_id===id);return prior?response({application:prior,replayed:true}):failed();}
 if(Date.parse(i.expires)<Date.now() || ['sent_to_landlord','landlord_approved','lease_sent','lease_signed','declined'].includes(root?.status))return failed();
 if(!draft.test_run && state.applications.some(a=>a.email===values.email && a.listing_id===values.listing_id && a.status!=='declined'))return failed();
 if(root && i.role==='inviter' && !root.responsible_email && values.responsible_email)state.applications.filter(a=>a.rental_group_id===id).forEach(a=>{a.responsible_email=values.responsible_email;a.workspace_version++;});
 const appId=draft.activated?crypto.randomUUID():id;i.accepted=appId;
 const row={...values,id:appId,rental_group_id:id,status:'new',workspace_version:0,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),collaborator_emails:root?.collaborator_emails || [],responsible_email:root?.responsible_email || values.responsible_email || null,workspace:{...values.workspace,invitations:root?[]:structuredClone(entries),...(draft.test_run?{test_run:{...draft.test_run,member_of:id}}:{})}};
 state.applications.push(row);if(root)root.workspace_version++;draft.activated=true;draft.invitations=structuredClone(entries);
 return response({application:row,replayed:false});
}
