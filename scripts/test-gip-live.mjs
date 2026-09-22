// Explicit Dev-only acceptance probe. Creates two disposable synthetic accounts,
// never sends mail, never accesses business records, and deletes only its own UIDs.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {randomBytes,createHmac} from 'node:crypto';
import {createGipClient} from '../worker/gip.js';
import {createGipAdmin} from '../worker/gip-admin.js';
const env={...JSON.parse(readFileSync('.local/gip/dev-config.json','utf8')),ACCOUNT_SECURITY:'on'};
if(env.GIP_PROJECT_ID!=='starreusa-dev-auth'||env.GIP_APPLICANT_TENANT_ID!=='Applicant-sw0j9'||env.GIP_WORKSPACE_TENANT_ID!=='Workspace-7ppgr')throw new Error('Unexpected Dev target');
const access=execFileSync(resolve('.local/gip-tools/google-cloud-sdk/bin/gcloud'),['auth','print-access-token','info@starreusa.com','--project=starreusa-dev-auth'],{env:{...process.env,CLOUDSDK_CONFIG:resolve('.local/gip-tools/config')},encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function admin(method,tenantId,body){
  const path=method==='signUp'?'accounts:signUp':`projects/starreusa-dev-auth/tenants/${tenantId}/accounts:${method}`;
  const payload=method==='signUp'?{...body,tenantId,targetProjectId:'starreusa-dev-auth'}:body;
  const r=await fetch(`https://identitytoolkit.googleapis.com/v1/${path}`,{method:'POST',signal:AbortSignal.timeout(15000),redirect:'error',headers:{Authorization:'Bearer '+access,'x-goog-user-project':'starreusa-dev-auth','Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await r.json().catch(()=>null);if(!r.ok)throw new Error(`Dev test admin ${method}: ${r.status} ${data?.error?.message || 'invalid response'}`);return data;
}
const email=`gip-probe-${crypto.randomUUID()}@example.invalid`;
const passwordA=randomBytes(24).toString('base64url'),passwordW=randomBytes(24).toString('base64url');
const cleanup=[];
const app=createGipClient(env,'applicant'),work=createGipClient(env,'workspace');
const providerOnly=process.argv.includes('--provider-only');
if(process.argv.slice(2).some(arg=>arg!=='--provider-only'))throw new Error('Only --provider-only is supported; this probe cannot target production.');
function totp(secret){
  let bits='';for(const char of secret.replace(/=/g,''))bits+='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char).toString(2).padStart(5,'0');
  const key=Buffer.from(bits.match(/.{8}/g).map(b=>parseInt(b,2)));
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
  const hash=createHmac('sha1',key).update(counter).digest(),offset=hash.at(-1)&15;
  return String((hash.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
let checks=0;
try{
  const registered=await app.signUp(email,passwordA);cleanup.push([env.GIP_APPLICANT_TENANT_ID,registered.user.localId]);
  assert.equal(registered.user.emailVerified,false);checks++;
  await assert.rejects(app.signIn(email,passwordA),e=>e.code==='email_unverified');checks++;
  // Return the link rather than sending mail; exercise the real verification path.
  const verification=await admin('sendOobCode',env.GIP_APPLICANT_TENANT_ID,{requestType:'VERIFY_EMAIL',email,returnOobLink:true});
  const verifyCode=new URL(verification.oobLink).searchParams.get('oobCode');
  await app.verifyEmail(verifyCode);checks++;
  await assert.rejects(app.verifyEmail(verifyCode));checks++;
  // Explicit diagnostic mode still uses the real tenants, but does not claim to
  // validate runtime IAM. The normal/default acceptance path requires WIF.
  const runtime=providerOnly?{
    async createInvited(email){const user=await admin('signUp',env.GIP_WORKSPACE_TENANT_ID,{email,password:randomBytes(32).toString('base64url'),emailVerified:false});return {id:user.localId};},
    async findByEmail(email){const result=await admin('lookup',env.GIP_WORKSPACE_TENANT_ID,{email:[email]});return result.users[0];},
    async emailAction(email,type){const result=await admin('sendOobCode',env.GIP_WORKSPACE_TENANT_ID,{email,requestType:type,returnOobLink:true});return {code:new URL(result.oobLink).searchParams.get('oobCode')};}
  }:createGipAdmin({...env,GIP_WORKLOAD_IDENTITY:readFileSync('.local/gip/workload.json','utf8')},'workspace');
  const member=await runtime.createInvited(email);
  cleanup.push([env.GIP_WORKSPACE_TENANT_ID,member.id]);
  assert.notEqual((await runtime.findByEmail(email)).emailVerified,true);checks++;
  const activation=await runtime.emailAction(email,'PASSWORD_RESET');
  await work.resetPassword(activation.code,passwordW);checks++;
  const applicant=await app.signIn(email,passwordA),workspace=await work.signIn(email,passwordW);
  assert.notEqual(applicant.user.localId,workspace.user.localId);checks++;
  for(const [client,password] of [[app,passwordW],[work,passwordA]]){await assert.rejects(client.signIn(email,password),e=>e.code==='invalid_credentials');checks++;}
  await assert.rejects(work.lookup(applicant.idToken));checks++;
  await assert.rejects(app.lookup(workspace.idToken));checks++;
  await assert.rejects(app.refresh(workspace.refreshToken));checks++;
  assert.equal((await app.refresh(applicant.refreshToken)).user.localId,applicant.user.localId);checks++;
  const setup=await work.startTotp(workspace.idToken);
  assert.equal(setup.hashingAlgorithm,'SHA1');assert.equal(setup.periodSec,30);
  await work.finishTotpEnrollment(workspace.idToken,setup.sessionInfo,totp(setup.sharedSecretKey));checks++;
  // Google rejects replaying the enrollment TOTP immediately for a new sign-in.
  await new Promise(resolve=>setTimeout(resolve,30000-Date.now()%30000+1000));
  const pending=await work.signIn(email,passwordW);assert.ok(pending.mfaPendingCredential);assert.equal(pending.idToken,undefined);checks++;
  const done=await work.finishMfa(pending.mfaPendingCredential,pending.factors[0].id,totp(setup.sharedSecretKey));
  assert.equal(done.user.localId,workspace.user.localId);checks++;
  // Generate a reset link without sending mail, then consume it in Applicant only.
  const action=await admin('sendOobCode',env.GIP_APPLICANT_TENANT_ID,{requestType:'PASSWORD_RESET',email,returnOobLink:true});
  const code=new URL(action.oobLink).searchParams.get('oobCode');
  await assert.rejects(work.checkEmailAction(code));checks++;
  const changed=randomBytes(24).toString('base64url');await app.resetPassword(code,changed);checks++;
  await assert.rejects(app.resetPassword(code,changed));checks++;
  await assert.rejects(app.signIn(email,passwordA));checks++;
  const changedApplicant=await app.signIn(email,changed);
  assert.equal(changedApplicant.user.localId,applicant.user.localId);checks++;
  assert.ok((await work.signIn(email,passwordW)).mfaPendingCredential);checks++;
  const workAction=await admin('sendOobCode',env.GIP_WORKSPACE_TENANT_ID,{requestType:'PASSWORD_RESET',email,returnOobLink:true});
  const workCode=new URL(workAction.oobLink).searchParams.get('oobCode');
  const changedWork=randomBytes(24).toString('base64url');
  await work.resetPassword(workCode,changedWork);
  assert.ok((await work.signIn(email,changedWork)).mfaPendingCredential,'Workspace reset must preserve its existing MFA requirement');checks++;
  assert.equal((await app.signIn(email,changed)).user.localId,applicant.user.localId);checks++;
  await admin('update',env.GIP_APPLICANT_TENANT_ID,{localId:applicant.user.localId,disableUser:true});
  await assert.rejects(app.lookup(changedApplicant.idToken));checks++;
  console.log(`PASS ${checks} live Dev GIP checks: separate passwords, verified email, token isolation, refresh, TOTP, reset isolation and reset replay. Runtime IAM: ${providerOnly?'NOT TESTED (operator setup)':'VERIFIED via WIF'}.`);
}finally{
  for(const [tenant,id] of cleanup)await admin('delete',tenant,{localId:id});
  console.log(`Removed ${cleanup.length} probe-created synthetic accounts. No emails sent; no business records touched.`);
}
