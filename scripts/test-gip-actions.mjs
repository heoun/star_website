import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT,createLocalJWKSet,exportJWK} from 'jose';
import {createGipClient} from '../worker/gip.js';
const env={ACCOUNT_SECURITY:'on',GIP_PROJECT_ID:'starreusa-dev-auth',GIP_API_KEY:'test-key',GIP_APPLICANT_TENANT_ID:'applicant-test',GIP_WORKSPACE_TENANT_ID:'workspace-test'};
const {privateKey,publicKey}=await generateKeyPair('RS256');
const keys=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'test'}]});
const now=Math.floor(Date.now()/1000),email='test@example.invalid';
const claims={iss:'https://securetoken.google.com/starreusa-dev-auth',aud:'starreusa-dev-auth',sub:'google-uid',email,email_verified:true,auth_time:now,iat:now,exp:now+3600,firebase:{tenant:'applicant-test',sign_in_provider:'password'}};
const jwt=changes=>new SignJWT({...claims,...changes}).setProtectedHeader({alg:'RS256',kid:'test'}).sign(privateKey);
const token=await jwt({});
let action='PASSWORD_RESET',responseEmail=email,verified=true,mfaInfo=[],mutationCalls=0;
const fetcher=async (url,options)=>{
  const path=new URL(url).pathname,body=JSON.parse(options.body);
  if(path==='/v1/accounts:lookup')return Response.json({users:[{localId:'google-uid',email,emailVerified:true,tenantId:'applicant-test',mfaInfo}]});
  assert.equal(body.tenantId,'applicant-test');
  if(path==='/v1/accounts:resetPassword'){
    if(body.newPassword){mutationCalls++;return Response.json({email:responseEmail});}
    return Response.json({email,requestType:action});
  }
  if(path==='/v1/accounts:update'){mutationCalls++;return Response.json({email:responseEmail,emailVerified:verified});}
  if(path==='/v1/accounts:signUp')return Response.json({idToken:token,refreshToken:'signup-refresh'});
  if(path==='/v2/accounts/mfaEnrollment:start'){mutationCalls++;return Response.json({totpSessionInfo:{sessionInfo:'enroll-session',sharedSecretKey:'SYNTHETIC',verificationCodeLength:6,periodSec:30,hashingAlgorithm:'SHA1'}});}
  if(path==='/v2/accounts/mfaEnrollment:finalize'){mutationCalls++;return Response.json({idToken:token,refreshToken:'enrolled-refresh'});}
  throw new Error('Unexpected path '+path);
};
const client=createGipClient(env,'applicant',{fetcher,keyResolver:keys});
let checks=0;
const rejected=async (promise,status=401)=>{await assert.rejects(promise,e=>e.status===status);checks++;};
await rejected(client.verifyEmail('reset-code'));assert.equal(mutationCalls,0);checks++;
action='VERIFY_EMAIL';
await rejected(client.resetPassword('verify-code','valid password'));assert.equal(mutationCalls,0);checks++;
assert.deepEqual(await client.verifyEmail('verify-code'),{email,verified:true});checks++;
verified=false;await rejected(client.verifyEmail('verify-code'));verified=true;
responseEmail='other@example.invalid';await rejected(client.verifyEmail('verify-code'));
action='PASSWORD_RESET';await rejected(client.resetPassword('reset-code','valid password'));responseEmail=email;
assert.deepEqual(await client.resetPassword('reset-code','valid password'),{email});checks++;
for(const code of ['',null,'x'.repeat(2049)])await rejected(client.checkEmailAction(code));
for(const password of ['',null,'short','x'.repeat(201)])await rejected(client.resetPassword('code',password),422);
action='RECOVER_EMAIL';await rejected(client.checkEmailAction('code'));
const workspace=createGipClient(env,'workspace',{fetcher:()=>{throw new Error('Must not request public Workspace signup');}});
await rejected(workspace.signUp(email,'valid password'),403);
for(const [mail,password] of [['bad','valid password'],[email,'short'],[email,'x'.repeat(201)]])await rejected(client.signUp(mail,password),422);
const stale=await jwt({auth_time:now-301});
for(const op of [()=>client.startTotp(stale),()=>client.finishTotpEnrollment(stale,'session','123456')])await rejected(op(),403);
mfaInfo=[{mfaEnrollmentId:'existing',totpInfo:{}}];
for(const op of [()=>client.startTotp(token),()=>client.finishTotpEnrollment(token,'session','123456')])await rejected(op(),403);
mfaInfo=[];
const setup=await client.startTotp(token);assert.equal(setup.sessionInfo,'enroll-session');assert.ok(setup.uri.startsWith('otpauth://totp/'));checks++;
await rejected(client.finishTotpEnrollment(token,'session','not-a-code'));
assert.equal((await client.finishTotpEnrollment(token,'session','123456')).refreshToken,'enrolled-refresh');checks++;
console.log(`PASS ${checks} GIP email-action, signup and enrollment boundary checks.`);
