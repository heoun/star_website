import { internalTestAccount,internalTestListing } from '../backend/app/internal-testing.ts';
import { requireConfig } from './supabase.js';
export { internalTestAccount,internalTestListing };
export async function submitTestApplication(request,env,session,values,runId) {
  if(!internalTestAccount(env,request,session) || !internalTestListing(env,values.listing_id))throw Object.assign(new Error('Internal testing is unavailable for this account or listing.'),{status:403});
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId))throw Object.assign(new Error('Start a new test run from the application form.'),{status:422});
  if(values.roommates?.length)throw Object.assign(new Error('This test setup supports the designated tenant only.'),{status:422});
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
