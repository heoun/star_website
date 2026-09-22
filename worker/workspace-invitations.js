import {identityRequest,identityRpc,hashInvitation,randomInvitation,workspaceAccess} from './account-security.js';
import {authRequest,signedIn,readSession} from './auth.js';
import {recoveryCookie} from './workspace-recovery.js';
import {sendEmail} from './email.js';
import {fetchStaffMember} from './supabase.js';
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
const tokenPattern=/^[a-f0-9]{64}$/;
export async function sendWorkspaceInvitation(request,env,email) {
  const member=await fetchStaffMember(env,email);
  if(!member?.active)return {status:'failed'};
  const token=randomInvitation(),token_hash=await hashInvitation(token);
  await identityRequest(env,'workspace_invitations?on_conflict=email',{method:'POST',prefer:'resolution=merge-duplicates,return=representation',body:{email,role:member.role,token_hash,expires_at:new Date(Date.now()+7*86400000).toISOString(),accepted_by:null,accepted_at:null,revoked_at:null,needs_password:false,created_at:new Date().toISOString()}});
  const url=`${new URL(request.url).origin}/login/#invite=${token}`;
  const dev=env.APP_ENV==='staging';
  const environmentNote=dev?'DEV — TEST ENVIRONMENT\nThis invitation is for dev.starreusa.com only. Your test account and permissions are separate from the live site. Live access requires a separate invitation and activation.\n\n':'';
  const sent=await sendEmail(request,env,{to:[email],subject:`${dev?'[DEV · Test] ':''}Your Star Real Estate workspace invitation`,text:`${environmentNote}You have been invited to join Star Real Estate as ${member.role==='manager'?'an Admin':member.role==='agent'?'an Agent':'a Landlord'}.\n\nAccept your invitation:\n${url}\n\nSign in with ${email}, or create your account if this is your first visit. Existing accounts keep their current password. This invitation expires in seven days.\n\nStar Real Estate`},{workspaceInvitationRecipient:member.email});
  return {status:sent?'sent':'failed'};
}
export async function invitation(env,token) {
  if(!tokenPattern.test(token||''))return null;
  const [row]=await identityRequest(env,`workspace_invitations?token_hash=eq.${await hashInvitation(token)}&select=email,role,expires_at,accepted_at,revoked_at`);
  if(!row||row.accepted_at||row.revoked_at||Date.parse(row.expires_at)<=Date.now())return null;
  const member=await fetchStaffMember(env,row.email);
  return member?.active && member.role===row.role?row:null;
}
export async function handleSecureWorkspaceActivation(request,env,resource,body) {
  if(resource==='workspace-invitation') {
    const inv=await invitation(env,body.invite);
    return inv?json({email:inv.email,role:inv.role}):json({error:'This invitation has expired, been replaced, or already been accepted.'},410);
  }
  const email=String(body.email||'').trim().toLowerCase();
  const inv=body.invite?await invitation(env,body.invite):null;
  if(body.invite && (!inv||inv.email!==email))return json({error:'Use the latest invitation and the invited email.'},403);
  const member=await fetchStaffMember(env,email);
  const owner=(await identityRequest(env,`app_users?email=eq.${encodeURIComponent(email)}&realm=eq.workspace&select=id,password_setup_required,active`))[0];
  const ownerRow=owner?(await identityRequest(env,`platform_owner?user_id=eq.${owner.id}&select=user_id`))[0]:null;
  const incomplete=owner?.active&&owner.password_setup_required===true&&(!!ownerRow||member?.active&&member.access_state==='active');
  const eligible=!!inv||incomplete;
  if(!eligible&&!body.invite&&(ownerRow||member?.active&&member.access_state==='active'))return json({error:'This account is already activated. Sign in with your password, or use Forgot password to reset it.',code:'already_activated'},409);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({error:'Enter your invited email address.'},422);
  if(resource==='workspace-code') {
    if(eligible) {
      if(inv && !await identityRpc(env,'workspace_email_verified',{p_email:email}))await identityRequest(env,`workspace_invitations?email=eq.${encodeURIComponent(email)}&token_hash=eq.${await hashInvitation(body.invite)}`,{method:'PATCH',body:{needs_password:true}});
      const result=await authRequest(env,'otp',{body:{email,create_user:!!inv}});
      if(!result.ok)return json({error:'An email code could not be sent. Please wait before trying again.'},result.status===429?429:503);
    }
    return json({ok:true,message:'If this email has workspace access, a code is on its way.'});
  }
  if(resource==='workspace-accept') {
    const session=await readSession(request,env,'workspace');
    if(!session||!inv||session.email!==inv.email)return json({error:'Sign in with the invited email to accept.'},403);
    await identityRpc(env,'accept_workspace_invitation',{p_subject:session.subject,p_email:session.email,p_hash:await hashInvitation(body.invite)});
    const response=json({ok:true});if(session.setCookie)response.headers.append('Set-Cookie',session.setCookie);return response;
  }
  if(!eligible||!/^\d{6,8}$/.test(String(body.code||'')))return json({error:'Enter the code sent to your invited email.'},403);
  const result=await authRequest(env,'verify',{body:{type:'email',email,token:body.code}});
  if(!result.ok||!result.payload?.access_token||result.payload.user?.email?.toLowerCase()!==email)return json({error:'The email code is invalid or expired.'},401);
  const session=result.payload;
  if(inv)await identityRpc(env,'accept_workspace_invitation',{p_subject:session.user.id,p_email:email,p_hash:await hashInvitation(body.invite)});
  // First password setup is a separate authenticated step, tracked explicitly.
  await workspaceAccess(env,{subject:session.user.id,email});
  const response=await signedIn(request,session,env);
  response.headers.append('Set-Cookie',recoveryCookie(request));
  return response;
}
