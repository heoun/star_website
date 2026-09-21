import { requireConfig } from './supabase.js';
import { internalTestAccount, internalTestListing, internalTestRoommates } from '../backend/app/internal-testing.ts';
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
export async function saveRentalDraft(env,request,session,listingId,id,roommates,testId='') {
 if(!uuid.test(id || ''))throw fail('Start a new application before inviting roommates.',422);
 let test=null;
 if(testId){
  if(testId!==id || !internalTestAccount(env,request,session) || !internalTestListing(env,listingId))throw fail('Internal testing is unavailable for this account or listing.',403);
  if(roommates.some(m=>!internalTestRoommates(env).includes(m.email.toLowerCase())))throw fail('Internal test roommates are limited to the configured test inboxes.',422);
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
