import {verifyLandlordDecisionToken} from './landlord-decision-token.js';
import {rentalMode,rentalWorkflow} from './rentals.js';
import {sameOriginMutation,readSession} from './auth.js';
import {resolveStaff} from './staff.js';
import {accountSecurityEnabled} from './account-security.js';
import {fetchBuilding} from './supabase.js';
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
const fail=(message,status)=>{throw Object.assign(new Error(message),{status});};
async function readBody(request) {
  if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) fail('Send the confirmation as JSON.',415);
  const reader=request.body?.getReader(),chunks=[];let size=0;
  if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();fail('The confirmation is too large.',413);}chunks.push(value);}
  try {return JSON.parse(await new Blob(chunks).text());} catch {fail('Invalid confirmation.',400);}
}
export async function handleLandlordDecision(request,env) {
  if(!rentalMode(env))return json({error:'This decision request is unavailable.'},404);
  if(!['GET','POST'].includes(request.method))return json({error:'Method not allowed.'},405);
  if(!sameOriginMutation(request))return json({error:'Confirm your decision on this website.'},403);
  try {
    const token=request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
    const claims=await verifyLandlordDecisionToken(env,request.url,token);
    let authenticated;
    if(accountSecurityEnabled(env)){
      const session=await readSession(request,env,'workspace');
      if(!session)fail('Sign in with your landlord account to review this request.',401);
      const resolved=await resolveStaff(env,session);
      if(!resolved.identity || resolved.identity.role!=='landlord' || resolved.identity.onboarding_pending || resolved.identity.email!==claims.email)fail('This request requires the assigned landlord account.',403);
      authenticated=resolved.identity;
    }
    const flow=rentalWorkflow(env,request),g=await flow.store.group(claims.id),r=g?.root.workspace?.recommendation;
    if(!g || g.root.id!==claims.id || g.root.workspace?.rental_flow!=='automatic' || !r || r.revision!==claims.revision || r.landlord_email.toLowerCase()!==claims.email)
      fail('This email is out of date. Open the latest decision request.',409);
    const staff=(await flow.store.staff()).find(s=>s.active && s.role==='landlord' && s.email.toLowerCase()===claims.email && s.property_ids?.includes(g.root.listings?.building_id));
    if(!staff)fail('This decision link is no longer authorized. Contact the leasing team.',403);
    const building=await fetchBuilding(env,g.root.listings.building_id);
    if(building?.landlord_signer_email && building.landlord_signer_email.toLowerCase()!==claims.email)
      fail('The landlord for this property has changed. Contact the leasing team.',403);
    const principal=authenticated || {role:'landlord',email:claims.email,property_ids:staff.property_ids};
    const view=await flow.get(principal,claims.id);
    // Link scanners and ordinary page loads may read this summary, never decide.
    if(request.method==='GET')return json({case:view});
    const body=await readBody(request);
    if(!body || !['accept','decline'].includes(body.outcome) || body.confirmed!==true || !Number.isSafeInteger(body.version) ||
      (body.reason!==undefined && (typeof body.reason!=='string' || body.reason.length>2000)))fail('Confirm a valid decision.',422);
    const prior=g.root.workspace.landlord_decision;
    if(prior){
      if(prior.revision===claims.revision && prior.outcome===(body.outcome==='accept'?'accepted':'declined'))return json({case:view,recorded:true});
      fail('A decision is already recorded. Contact the leasing team to change it.',409);
    }
    const result=await flow.execute(principal,claims.id,{action:body.outcome==='accept'?'landlord_accept':'landlord_decline',
      revision:claims.revision,version:body.version,reason:body.reason || ''});
    return json({case:result,recorded:true});
  } catch(e) {
    const status=Number.isInteger(e.status) ? e.status : 503;
    return json({error:status>=500?'The decision could not be saved right now. Please try again.':e.message},status);
  }
}
