// Exercise the real Workers fetch implementation; Node fetch mocks missed an
// unsupported redirect mode and cannot replace this runtime regression check.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import * as runtime from 'miniflare';
import {generateKeyPair,exportPKCS8} from 'jose';
const {privateKey}=await generateKeyPair('RS256',{extractable:true});
const credential={privateKey:await exportPKCS8(privateKey),kid:'runtime-fixture',issuer:'https://dev.starreusa.com/workload-identity',subject:'star-website-staging',audience:'//iam.googleapis.com/projects/54640971372/locations/global/workloadIdentityPools/star-dev-auth/providers/cloudflare-worker',serviceAccount:'star-dev-auth-runtime@starreusa-dev-auth.iam.gserviceaccount.com'};
const env={ACCOUNT_SECURITY:'on',GIP_PROJECT_ID:'starreusa-dev-auth',GIP_API_KEY:'fixture',GIP_APPLICANT_TENANT_ID:'applicant-test',GIP_WORKSPACE_TENANT_ID:'workspace-test',GIP_WORKLOAD_IDENTITY:JSON.stringify(credential)};
const {outputFiles}=await build({stdin:{contents:`
import {createGipClient} from './worker/gip.js';
import {createGipAdmin} from './worker/gip-admin.js';
export default {async fetch(request,env){try {
  if(new URL(request.url).pathname==='/admin')return Response.json({user:await createGipAdmin(env,'workspace').findByEmail('fixture@example.invalid')});
  await createGipClient(env,'workspace').signIn('fixture@example.invalid','synthetic-password');
  return Response.json({unexpected:true});
}catch(e){return Response.json({error:e.message},{status:e.status||500});}}};`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
let redirect=false,requests=[];
const options={modules:true,script:outputFiles[0].text,compatibilityDate:'2026-07-01',bindings:env,outboundService:async request=>{
  const url=new URL(request.url);requests.push(url.hostname);
  if(redirect)return new Response(null,{status:307,headers:{Location:'https://must-not-follow.example.invalid/'}});
  if(url.hostname==='sts.googleapis.com')return Response.json({access_token:'synthetic-sts'});
  if(url.hostname==='iamcredentials.googleapis.com')return Response.json({accessToken:'synthetic-access'});
  if(url.pathname.endsWith(':lookup'))return Response.json({users:[]});
  return Response.json({error:{message:'INVALID_LOGIN_CREDENTIALS'}},{status:400});
}};
const mf=new runtime.Miniflare(runtime.convertV4MiniflareOptions?runtime.convertV4MiniflareOptions(options):options);
try {
  let response=await mf.dispatchFetch('http://localhost/admin');
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{user:null});
  assert.deepEqual(requests,['sts.googleapis.com','iamcredentials.googleapis.com','identitytoolkit.googleapis.com']);
  response=await mf.dispatchFetch('http://localhost/login');assert.equal(response.status,401);
  assert.match((await response.json()).error,/Email or password/);
  redirect=true;
  for(const path of ['/admin','/login']){
    requests=[];response=await mf.dispatchFetch('http://localhost'+path);
    assert.equal(response.status,503);assert.equal(requests.length,1);
    assert.ok(!requests.includes('must-not-follow.example.invalid'));
  }
  console.log('PASS Workers runtime: credential exchange, login errors, and no credential-bearing redirects.');
} finally {await mf.dispose();}
