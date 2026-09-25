import {importPKCS8,SignJWT} from 'jose';
import {gipConfig} from './gip.js';
const unavailable=()=>Object.assign(new Error('Account setup is temporarily unavailable.'),{status:503});

// Uses a pinned external workload key, not a Google service-account private key.
// Google issues short-lived credentials for the four-permission runtime role.
export function createGipAdmin(env,scope,{fetcher=fetch}={}) {
  const config=gipConfig(env,scope);
  function failure(stage,status,code){
    // Diagnostics identify the failed hop, never Google's raw body, tokens,
    // signing material, email addresses or submitted request values.
    if(env.APP_ENV==='staging')console.warn('gip_admin_unavailable',{stage,status,code:/^[A-Za-z_]{1,64}$/.test(code||'')?code:'unavailable'});
    return unavailable();
  }
  let credential;
  try {credential=JSON.parse(env.GIP_WORKLOAD_IDENTITY);} catch {throw failure('credential_parse');}
  if(credential.serviceAccount!==`star-dev-auth-runtime@${config.projectId}.iam.gserviceaccount.com` ||
    credential.subject!=='star-website-staging' || credential.issuer!=='https://dev.starreusa.com/workload-identity' ||
    config.projectId!=='starreusa-dev-auth' || credential.audience!=='//iam.googleapis.com/projects/54640971372/locations/global/workloadIdentityPools/star-dev-auth/providers/cloudflare-worker' ||
    !credential.kid || !credential.privateKey)throw failure('credential_target');
  // Per-request client cache only; no user or credential state is shared globally.
  let accessToken;
  async function request(url,body,authorization){
    const stage=url.includes('sts.googleapis.com')?'federation':url.includes('iamcredentials.googleapis.com')?'impersonation':url.split(':').at(-1);
    let r;
    // Workers supports manual/follow, not the browser's redirect:error mode.
    // Never forward credentials or workload assertions to a redirect target.
    try {r=await fetcher(url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',...(authorization?{Authorization:'Bearer '+authorization}:{})},body:JSON.stringify(body)});}catch{throw failure(stage,0,'network');}
    if(r.status>=300&&r.status<400)throw failure(stage,r.status,'redirect');
    const reader=r.body?.getReader();if(!reader)throw unavailable();
    const decoder=new TextDecoder();let text='',length=0;
    for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>131072){await reader.cancel();throw unavailable();}text+=decoder.decode(value,{stream:true});}
    let data;try{data=JSON.parse(text+decoder.decode());}catch{throw unavailable();}
    if(!r.ok){
      const raw=String(data?.error?.message||'').split(' : ')[0];
      if(raw==='EMAIL_EXISTS')throw Object.assign(new Error('This workspace account already exists.'),{status:409,code:'already_registered'});
      if(raw==='EMAIL_NOT_FOUND'||raw==='USER_NOT_FOUND')throw Object.assign(new Error('Account unavailable.'),{status:404,code:'account_missing'});
      throw failure(stage,r.status,typeof data.error==='string'?data.error:raw);
    }
    return data;
  }
  async function token(){
    if(accessToken)return accessToken;
    const key=await importPKCS8(credential.privateKey,'RS256');
    const assertion=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:credential.kid})
      .setIssuer(credential.issuer).setSubject(credential.subject).setAudience(credential.audience)
      .setIssuedAt().setExpirationTime('5m').sign(key);
    const federated=await request('https://sts.googleapis.com/v1/token',{
      grantType:'urn:ietf:params:oauth:grant-type:token-exchange',audience:credential.audience,
      scope:'https://www.googleapis.com/auth/cloud-platform',requestedTokenType:'urn:ietf:params:oauth:token-type:access_token',
      subjectToken:assertion,subjectTokenType:'urn:ietf:params:oauth:token-type:jwt'});
    if(!federated.access_token)throw unavailable();
    const minted=await request(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${credential.serviceAccount}:generateAccessToken`,{
      scope:['https://www.googleapis.com/auth/identitytoolkit'],lifetime:'600s'
    },federated.access_token);
    if(!minted.accessToken)throw unavailable();
    accessToken=minted.accessToken;return accessToken;
  }
  async function api(method,body){
    const path=method==='signUp'?'accounts:signUp':`projects/${config.projectId}/tenants/${config.tenantId}/accounts:${method}`;
    return request('https://identitytoolkit.googleapis.com/v1/'+path,
      method==='signUp'?{...body,tenantId:config.tenantId,targetProjectId:config.projectId}:body,await token());
  }
  const safeUser=u=>u?{id:u.localId,email:u.email,emailVerified:u.emailVerified===true,disabled:u.disabled===true,tenantId:u.tenantId,mfaInfo:u.mfaInfo||[]}:null;
  return {
    async findByEmail(email){
      const result=await api('lookup',{email:[email]});
      const user=result.users?.length===1?result.users[0]:null;
      if(user&&(user.tenantId!==config.tenantId||user.email?.toLowerCase()!==email.toLowerCase()))throw unavailable();
      return safeUser(user);
    },
    async createInvited(email){
      if(scope!=='workspace'||!/^\S+@\S+\.\S+$/.test(email))throw unavailable();
      // A random unrevealed password prevents accidental passwordless/anonymous
      // provisioning. Only the recipient's reset link can establish a usable one.
      const password=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
      const result=await api('signUp',{email,password,emailVerified:false});
      if(!result.localId)throw unavailable();
      return {id:result.localId,email};
    },
    async emailAction(email,type){
      if(!['VERIFY_EMAIL','PASSWORD_RESET'].includes(type))throw unavailable();
      const result=await api('sendOobCode',{requestType:type,email,returnOobLink:true});
      let link;try{link=new URL(result.oobLink);}catch{throw unavailable();}
      if(link.protocol!=='https:'||link.hostname!==`${config.projectId}.firebaseapp.com`||link.searchParams.get('tenantId')!==config.tenantId)throw unavailable();
      const code=link.searchParams.get('oobCode');if(!code)throw unavailable();
      // Caller sends a branded first-party link, with this code in its fragment.
      return {code,tenantId:config.tenantId};
    }
  };
}
