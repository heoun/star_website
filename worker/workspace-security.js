import {authRequest,readSession,signedIn,sameOriginMutation,validPassword,workspaceRoleCookie} from './auth.js';
import {identityRpc,recentMfa,auditIdentity} from './account-security.js';
import {resolveStaff} from './staff.js';
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function handleWorkspaceSecurity(request,env,resource) {
  if(request.method!=='POST'||!sameOriginMutation(request))return json({error:'Use this website to submit the form.'},403);
  let session;
  try {
    if(!request.headers.get('Content-Type')?.startsWith('application/json'))return json({error:'JSON required.'},415);
    const reader=request.body?.getReader();let text='',size=0;const decoder=new TextDecoder();
    if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();return json({error:'Form too large.'},413);}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();
    const body=JSON.parse(text);
    session=await readSession(request,env,'workspace');
    if(!session)return json({error:'Please sign in.'},401);
    const resolved=await resolveStaff(env,{...session,workspaceRole:'owner'},{allowPending:true});
    if(!resolved.identity)return json({error:resolved.error},403);
    const identity=resolved.identity;
    if(identity.access_state==='invited')return json({error:'Accept your invitation first.'},403);
    let response;
    if(resource==='security') {
      response=json({email:identity.email,setup_password:identity.has_password===false,mfa_required:identity.role==='manager',verified:session.aal==='aal2',factors:session.factors,
        owner_account:identity.is_owner===true,admin_enabled:identity.admin_enabled===true,owner_version:identity.version,onboarding_pending:identity.onboarding_pending===true});
    } else if(resource==='setup-password') {
      if(identity.has_password!==false)return json({error:'This account already has a password. Use password reset to change it.'},409);
      if(!validPassword(body.password))return json({error:'Choose a password of at least 8 characters.'},422);
      const result=await authRequest(env,'user',{method:'PUT',token:session.token,body:{password:body.password}});
      if(!result.ok)return json({error:'Password could not be saved.'},400);
      await identityRpc(env,'complete_workspace_password_setup',{p_subject:session.subject,p_email:session.email});
      response=json({ok:true});
    } else if(resource==='mfa-enroll') {
      if(identity.has_password===false)return json({error:'Set your password first.'},403);
      // Enrollment cannot replace a verified factor on an AAL1 session.
      if(session.factors.some(f=>f.status==='verified') && !recentMfa(session))return json({error:'Verify your existing authenticator first.'},403);
      for(const factor of session.factors.filter(f=>f.status==='unverified')){const removed=await authRequest(env,`factors/${factor.id}`,{method:'DELETE',token:session.token});if(!removed.ok)return json({error:'Previous authenticator setup could not be cleared. Try again.'},503);}
      const result=await authRequest(env,'factors',{token:session.token,body:{factor_type:'totp',friendly_name:`Star ${crypto.randomUUID().slice(0,8)}`,issuer:'Star Real Estate'}});
      if(!result.ok)return json({error:'Authenticator setup could not start. Please try again.'},400);
      response=json({factor_id:result.payload.id,secret:result.payload.totp.secret,uri:result.payload.totp.uri});
    } else if(resource==='mfa-verify') {
      if(!uuid.test(body.factor_id)||!/^\d{6}$/.test(body.code)||!session.factors.some(f=>f.id===body.factor_id))return json({error:'Choose your authenticator and enter its six-digit code.'},422);
      const challenge=await authRequest(env,`factors/${body.factor_id}/challenge`,{token:session.token,body:{}});
      if(!challenge.ok)return json({error:'Verification could not start. Please wait and try again.'},429);
      const result=await authRequest(env,`factors/${body.factor_id}/verify`,{token:session.token,body:{challenge_id:challenge.payload.id,code:body.code}});
      if(!result.ok)return json({error:'The authenticator code is invalid or expired.'},401);
      await auditIdentity(env,identity,'mfa_verified');
      // Supabase returns rotated access AND refresh tokens after the challenge.
      return signedIn(request,result.payload,env);
    } else if(resource==='switch-role') {
      if(!identity.is_owner || !recentMfa(session))return json({error:'Verify your authenticator again before switching roles.',code:'mfa_required'},403);
      if(!['owner','admin'].includes(body.role)||body.role==='admin'&&!identity.admin_enabled)return json({error:'This role has not been granted.'},403);
      await auditIdentity(env,{...identity,owner:session.workspaceRole!=='admin'},'switch_role',{from:session.workspaceRole,to:body.role});
      response=json({ok:true});response.headers.append('Set-Cookie',workspaceRoleCookie(request,body.role));
    } else if(resource==='owner-admin') {
      if(!identity.owner||session.workspaceRole!=='owner'||!recentMfa(session))return json({error:'Use Owner mode and verify your authenticator again.',code:'mfa_required'},403);
      if(typeof body.enabled!=='boolean'||!Number.isInteger(body.version)||typeof body.reason!=='string'||body.reason.trim().length<5)return json({error:'Enter the authorization reason and reload the current record.'},422);
      await identityRpc(env,'set_owner_admin',{p_subject:session.subject,p_email:session.email,p_enabled:body.enabled,p_version:body.version,p_reason:body.reason.slice(0,1000)});
      response=json({ok:true});
    } else return json({error:'Unknown security action.'},404);
    if(session.setCookie)response.headers.append('Set-Cookie',session.setCookie);
    return response;
  } catch(error) {
    const response=json({error:error.status?error.message:'Account security is temporarily unavailable.'},error.status||503);
    if(session?.setCookie)response.headers.append('Set-Cookie',session.setCookie);
    return response;
  }
}
