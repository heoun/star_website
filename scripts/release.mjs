import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {checkSchema,schemaRevision} from './release-schema.mjs';
const target=process.argv[2];
if(!['staging','production'].includes(target))throw new Error('Select staging or production.');
const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim())throw new Error('Commit changes before releasing.');
if(target==='staging' && process.env.SUPABASE_URL && process.env.SUPABASE_URL!=='https://shlodyxlnepxnafthvod.supabase.co')throw new Error('Use only the Star Dev database for staging.');
if(target==='production') {
  if(process.env.SUPABASE_URL?.includes('shlodyxlnepxnafthvod'))throw new Error('Use the production database for the release check.');
  const current=await fetch('https://dev.starreusa.com/api/release',{signal:AbortSignal.timeout(15000)});
  const tested=await current.json();
  if(!current.ok || tested.environment!=='staging' || tested.revision!==revision)throw new Error('Deploy and accept this exact revision on Dev before production.');
}
if(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)await checkSchema(process.env);
else {
  const origin=target==='staging'?'https://dev.starreusa.com':'https://starreusa.com';
  const r=await fetch(origin+'/api/health',{signal:AbortSignal.timeout(15000)});
  const health=await r.json().catch(()=>null);
  if(!r.ok || !health?.ok || health.environment!==target || health.schema!==schemaRevision())throw new Error('Target database is not ready. Apply the reviewed schema bundle first; initial provisioning requires database credentials.');
  if(target==='staging' && JSON.stringify(health.simulatorMigrations)!==JSON.stringify(readdirSync('testing/screening/migrations').filter(f=>f.endsWith('.sql')).sort()))throw new Error('Apply the reviewed staging simulator D1 migrations before releasing.');
}
if(process.argv.includes('--check')) {console.log('Release revision and database preflight passed.');process.exit(0);}
// CI runs the shared test gate before calling this script. Manual releases run it too.
if(process.env.STAR_CI_GATE!=='passed')execFileSync('npm',['run','test:release'],{stdio:'inherit'});
execFileSync('npm',['run','build'],{stdio:'inherit'});
execFileSync('./node_modules/.bin/wrangler',['deploy',...(target==='staging'?['--env','staging']:[]),'--var',`RELEASE_SHA:${revision}`],{stdio:'inherit'});
const origin=target==='staging'?'https://dev.starreusa.com':'https://starreusa.com';
let verified=false;
for(let attempt=0;attempt<10;attempt++) {
  try {
    const [version,health]=await Promise.all([fetch(origin+'/api/release',{signal:AbortSignal.timeout(5000)}),fetch(origin+'/api/health',{signal:AbortSignal.timeout(5000)})]);
    const v=await version.json(),h=await health.json();
    if(version.ok && health.ok && v.revision===revision && h.ok){verified=true;break;}
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,2000));
}
if(!verified)throw new Error('Deployment uploaded, but live verification failed. Inspect the target deployment before continuing.');
console.log(`Released ${revision} to ${target}.`);
