import assert from 'node:assert/strict';
import {generateKeyPair,exportPKCS8,jwtVerify} from 'jose';
import {createGipAdmin} from '../worker/gip-admin.js';
const {privateKey,publicKey}=await generateKeyPair('RS256',{extractable:true});
const credential={privateKey:await exportPKCS8(privateKey),kid:'synthetic-key',issuer:'https://dev.starreusa.com/workload-identity',subject:'star-website-staging',audience:'//iam.googleapis.com/projects/54640971372/locations/global/workloadIdentityPools/star-dev-auth/providers/cloudflare-worker',serviceAccount:'star-dev-auth-runtime@starreusa-dev-auth.iam.gserviceaccount.com'};
const env={ACCOUNT_SECURITY:'on',GIP_PROJECT_ID:'starreusa-dev-auth',GIP_API_KEY:'test-key',GIP_APPLICANT_TENANT_ID:'applicant-test',GIP_WORKSPACE_TENANT_ID:'workspace-test',GIP_WORKLOAD_IDENTITY:JSON.stringify(credential)};
const email='invited@example.invalid';
let mode='',exchanges=0,checks=0,created=0;
const fetcher=async (url,options)=>{
  assert.equal(options.redirect,'manual');assert.ok(options.signal);
  const u=new URL(url),body=JSON.parse(options.body);
  if(u.hostname==='sts.googleapis.com'){
    exchanges++;
    assert.equal(body.audience,credential.audience);
    const {payload,protectedHeader}=await jwtVerify(body.subjectToken,publicKey,{issuer:credential.issuer,audience:credential.audience,subject:credential.subject,algorithms:['RS256']});
    assert.equal(protectedHeader.kid,credential.kid);assert.ok(payload.exp-payload.iat<=300);
    if(mode==='sts-failure')return Response.json({error:{message:'secret-assertion-private-details'}},{status:403});
    return Response.json({access_token:'synthetic-sts-token'});
  }
  if(u.hostname==='iamcredentials.googleapis.com'){
    assert.equal(u.pathname,`/v1/projects/-/serviceAccounts/${credential.serviceAccount}:generateAccessToken`);
    assert.equal(options.headers.Authorization,'Bearer synthetic-sts-token');
    assert.deepEqual(body,{scope:['https://www.googleapis.com/auth/identitytoolkit'],lifetime:'600s'});
    if(mode==='iam-failure')return Response.json({error:{message:'secret-credential-details'}},{status:403});
    return Response.json({accessToken:'synthetic-runtime-token'});
  }
  assert.equal(u.hostname,'identitytoolkit.googleapis.com');
  assert.equal(options.headers.Authorization,'Bearer synthetic-runtime-token');
  if(mode==='api-failure')return Response.json({error:{message:'provider-sensitive-details'}},{status:400});
  if(u.pathname==='/v1/accounts:signUp'){
    assert.equal(body.tenantId,'workspace-test');assert.equal(body.targetProjectId,'starreusa-dev-auth');
    assert.equal(body.emailVerified,false);assert.match(body.password,/^[a-f0-9]{64}$/);created++;
    return Response.json({localId:'workspace-uid'});
  }
  assert.ok(u.pathname.startsWith('/v1/projects/starreusa-dev-auth/tenants/workspace-test/accounts:'));
  if(u.pathname.endsWith(':lookup'))return Response.json({users:[{localId:'workspace-uid',email,tenantId:mode==='wrong-tenant'?'applicant-test':'workspace-test',emailVerified:false,passwordHash:'must-not-return'}]});
  if(u.pathname.endsWith(':sendOobCode')){
    assert.equal(body.returnOobLink,true);assert.ok(['VERIFY_EMAIL','PASSWORD_RESET'].includes(body.requestType));
    const link=new URL('https://starreusa-dev-auth.firebaseapp.com/__/auth/action');link.searchParams.set('tenantId',mode==='wrong-link-tenant'?'applicant-test':'workspace-test');link.searchParams.set('oobCode','synthetic-oob');
    if(mode==='evil-link')link.hostname='other.example.invalid';
    return Response.json({oobLink:link.href});
  }
  throw new Error('Unexpected endpoint');
};
const client=createGipAdmin(env,'workspace',{fetcher});
assert.deepEqual(await client.createInvited(email),{id:'workspace-uid',email});checks++;
const user=await client.findByEmail(email);assert.equal(user.passwordHash,undefined);assert.equal(user.tenantId,'workspace-test');checks++;
assert.deepEqual(await client.emailAction(email,'PASSWORD_RESET'),{code:'synthetic-oob',tenantId:'workspace-test'});checks++;
assert.equal(exchanges,1,'Only this request-scoped client reuses its short-lived token');checks++;
for(const next of ['wrong-tenant','wrong-link-tenant','evil-link','api-failure']){
  mode=next;await assert.rejects(next==='wrong-tenant'?client.findByEmail(email):client.emailAction(email,'VERIFY_EMAIL'),e=>e.status===503&&!e.message.includes('sensitive'));checks++;
}
for(const next of ['sts-failure','iam-failure']){mode=next;await assert.rejects(createGipAdmin(env,'workspace',{fetcher}).findByEmail(email),e=>e.status===503&&!e.message.includes('secret'));checks++;}
const before=created;
await assert.rejects(createGipAdmin(env,'applicant',{fetcher}).createInvited(email),e=>e.status===503);checks++;
assert.equal(created,before);checks++;
for(const changed of [{subject:'other-worker'},{issuer:'https://evil.example.invalid'},{serviceAccount:'other@starreusa-dev-auth.iam.gserviceaccount.com'},{audience:'other-provider'}]){assert.throws(()=>createGipAdmin({...env,GIP_WORKLOAD_IDENTITY:JSON.stringify({...credential,...changed})},'workspace'),e=>e.status===503);checks++;}
assert.throws(()=>createGipAdmin({...env,GIP_PROJECT_ID:'starreusa-prod-auth'},'workspace'),e=>e.status===503);checks++;
console.log(`PASS ${checks} Dev workload identity, credential confinement and invitation adapter checks.`);
