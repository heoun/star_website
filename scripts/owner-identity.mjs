// Operator-only bootstrap; no public endpoint can claim or replace the Owner.
import {readFileSync} from 'node:fs';
const target=process.argv[2],file=process.argv[3];
if(!['staging','production'].includes(target)||!file)throw Error('Usage: node scripts/owner-identity.mjs staging|production /path/to/env [--bootstrap|--provision]');
const env=Object.fromEntries(readFileSync(file,'utf8').split(/\r?\n/).filter(l=>/^\w+=/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim().replace(/^(["'])(.*)\1$/,'$2')];}));
const url=env.SUPABASE_URL?.replace(/\/$/,'');
if(!url?.startsWith('https://') || (target==='staging')!==(url==='https://shlodyxlnepxnafthvod.supabase.co'))throw Error('Database does not match the selected environment.');
const headers={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json'};
const matches=[];
for(let page=1;;page++){
  const r=await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=100`,{headers,signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('Cannot verify Auth users.');
  const users=(await r.json()).users;
  matches.push(...users.filter(u=>u.email?.toLowerCase()==='info@starreusa.com'));
  if(users.length<100)break;
}
console.log(JSON.stringify({matching_accounts:matches.length,verified:matches.length===1&&!!matches[0].email_confirmed_at}));
let selected=matches[0];
if(process.argv.includes('--inspect')){
  const bindings=await fetch(`${url}/rest/v1/platform_owner?select=user_id,admin_enabled,version`,{headers,signal:AbortSignal.timeout(15000)});
  console.log(JSON.stringify({environment:target,auth_users:matches.map(u=>({id:u.id,email:u.email,verified:!!u.email_confirmed_at})),owner_state:bindings.ok?await bindings.json():{status:bindings.status}}));
  process.exit(0);
}

if(process.argv.includes('--provision') || process.argv.includes('--reserve-existing')){
  if(process.argv.includes('--reserve-existing') && matches.length!==1)throw Error('Exactly one existing Auth identity is required; no account will be created.');
  if(matches.length>1)throw Error('Owner email is ambiguous.');
  if(!selected){
    const r=await fetch(`${url}/auth/v1/admin/users`,{method:'POST',headers,body:JSON.stringify({email:'info@starreusa.com',email_confirm:false,app_metadata:{star_owner_provisioned:true}}),signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Error('Could not provision Owner identity.');
    selected=await r.json();
  }
  if(process.argv.includes('--mark-initial') && !selected.email_confirmed_at){
    const expected=process.argv[process.argv.indexOf('--mark-initial')+1];
    if(selected.id!==expected || selected.last_sign_in_at)throw Error('Initial identity does not match or has already signed in.');
    const r=await fetch(`${url}/auth/v1/admin/users/${selected.id}`,{method:'PUT',headers,body:JSON.stringify({app_metadata:{...selected.app_metadata,star_owner_provisioned:true}}),signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Error('Could not mark the verified initial provisioning identity.');
  }
  const name=selected.email_confirmed_at?'bootstrap_platform_owner':'reserve_platform_owner';
  const r=await fetch(`${url}/rest/v1/rpc/${name}`,{method:'POST',headers,body:JSON.stringify({p_subject:selected.id,...(selected.email_confirmed_at?{p_email:'info@starreusa.com'}:{})}),signal:AbortSignal.timeout(15000)});
  if(!r.ok){const error=await r.json().catch(()=>({}));console.log(JSON.stringify({status:r.status,code:error.code,message:error.message}));throw Error('Owner reservation refused. Review existing identity; do not delete or overwrite it.');}
  console.log(JSON.stringify({environment:target,email:'info@starreusa.com',owner_user_id:await r.json(),verified:!!selected.email_confirmed_at,next:'Verify email, create password if needed, and enroll authenticator.'}));
}else{
  if(matches.length!==1 || !selected.email_confirmed_at || selected.is_anonymous)throw Error('Exactly one verified Owner Auth identity is required. Use --provision for the approved initial setup.');
  console.log(JSON.stringify({environment:target,email:'info@starreusa.com',verified:true,auth_user_id:selected.id}));
  if(process.argv.includes('--bootstrap')){
    const r=await fetch(`${url}/rest/v1/rpc/bootstrap_platform_owner`,{method:'POST',headers,body:JSON.stringify({p_subject:selected.id,p_email:'info@starreusa.com'}),signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Error('Owner bootstrap refused. Check migration and existing Owner binding.');
    console.log(JSON.stringify({owner_user_id:await r.json(),note:'Existing Admin grants are preserved.'}));
  }
}
