import {EncryptJWT,jwtDecrypt} from 'jose';
import {createGipClient,gipConfig} from './gip.js';
import {businessIdentity,gipIdentityArgs,identityRpc} from './account-security.js';
import {cookieValue,sessionCookie,sessionCookieName} from './auth.js';
import {isLocalRequest} from './env.js';
import {resolveStaff} from './staff.js';
const maxAge=7*86400;
const encode=value=>btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function unpack(value){try{return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))));}catch{return null;}}
export function gipSessionCookie(request,scope,result){
  const value=encode({provider:'gip',at:result.idToken,rt:result.refreshToken});
  if(value.length>3800||!sessionCookieName(request,scope))throw Object.assign(Error('Sign-in session could not be saved.'),{status:503});
  return sessionCookie(request,value,maxAge,scope);
}
export async function gipIdentity(request,env,scope,result){
  const {claims,user}=result;
  const identity={email:user.email.toLowerCase(),subject:user.localId,token:result.idToken,auth_scope:scope,user_id:undefined,setCookie:undefined,
    aal:claims.firebase?.sign_in_second_factor==='totp'?'aal2':'aal1',
    mfaAt:claims.firebase?.sign_in_second_factor==='totp'?claims.auth_time:0,
    workspaceRole:cookieValue(request,'star_workspace_role')==='admin'?'admin':'owner',
    factors:(user.mfaInfo||[]).filter(f=>f.totpInfo).map(f=>({id:f.mfaEnrollmentId,status:'verified',friendly_name:f.displayName||'Authenticator'}))};
  identity.user_id=await businessIdentity(env,identity,scope);
  return identity;
}
export async function readGipSession(request,env,scope){
  const name=sessionCookieName(request,scope);if(!name)return null;
  const packed=unpack(cookieValue(request,name));
  if(packed?.provider!=='gip'||typeof packed.at!=='string'||typeof packed.rt!=='string')return null;
  const client=createGipClient(env,scope);
  let result,rotated=false;
  try{result={...await client.lookup(packed.at),idToken:packed.at,refreshToken:packed.rt};}
  catch(error){
    if(error.status!==401)return error.status===403?null:Promise.reject(error);
    try{result=await client.refresh(packed.rt);rotated=true;}catch(error){if([400,401,403].includes(error.status))return null;throw error;}
  }
  const identity=await gipIdentity(request,env,scope,result);
  if(rotated)identity.setCookie=gipSessionCookie(request,scope,result);
  return identity;
}
export async function finishGipSignIn(request,env,scope,result){
  const identity=await gipIdentity(request,env,scope,result);
  if(scope==='workspace'){
    const access=await resolveStaff(env,identity,{allowPending:true});
    if(!access.identity)throw Object.assign(Error(access.error),{status:access.status||403});
    if(result.claims.firebase?.sign_in_provider!=='password')throw Object.assign(Error('Sign in with your workspace password.'),{status:403});
    await identityRpc(env,'complete_gip_workspace_password_setup',gipIdentityArgs(env,identity));
  }
  const response=Response.json({ok:true,email:identity.email},{headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  response.headers.append('Set-Cookie',gipSessionCookie(request,scope,result));
  response.headers.append('Set-Cookie',challengeCookie(request,scope));
  return response;
}
function challengeName(request,scope){const name=sessionCookieName(request,scope);if(!name)throw Object.assign(Error('Invalid applicant session.'),{status:400});return name+'_gip_challenge';}
export function challengeCookie(request,scope,value='',age=0){return `${challengeName(request,scope)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${isLocalRequest(request)?'':'; Secure'}`;}
async function challengeKey(env){
  if(typeof env.AUTH_LINK_SECRET!=='string'||env.AUTH_LINK_SECRET.length<32)throw Object.assign(Error('Account security is unavailable.'),{status:503});
  return new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('star/gip-challenge/v1:'+env.AUTH_LINK_SECRET)));
}
function audience(request,env,scope){const c=gipConfig(env,scope);return `${new URL(request.url).origin}|${c.projectId}|${c.tenantId}|${challengeName(request,scope)}`;}
export async function writeGipChallenge(request,env,scope,kind,payload){
  const token=await new EncryptJWT({...payload,kind}).setProtectedHeader({alg:'dir',enc:'A256GCM'}).setIssuedAt().setExpirationTime('5m').setIssuer('star/gip-challenge/v1').setAudience(audience(request,env,scope)).encrypt(await challengeKey(env));
  if(token.length>3800)throw Object.assign(Error('Verification could not start.'),{status:503});
  return challengeCookie(request,scope,token,300);
}
export async function readGipChallenge(request,env,scope,kind){
  try{const value=cookieValue(request,challengeName(request,scope));if(!value||value.length>3800)return null;
    const {payload}=await jwtDecrypt(value,await challengeKey(env),{issuer:'star/gip-challenge/v1',audience:audience(request,env,scope),keyManagementAlgorithms:['dir'],contentEncryptionAlgorithms:['A256GCM'],requiredClaims:['exp','iat']});
    return payload.kind===kind?payload:null;
  }catch{return null;}
}
