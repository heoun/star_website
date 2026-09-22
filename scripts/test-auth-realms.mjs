// Same mailbox, independent providers and business identities. No live services.
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {schemaBundle} from './release-schema.mjs';
import {authConfig,handleAuthRequest,readSession} from '../worker/auth.js';
import {makeRealAuth} from '../backend/adapters/auth-real/index.ts';
const db=new PGlite(),nativeFetch=globalThis.fetch;let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const rejects=async f=>{await assert.rejects(f);checks++;};
const env={ACCOUNT_SECURITY:'on',APPLICANT_AUTH_MODE:'isolated',SUPABASE_URL:'https://workspace.example.test',SUPABASE_PUBLISHABLE_KEY:'workspace-public',SUPABASE_SERVICE_ROLE_KEY:'business-service',APPLICANT_AUTH_URL:'https://applicant.example.test',APPLICANT_AUTH_PUBLISHABLE_KEY:'applicant-public'};
const issuer=env.APPLICANT_AUTH_URL+'/auth/v1',email='same-mailbox@example.test';
const providers=new Map(['workspace','applicant'].map(realm=>[`${realm}.example.test`,{users:new Map(),tokens:new Map(),refresh:new Map(),codes:new Map()}]));
const calls=[],pending=[];const ctx={waitUntil(p){pending.push(p)}};
const reply=(b,status=200)=>Response.json(b,{status});
const makeUser=(p,email,password,id=crypto.randomUUID())=>{const u={id,email,password,email_confirmed_at:new Date().toISOString()};p.users.set(email,u);return u};
const staffProvider=providers.get('workspace.example.test'),appProvider=providers.get('applicant.example.test');
const staff=makeUser(staffProvider,email,'staff-only-password');staff.factors=[{id:crypto.randomUUID(),factor_type:'totp',status:'verified'}];
const applicant=makeUser(appProvider,email,'applicant-only-password');
const jwt=u=>[Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:u.id,aal:'aal1',amr:[]})).toString('base64url'),crypto.randomUUID()].join('.');
const issue=(p,u)=>{const at=jwt(u),rt=crypto.randomUUID();p.tokens.set(at,u);p.refresh.set(rt,u);return {user:u,access_token:at,refresh_token:rt}};
const rpc=async(name,body)=>(await db.query(`select public.${name}(${Object.keys(body).map((k,i)=>`${k}=>$${i+1}`).join(',')}) result`,Object.values(body))).rows[0].result;
const request=(realm,path,body,cookie='')=>new Request(`https://site.example.test${realm==='workspace'?'/api/auth/workspace/':'/api/portal/'}${path}`,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json',Origin:'https://site.example.test'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
const call=(realm,path,body,cookie='',configuration=env)=>handleAuthRequest(request(realm,path,body,cookie),configuration,ctx,path);
const cookie=r=>r.headers.getSetCookie().find(c=>c.startsWith('star_workspace=')||c.startsWith('star_portal='))?.split(';')[0];
try {
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean default false,encrypted_password text);create schema storage;create table storage.buckets(id text primary key,name text,public boolean);create table storage.objects(id uuid,bucket_id text,name text);alter table storage.objects enable row level security;');
 await db.exec(schemaBundle());
 await db.query('insert into auth.users(id,email,email_confirmed_at,encrypted_password) values($1,$2,now(),$3)',[staff.id,email,'unchanged-password-hash']);
 const oldId=await rpc('resolve_business_identity',{p_subject:staff.id,p_email:email});
 await db.query("insert into staff(email,role,name,active,user_id,auth_user_id,access_state) values($1,'manager','Staff',true,$2,$3,'active')",[email,oldId,staff.id]);
 const listing=(await db.query("insert into listings(title,category,transaction_type) values('Realm fixture','residential','rental') returning id")).rows[0].id;
 const application=(await db.query('insert into applications(listing_id,email,name,workspace) values($1,$2,$3,$4) returning *',[listing,email,'Applicant',{test_run:{account_id:staff.id}}])).rows[0];
 const draft=crypto.randomUUID();
 await db.query('select save_rental_draft($1,$2,$3,$4,$5,$6)',[draft,listing,staff.id,email,[],{account_id:staff.id}]);
 await db.query('insert into applicant_auth_config(issuer) values($1)',[issuer]);
 await rejects(()=>rpc('resolve_applicant_identity',{p_subject:applicant.id,p_email:email,p_issuer:issuer}));
 await rejects(()=>db.query('update applicant_auth_config set enabled=true'));
 await db.query('update app_users set active=false where id=$1',[oldId]);
 const newId=await rpc('migrate_applicant_identity',{p_old_subject:staff.id,p_new_subject:applicant.id,p_email:email,p_issuer:issuer});
 assert.notEqual(newId,oldId);checks++;
 eq((await db.query('select active from app_users where id=$1',[newId])).rows[0].active,false);
 await db.query('update app_users set active=true where id=any($1::uuid[])',[[oldId,newId]]);
 eq(await rpc('migrate_applicant_identity',{p_old_subject:staff.id,p_new_subject:applicant.id,p_email:email,p_issuer:issuer}),newId);
 await rejects(()=>rpc('migrate_applicant_identity',{p_old_subject:staff.id,p_new_subject:crypto.randomUUID(),p_email:email,p_issuer:issuer}));
 eq((await db.query('select user_id from applications where id=$1',[application.id])).rows[0].user_id,newId);
 eq((await db.query('select owner_id from rental_drafts where id=$1',[draft])).rows[0].owner_id,applicant.id);
 eq((await db.query('select workspace from applications where id=$1',[application.id])).rows[0].workspace.test_run.account_id,applicant.id);
 eq((await db.query('select user_id,auth_user_id from staff where email=$1',[email])).rows[0],{user_id:oldId,auth_user_id:staff.id});
 eq((await db.query('select encrypted_password from auth.users where id=$1',[staff.id])).rows[0].encrypted_password,'unchanged-password-hash');
 await rejects(()=>db.query('update applications set user_id=$1 where id=$2',[oldId,application.id]));
 await db.query('update applicant_auth_config set enabled=true');
 eq(await rpc('resolve_applicant_identity',{p_subject:applicant.id,p_email:email,p_issuer:issuer}),newId);
 await rejects(()=>rpc('resolve_applicant_identity',{p_subject:crypto.randomUUID(),p_email:email,p_issuer:issuer}));
 await rejects(()=>rpc('resolve_applicant_identity',{p_subject:applicant.id,p_email:email,p_issuer:env.SUPABASE_URL+'/auth/v1'}));
 // New applications bind to the applicant, never the same-email manager.
 eq((await db.query('insert into applications(listing_id,email,name) values($1,$2,$3) returning user_id',[listing,email,'Second application'])).rows[0].user_id,newId);
 await rejects(()=>db.query('insert into applications(listing_id,email,name,user_id) values($1,$2,$3,$4)',[listing,email,'Forged identity',oldId]));
 // Replaying the bundle must not reattach a previously unpinned row to staff.
 const unpinnedEmail='historical@example.test',unpinnedSubject=crypto.randomUUID();
 await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[unpinnedSubject,unpinnedEmail]);
 const unpinned=(await db.query('insert into applications(listing_id,email,name) values($1,$2,$3) returning id',[listing,unpinnedEmail,'Historical fixture'])).rows[0].id;
 // Bundled schema can be reapplied after the cutover without repinning applicants.
 await db.exec(schemaBundle());
 eq((await db.query('select user_id from applications where id=$1',[application.id])).rows[0].user_id,newId);
 eq(await rpc('resolve_business_identity',{p_subject:staff.id,p_email:email}),oldId);
 eq((await db.query('select user_id from applications where id=$1',[unpinned])).rows[0].user_id,null);
 for(const role of ['anon','authenticated']){
  await db.exec(`set role ${role}`);
  await rejects(()=>rpc('resolve_applicant_identity',{p_subject:applicant.id,p_email:email,p_issuer:issuer}));
 await rejects(()=>db.query('update applicant_auth_config set enabled=true'));
  await rejects(()=>rpc('migrate_applicant_identity',{p_old_subject:staff.id,p_new_subject:applicant.id,p_email:email,p_issuer:issuer}));
  await rejects(()=>db.query('select * from applicant_identity_migrations'));
  await db.exec('reset role');
 }
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(input),body=init.body?JSON.parse(init.body):{},token=new Headers(init.headers).get('Authorization')?.replace('Bearer ','');calls.push({host:url.host,path:url.pathname});
  if(url.pathname.startsWith('/rest/v1/rpc/')){try{return reply(await rpc(url.pathname.split('/').at(-1),body))}catch{return reply({message:'Denied'},403)}}
  const p=providers.get(url.host);if(!p)throw Error('Unexpected destination');
  eq(new Headers(init.headers).get('apikey'),url.host.startsWith('applicant')?'applicant-public':'workspace-public');
  if(url.pathname==='/auth/v1/signup'){
   if(p.users.has(body.email)){const u=p.users.get(body.email);if(u.email_confirmed_at)return reply({user:{identities:[]}});p.codes.set(body.email,'123456');return reply({user:{id:u.id,identities:[{id:u.id}]}});}
   const u=makeUser(p,body.email,body.password);u.email_confirmed_at=null;p.codes.set(body.email,'123456');return reply({user:{id:u.id,identities:[{id:u.id}]}});
  }
  if(url.pathname==='/auth/v1/token'){
   if(url.searchParams.get('grant_type')==='refresh_token'){const u=p.refresh.get(body.refresh_token);if(!u)return reply({},401);p.refresh.delete(body.refresh_token);return reply(issue(p,u))}
   const u=p.users.get(body.email);return u&&u.password===body.password?reply(issue(p,u)):reply({message:'Invalid login credentials'},401);
  }
  if(url.pathname==='/auth/v1/user'){
   const u=p.tokens.get(token);if(!u)return reply({},401);
   if(init.method==='PUT'){if(u.password===body.password)return reply({code:'same_password'},422);u.password=body.password;}
   return reply(u);
  }
  if(['/auth/v1/recover','/auth/v1/resend'].includes(url.pathname)){if(p.users.has(body.email))p.codes.set(body.email,'123456');return reply({})}
  if(url.pathname==='/auth/v1/verify'){
   const u=p.users.get(body.email);if(!u||p.codes.get(body.email)!==body.token)return reply({},401);p.codes.delete(body.email);u.email_confirmed_at ||=new Date().toISOString();return reply(issue(p,u));
  }
  if(url.pathname==='/auth/v1/logout'){const u=p.tokens.get(token);p.tokens.delete(token);for(const[rt,row]of p.refresh)if(row===u)p.refresh.delete(rt);return reply({})}
  throw Error('Unexpected request '+url.pathname);
 };
 await db.query('update app_users set active=false where id=$1',[newId]);
 const suspendedLogin=await call('applicant','login',{email,password:'applicant-only-password'});
 eq(suspendedLogin.status,403);eq(suspendedLogin.headers.getSetCookie(),[]);
 await db.query('update app_users set active=true where id=$1',[newId]);
 let r=await call('workspace','login',{email,password:'staff-only-password'});eq(r.status,200);const staffCookie=cookie(r);
 r=await call('applicant','login',{email,password:'applicant-only-password'});eq(r.status,200);let appCookie=cookie(r);
 eq((await call('applicant','login',{email,password:'staff-only-password'})).status,401);
 eq((await call('workspace','login',{email,password:'applicant-only-password'})).status,401);
 const both=staffCookie+'; '+appCookie;
 eq((await readSession(request('applicant','me',undefined,both),env,'applicant')).user_id,newId);
 eq((await readSession(request('workspace','me',undefined,both),env,'workspace')).user_id,oldId);
 eq(await readSession(request('applicant','me',undefined,staffCookie.replace('star_workspace=','star_portal=')),env,'applicant'),null);
 eq(await readSession(request('workspace','me',undefined,appCookie.replace('star_portal=','star_workspace=')),env,'workspace'),null);
 const principal=await makeRealAuth(env).resolve(new Request('https://site.example.test/api/v2/me',{headers:{Cookie:both}}));
 eq(principal.kind,'applicant');eq(principal.id,newId);
 // A staff-only mailbox can register independently; workspace registration remains closed.
 makeUser(staffProvider,'new-applicant@example.test','staff-password');
 r=await call('applicant','register',{email:'new-applicant@example.test',password:'new-applicant-password'});eq(r.status,200);
 eq(appProvider.users.get('new-applicant@example.test').password,'new-applicant-password');
 eq(staffProvider.users.get('new-applicant@example.test').password,'staff-password');
 eq((await call('workspace','register',{email:'new-applicant@example.test',password:'bad-route-password'})).status,404);
 eq((await call('applicant','verify-register',{email:'new-applicant@example.test',code:'123456',password:'new-applicant-password'})).status,200);
 eq((await call('applicant','register',{email,password:'must-not-replace'})).status,409);
 // Supabase preserves an existing unconfirmed record's password on signup.
 // Mailbox verification must install the password the applicant actually chose.
 const reserved=makeUser(appProvider,'reserved@example.test',undefined);reserved.email_confirmed_at=null;
 eq((await call('applicant','register',{email:reserved.email,password:'chosen-password'})).status,200);
 eq(reserved.password,undefined);
 eq((await call('applicant','verify-register',{email:reserved.email,code:'123456'})).status,422);
 eq((await call('applicant','verify-register',{email:reserved.email,code:'999999',password:'attacker-password'})).status,401);
 eq(reserved.password,undefined);
 eq((await call('applicant','verify-register',{email:reserved.email,code:'123456',password:'chosen-password'})).status,200);
 eq((await call('applicant','login',{email:reserved.email,password:'chosen-password'})).status,200);
 eq((await call('applicant','verify-register',{email:reserved.email,code:'123456',password:'replayed-password'})).status,401);
 eq(reserved.password,'chosen-password');
 // Applicant recovery changes only that provider, even with workspace MFA present.
 eq((await call('applicant','request-reset',{email})).status,200);
 r=await call('applicant','verify-reset',{email,code:'123456',password:'applicant-reset-password'});eq(r.status,200);appCookie=cookie(r);
 eq(staff.password,'staff-only-password');eq(staff.factors[0].status,'verified');
 eq((await call('applicant','login',{email,password:'applicant-only-password'})).status,401);
 eq((await call('applicant','login',{email,password:'applicant-reset-password'})).status,200);
 eq((await call('workspace','login',{email,password:'staff-only-password'})).status,200);
 // Expiry refresh must remain in the applicant provider, then scope-local logout.
 const packed=JSON.parse(Buffer.from(appCookie.split('=')[1],'base64url').toString());appProvider.tokens.delete(packed.at);
 const refreshed=await readSession(request('applicant','me',undefined,appCookie),env,'applicant');eq(refreshed.user_id,newId);assert.ok(refreshed.setCookie);checks++;
 appCookie=refreshed.setCookie.split(';')[0];
 eq((await call('applicant','sign-out',{},appCookie+'; '+staffCookie)).status,200);await Promise.all(pending);
 eq((await readSession(request('workspace','me',undefined,staffCookie),env,'workspace')).user_id,oldId);
 // Missing, shared or insecure applicant config rejects without touching either provider.
 for(const bad of [{APPLICANT_AUTH_URL:''},{APPLICANT_AUTH_PUBLISHABLE_KEY:''},{APPLICANT_AUTH_URL:env.SUPABASE_URL},{APPLICANT_AUTH_URL:'http://unsafe.example.test'},{APPLICANT_AUTH_MODE:'misspelled'},{ACCOUNT_SECURITY:'off'},{APPLICANT_AUTH_MODE:'maintenance'},{APPLICANT_AUTH_URL:'https://WORKSPACE.example.test/'},{APPLICANT_AUTH_URL:'https://user:secret@applicant.example.test'}]){
  const badEnv={...env,...bad},n=calls.length;eq(authConfig(badEnv,'applicant'),null);eq((await call('applicant','login',{email,password:'staff-only-password'},'',badEnv)).status,503);eq(calls.length,n);
 }
 if(process.argv.includes('--ui')){
  const reservedBrowser=makeUser(appProvider,'browser-reserved@example.test',undefined);reservedBrowser.email_confirmed_at=null;
  await (await import('./test-auth-realms-ui.mjs')).testRealmUi(env,ctx,email,staff.password,applicant.password,reservedBrowser.email);
  eq(reservedBrowser.password,'browser-reset-password');eq(staff.password,'staff-only-password');
 }
 console.log(`PASS ${checks} auth realm checks: independent same-email passwords, registration, recovery, MFA preservation, cookies, refresh, logout, principal scope, identity/data migration, schema replay and fail-closed configuration.`);
}finally{globalThis.fetch=nativeFetch;await db.close()}
