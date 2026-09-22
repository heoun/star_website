import assert from 'node:assert/strict';
import {generateKeyPair, SignJWT, createLocalJWKSet, exportJWK} from 'jose';
import {gipConfig, verifyGipToken, createGipClient} from '../worker/gip.js';

const env = {ACCOUNT_SECURITY:'on',GIP_PROJECT_ID:'starreusa-dev-auth',GIP_API_KEY:'test-key',
  GIP_APPLICANT_TENANT_ID:'applicant-test',GIP_WORKSPACE_TENANT_ID:'workspace-test'};
const config = gipConfig(env,'applicant');
const {privateKey,publicKey} = await generateKeyPair('RS256');
const jwk = {...await exportJWK(publicKey),kid:'test-key',alg:'RS256',use:'sig'};
const keys = createLocalJWKSet({keys:[jwk]});
const now = Math.floor(Date.now()/1000);
const base = {iss:config.issuer,aud:config.projectId,sub:'non-uuid-google-user',iat:now,exp:now+3600,
  auth_time:now-20,email:'same@example.test',email_verified:true,firebase:{tenant:config.tenantId,sign_in_provider:'password'}};
const jwt = (changes={},key=privateKey) => new SignJWT({...base,...changes}).setProtectedHeader({alg:'RS256',kid:'test-key'}).sign(key);
let checks=0;
async function reject(promise,status=401) {await assert.rejects(promise,e=>e.status===status);checks++;}
const token = await jwt();
assert.equal((await verifyGipToken(token,config,keys)).sub,base.sub);checks++;
for (const changes of [
  {aud:'other-project'}, {iss:'https://securetoken.google.com/other-project'},
  {firebase:{tenant:'workspace-test'}}, {firebase:{}}, {firebase:{tenant:config.tenantId,sign_in_provider:'anonymous'}},
  {exp:now-1}, {iat:now+300}, {auth_time:now+300}, {auth_time:undefined},
  {sub:''}, {sub:'a'.repeat(129)}, {email:'bad'}, {exp:undefined}
]) await reject(verifyGipToken(await jwt(changes),config,keys));
const other = await generateKeyPair('RS256');
await reject(verifyGipToken(await jwt({},other.privateKey),config,keys));
const none = Buffer.from(JSON.stringify({alg:'none'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(base)).toString('base64url')+'.';
await reject(verifyGipToken(none,config,keys));
for (const changes of [{GIP_PROJECT_ID:''},{GIP_API_KEY:''},{GIP_APPLICANT_TENANT_ID:''},
  {GIP_WORKSPACE_TENANT_ID:config.tenantId},{ACCOUNT_SECURITY:'off'}, {GIP_PROJECT_ID:'https://evil.test'}]) {
  assert.throws(()=>gipConfig({...env,...changes},'applicant'),e=>e.status===503);checks++;
}
assert.throws(()=>gipConfig(env,'client-selected'),e=>e.status===503);checks++;

let user = {localId:base.sub,email:base.email,emailVerified:true,tenantId:config.tenantId,validSince:'0'};
let signInResponse = {idToken:token,refreshToken:'refresh-applicant'};
let refreshResponse = {id_token:token,refresh_token:'rotated-applicant'};
let finalizeResponse;
let calls=[];
let failure;
const client = createGipClient(env,'applicant',{keyResolver:keys,fetcher:async(url,options)=>{
  url = new URL(url);calls.push({url,options});
  assert.equal(url.searchParams.get('key'),'test-key');
  if (failure) return new Response(JSON.stringify(failure),{status:400});
  if (url.pathname === '/v1/accounts:lookup') {
    assert.deepEqual(Object.keys(JSON.parse(options.body)),['idToken']);
    return Response.json({users:[user]});
  }
  if (url.pathname === '/v1/accounts:signInWithPassword') {
    assert.equal(JSON.parse(options.body).tenantId,'applicant-test');
    return Response.json(signInResponse);
  }
  if (url.pathname === '/v2/accounts/mfaSignIn:finalize') {
    assert.deepEqual(JSON.parse(options.body),{tenantId:'applicant-test',mfaPendingCredential:'pending',mfaEnrollmentId:'factor-one',totpVerificationInfo:{verificationCode:'123456'}});
    return Response.json(finalizeResponse);
  }
  assert.equal(url.origin,'https://securetoken.googleapis.com');
  assert.equal(url.pathname,'/v1/token');
  assert.equal(new URLSearchParams(options.body).get('grant_type'),'refresh_token');
  return Response.json(refreshResponse);
}});
assert.equal((await client.signIn(base.email,'applicant-password')).user.localId,base.sub);checks++;
assert.equal((await client.refresh('refresh-applicant')).refreshToken,'rotated-applicant');checks++;
for (const changes of [{disabled:true},{emailVerified:false},{tenantId:'workspace-test'},
  {localId:'different-user'},{email:'different@example.test'},{validSince:String(now+1)},{validSince:'bad'}]) {
  const before=user;user={...before,...changes};
  await reject(client.lookup(token),changes.emailVerified===false?403:401);user=before;
}
await reject(client.lookup(await jwt({email_verified:false})),403);
const crossTenant = await jwt({firebase:{tenant:'workspace-test',sign_in_provider:'password'}});
const countBefore = calls.length;
await reject(client.lookup(crossTenant));assert.equal(calls.length,countBefore);checks++;
refreshResponse = {...refreshResponse,id_token:crossTenant};
await reject(client.refresh('workspace-refresh'));
signInResponse = {mfaPendingCredential:'pending',mfaInfo:[{mfaEnrollmentId:'factor-one',totpInfo:{},displayName:'Authenticator'}]};
const pending = await client.signIn(base.email,'password');
assert.equal(pending.idToken,undefined);assert.equal(pending.mfaPendingCredential,'pending');checks++;
finalizeResponse = {idToken:token,refreshToken:'after-mfa'};
await reject(client.finishMfa('pending','factor-one','123456'));
finalizeResponse = {idToken:await jwt({firebase:{...base.firebase,sign_in_second_factor:'totp',second_factor_identifier:'factor-one'}}),refreshToken:'after-mfa'};
assert.equal((await client.finishMfa('pending','factor-one','123456')).refreshToken,'after-mfa');checks++;
for (const code of ['INVALID_PASSWORD','EMAIL_NOT_FOUND','INVALID_LOGIN_CREDENTIALS']) {
  failure={error:{message:code}};
  await assert.rejects(client.signIn(base.email,'wrong'),e=>e.status===401&&e.message==='Email or password is incorrect.');checks++;
}
failure={error:{message:'secret-provider-error'}};
await assert.rejects(client.signIn(base.email,'password'),e=>e.status===503&&!e.message.includes('secret'));checks++;
const broken=createGipClient(env,'applicant',{keyResolver:keys,fetcher:async()=>new Response('x'.repeat(131073))});
await reject(broken.signIn(base.email,'password'),503);
console.log(`PASS ${checks} GIP token, tenant, refresh, MFA and failure checks (synthetic provider; no live accounts).`);
