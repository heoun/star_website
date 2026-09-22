// A short-lived recovery receipt bound to one provider session and this site.
// It survives MFA token rotation, but cannot be used by another signed-in account.
import {verifiedSessionClaims} from './account-security.js';
import {isLocalRequest} from './env.js';
export const RECOVERY_COOKIE='star_workspace_recovery';
const purpose='star/workspace-recovery/v1';
const encode=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const decode=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
async function key(env,usage){
  if(typeof env.AUTH_LINK_SECRET!=='string'||env.AUTH_LINK_SECRET.length<32)throw Error('Recovery signing is unavailable');
  return crypto.subtle.importKey('raw',new TextEncoder().encode(env.AUTH_LINK_SECRET),{name:'HMAC',hash:'SHA-256'},false,[usage]);
}
export function recoveryCookie(request,value='',age=0){
  return `${RECOVERY_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${isLocalRequest(request)?'':'; Secure'}`;
}
export async function createRecoveryCookie(request,env,token){
  const claims=verifiedSessionClaims(token);
  if(!claims.sub||!claims.session_id)throw Error('Recovery session is unavailable');
  const payload=encode(new TextEncoder().encode(JSON.stringify({sub:claims.sub,sid:claims.session_id,origin:new URL(request.url).origin,provider:env.SUPABASE_URL,exp:Math.floor(Date.now()/1000)+600})));
  const signature=await crypto.subtle.sign('HMAC',await key(env,'sign'),new TextEncoder().encode(`${purpose}.${payload}`));
  return recoveryCookie(request,`${payload}.${encode(new Uint8Array(signature))}`,600);
}
export async function hasRecoveryProof(request,env,session,value){
  try{
    if(!value||value.length>2048||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))return false;
    const [payload,signature]=value.split('.');
    if(!await crypto.subtle.verify('HMAC',await key(env,'verify'),decode(signature),new TextEncoder().encode(`${purpose}.${payload}`)))return false;
    const proof=JSON.parse(new TextDecoder().decode(decode(payload))),claims=verifiedSessionClaims(session.token);
    return proof.sub===session.subject&&proof.sid===claims.session_id&&!!proof.sid&&proof.origin===new URL(request.url).origin&&proof.provider===env.SUPABASE_URL&&Number.isSafeInteger(proof.exp)&&proof.exp>Date.now()/1000;
  }catch{return false;}
}
