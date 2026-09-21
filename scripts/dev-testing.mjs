// One supervised local rehearsal of the real application, including inbound
// DocuSign Connect. No production credentials, charges, or bureau requests.
import {readFileSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import net from 'node:net';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHmac,randomUUID} from 'node:crypto';
import {makeDocusign} from '../backend/adapters/esign-docusign/index.ts';
import {createWebhookForwarder} from './dev-docusign-webhook.js';
export function testingConfig(source,port=8787) {
 const env=Object.fromEntries(source.split('\n').filter(l=>/^\w+=/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));
 const required=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','APP_ENCRYPTION_KEY','INTERNAL_TEST_DATABASE_HOST','INTERNAL_TEST_USER_ID','INTERNAL_TEST_EMAIL','INTERNAL_TEST_LANDLORD_EMAIL','INTERNAL_TEST_LISTING_IDS','SCREENING_SIMULATOR_URL','SCREENING_SIMULATOR_TOKEN','RESEND_API_KEY','LANDLORD_DECISION_SECRET','DOCUSIGN_INTEGRATION_KEY','DOCUSIGN_USER_ID','DOCUSIGN_ACCOUNT_ID','DOCUSIGN_PRIVATE_KEY','DOCUSIGN_CONNECT_HMAC_SECRET'];
 if(!env.SUPABASE_PUBLISHABLE_KEY && !env.SUPABASE_ANON_KEY)throw new Error('Configure SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY.');
 const missing=required.filter(key=>!env[key]);if(missing.length)throw new Error(`Configure .dev.vars: ${missing.join(', ')}`);
 for(const [key,value] of Object.entries({INTERNAL_TESTING:'on',RENTAL_AUTOMATION:'on',RENTAL_SCREENING:'simulator',DEV_REAL_EMAIL:'true',DOCUSIGN_ENABLED:'on',DOCUSIGN_ENVIRONMENT:'demo',DEV_DOCUSIGN_SEND:'on'}))if(env[key]!==value)throw new Error(`dev:testing requires ${key}=${value}.`);
 if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Choose a valid local PORT.');
 if(new URL(env.SUPABASE_URL).hostname!==env.INTERNAL_TEST_DATABASE_HOST || new URL(env.SUPABASE_URL).protocol!=='https:')throw new Error('Supabase must match INTERNAL_TEST_DATABASE_HOST.');
 if(env.SITE_ORIGIN!==`http://127.0.0.1:${port}`)throw new Error(`Set SITE_ORIGIN=http://127.0.0.1:${port} for test email links.`);
 const simulator=new URL(env.SCREENING_SIMULATOR_URL);if(simulator.hostname!=='127.0.0.1' || simulator.protocol!=='http:' || !simulator.port)throw new Error('Use a local SCREENING_SIMULATOR_URL with a port.');
 return env;
}
async function freePort(port){await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',()=>reject(new Error(`Port ${port} is occupied. Stop the previous dev server before running dev:testing.`)));s.listen(port,'127.0.0.1',()=>s.close(resolve));});}
export async function main(){
 const port=Number(process.env.PORT || 8787),forwardPort=Number(process.env.DOCUSIGN_FORWARD_PORT || 8788);
 const env=testingConfig(readFileSync('.dev.vars','utf8'),port),simulatorPort=Number(new URL(env.SCREENING_SIMULATOR_URL).port);
 if(new Set([port,forwardPort,simulatorPort]).size!==3)throw new Error('Worker, callback and simulator need distinct local ports.');
 await Promise.all([port,forwardPort,simulatorPort].map(freePort));
 if(spawnSync('cloudflared',['--version'],{stdio:'ignore'}).status!==0)throw new Error('Install cloudflared once (macOS: brew install cloudflared), then rerun npm run dev:testing.');
 const headers={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`};
 const database=async path=>{const r=await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`,{headers,signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('Star Dev database/signing schema is unavailable. Apply the SQL setup in docs/backoffice/internal-testing.md.');return r.json();};
 await Promise.all(['applications?select=id,rental_group_id,workspace_version&limit=1','rental_signing_jobs?select=package_id&limit=1','rental_signing_inbox?select=hash&limit=1'].map(database));
 console.log('✓ Star Dev database and signing schema');
 const children=[];let stopping=false,monitor;
 const forwarder=createWebhookForwarder(port);
 const stop=(code=0)=>{if(stopping)return;stopping=true;clearInterval(monitor);forwarder.close();for(const child of children){try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');}}process.exitCode=code;};
 const launch=(command,args,options={})=>{
  const child=spawn(command,args,{detached:true,stdio:'inherit',...options});children.push(child);
  child.once('error',()=>{console.error(`Testing dependency failed: ${command}`);stop(1);});
  child.once('exit',code=>{if(!stopping){console.error(`Testing dependency stopped (${command}, exit ${code}). Stopping the test stack.`);stop(1);}});return child;
 };
 process.once('SIGINT',()=>stop());process.once('SIGTERM',()=>stop());
 try {
  await new Promise((resolve,reject)=>{forwarder.once('error',reject);forwarder.listen(forwardPort,'127.0.0.1',resolve);});
  console.log('✓ Callback listener (only the HMAC-verified webhook is public)');
  const tunnel=launch('cloudflared',['tunnel','--protocol','http2','--url',`http://127.0.0.1:${forwardPort}`,'--no-autoupdate'],{stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('The HTTPS callback tunnel did not start within 45 seconds.')),45000);
   const read=chunk=>{if(/\bERR\b/.test(String(chunk)))console.error(String(chunk).trim());const url=/https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(chunk))?.[0];if(url){clearTimeout(timer);resolve(url);}};
   tunnel.stdout.on('data',read);tunnel.stderr.on('data',read);tunnel.once('exit',()=>{clearTimeout(timer);reject(new Error('The HTTPS callback tunnel stopped.'));});
  });
  if(stopping)throw new Error('Testing startup stopped.');
  const webhook=`${origin}/api/webhooks/docusign`;
  console.log(`✓ HTTPS tunnel: ${origin}`);
  launch(process.execPath,['scripts/screening-simulator.mjs']);
  launch(process.execPath,['scripts/dev.js','--signing-scheduler','--var',`DOCUSIGN_WEBHOOK_URL:${webhook}`],{env:{...process.env,STAR_TESTING_SCHEDULE_MS:'15000'}});
  const waitFor=async(check,label,timeout=60000)=>{const end=Date.now()+timeout;let last='',reported=Date.now();while(Date.now()<end && !stopping){try{if(await check())return;}catch(error){last=error.cause?.code || error.message;}if(Date.now()-reported>15000){console.log(`Waiting for ${label}…`);reported=Date.now();}await new Promise(r=>setTimeout(r,1000));}throw new Error(`${label} failed its startup check. ${last}`);};
  await waitFor(async()=>{const r=await fetch(`http://127.0.0.1:${port}/api/webhooks/docusign`,{method:'POST',body:'{}',signal:AbortSignal.timeout(3000)});await r.body?.cancel();return r.status===401;},'Worker / DocuSign HMAC validation');
  await waitFor(async()=>{const r=await fetch(`${env.SCREENING_SIMULATOR_URL}/screenings/${randomUUID()}`,{headers:{Authorization:`Bearer ${env.SCREENING_SIMULATOR_TOKEN}`},signal:AbortSignal.timeout(3000)});await r.body?.cancel();return r.status===404;},'Payment / screening simulator');
  const diagnostic=JSON.stringify({event:'testing-health',generatedDateTime:new Date().toISOString(),data:{accountId:env.DOCUSIGN_ACCOUNT_ID,envelopeId:randomUUID()}});
  const signature=createHmac('sha256',env.DOCUSIGN_CONNECT_HMAC_SECRET).update(diagnostic).digest('base64');
  await waitFor(async()=>{const r=await fetch(webhook,{method:'POST',headers:{'Content-Type':'application/json','x-docusign-signature-1':signature},body:diagnostic,signal:AbortSignal.timeout(10000)});await r.body?.cancel();return r.ok;},'Public HTTPS → HMAC → durable inbox',180000);
  const provider=makeDocusign({environment:'demo',integrationKey:env.DOCUSIGN_INTEGRATION_KEY,userId:env.DOCUSIGN_USER_ID,accountId:env.DOCUSIGN_ACCOUNT_ID,privateKey:env.DOCUSIGN_PRIVATE_KEY,hmacSecret:env.DOCUSIGN_CONNECT_HMAC_SECRET,webhookUrl:webhook});
  await provider.configureTestingWebhook(webhook,`Star local testing ${env.INTERNAL_TEST_DATABASE_HOST}`);
  // The sandbox subscription is reused on each start. Old test envelopes now
  // follow its current URL too, instead of being stranded on a dead tunnel.
  const pending=await database('rental_signing_packages?reserved=eq.true&record->>phase=in.(in_progress,archiving,needs_attention)&select=record&limit=20');
  for(const {record} of pending)if(record.envelope?.accountId===env.DOCUSIGN_ACCOUNT_ID && record.envelope?.envelopeId)await provider.replayTestingEnvelope(record.envelope.envelopeId);
  console.log(`\n✓ TESTING READY\n  Website / Admin: http://127.0.0.1:${port}\n  Supabase: ${env.INTERNAL_TEST_DATABASE_HOST}\n  Email: real delivery to configured test inboxes\n  Payment / credit: local provider simulator\n  Signing: DocuSign Sandbox + authenticated Connect\n  Callback: ${webhook}\n  Background jobs: every 15s; page signing refresh: every 5s\n  Keep this command running. Ctrl+C stops the entire test stack.\n`);
  let failures=0,busy=false;
  monitor=setInterval(async()=>{if(busy||stopping)return;busy=true;try{const r=await fetch(webhook,{method:'POST',body:'{}',signal:AbortSignal.timeout(10000)});await r.body?.cancel();if(r.status!==401)throw new Error();failures=0;}catch{failures++;console.error(`Testing callback unavailable (${failures}/3). Signing updates are delayed.`);if(failures>=3)stop(1);}finally{busy=false;}},30000);
 }catch(error){stop(1);throw error;}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(`dev:testing: ${error.message}`);process.exitCode=1;});
