import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {schemaBundle} from './release-schema.mjs';
import {createIdentityFixture} from './identity-fixtures.mjs';
import worker from '../worker/index.js';
import {devIdentity} from '../worker/env.js';
import {hashInvitation,verifiedSessionClaims} from '../worker/account-security.js';
const db=new PGlite(),f=createIdentityFixture();let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const ownerEmail='info@starreusa.com',ownerId=crypto.randomUUID();f.user(ownerEmail,ownerId);
const env={...f.env,ACCOUNT_SECURITY:'on',OWNER_EMAIL:ownerEmail,AUTH_LINK_SECRET:'isolated-recovery-signing-key-for-tests-only'};
const baseFetch=globalThis.fetch,issued=new Map();
const jwt=(user,aal='aal1',session_id=crypto.randomUUID())=>{const token=[Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,session_id,aal,amr:aal==='aal2'?[{method:'totp',timestamp:Math.floor(Date.now()/1000)}]:[]})).toString('base64url'),crypto.randomUUID()].join('.');issued.set(token,user);return token;};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const rpc=async(name,body)=>{
  const keys=Object.keys(body),q=`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) result`;
  return (await db.query(q,Object.values(body))).rows[0].result;
};
let cookie='';
const ctx={waitUntil(p){p.catch(()=>{});}};
async function call(path,body,customCookie=cookie){const r=await worker.fetch(new Request('https://site.example.test'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:customCookie,...(body===undefined?{}:{'Content-Type':'application/json',Origin:'https://site.example.test'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,ctx);return r;}
const auth=(resource,body={})=>call('/api/auth/workspace/'+resource,body);
function takeCookies(r){for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],name=pair.split('=')[0];cookie=cookie.split('; ').filter(v=>v&&!v.startsWith(name+'=')).concat(pair).join('; ');}}
try{
  eq(devIdentity(new Request('http://127.0.0.1:8787'),{ACCOUNT_SECURITY:'on',DEV_ADMIN_EMAIL:ownerEmail}),null);
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean default false,encrypted_password text);create schema storage;create table storage.buckets(id text primary key,name text,public boolean);create table storage.objects(id uuid,bucket_id text,name text);alter table storage.objects enable row level security;`);
  await db.exec(schemaBundle());
  for(const u of f.users.values())if(u.id!=='owner-id')await db.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous,encrypted_password) values($1,$2,now(),false,$3)',[u.id,u.email,'hash']);
  for(const s of f.fixture.state.staff)await db.query("insert into staff(email,role,name,active,property_ids,access_state) values($1,$2,$3,$4,$5,'active')",[s.email,s.role,s.name||'',s.active,s.property_ids||[]]);
  await db.query("insert into staff(email,role,active,access_state) values($1,'manager',true,'active')",[ownerEmail]);
  await db.exec("alter table auth.users add column raw_app_meta_data jsonb default '{}';alter table auth.users add column last_sign_in_at timestamptz");
  await db.query("update auth.users set email_confirmed_at=null,raw_app_meta_data='{\"star_owner_provisioned\":true}' where id=$1",[ownerId]);
  const reservedOwner=await rpc('reserve_platform_owner',{p_subject:ownerId});
  await assert.rejects(()=>rpc('resolve_workspace_access',{p_subject:ownerId,p_email:ownerEmail}));checks++;
  await db.query('update auth.users set email_confirmed_at=now() where id=$1',[ownerId]);
  eq((await rpc('resolve_workspace_access',{p_subject:ownerId,p_email:ownerEmail})).has_password,false);
  const ownerBusiness=await rpc('bootstrap_platform_owner',{p_subject:ownerId,p_email:ownerEmail});
  eq(ownerBusiness,reservedOwner);
  eq(await rpc('bootstrap_platform_owner',{p_subject:ownerId,p_email:ownerEmail}),ownerBusiness);
  eq((await db.query('select count(*)::int n from platform_owner')).rows[0].n,1);
  await assert.rejects(()=>rpc('bootstrap_platform_owner',{p_subject:ownerId,p_email:'other@example.test'}));checks++;
  await db.exec(schemaBundle());eq((await db.query('select user_id from platform_owner')).rows[0].user_id,ownerBusiness);
  for(const role of ['anon','authenticated']){
    await db.exec(`set role ${role}`);
    await assert.rejects(()=>rpc('set_owner_admin',{p_subject:ownerId,p_email:ownerEmail,p_enabled:true,p_version:0,p_reason:'attack'}));checks++;
    await assert.rejects(()=>db.query('select * from auth_bindings'));checks++;await db.exec('reset role');
  }
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:input.url),body=init.body?JSON.parse(init.body):{},token=new Headers(init.headers).get('Authorization')?.replace('Bearer ','');
    if(url.pathname==='/auth/v1/user'&&issued.has(token)){
      const u=issued.get(token);if(init.method==='PUT'){if(u.factors?.some(f=>f.status==='verified')&&verifiedSessionClaims(token).aal!=='aal2')return reply({code:'insufficient_aal',message:'AAL2 session is required'},401);u.password=body.password;f.users.get(u.email).password=body.password;await db.query('update auth.users set encrypted_password=$1 where id=$2',[body.password,u.id]);}return reply(u);
    }
    if(url.pathname==='/auth/v1/factors'){
      const u=issued.get(token);if(!u)return reply({},401);const id=crypto.randomUUID();u.factors=(u.factors||[]).concat({id,status:'unverified',factor_type:'totp'});f.users.get(u.email).factors=u.factors;return reply({id,totp:{secret:'TEST-ONLY-SECRET',uri:'otpauth://totp/test'}});
    }
    if(/^\/auth\/v1\/factors\/[^/]+\/challenge$/.test(url.pathname))return issued.has(token)?reply({id:crypto.randomUUID()}):reply({},401);
    if(/^\/auth\/v1\/factors\/[^/]+\/verify$/.test(url.pathname)){
      const u=issued.get(token),id=url.pathname.split('/')[4];if(!u||body.code!=='123456')return reply({},401);
      const factor=u.factors.find(f=>f.id===id);if(!factor)return reply({},401);factor.status='verified';return reply({user:u,access_token:jwt(u,'aal2',verifiedSessionClaims(token).session_id),refresh_token:'rotated-refresh'});
    }
    if(url.pathname.startsWith('/rest/v1/rpc/')){
      const name=url.pathname.split('/').at(-1);if(['resolve_business_identity','resolve_workspace_access','set_owner_admin','accept_workspace_invitation','workspace_email_verified','complete_workspace_password_setup'].includes(name))try{return reply(await rpc(name,body));}catch{return reply({message:'Access denied'},403);}
    }
    const table=url.pathname.split('/').at(-1);
    if(['staff','app_users','platform_owner','workspace_invitations'].includes(table)){
      let sql=`select * from ${table}`,args=[],filters=[];
      for(const key of ['email','user_id','token_hash'])if(url.searchParams.has(key)){args.push(url.searchParams.get(key).slice(3));filters.push(`${key}=$${args.length}`);}
      if(filters.length)sql+=' where '+filters.join(' and ');
      if(init.method==='PATCH'){const fields=Object.keys(body);const vals=Object.values(body);const where=filters.map(f=>f.replace(/\$(\d+)/g,(_,n)=>'$'+(Number(n)+vals.length)));return reply((await db.query(`update ${table} set ${fields.map((f,i)=>f+'=$'+(i+1)).join(',')} where ${where.join(' and ')} returning *`,[...vals,...args])).rows);}
      return reply((await db.query(sql,args)).rows);
    }
    if(table==='identity_audit'&&init.method==='POST'){await db.query('insert into identity_audit(actor_id,acting_role,action,target_id,details) values($1,$2,$3,$4,$5)',[body.actor_id,body.acting_role,body.action,body.target_id,body.details]);return reply([]);}
    const r=await baseFetch(input,init);
    if(['/auth/v1/token','/auth/v1/verify'].includes(url.pathname)&&r.ok){const p=await r.json();if(p.user){if(url.pathname==='/auth/v1/verify')await db.query('update auth.users set email_confirmed_at=now() where id=$1',[p.user.id]);return reply({...p,access_token:jwt(p.user)});}return reply(p);}
    return r;
  };
  let r=await auth('login',{email:ownerEmail,password:'testing-password'});eq(r.status,200);takeCookies(r);
  eq((await call('/api/admin/me')).status,403);
  eq((await auth('security')).status,200);
  eq((await auth('setup-password',{password:'testing-password'})).status,200);
  eq((await auth('owner-admin',{enabled:true,version:0,reason:'Test dual role'})).status,403);
  const enrollment=await (await auth('mfa-enroll')).json();assert.ok(enrollment.factor_id);checks++;
  eq((await auth('mfa-verify',{factor_id:enrollment.factor_id,code:'000000'})).status,401);
  r=await auth('mfa-verify',{factor_id:enrollment.factor_id,code:'123456'});eq(r.status,200);takeCookies(r);
  let me=await (await call('/api/admin/me')).json();eq(me.owner,true);eq(me.user_id,ownerBusiness);
  eq((await call('/api/admin/applications')).status,403);
  eq((await auth('switch-role',{role:'admin'})).status,403);
  eq((await auth('owner-admin',{enabled:true,version:0,reason:'Test dual role'})).status,200);
  eq((await auth('owner-admin',{enabled:true,version:0,reason:'Stale version'})).status,403);
  r=await auth('switch-role',{role:'admin'});eq(r.status,200);takeCookies(r);
  me=await (await call('/api/admin/me')).json();eq(me.owner,false);eq(me.role,'manager');eq(me.user_id,ownerBusiness);
  r=await auth('switch-role',{role:'owner'});takeCookies(r);
  eq((await auth('owner-admin',{enabled:false,version:1,reason:'Test revoke Admin'})).status,200);
  eq((await call('/api/admin/me',undefined,cookie.replace('star_workspace_role=owner','star_workspace_role=admin'))).status,403);
  eq((await auth('security')).status,200);
  const fake=Buffer.from(JSON.stringify({at:'forged.jwt.token',rt:'fake'})).toString('base64url');eq((await call('/api/admin/me',undefined,'star_workspace='+fake)).status,401);
  // A verified existing account accepts an invitation without overwriting its password.
  const existing='existing@example.test',u=f.user(existing),secret='a'.repeat(64),hash=await hashInvitation(secret);
  await db.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous,encrypted_password) values($1,$2,now(),false,$3)',[u.id,existing,'existing-password-hash']);
  await db.query("insert into staff(email,role,active) values($1,'agent',true)",[existing]);
  await db.query("insert into workspace_invitations(email,role,token_hash,expires_at) values($1,'agent',$2,now()+interval '7 days')",[existing,hash]);
  cookie='';
  eq((await auth('workspace-code',{email:existing,invite:secret})).status,200);
  r=await auth('workspace-activate',{email:existing,invite:secret,code:'123456',password:'do-not-overwrite'});eq(r.status,200);takeCookies(r);
  eq(f.users.get(existing).password,'testing-password');
  eq((await auth('setup-password',{password:'do-not-overwrite'})).status,409);
  eq((await (await call('/api/admin/me')).json()).role,'agent');
  eq((await auth('switch-role',{role:'owner'})).status,403);
  eq((await auth('workspace-invitation',{invite:secret})).status,410);
  await db.query('update staff set active=false where email=$1',[existing]);eq((await call('/api/admin/me')).status,403);
  const reusedId=crypto.randomUUID();await db.query('delete from auth.users where id=$1',[u.id]);await db.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous,encrypted_password) values($1,$2,now(),false,$3)',[reusedId,existing,'hash']);
  await assert.rejects(()=>rpc('resolve_business_identity',{p_subject:reusedId,p_email:existing}));checks++;
  const fresh='new-agent@example.test',freshUser=f.user(fresh),freshToken='d'.repeat(64),freshHash=await hashInvitation(freshToken);
  await db.query('insert into auth.users(id,email,encrypted_password) values($1,$2,$3)',[freshUser.id,fresh,'provider-generated-hash']);
  await db.query("insert into staff(email,role,active) values($1,'agent',true)",[fresh]);
  await db.query("insert into workspace_invitations(email,role,token_hash,expires_at) values($1,'agent',$2,now()+interval '7 days')",[fresh,freshHash]);
  cookie='';eq((await auth('workspace-code',{email:fresh,invite:freshToken})).status,200);
  r=await auth('workspace-activate',{email:fresh,invite:freshToken,code:'123456'});eq(r.status,200);takeCookies(r);eq((await r.json()).setup_password,true);
  eq((await call('/api/admin/me')).status,403);
  eq((await auth('setup-password',{password:'new-test-password'})).status,200);
  eq((await call('/api/admin/me')).status,200);
  // A saved password must work after logout; activation cannot act as passwordless login.
  r=await auth('sign-out');takeCookies(r);
  eq((await auth('login',{email:fresh,password:'new-test-password'})).status,200);
  eq((await auth('login',{email:fresh,password:'testing-password'})).status,401);
  eq((await auth('workspace-code',{email:fresh})).status,409);
  eq((await auth('workspace-activate',{email:fresh,code:'123456'})).status,409);
  eq((await auth('workspace-code',{email:ownerEmail})).status,409);
  // Recovery without MFA still requires mailbox proof and returns to password login.
  cookie='';eq((await auth('request-reset',{email:fresh})).status,200);
  r=await auth('verify-reset',{email:fresh,code:'123456'});eq(r.status,200);takeCookies(r);
  eq((await (await auth('security')).json()).reset_password,true);
  r=await auth('reset-password',{password:'fresh-recovered-password'});eq(r.status,200);takeCookies(r);
  eq((await auth('login',{email:fresh,password:'new-test-password'})).status,401);
  eq((await auth('login',{email:fresh,password:'fresh-recovered-password'})).status,200);
  // Recovery must not update the password before the existing MFA challenge succeeds.
  cookie='';await auth('request-reset',{email:ownerEmail});
  r=await auth('verify-reset',{email:ownerEmail,code:'123456',password:'must-not-be-saved'});eq(r.status,200);takeCookies(r);
  const recoveryCookies=cookie;
  eq(f.users.get(ownerEmail).password,'testing-password');
  eq((await (await auth('security')).json()).reset_password,true);
  eq((await auth('reset-password',{password:'owner-recovered-password'})).status,403);
  eq((await auth('mfa-verify',{factor_id:enrollment.factor_id,code:'000000'})).status,401);
  r=await auth('mfa-verify',{factor_id:enrollment.factor_id,code:'123456'});eq(r.status,200);takeCookies(r);
  eq((await (await auth('security')).json()).reset_password,true);
  const realNow=Date.now;Date.now=()=>realNow()+601000;
  try{eq((await (await auth('security')).json()).reset_password,false);}finally{Date.now=realNow;}
  const verifiedRecoveryCookies=cookie;
  cookie=cookie.replace(/star_workspace_recovery=([^;]+)/,(_,v)=>'star_workspace_recovery=x'+v);
  eq((await auth('reset-password',{password:'owner-recovered-password'})).status,403);cookie=verifiedRecoveryCookies;
  r=await auth('reset-password',{password:'owner-recovered-password'});eq(r.status,200);takeCookies(r);
  eq((await auth('reset-password',{password:'replayed-password'})).status,401);
  eq((await auth('login',{email:ownerEmail,password:'testing-password'})).status,401);
  r=await auth('login',{email:ownerEmail,password:'owner-recovered-password'});eq(r.status,200);takeCookies(r);
  // A receipt from another session cannot authorize even the same user's new session.
  cookie=cookie.replace(/star_workspace_recovery=[^;]*/,recoveryCookies.match(/star_workspace_recovery=[^;]*/)[0]);
  eq((await (await auth('security')).json()).reset_password,false);
  eq((await auth('reset-password',{password:'another-password'})).status,403);
  // Invitation expiration, replacement and wrong-email acceptance are enforced in SQL.
  await db.query('update staff set active=true where email=$1',[existing]);
  await db.query('delete from auth.users where id=$1',[reusedId]);await db.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous,encrypted_password) values($1,$2,now(),false,$3)',[u.id,existing,'hash']);
  await db.query("update workspace_invitations set accepted_at=null,accepted_by=null,expires_at=now()-interval '1 minute' where email=$1",[existing]);
  await assert.rejects(()=>rpc('accept_workspace_invitation',{p_subject:u.id,p_email:existing,p_hash:hash}));checks++;
  await db.query("update workspace_invitations set expires_at=now()+interval '7 days',token_hash=$1 where email=$2",['b'.repeat(64),existing]);
  await assert.rejects(()=>rpc('accept_workspace_invitation',{p_subject:u.id,p_email:existing,p_hash:hash}));checks++;
  await assert.rejects(()=>rpc('accept_workspace_invitation',{p_subject:ownerId,p_email:ownerEmail,p_hash:'b'.repeat(64)}));checks++;
  // Landlord invitation creates a restricted account before any property approval.
  const landlord='new-landlord@example.test',landlordId=crypto.randomUUID(),onboarding=crypto.randomUUID();
  await db.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous,encrypted_password) values($1,$2,now(),false,$3)',[landlordId,landlord,'hash']);
  await db.query("insert into landlord_onboarding(id,email,contact_name,created_by,token_hash,expires_at) values($1,$2,'Test Landlord',$3,$4,now()+interval '14 days')",[onboarding,landlord,ownerEmail,'c'.repeat(64)]);
  let la=await rpc('resolve_workspace_access',{p_subject:landlordId,p_email:landlord});eq(la.access_state,'invited');eq(la.onboarding_pending,true);eq(la.property_ids,[]);
  await rpc('accept_workspace_invitation',{p_subject:landlordId,p_email:landlord,p_hash:'c'.repeat(64)});
  la=await rpc('resolve_workspace_access',{p_subject:landlordId,p_email:landlord});eq(la.access_state,'active');eq(la.onboarding_pending,true);
  await db.query("update landlord_onboarding set status='cancelled' where id=$1",[onboarding]);
  eq((await db.query('select revoked_at is not null ok from workspace_invitations where email=$1',[landlord])).rows[0].ok,true);
  // The Owner role is unaffected by revoking its independent Admin grant.
  eq((await db.query('select count(*)::int n from platform_owner')).rows[0].n,1);
  if(process.argv.includes('--ui')){
    const http=await import('node:http'),fs=await import('node:fs/promises'),path=await import('node:path');
    const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
    env.ASSETS={async fetch(request){const pathname=new URL(request.url).pathname;const file=path.resolve('dist','.'+pathname+(pathname.endsWith('/')?'index.html':''));if(!file.startsWith(path.resolve('dist')+'/'))return new Response('',{status:404});try{return new Response(await fs.readFile(file),{headers:{'Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream'}});}catch{return new Response('',{status:404});}}};
    const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const r=await worker.fetch(new Request('http://'+req.headers.host+req.url,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})}),env,ctx);const headers=Object.fromEntries(r.headers);if(r.headers.getSetCookie().length)headers['set-cookie']=r.headers.getSetCookie();res.writeHead(r.status,headers);res.end(Buffer.from(await r.arrayBuffer()));}catch{res.writeHead(500);res.end();}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
    const browser=await chromium.launch({headless:true});
    try{
      const page=await browser.newPage();page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(origin+'/login/');await page.getByLabel('Email address').fill(ownerEmail);await page.getByLabel('Password',{exact:true}).fill('owner-recovered-password');await page.getByRole('button',{name:'Sign In',exact:true}).click();
      await page.getByRole('heading',{name:'Two-step verification'}).waitFor({timeout:10000}).catch(async e=>{console.error(await page.locator('body').innerText());console.error(errors);throw e;});checks++;
      await page.getByLabel('Authenticator code').fill('123456');await page.getByRole('button',{name:'Verify & Continue'}).click();await page.waitForURL('**/admin/**');checks++;
      await page.goto(origin+'/login/?security=1');await page.getByRole('heading',{name:'Account security'}).waitFor();checks++;
      await page.getByLabel('Reason for granting your Admin access').fill('UI acceptance test');await page.getByRole('button',{name:'Grant my Admin role'}).click();await page.getByRole('button',{name:'Open Admin workspace'}).waitFor();checks++;
      await page.getByRole('button',{name:'Open Admin workspace'}).click();await page.waitForURL('**/admin/#/overview');checks++;
      eq((await (await page.request.get(origin+'/api/admin/me')).json()).owner,false);
      // Browser regression: reset requests only an email code, then MFA, then a new password.
      await page.request.post(origin+'/api/auth/workspace/sign-out');
      await page.goto(origin+'/login/');
      eq(await page.getByText('Applying for a home?').count(),0);
      eq(await page.getByRole('link',{name:'Open applicant portal →'}).count(),0);
      await page.getByRole('button',{name:'Forgot Password?'}).click();
      await page.getByLabel('Email address').fill(ownerEmail);
      await page.getByRole('button',{name:'Send Email Code'}).click();
      await page.getByRole('heading',{name:'Verify your reset code'}).waitFor();
      eq(await page.getByLabel('New password',{exact:true}).count(),0);
      await page.getByLabel('Email code').fill('123456');
      await page.getByRole('button',{name:'Verify & Continue'}).click();
      await page.getByRole('heading',{name:'Two-step verification'}).waitFor();checks++;
      await page.getByLabel('Authenticator code').fill('123456');
      await page.getByRole('button',{name:'Verify & Continue'}).click();
      await page.getByRole('heading',{name:'Choose a new password'}).waitFor().catch(async e=>{console.error(await page.locator('body').innerText());throw e;});
      await page.getByLabel('New password',{exact:true}).fill('browser-reset-password');
      await page.getByLabel('Confirm password').fill('browser-reset-password');
      await page.getByRole('button',{name:'Save Password',exact:true}).click();
      await page.getByRole('heading',{name:'Password updated'}).waitFor();checks++;
      await page.getByRole('link',{name:'Back to Sign In'}).click();
      await page.getByLabel('Email address').fill(ownerEmail);
      await page.getByLabel('Password',{exact:true}).fill('browser-reset-password');
      await page.getByRole('button',{name:'Sign In',exact:true}).click();
      await page.getByRole('heading',{name:'Two-step verification'}).waitFor();checks++;
      await page.getByLabel('Authenticator code').fill('123456');
      await page.getByRole('button',{name:'Verify & Continue'}).click();
      await page.waitForURL('**/admin/**');checks++;
      // Browser regression: a new invitation opens activation directly and creates a working password.
      const uiEmail='ui-invited-admin@example.test',uiUser=f.user(uiEmail),uiInvite='e'.repeat(64);
      await db.query('insert into auth.users(id,email,encrypted_password) values($1,$2,$3)',[uiUser.id,uiEmail,'provider-generated']);
      await db.query("insert into staff(email,role,active) values($1,'manager',true)",[uiEmail]);
      await db.query("insert into workspace_invitations(email,role,token_hash,expires_at) values($1,'manager',$2,now()+interval '7 days')",[uiEmail,await hashInvitation(uiInvite)]);
      await page.request.post(origin+'/api/auth/workspace/sign-out');
      await page.goto(origin+'/login/#invite='+uiInvite);
      await page.getByRole('heading',{name:'Activate your account'}).waitFor();checks++;
      eq(await page.getByLabel('Email address').inputValue(),uiEmail);
      await page.getByRole('button',{name:'Send Email Code'}).click();
      await page.getByLabel('Email code').fill('123456');
      await page.getByRole('button',{name:'Verify & Continue'}).click();
      await page.getByRole('heading',{name:'Create your password'}).waitFor();
      await page.getByLabel('New password',{exact:true}).fill('invited-admin-password');
      await page.getByLabel('Confirm password').fill('invited-admin-password');
      await page.getByRole('button',{name:'Save Password',exact:true}).click();
      await page.getByRole('button',{name:'Set Up Authenticator'}).click();
      await page.getByLabel('Authenticator code').fill('123456');
      await page.getByRole('button',{name:'Verify & Continue'}).click();
      await page.waitForURL('**/admin/**');checks++;
      await page.request.post(origin+'/api/auth/workspace/sign-out');
      await page.goto(origin+'/login/');
      await page.getByLabel('Email address').fill(uiEmail);
      await page.getByLabel('Password',{exact:true}).fill('invited-admin-password');
      await page.getByRole('button',{name:'Sign In',exact:true}).click();
      await page.getByRole('heading',{name:'Two-step verification'}).waitFor();
      await page.getByLabel('Authenticator code').fill('123456');
      await page.getByRole('button',{name:'Verify & Continue'}).click();
      await page.waitForURL('**/admin/**');checks++;
      await page.request.post(origin+'/api/auth/workspace/sign-out');
      await page.goto(origin+'/login/');
      await page.getByRole('button',{name:'Activate an Invited Account'}).click();
      await page.getByLabel('Email address').fill(uiEmail);
      await page.getByRole('button',{name:'Send Email Code'}).click();
      await page.getByRole('status').filter({hasText:'already activated'}).waitFor();checks++;
      // An existing account can recover its password while accepting a fresh role invitation.
      const returningEmail='ui-existing-agent@example.test',returningUser=f.user(returningEmail),returningInvite='f'.repeat(64);
      await db.query('insert into auth.users(id,email,email_confirmed_at,encrypted_password) values($1,$2,now(),$3)',[returningUser.id,returningEmail,'existing-hash']);
      await db.query("insert into staff(email,role,active) values($1,'agent',true)",[returningEmail]);
      await db.query("insert into workspace_invitations(email,role,token_hash,expires_at) values($1,'agent',$2,now()+interval '7 days')",[returningEmail,await hashInvitation(returningInvite)]);
      await page.goto(origin+'/login/#invite='+returningInvite);
      await page.waitForFunction(expected=>document.querySelector('#email')?.value===expected,returningEmail);
      await page.getByRole('heading',{name:'Activate your account'}).waitFor();
      await page.getByRole('button',{name:'Back to Sign In'}).click();
      await page.getByRole('button',{name:'Forgot Password?'}).click();
      await page.getByRole('button',{name:'Send Email Code'}).click();
      await page.getByLabel('Email code').fill('123456');
      await page.getByRole('button',{name:'Verify & Continue'}).click();
      await page.getByRole('heading',{name:'Choose a new password'}).waitFor().catch(async e=>{console.error(await page.locator('body').innerText());throw e;});
      await page.getByLabel('New password',{exact:true}).fill('returning-agent-password');
      await page.getByLabel('Confirm password').fill('returning-agent-password');
      await page.getByRole('button',{name:'Save Password',exact:true}).click();
      await page.getByRole('heading',{name:'Password updated'}).waitFor();checks++;
      await page.getByRole('link',{name:'Back to Sign In'}).click();
      await page.getByLabel('Email address').fill(returningEmail);
      await page.getByLabel('Password',{exact:true}).fill('returning-agent-password');
      await page.getByRole('button',{name:'Sign In',exact:true}).click();
      await page.waitForURL('**/admin/**');checks++;
      eq(errors,[]);await fs.mkdir('/tmp/star-account-ui',{recursive:true});await page.screenshot({path:'/tmp/star-account-ui/admin.png',fullPage:true});
    }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
  }
  const audit=(await db.query('select action from identity_audit')).rows.map(r=>r.action);assert.ok(audit.includes('mfa_verified')&&audit.includes('switch_role')&&audit.includes('accept_invitation'));checks++;
  console.log(`PASS ${checks} account security checks: stable identity, unique Owner, MFA enforcement, dual roles, revocation, invitation replay and password preservation`);
}finally{globalThis.fetch=baseFetch;f.restore();await db.close();}
