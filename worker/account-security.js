// Provider bindings are confined to this adapter. Business user IDs survive provider migrations.
import { requireConfig } from './supabase.js';
export const accountSecurityEnabled = env => env.ACCOUNT_SECURITY === 'on';
export async function identityRequest(env, path, {method='GET',body,prefer='return=representation'}={}) {
  const config=requireConfig(env);
  const response=await fetch(`${config.url}/rest/v1/${path}`,{method,signal:AbortSignal.timeout(15000),headers:{apikey:config.key,Authorization:`Bearer ${config.key}`,'Content-Type':'application/json',Prefer:prefer},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Object.assign(new Error('Account access could not be verified. Refresh or contact your administrator.'),{status:response.status>=500?503:403});
  return response.status===204?null:response.json();
}
export const identityRpc=(env,name,body)=>identityRequest(env,`rpc/${name}`,{method:'POST',body});
export const businessIdentity=(env,identity)=>identityRpc(env,'resolve_business_identity',{p_subject:identity.subject,p_email:identity.email});
export const workspaceAccess=(env,identity)=>identityRpc(env,'resolve_workspace_access',{p_subject:identity.subject,p_email:identity.email});
// Only inspect claims AFTER Supabase has validated this exact access token via /user.
export function verifiedSessionClaims(token) {
  try { const part=token.split('.')[1];return JSON.parse(atob(part.replace(/-/g,'+').replace(/_/g,'/'))); } catch {return {};}
}
export function recentMfa(identity) {
  return identity.aal==='aal2' && Number.isFinite(identity.mfaAt) && identity.mfaAt<=Date.now()/1000+30 && Date.now()/1000-identity.mfaAt<300;
}
export async function hashInvitation(token) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function randomInvitation() {return [...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export async function auditIdentity(env,identity,action,details={}) {
  await identityRequest(env,'identity_audit',{method:'POST',body:{actor_id:identity.user_id,acting_role:identity.owner?'owner':identity.role,action,target_id:identity.user_id,details}});
}
