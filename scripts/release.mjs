import {execFileSync} from 'node:child_process';
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
}
// CI runs the shared test gate before calling this script. Manual releases run it too.
if(process.env.STAR_CI_GATE!=='passed')execFileSync('npm',['run','test:release'],{stdio:'inherit'});
execFileSync('npm',['run','build'],{stdio:'inherit'});
execFileSync('./node_modules/.bin/wrangler',['deploy',...(target==='staging'?['--env','staging']:[]),'--var',`RELEASE_SHA:${revision}`],{stdio:'inherit'});
console.log(`Released ${revision} to ${target}.`);
