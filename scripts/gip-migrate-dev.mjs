// Operator-only Dev migration. No passwords, MFA secrets or email messages are
// exported. Newly provisioned accounts require user-chosen passwords afterwards.
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
const command=process.argv[2],project='starreusa-dev-auth',tenants={workspace:'Workspace-7ppgr',applicant:'Applicant-sw0j9'};
if(!['plan','provision','sql'].includes(command))throw Error('Use plan, provision, or sql. Dev only.');
const env=Object.fromEntries(readFileSync('.dev.vars','utf8').split('\n').filter(l=>/^\w+=/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));
if(env.SUPABASE_URL!=='https://shlodyxlnepxnafthvod.supabase.co')throw Error('Wrong database; Star Dev only.');
const path='.local/gip/migration-plan.json';mkdirSync('.local/gip',{recursive:true,mode:0o700});
const save=plan=>writeFileSync(path,JSON.stringify(plan,null,2)+'\n',{mode:0o600});
async function source(path){const r=await fetch(env.SUPABASE_URL+path,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Dev inventory failed '+r.status);return r.json();}
if(command==='plan'){
 if(existsSync(path))throw Error('A plan already exists. Review it; do not replace provisioned UIDs.');
 const [auth,staff,applications,drafts]=await Promise.all([source('/auth/v1/admin/users?page=1&per_page=1000'),source('/rest/v1/staff?select=email,role,active,access_state,user_id,auth_user_id'),source('/rest/v1/applications?select=id,email,user_id'),source('/rest/v1/rental_drafts?select=id,owner_id,owner_email')]);
 if(auth.users.length>=1000)throw Error('Implement source pagination before migration.');
 const users=auth.users.filter(u=>u.email_confirmed_at&&!u.is_anonymous).map(u=>({id:u.id,email:u.email.toLowerCase(),disabled:!!u.banned_until&&Date.parse(u.banned_until)>Date.now()}));
 if(applications.some(a=>!users.some(u=>u.email===a.email.toLowerCase()))||drafts.some(d=>!users.some(u=>u.id===d.owner_id&&u.email===d.owner_email)))throw Error('Historical records need operator identity review.');
 const accounts=[];
 for(const u of users){const member=staff.find(s=>s.email===u.email);const applicant=applications.some(a=>a.email.toLowerCase()===u.email)||drafts.some(d=>d.owner_id===u.id)||!member;
  for(const realm of [...(member?['workspace']:[]),...(applicant?['applicant']:[])])accounts.push({realm,email:u.email,oldSubject:u.id,newSubject:randomUUID(),disabled:u.disabled||realm==='workspace'&&!member.active,tenant:tenants[realm],provisioned:false});
 }
 if(accounts.filter(a=>a.realm==='workspace'&&a.email==='info@starreusa.com').length!==1)throw Error('One approved Owner required.');
 save({project,source:env.SUPABASE_URL,createdAt:new Date().toISOString(),accounts,applications,drafts});
 console.log(`Prepared ${accounts.length} identities; ${applications.length} applications and ${drafts.length} drafts. No cloud writes.`);
 process.exit(0);
}
const plan=JSON.parse(readFileSync(path,'utf8'));
if(plan.project!==project||plan.source!==env.SUPABASE_URL||plan.accounts.some(a=>a.tenant!==tenants[a.realm]||!/^\S+@\S+\.\S+$/.test(a.email)||!/^[a-f0-9-]{36}$/.test(a.newSubject)))throw Error('Invalid migration target or plan.');
const access=execFileSync(resolve('.local/gip-tools/google-cloud-sdk/bin/gcloud'),['auth','print-access-token','info@starreusa.com','--project='+project],{env:{...process.env,CLOUDSDK_CONFIG:resolve('.local/gip-tools/config')},encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function google(a,method,body){const path=method==='signUp'?'accounts:signUp':`projects/${project}/tenants/${a.tenant}/accounts:${method}`;
 const r=await fetch('https://identitytoolkit.googleapis.com/v1/'+path,{method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json','x-goog-user-project':project},signal:AbortSignal.timeout(15000),redirect:'error',body:JSON.stringify(method==='signUp'?{...body,tenantId:a.tenant,targetProjectId:project}:body)});
 if(!r.ok)throw Error(`Dev Google ${method} failed (${r.status}); no identity reassignment attempted.`);return r.json();
}
for(const a of plan.accounts){
 const src=await source('/auth/v1/admin/users/'+a.oldSubject);
 if(src.email?.toLowerCase()!==a.email||!src.email_confirmed_at||src.is_anonymous)throw Error('Source verified identity changed.');
 let result=await google(a,'lookup',{email:[a.email]}),user=result.users?.[0];
 if(!user&&command==='provision'){
  await google(a,'signUp',{localId:a.newSubject,email:a.email,emailVerified:true,disabled:a.disabled,password:randomBytes(48).toString('base64url')});
  result=await google(a,'lookup',{email:[a.email]});user=result.users?.[0];
 }
 if(!user||user.localId!==a.newSubject||user.email?.toLowerCase()!==a.email||user.tenantId!==a.tenant||user.emailVerified!==true||!!user.disabled!==a.disabled)throw Error('Target identity mismatch; never rebind historical data by email alone.');
 a.provisioned=true;save(plan);
}
if(command==='provision'){console.log(`Verified ${plan.accounts.length} provisioned identities. No passwords retained, emails sent or business references changed.`);process.exit(0);}
const q=v=>"'"+String(v).replaceAll("'","''")+"'";
const sql=['begin;','lock table public.applications,public.rental_drafts,public.staff in share row exclusive mode;',...Object.entries(tenants).map(([realm,tenant])=>`insert into public.gip_auth_realms(realm,project_id,tenant_id) values(${q(realm)},${q(project)},${q(tenant)}) on conflict(realm) do nothing;`),...plan.accounts.map(a=>`select public.migrate_gip_identity(${q(a.oldSubject)},${q(a.newSubject)},${q(a.email)},${q(a.realm)},${q(project)},${q(a.tenant)});`),"update public.gip_auth_realms set enabled=true;","notify pgrst,'reload schema';",'commit;'].join('\n')+'\n';
writeFileSync('.local/gip/cutover.sql',sql,{mode:0o600});
console.log('Prepared verified atomic cutover SQL. Enable Worker maintenance and stop local writers before executing it. No business writes performed by this script.');
