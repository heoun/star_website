import { requireConfig } from './supabase.js';
import { internalTestParticipant, internalTestListing } from '../backend/app/internal-testing.ts';
import { internalTestInboxes } from './internal-testing.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
async function database(env,path,body) {
 const {url,key}=requireConfig(env);
 const response=await fetch(`${url}/rest/v1/${path}`,{headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw fail(response.status===409?'This invitation changed, expired, or the group is full. Reopen the invitation or contact your agent.':'Application invitations are temporarily unavailable. Please try again.',response.status===409?409:503);
 return response.json();
}
export async function rentalDraft(env,id) {
 if(!uuid.test(id || ''))return null;
 return (await database(env,`rental_drafts?id=eq.${id}&select=*`))[0] || null;
}
// A draft belongs to its authenticated creator even when a roommate is the
// first person to submit. Never expose the roommate's application to its owner.
export async function pendingOwnedApplications(env,session) {
 const email=String(session?.email || '').toLowerCase();
 if(!session?.subject || !email)return [];
 const cards=[];
 for(let offset=0;;offset+=100){
  const query=new URLSearchParams({owner_id:`eq.${session.subject}`,owner_email:`eq.${email}`,select:'id,listing_id,owner_id,owner_email,invitations,activated,created_at,listings(title,property_name,unit,location)',order:'created_at.desc,id.desc',limit:'100',offset:String(offset)});
  const drafts=await database(env,`rental_drafts?${query}`);
  const owned=drafts.filter(d=>d.owner_id===session.subject && d.owner_email===email && uuid.test(d.id) && uuid.test(d.listing_id));
  const active=owned.filter(d=>d.activated).map(d=>d.id);
  const roots=active.length?await database(env,`applications?${new URLSearchParams({id:`in.(${active.join(',')})`,select:'id,listing_id,rental_group_id,status,workspace'})}`):[];
  for(const draft of owned){
   const root=roots.find(r=>r.id===draft.id && r.rental_group_id===draft.id && r.listing_id===draft.listing_id);
   // Live case invitations take precedence: a canceled or removed membership
   // must not reappear from the original draft's saved invitation list.
   if(draft.activated && (!root || ['sent_to_landlord','landlord_approved','lease_sent','lease_signed','declined'].includes(root.status)))continue;
   const entries=(draft.activated?root.workspace?.invitations:draft.invitations) || [];
   const invitation=entries.find(i=>i.role==='inviter' && i.email===email && !i.accepted && uuid.test(i.id) && Date.parse(i.expires)>=Date.now());
   if(!invitation)continue;
   const listing=draft.listings || {};
   cards.push({group_id:draft.id,listing_id:draft.listing_id,created_at:draft.created_at,
    listing:{title:listing.title,property_name:listing.property_name,unit:listing.unit,location:listing.location},
    submitted_count:entries.filter(i=>i.accepted).length,
    continue_url:`/apply/?${new URLSearchParams({id:draft.listing_id,group:draft.id,invited:email,invite:`${draft.id}.${invitation.id}`})}`});
  }
  if(drafts.length<100)break;
 }
 return cards;
}
export async function saveRentalDraft(env,request,session,listingId,id,roommates,testId='') {
 if(!uuid.test(id || ''))throw fail('Start a new application before inviting roommates.',422);
 let test=null;
 if(testId){
  if(testId!==id || !internalTestParticipant(env,request,session) || !internalTestListing(env,listingId))throw fail('Internal testing is unavailable for this account or listing.',403);
  if(roommates.some(m=>!internalTestInboxes(env).includes(m.email.toLowerCase())))throw fail('Internal test roommates are limited to the configured test inboxes.',422);
  test={id,account_id:session.subject,created_at:new Date().toISOString()};
 }
 return database(env,'rpc/save_rental_draft',{p_id:id,p_listing:listingId,p_owner:session.subject,p_email:session.email,p_roommates:roommates.map(m=>({email:m.email.toLowerCase(),name:`${m.first_name} ${m.last_name}`.trim()})),p_test:test});
}
export async function submitDraftApplication(env,session,values,draft,token='') {
 const parts=token.split('.');
 if(token && (parts.length!==2 || parts[0]!==draft.id || !uuid.test(parts[1])))throw fail('This invitation link is invalid.',422);
 return database(env,'rpc/submit_draft_application',{p_group:draft.id,p_actor:session.subject,p_application:values,p_invite:token?parts[1]:null});
}

export const recordDraftDelivery=(env,id,sent)=>database(env,'rpc/record_draft_invite_delivery',{p_group:id,p_sent:sent});
