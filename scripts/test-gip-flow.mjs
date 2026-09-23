// Full Worker routes with real signed JWTs and the real business schema; only
// Google/Resend transports are replaced. No network or live account writes.
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {generateKeyPair,exportJWK,SignJWT,exportPKCS8} from 'jose';
import {schemaBundle} from './release-schema.mjs';
import worker from '../worker/index.js';
import {gipSessionCookie} from '../worker/gip-session.js';
import {hashInvitation} from '../worker/account-security.js';
const db=new PGlite(),nativeFetch=globalThis.fetch;let checks=0;
const {privateKey,publicKey}=await generateKeyPair('RS256',{extractable:true});
const env={AUTH_PROVIDER:'gip',ACCOUNT_SECURITY:'on',GIP_PROJECT_ID:'starreusa-dev-auth',GIP_API_KEY:'test-key',GIP_APPLICANT_TENANT_ID:'Applicant-test',GIP_WORKSPACE_TENANT_ID:'Workspace-test',SUPABASE_URL:'https://business.example.test',SUPABASE_SERVICE_ROLE_KEY:'business-only',AUTH_LINK_SECRET:'synthetic-test-challenge-encryption-key-32',SITE_ORIGIN:'https://site.example.test',RESEND_API_KEY:'synthetic-mail-key'};
env.GIP_WORKLOAD_IDENTITY=JSON.stringify({privateKey:await exportPKCS8(privateKey),kid:'test-workload',issuer:'https://dev.starreusa.com/workload-identity',subject:'star-website-staging',audience:'//iam.googleapis.com/projects/54640971372/locations/global/workloadIdentityPools/star-dev-auth/providers/cloudflare-worker',serviceAccount:'star-dev-auth-runtime@starreusa-dev-auth.iam.gserviceaccount.com'});
const tenant=scope=>scope==='workspace'?env.GIP_WORKSPACE_TENANT_ID:env.GIP_APPLICANT_TENANT_ID;
const users=new Map(),tokens=new Map(),pending=new Map(),refresh=new Map(),actions=new Map(),mails=[],jars=new Map();
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const rpc=async(name,body)=>(await db.query(`select public.${name}(${Object.keys(body).map((k,i)=>`${k}=>$${i+1}`).join(',')}) result`,Object.values(body))).rows[0].result;
function add(scope,email,password,id,verified=true,mfa=false){const u={localId:id,email,password,emailVerified:verified,tenantId:tenant(scope),mfaInfo:mfa?[{mfaEnrollmentId:'factor-'+id,totpInfo:{}}]:[]};users.set(u.tenantId+':'+email,u);return u;}
async function issue(u,mfa=false,age=0){const now=Math.floor(Date.now()/1000);const claims={sub:u.localId,email:u.email,email_verified:u.emailVerified,iss:'https://securetoken.google.com/'+env.GIP_PROJECT_ID,aud:env.GIP_PROJECT_ID,iat:now,exp:now+3600,auth_time:now-age,firebase:{tenant:u.tenantId,sign_in_provider:'password',...(mfa?{sign_in_second_factor:'totp',second_factor_identifier:u.mfaInfo[0].mfaEnrollmentId}:{})}};const idToken=await new SignJWT(claims).setProtectedHeader({alg:'RS256',kid:'google-test'}).sign(privateKey);const refreshToken=crypto.randomUUID();tokens.set(idToken,u);refresh.set(refreshToken,{u,mfa});return {idToken,refreshToken};}
function cookies(r,jar){for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');if(pair.slice(i+1))jar.set(pair.slice(0,i),pair.slice(i+1));else jar.delete(pair.slice(0,i));}}
async function call(scope,resource,body={},jarName='shared',headers={}){let jar=jars.get(jarName);if(!jar){jar=new Map();jars.set(jarName,jar);}const url='https://site.example.test'+(scope==='workspace'?'/api/auth/workspace/':'/api/portal/')+resource;const r=await worker.fetch(new Request(url,{method:body===null?'GET':'POST',headers:{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),Origin:'https://site.example.test','Content-Type':'application/json',...headers},...(body===null?{}:{body:JSON.stringify(body)})}),env,{waitUntil(p){p.catch(()=>{});}});cookies(r,jar);return r;}
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean default false,encrypted_password text);create schema storage;create table storage.buckets(id text primary key,name text,public boolean);create table storage.objects(id uuid,bucket_id text,name text);alter table storage.objects enable row level security;');
 await db.exec(schemaBundle());
 const ownerOld=crypto.randomUUID(),same='same@example.invalid';
 await db.query('insert into auth.users(id,email,email_confirmed_at,encrypted_password) values($1,$2,now(),$3)',[ownerOld,'info@starreusa.com','source-hash']);
 const ownerId=await rpc('bootstrap_platform_owner',{p_subject:ownerOld,p_email:'info@starreusa.com'});
 for(const scope of ['workspace','applicant'])await db.query('insert into gip_auth_realms(realm,project_id,tenant_id) values($1,$2,$3)',[scope,env.GIP_PROJECT_ID,tenant(scope)]);
 await rpc('migrate_gip_identity',{p_old_subject:ownerOld,p_new_subject:'owner-google',p_email:'info@starreusa.com',p_realm:'workspace',p_project:env.GIP_PROJECT_ID,p_tenant:tenant('workspace')});
 await db.exec('update gip_auth_realms set enabled=true');
 const owner=add('workspace','info@starreusa.com','owner-password','owner-google',true,true);
 const applicant=add('applicant',same,'applicant-password','applicant-google');
 const invite='a'.repeat(64);
 await db.query("insert into staff(email,role,active,access_state) values($1,'agent',true,'invited')",[same]);
 await db.query("insert into workspace_invitations(email,role,token_hash,expires_at) values($1,'agent',$2,now()+interval '1 day')",[same,await hashInvitation(invite)]);
 globalThis.fetch=async(input,options={})=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  const body=options.body?(url.hostname==='securetoken.googleapis.com'?Object.fromEntries(new URLSearchParams(options.body)):JSON.parse(options.body)):{};
  const ok=Response.json,fail=(message,status=400)=>Response.json({error:{message}},{status});
  if(url.hostname==='www.googleapis.com')return ok({keys:[{...await exportJWK(publicKey),kid:'google-test',alg:'RS256',use:'sig'}]});
  if(url.hostname==='sts.googleapis.com')return ok({access_token:'synthetic-sts'});
  if(url.hostname==='iamcredentials.googleapis.com')return ok({accessToken:'synthetic-runtime'});
  if(url.hostname==='api.resend.com'){mails.push(body);return ok({id:crypto.randomUUID()});}
  if(url.hostname==='securetoken.googleapis.com'){const found=refresh.get(body.refresh_token);if(!found)return fail('INVALID_REFRESH_TOKEN');const r=await issue(found.u,found.mfa);return ok({id_token:r.idToken,refresh_token:r.refreshToken});}
  if(url.hostname==='business.example.test'){
   if(url.pathname.startsWith('/rest/v1/rpc/')){try{return ok(await rpc(url.pathname.split('/').at(-1),body));}catch{return Response.json({error:'Access denied'},{status:403});}}
   const table=url.pathname.split('/').at(-1);assert.ok(['staff','app_users','platform_owner','workspace_invitations','identity_audit'].includes(table),'Unexpected business table '+table);
   if(table==='identity_audit'){await db.query('insert into identity_audit(actor_id,acting_role,action,target_id,details) values($1,$2,$3,$4,$5)',[body.actor_id,body.acting_role,body.action,body.target_id,body.details]);return ok([]);}
   const clauses=[],values=[];for(const [key,value] of url.searchParams){if(['email','realm','user_id','token_hash'].includes(key)){assert.ok(value.startsWith('eq.'));values.push(value.slice(3));clauses.push(key+'=$'+values.length);}}
   return ok((await db.query('select * from '+table+(clauses.length?' where '+clauses.join(' and '):''),values)).rows);
  }
  assert.equal(url.hostname,'identitytoolkit.googleapis.com','No unexpected network requests');
  const path=url.pathname,scopeTenant=body.tenantId||path.match(/\/tenants\/([^/]+)\//)?.[1];
  if(path.endsWith('accounts:lookup')){
   if(body.idToken){const u=tokens.get(body.idToken);return u?ok({users:[u]}):fail('INVALID_ID_TOKEN');}
   const u=users.get(scopeTenant+':'+body.email[0]);return ok({users:u?[u]:[]});
  }
  if(path.endsWith('accounts:signUp')){
   if(scopeTenant===tenant('workspace')&&!options.headers.Authorization)return fail('OPERATION_NOT_ALLOWED');
   if(users.has(scopeTenant+':'+body.email))return fail('EMAIL_EXISTS');
   const u=add(scopeTenant===tenant('workspace')?'workspace':'applicant',body.email,body.password,crypto.randomUUID(),false);
   return options.headers.Authorization?ok({localId:u.localId}):ok(await issue(u));
  }
  if(path.endsWith('accounts:signInWithPassword')){
   const u=users.get(scopeTenant+':'+body.email);if(!u||u.password!==body.password)return fail('INVALID_LOGIN_CREDENTIALS');
   if(u.mfaInfo.length){const id=crypto.randomUUID();pending.set(id,u);return ok({mfaPendingCredential:id,mfaInfo:u.mfaInfo});}
   return ok(await issue(u));
  }
  if(path.endsWith('mfaSignIn:finalize')){
   const u=pending.get(body.mfaPendingCredential);if(!u||u.tenantId!==scopeTenant||body.totpVerificationInfo.verificationCode!=='123456'||u.mfaInfo[0].mfaEnrollmentId!==body.mfaEnrollmentId)return fail('INVALID_CODE');
   pending.delete(body.mfaPendingCredential);return ok(await issue(u,true));
  }
  if(path.endsWith('accounts:sendOobCode')){
   assert.equal(body.returnOobLink,true);const u=users.get(scopeTenant+':'+body.email);if(!u)return fail('EMAIL_NOT_FOUND');
   const code=crypto.randomUUID();actions.set(code,{u,type:body.requestType});return ok({oobLink:`https://starreusa-dev-auth.firebaseapp.com/__/auth/action?tenantId=${scopeTenant}&oobCode=${code}`});
  }
  if(path.endsWith('accounts:resetPassword')){
   const action=actions.get(body.oobCode);if(!action||action.u.tenantId!==scopeTenant)return fail('INVALID_OOB_CODE');
   if(body.newPassword){if(action.type!=='PASSWORD_RESET')return fail('INVALID_OOB_CODE');action.u.password=body.newPassword;action.u.emailVerified=true;actions.delete(body.oobCode);}
   return ok({email:action.u.email,requestType:action.type});
  }
  if(path.endsWith('accounts:update')){const action=actions.get(body.oobCode);if(!action||action.type!=='VERIFY_EMAIL'||action.u.tenantId!==scopeTenant)return fail('INVALID_OOB_CODE');action.u.emailVerified=true;actions.delete(body.oobCode);return ok({email:action.u.email,emailVerified:true});}
  throw Error('Unexpected Google path '+path);
 };
 let r=await call('workspace','login',{email:owner.email,password:owner.password});eq(r.status,200);const mfa=await r.json();eq(mfa.mfa_required,true);eq(jars.get('shared').has('star_workspace'),false);
 eq((await call('workspace','security')).status,401);
 const pendingCookie=jars.get('shared').get('star_workspace_gip_challenge');assert.ok(pendingCookie.split('.').length===5);checks++;
 eq((await call('workspace','mfa-login',{factor_id:mfa.factors[0].id,code:'000000'})).status,401);
 eq((await call('workspace','mfa-login',{factor_id:mfa.factors[0].id,code:'123456'})).status,200);
 eq(jars.get('shared').has('star_workspace_gip_challenge'),false);
 let security=await (await call('workspace','security')).json();eq(security.owner_account,true);eq(security.verified,true);eq(security.setup_password,false);
 // Inline step-up preserves the existing session until password + TOTP pass.
 cookies(new Response(null,{headers:{'Set-Cookie':gipSessionCookie(new Request('https://site.example.test'),'workspace',await issue(owner,true,1800))}}),jars.get('shared'));
 eq((await (await call('workspace','security')).json()).recent_mfa,false);
 const oldSession=jars.get('shared').get('star_workspace');
 eq((await call('workspace','reauth-start',{password:'wrong'})).status,401);
 eq(jars.get('shared').get('star_workspace'),oldSession);
 eq((await call('workspace','reauth-start',{password:owner.password},'anonymous')).status,401);
 eq((await call('workspace','reauth-start',{password:owner.password},'shared',{Origin:'https://evil.example'})).status,403);
 const step=await (await call('workspace','reauth-start',{email:'ignored@example.test',password:owner.password})).json();
 eq(jars.get('shared').get('star_workspace'),oldSession);
 eq((await call('workspace','mfa-login',{factor_id:step.factors[0].id,code:'123456'})).status,401);
 eq((await call('workspace','reauth-verify',{factor_id:'unlisted',code:'123456'})).status,403);
 eq((await call('workspace','reauth-verify',{factor_id:step.factors[0].id,code:'000000'})).status,401);
 eq((await (await call('workspace','security')).json()).recent_mfa,false);
 eq((await call('workspace','reauth-verify',{factor_id:step.factors[0].id,code:'123456'})).status,200);
 eq((await (await call('workspace','security')).json()).recent_mfa,true);
 eq((await call('workspace','reauth-verify',{factor_id:step.factors[0].id,code:'123456'})).status,403);
 eq((await call('workspace','owner-admin',{enabled:true,version:security.owner_version,reason:'Test separate role'})).status,200);
 eq((await call('applicant','login',{email:same,password:applicant.password})).status,200);
 eq((await (await call('applicant','me',null)).json()).email,same);
 eq((await call('workspace','security')).status,200);
 eq((await call('applicant','login',{email:owner.email,password:owner.password})).status,401);
 eq((await call('workspace','login',{email:same,password:applicant.password},'other')).status,401);
 eq((await call('applicant','sign-out')).status,200);eq((await call('applicant','me',null)).status,401);eq((await call('workspace','security')).status,200);
 eq((await call('workspace','workspace-code',{email:same,invite},'member')).status,200);eq(mails.length,1);
 const activationUrl=new URL(mails[0].text.match(/https:\/\/site\.example\.test\/login\/#[^\s]+/)[0]),activationCode=new URLSearchParams(activationUrl.hash.slice(1)).get('oob');
 eq((await call('applicant','check-action',{code:activationCode})).status,400);
 eq((await call('workspace','verify-reset',{code:activationCode,password:'member-password',activation:true,invite},'member')).status,200);
 eq((await call('workspace','verify-reset',{code:activationCode,password:'new-password'},'member')).status,400);
 eq((await call('workspace','login',{email:same,password:'member-password'},'member')).status,200);
 eq((await call('workspace','security',{},'member')).status,403);
 eq((await call('workspace','workspace-accept',{invite},'member')).status,200);
 eq((await call('workspace','reauth-start',{password:owner.password})).status,200);
 jars.get('member').set('star_workspace_gip_challenge',jars.get('shared').get('star_workspace_gip_challenge'));
 eq((await call('workspace','reauth-verify',{factor_id:'factor-owner-google',code:'123456'},'member')).status,403);
 eq((await (await call('workspace','security',{},'member')).json()).email,same);

 eq((await call('workspace','workspace-accept',{invite},'member')).status,403);
 eq((await call('workspace','security',{},'member')).status,200);
 eq((await call('workspace','workspace-code',{email:same},'member')).status,403);
 eq((await call('applicant','login',{email:same,password:'member-password'})).status,401);
 eq((await call('applicant','login',{email:same,password:applicant.password})).status,200);
 eq((await call('workspace','request-reset',{email:owner.email})).status,200);
 const resetUrl=new URL(mails.at(-1).text.match(/https:\/\/site\.example\.test\/login\/#[^\s]+/)[0]),resetCode=new URLSearchParams(resetUrl.hash.slice(1)).get('oob');
 eq((await call('workspace','verify-reset',{code:resetCode,password:'changed-owner-password'})).status,200);
 eq((await call('workspace','security')).status,401);
 const again=await (await call('workspace','login',{email:owner.email,password:'changed-owner-password'})).json();eq(again.mfa_required,true);
 eq((await call('applicant','me',null)).status,200);
 eq((await call('workspace','request-reset',{email:owner.email})).status,429);
 eq((await call('workspace','login',{email:owner.email,password:'changed-owner-password'},'evil',{Origin:'https://evil.example.invalid'})).status,403);
 const slot=crypto.randomUUID();eq((await call('applicant','me',null,'shared',{'X-Applicant-Session':slot})).status,401);
 const before=await db.query('select user_id from platform_owner');eq(before.rows[0].user_id,ownerId);
 env.AUTH_MIGRATION='maintenance';
 eq((await call('workspace','login',{email:owner.email,password:owner.password})).status,503);
 eq((await call('applicant','me',null)).status,503);
 eq((await worker.fetch(new Request('https://site.example.test/api/release'),env,{})).status,200);
 delete env.AUTH_MIGRATION;
 console.log(`PASS ${checks} GIP Worker login, encrypted MFA challenge, invitation, email, reset and session isolation checks.`);
}finally{globalThis.fetch=nativeFetch;await db.close();}
