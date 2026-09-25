import {createGipClient} from './gip.js';
import {createGipAdmin} from './gip-admin.js';
import {sameOriginMutation,sessionCookie,sessionCookieName,workspaceRoleCookie} from './auth.js';
import {readGipSession,finishGipSignIn,readGipChallenge,writeGipChallenge,challengeCookie} from './gip-session.js';
import {identityRequest,identityRpc,gipIdentityArgs,hashInvitation,recentMfa,auditIdentity} from './account-security.js';
import {invitation} from './workspace-invitations.js';
import {resolveStaff} from './staff.js';
import {fetchStaffMember} from './supabase.js';
import {sendEmail} from './email.js';
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
const emailPattern=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
async function input(request){
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw Object.assign(Error('JSON required.'),{status:415});
  const reader=request.body?.getReader();if(!reader)throw Object.assign(Error('Form required.'),{status:400});
  const decoder=new TextDecoder();let text='',size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();throw Object.assign(Error('Form too large.'),{status:413});}text+=decoder.decode(value,{stream:true});}
  try{const result=JSON.parse(text+decoder.decode());if(!result||typeof result!=='object'||Array.isArray(result))throw Error();return result;}catch{throw Object.assign(Error('Invalid form.'),{status:400});}
}
async function reserveEmail(request,env,scope,email){
  const key=await hashInvitation(scope+':'+email),ip=await hashInvitation(request.headers.get('CF-Connecting-IP')||'local');
  if(!await identityRpc(env,'reserve_gip_auth_email',{p_key:key,p_ip:ip}))throw Object.assign(Error('Please wait before requesting another email.'),{status:429});
}
async function mailAction(request,env,scope,email,type,{invite='',activation=false,member}={}){
  const action=await createGipAdmin(env,scope).emailAction(email,type);
  const origin=new URL(env.SITE_ORIGIN||request.url).origin;
  const url=new URL(scope==='workspace'?'/login/':'/portal/',origin);
  url.hash=new URLSearchParams({oob:action.code,action:type==='VERIFY_EMAIL'?'verify':activation?'activate':'reset',...(invite?{invite}:{})}).toString();
  const label=scope==='workspace'?'workspace':'applicant',dev=env.APP_ENV==='staging';
  const title=type==='VERIFY_EMAIL'?'Confirm your email':activation?'Activate your account':'Reset your password';
  const sent=await sendEmail(request,env,{to:[email],subject:`${dev?'[DEV · Test] ':''}Star Real Estate — ${title}`,text:`${dev?'DEV — TEST ENVIRONMENT\nThis account is for dev.starreusa.com only.\n\n':''}${title}\n\n${type==='VERIFY_EMAIL'?'Confirm your email address':activation?'Choose your password to activate your invited account':'Choose a new password'} for your Star Real Estate ${label} account:\n\n${url.href}\n\nYour applicant and workspace accounts are separate, even when they use the same email. This link applies only to your ${label} account.\n\nIf you did not request this email, you can ignore it. Do not share this link.`},member?.active?{workspaceInvitationRecipient:member.email}:{});
  if(!sent)throw Object.assign(Error('The email could not be sent. Please try again later.'),{status:503});
}
async function activationContext(env,body,email){
  const inv=body.invite?await invitation(env,body.invite):null;
  if(body.invite&&(!inv||inv.email!==email))throw Object.assign(Error('Use the latest invitation and the invited email.'),{status:403});
  const member=await fetchStaffMember(env,email);
  const [account]=await identityRequest(env,`app_users?realm=eq.workspace&email=eq.${encodeURIComponent(email)}&select=id,active,password_setup_required`);
  if(!inv&&!(member?.active&&account?.active&&account.password_setup_required)){
    throw Object.assign(Error('Use your latest invitation. If already activated, sign in or use Forgot password.'),{status:403});
  }
  return {inv,member,account};
}
export async function handleGipAuth(request,env,resource,scope){
  if(request.method==='GET'&&resource==='options')return json({provider:'gip',secure:true,auth_realm:scope});
  if(request.method!=='POST'||!sameOriginMutation(request))return json({error:'Use this website to submit the form.'},403);
  try{
    if(!sessionCookieName(request,scope))return json({error:'Invalid applicant session.'},400);
    const client=createGipClient(env,scope),body=await input(request);
    const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
    if(['sign-out','logout'].includes(resource)){
      const response=json({ok:true});response.headers.append('Set-Cookie',sessionCookie(request,'',0,scope));response.headers.append('Set-Cookie',challengeCookie(request,scope));return response;
    }
    if(resource==='workspace-invitation'&&scope==='workspace'){
      const inv=await invitation(env,body.invite);return inv?json({email:inv.email,role:inv.role}):json({error:'This invitation is expired, replaced or already accepted.'},410);
    }
    if(resource==='login'){
      if(!emailPattern.test(email)||typeof body.password!=='string'||!body.password||body.password.length>200)return json({error:'Email or password is incorrect.'},401);
      const result=await client.signIn(email,body.password);
      if(result.mfaPendingCredential){
        if(!result.factors.length)throw Object.assign(Error('A supported authenticator is required. Contact your administrator.'),{status:403});
        const response=json({mfa_required:true,factors:result.factors});
        response.headers.append('Set-Cookie',await writeGipChallenge(request,env,scope,'signin',{pending:result.mfaPendingCredential,factors:result.factors.map(f=>f.id),email}));
        // A new login attempt cannot silently retain a different authenticated user.
        response.headers.append('Set-Cookie',sessionCookie(request,'',0,scope));return response;
      }
      return await finishGipSignIn(request,env,scope,result);
    }
    if(resource==='mfa-login'){
      const challenge=await readGipChallenge(request,env,scope,'signin');
      if(!challenge||!challenge.factors?.includes(body.factor_id))return json({error:'Sign in again to start verification.'},401);
      const result=await client.finishMfa(challenge.pending,body.factor_id,body.code);
      if(result.user.email.toLowerCase()!==challenge.email)return json({error:'Sign-in identity changed. Sign in again.'},401);
      return await finishGipSignIn(request,env,scope,result);
    }
    if(resource==='check-action')return json(await client.checkEmailAction(body.code));
    if(resource==='verify-register')return json({ok:true,...await client.verifyEmail(body.code)});
    if(resource==='verify-reset'){
      let code=body.code;
      if(body.activation===true&&!code){
        const activation=await readGipChallenge(request,env,scope,'activation');
        if(!activation||activation.inviteHash!==await hashInvitation(body.invite||''))return json({error:'Open your latest invitation again to activate your account.'},403);
        code=activation.code;
      }
      const checked=await client.checkEmailAction(code);
      if(body.activation===true){if(scope!=='workspace')return json({error:'Use the applicant password reset page.'},400);await activationContext(env,body,checked.email);}
      const result=await client.resetPassword(code,body.password);
      const response=json({ok:true,email:result.email,sign_in_required:true});
      response.headers.append('Set-Cookie',sessionCookie(request,'',0,scope));response.headers.append('Set-Cookie',challengeCookie(request,scope));return response;
    }
    if(['register','resend','request-reset','workspace-code'].includes(resource)){
      if(!emailPattern.test(email)||email.length>180)return json({error:'Enter a valid email address.'},422);
      if(resource==='register'){
        if(scope!=='applicant')return json({error:'Use your workspace invitation.'},403);
        await reserveEmail(request,env,scope,email);
        await client.signUp(email,body.password);
        await mailAction(request,env,scope,email,'VERIFY_EMAIL');return json({ok:true,email_link:true});
      }
      if(resource==='workspace-code'){
        if(scope!=='workspace')return json({error:'Unknown action.'},404);
        const context=await activationContext(env,body,email);
        await reserveEmail(request,env,scope,email);
        const admin=createGipAdmin(env,scope);let account=await admin.findByEmail(email);
        if(account?.disabled)return json({error:'Account unavailable. Contact your administrator.'},403);
        if(account?.emailVerified&&(context.inv||!context.account?.password_setup_required))return json({ok:true,existing_account:true});
        if(!account){if(!context.inv)return json({error:'Account migration is not ready.'},503);account=await admin.createInvited(email);}
        if(context.inv){
          // The emailed invitation already proves mailbox possession. Keep the
          // provider's single-use code in an encrypted, invitation-bound cookie.
          const action=await admin.emailAction(email,'PASSWORD_RESET');
          const response=json({ok:true,activation_ready:true});
          response.headers.append('Set-Cookie',await writeGipChallenge(request,env,scope,'activation',{code:action.code,inviteHash:await hashInvitation(body.invite)}));
          return response;
        }
        await mailAction(request,env,scope,email,'PASSWORD_RESET',{invite:body.invite,activation:true,member:context.member});return json({ok:true,email_link:true});
      }
      await reserveEmail(request,env,scope,email);
      const admin=createGipAdmin(env,scope),account=await admin.findByEmail(email);
      const member=scope==='workspace'?await fetchStaffMember(env,email):undefined;
      if(account&&!account.disabled&&(scope!=='workspace'||member?.active)){
        if(resource==='request-reset')await mailAction(request,env,scope,email,'PASSWORD_RESET',{member});
        else if(!account.emailVerified&&scope==='applicant')await mailAction(request,env,scope,email,'VERIFY_EMAIL');
      }
      return json({ok:true,email_link:true});
    }
    if(scope!=='workspace')return json({error:'Unknown authentication action.'},404);
    const session=await readGipSession(request,env,scope);if(!session)return json({error:'Please sign in.'},401);
    if(resource==='workspace-accept'){
      const inv=await invitation(env,body.invite);
      if(!inv||session.email!==inv.email)return json({error:'Sign in with the invited email to accept.'},403);
      await identityRpc(env,'accept_gip_workspace_invitation',{...gipIdentityArgs(env,session),p_hash:await hashInvitation(body.invite)});
      const response=json({ok:true});if(session.setCookie)response.headers.append('Set-Cookie',session.setCookie);return response;
    }
    const resolved=await resolveStaff(env,{...session,workspaceRole:'owner'},{allowPending:true});
    if(!resolved.identity)return json({error:resolved.error},resolved.status||403);
    const identity=resolved.identity;if(identity.access_state==='invited')return json({error:'Accept your latest invitation first.'},403);
    let response;
    if(resource==='security')response=json({provider:'gip',email:identity.email,reset_password:false,setup_password:identity.has_password===false,recent_mfa:recentMfa(session),mfa_required:identity.role==='manager',verified:session.aal==='aal2',factors:session.factors,owner_account:identity.is_owner===true,admin_enabled:identity.admin_enabled===true,owner_version:identity.version,onboarding_pending:identity.onboarding_pending===true});
    else if(resource==='reauth-start'){
      if(typeof body.password!=='string'||!body.password||body.password.length>200)return json({error:'Enter your current password.'},422);
      const result=await client.signIn(session.email,body.password);
      if(!result.mfaPendingCredential||!result.factors?.length)return json({error:'An enrolled authenticator is required.'},403);
      response=json({factors:result.factors});
      response.headers.append('Set-Cookie',await writeGipChallenge(request,env,scope,'reauth',{subject:session.subject,email:session.email,pending:result.mfaPendingCredential,factors:result.factors.map(f=>f.id)}));
    }else if(resource==='reauth-verify'){
      const challenge=await readGipChallenge(request,env,scope,'reauth');
      if(!challenge||challenge.subject!==session.subject||challenge.email!==session.email||!challenge.factors?.includes(body.factor_id))return json({error:'Verification expired or the account changed. Start verification again.'},403);
      const result=await client.finishMfa(challenge.pending,body.factor_id,body.code);
      if(result.user.localId!==session.subject||result.user.email.toLowerCase()!==session.email||result.claims.firebase?.sign_in_second_factor!=='totp')return json({error:'Verification did not match your current account.'},403);
      return await finishGipSignIn(request,env,scope,result);
    }else if(resource==='mfa-enroll'){
      const setup=await client.startTotp(session.token);
      response=json({factor_id:'new-totp',secret:setup.sharedSecretKey,uri:setup.uri});
      response.headers.append('Set-Cookie',await writeGipChallenge(request,env,scope,'enroll',{subject:session.subject,session:setup.sessionInfo}));
    }else if(resource==='mfa-verify'){
      const challenge=await readGipChallenge(request,env,scope,'enroll');
      if(!challenge||challenge.subject!==session.subject||body.factor_id!=='new-totp')return json({error:'Sign in again with your password and authenticator to verify your identity.',code:'reauth_required'},403);
      const result=await client.finishTotpEnrollment(session.token,challenge.session,body.code);
      await auditIdentity(env,identity,'mfa_enrolled');return await finishGipSignIn(request,env,scope,result);
    }else if(resource==='switch-role'){
      if(!identity.is_owner||!recentMfa(session))return json({error:'Sign in again and verify your authenticator before switching roles.',code:'reauth_required'},403);
      if(!['owner','admin'].includes(body.role)||body.role==='admin'&&!identity.admin_enabled)return json({error:'This role has not been granted.'},403);
      await auditIdentity(env,{...identity,owner:session.workspaceRole!=='admin'},'switch_role',{from:session.workspaceRole,to:body.role});
      response=json({ok:true});response.headers.append('Set-Cookie',workspaceRoleCookie(request,body.role));
    }else if(resource==='owner-admin'){
      if(!identity.owner||session.workspaceRole!=='owner'||!recentMfa(session))return json({error:'Use Owner mode and sign in again with your authenticator.',code:'reauth_required'},403);
      if(typeof body.enabled!=='boolean'||!Number.isInteger(body.version)||typeof body.reason!=='string'||body.reason.trim().length<5)return json({error:'Enter the authorization reason and reload the current record.'},422);
      await identityRpc(env,'set_gip_owner_admin',{...gipIdentityArgs(env,session),p_enabled:body.enabled,p_version:body.version,p_reason:body.reason.slice(0,1000)});response=json({ok:true});
    }else return json({error:'Use Forgot password to change your password.'},400);
    if(session.setCookie)response.headers.append('Set-Cookie',session.setCookie);return response;
  }catch(error){return json({error:error.status?error.message:'Account access is temporarily unavailable.',...(error.code?{code:error.code}:{})},error.status||503);}
}
