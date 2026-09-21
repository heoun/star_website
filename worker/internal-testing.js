import { internalTestAccount,internalTestListing,internalTestRoommates,internalTestParticipant } from '../backend/app/internal-testing.ts';
import { rentalDraft } from './rental-drafts.js';
import { requireConfig } from './supabase.js';
import { rentalWorkflow } from './rentals.js';
export { internalTestAccount,internalTestListing,internalTestRoommates,internalTestParticipant };
// A saved invitation exposes the same test controls before or after the first
// application exists. Unknown browser group IDs never grant membership.
export async function invitedTestContext(env,request,session,listingId,invitation='',rootId='') {
  if(!internalTestParticipant(env,request,session) || !internalTestListing(env,listingId))return null;
  const parts=String(invitation).split('.'),root=rootId || parts[0];
  if(!/^[0-9a-f-]{36}$/i.test(root || '') || (invitation && (parts.length!==2 || parts[0]!==root)))return null;
  const group=await rentalWorkflow(env,request).store.group(root);
  if(!group) {
    const draft=await rentalDraft(env,root);
    const match=draft?.test_run && draft.listing_id===listingId && !draft.activated && draft.invitations.some(i=>!i.accepted && i.email===session.email.toLowerCase() && (i.role!=='inviter' || draft.owner_id===session.subject) && Date.parse(i.expires)>=Date.now() && (!invitation || i.id===parts[1]));
    return match ? {pendingGroup:root,run:{id:draft.test_run.id,created_at:draft.test_run.created_at,member_of:root}} : null;
  }
  const run=group?.root.workspace?.test_run;
  if(!run || group.root.id!==root || group.root.listing_id!==listingId || ['sent_to_landlord','landlord_approved','lease_sent','lease_signed','declined'].includes(group.root.status))return null;
  const match=group.root.workspace.invitations?.some(i=>!i.accepted && i.email===session.email.toLowerCase() && Date.parse(i.expires)>=Date.now() && (!invitation || i.id===parts[1]));
  return match ? {run:{id:run.id,created_at:run.created_at,member_of:root}} : null;
}
export async function invitedTestRun(env,request,session,listingId,invitation='',rootId='') {
  return (await invitedTestContext(env,request,session,listingId,invitation,rootId))?.run || null;
}
export async function submitTestApplication(request,env,session,values,runId) {
  if(!internalTestAccount(env,request,session) || !internalTestListing(env,values.listing_id))throw Object.assign(new Error('Internal testing is unavailable for this account or listing.'),{status:403});
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId))throw Object.assign(new Error('Start a new test run from the application form.'),{status:422});
  const inboxes=internalTestRoommates(env);
  if((values.roommates || []).some(m=>!inboxes.includes(String(m.email || '').toLowerCase())))throw Object.assign(new Error('Internal test roommates are limited to the configured test inboxes.'),{status:422});
  const {url,key}=requireConfig(env),headers={apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
  // A retried submit has the same primary key; each new run has a fresh one.
  const response=await fetch(`${url}/rest/v1/applications?on_conflict=id`,{method:'POST',headers:{...headers,Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify({...values,id:runId,rental_group_id:runId,status:'new',workspace:{...values.workspace,test_run:{id:runId,account_id:session.subject,created_at:new Date().toISOString()}}}),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Object.assign(new Error('Test application could not be saved.'),{status:503});
  const inserted=await response.json();if(inserted.length)return {application:inserted[0],replayed:false};
  const lookup=await fetch(`${url}/rest/v1/applications?id=eq.${runId}&select=id,email,listing_id,workspace,rental_group_id`,{headers,signal:AbortSignal.timeout(10000)});
  if(!lookup.ok)throw Object.assign(new Error('Test application could not be recovered.'),{status:503});
  const [prior]=await lookup.json();
  if(prior?.email!==session.email || prior?.listing_id!==values.listing_id || prior?.workspace?.test_run?.account_id!==session.subject)throw Object.assign(new Error('This run ID is already in use. Start a new test run.'),{status:409});
  return {application:prior,replayed:true};
}
// Roommates who join an internal run inherit it, so the portal offers them the
// same simulated payment and screening. Only allowlisted inboxes ever join one.
export async function markTestMembers(env,request,rootId) {
  const g=await rentalWorkflow(env,request).store.group(rootId);
  const run=g?.root.workspace?.test_run;if(!run)return;
  const inboxes=internalTestRoommates(env),{url,key}=requireConfig(env),headers={apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
  for(const m of g.members)if(m.id!==g.root.id && !m.workspace?.test_run && inboxes.includes(String(m.email || '').toLowerCase())){
    const response=await fetch(`${url}/rest/v1/applications?id=eq.${m.id}`,{method:'PATCH',headers,body:JSON.stringify({workspace:{...m.workspace,test_run:{id:run.id,created_at:run.created_at,member_of:g.root.id}}}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)console.error('Test member marking requires retry',m.id);
  }
}
