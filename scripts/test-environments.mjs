import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {internalTesting,internalTestParticipant} from '../backend/app/internal-testing.ts';
import {testingProvider} from '../backend/app/testing-provider.ts';
import {deploymentError} from '../worker/deployment.js';
import {devIdentity} from '../worker/env.js';
import simulator from '../testing/screening/worker.js';
import {schemaBundle,schemaRevision} from './release-schema.mjs';
import worker from '../worker/index.js';
const db=new DatabaseSync(':memory:');db.exec(readFileSync('testing/screening/migrations/0001_simulation.sql','utf8'));
db.exec("CREATE TABLE d1_migrations(name TEXT); INSERT INTO d1_migrations VALUES ('0001_simulation.sql')");
const DB={prepare(sql){return {bind(...args){const q=db.prepare(sql);return {async first(){return q.get(...args)},async run(){return q.run(...args)},async all(){return {results:q.all(...args)}}}},async all(){return {results:db.prepare(sql).all()}}}}};
const binding={fetch:(url,init)=>simulator.fetch(new Request(url,init),{DB,APP_ENV:'staging'})};
const env={APP_ENV:'staging',SITE_ORIGIN:'https://dev.starreusa.com',SUPABASE_URL:'https://shlodyxlnepxnafthvod.supabase.co',INTERNAL_TEST_DATABASE_HOST:'shlodyxlnepxnafthvod.supabase.co',DOCUSIGN_ENVIRONMENT:'demo',INTERNAL_TESTING:'on',SCREENING_SIMULATOR:binding,INTERNAL_TEST_USER_ID:'user',INTERNAL_TEST_EMAIL:'test@example.test'};
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++};
const req=new Request(env.SITE_ORIGIN);
eq(internalTesting(env,req),true);eq(internalTesting(env,new Request('https://starreusa.com')),false);
eq(internalTesting({...env,APP_ENV:'production'},req),false);
eq(internalTesting({...env,SUPABASE_URL:'https://another.supabase.co'},req),false);
eq(internalTestParticipant(env,req,{subject:'user',email:'test@example.test'}),true);
eq(internalTestParticipant(env,req,{subject:'stranger',email:'test@example.test'}),false);
eq(devIdentity(req,{DEV_ADMIN_EMAIL:'admin@example.test'}),null);
eq(deploymentError(env),'');assert.ok(deploymentError({...env,DOCUSIGN_ENVIRONMENT:'production'}));checks++;
assert.throws(()=>testingProvider({...env,APP_ENV:'production'}));checks++;
const provider=testingProvider(env),id=crypto.randomUUID(),documents=[{id:crypto.randomUUID(),type:'bank_statement'}];
await assert.rejects(()=>provider.order(id,{consent:true,documents,scenario:'scored'}));checks++;
eq((await provider.payment(id,'failed')).status,'failed');const receipt=await provider.payment(id,'paid');
eq((await provider.payment(id,'failed')).status,'paid');eq((await provider.payment(id)).id,receipt.id);
const order=await provider.order(id,{consent:true,documents,scenario:'scored'});
eq((await provider.order(id,{consent:true,documents,scenario:'scored'})).id,order.id);
await assert.rejects(()=>provider.order(id,{consent:true,documents,scenario:'failed'}));checks++;
db.prepare("UPDATE simulations SET record=json_set(record,'$.ready_at',0) WHERE kind='screening'").run();
eq((await provider.result(id)).status,'complete');assert.ok((await provider.result(id)).score>=710);checks++;
for(const scenario of ['no_score','failed']){const key=crypto.randomUUID();await provider.payment(key,'paid');await provider.order(key,{consent:true,documents,scenario});db.prepare("UPDATE simulations SET record=json_set(record,'$.ready_at',0) WHERE kind='screening'").run();eq((await provider.result(key)).status,scenario==='failed'?'failed':'complete');}
const post=(body)=>binding.fetch('https://screening.internal/payments/'+crypto.randomUUID(),{method:'POST',body});
eq((await post('null')).status,422);eq((await post('x'.repeat(17000))).status,413);
eq((await simulator.fetch(req,{DB,APP_ENV:'production'})).status,503);
const nativeFetch=globalThis.fetch;
try {
  globalThis.fetch=async()=>Response.json([{revision:schemaRevision()}]);
  const health=await worker.fetch(new Request(env.SITE_ORIGIN+'/api/health'),env,{});
  eq(health.status,200);eq((await health.json()).schema,schemaRevision());
  globalThis.fetch=async()=>new Response('',{status:503});
  eq((await worker.fetch(new Request(env.SITE_ORIGIN+'/api/health'),env,{})).status,503);
  const release=await worker.fetch(new Request(env.SITE_ORIGIN+'/api/release'),{...env,RELEASE_SHA:'abc'},{});eq((await release.json()).revision,'abc');
}finally{globalThis.fetch=nativeFetch;db.close();}
const pg=new PGlite();
try {
  await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls; create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean default false);create schema storage;create table storage.buckets(id text primary key,name text,public boolean);create table storage.objects(id uuid,bucket_id text,name text);alter table storage.objects enable row level security;`);
  await pg.exec(schemaBundle());
  await pg.exec("insert into staff(email,role,active) values('retained@example.test','manager',true)");
  await pg.exec(schemaBundle());
  eq((await pg.query('select revision from star_schema_release')).rows[0].revision,schemaRevision());
  eq((await pg.query("select count(*)::int n from staff where email='retained@example.test'")).rows[0].n,1);
  await pg.exec('set role authenticated');await assert.rejects(()=>pg.query('select * from star_schema_release'));checks++;
}finally{await pg.close();}
console.log(`PASS ${checks} environment, persistent simulator and repeatable schema release checks`);
