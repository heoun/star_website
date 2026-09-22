import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const { PGlite } = await import(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const db = new PGlite(); let checks = 0;
const eq = (a,b) => { assert.deepEqual(a,b); checks++; };
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean default false);
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean);
    create table storage.objects(id uuid primary key,bucket_id text,name text); alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated,service_role; grant all on storage.objects to anon,authenticated,service_role;
    create policy overly_broad_policy on storage.objects for all to anon,authenticated using(true) with check(true);`);
  for (const name of ["schema","backoffice","workspace","administration","identity","identity","storage","storage"]) await db.exec(readFileSync(new URL(`../supabase/${name}.sql`,import.meta.url),"utf8"));
  const id1="11111111-1111-4111-8111-111111111111", id2="22222222-2222-4222-8222-222222222222";
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'agent@example.test',now()),($2,'other@example.test',now())",[id1,id2]);
  await db.exec("insert into staff(email,role,active) values('agent@example.test','agent',true)");
  const bind = async (email,id) => (await db.query("select bind_staff_identity($1,$2) ok",[email,id])).rows[0].ok;
  eq(await bind("agent@example.test",id2),false);
  eq(await bind("agent@example.test",id1),true);
  eq(await bind("agent@example.test",id1),true);
  await db.exec("update staff set active=false"); eq(await bind("agent@example.test",id1),false);
  await db.exec("update staff set active=true; delete from auth.users");
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'agent@example.test',now())",[id2]);
  eq(await bind("agent@example.test",id2),false);
  eq((await db.query("select auth_user_id from staff")).rows[0].auth_user_id,id1);
  await db.exec("insert into staff(email,role,active) values('unconfirmed@example.test','agent',true)");
  await db.query("insert into auth.users(id,email) values($1,'unconfirmed@example.test')",[id1]);
  eq(await bind("unconfirmed@example.test",id1),false);
  await db.exec("insert into storage.objects values(gen_random_uuid(),'applicant-docs','private.pdf'),(gen_random_uuid(),'listing-media','image.jpg')");
  eq((await db.query("select public from storage.buckets")).rows.every(row=>row.public===false),true);
  for (const role of ["anon","authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(()=>bind("agent@example.test",id2));checks++;
    eq((await db.query("select * from storage.objects")).rows.length,0);
    await assert.rejects(()=>db.exec("insert into storage.objects values(gen_random_uuid(),'applicant-docs','attack.pdf')"));checks++;
    await db.exec("reset role");
  }
  await db.exec("set role service_role");eq((await db.query("select * from storage.objects")).rows.length,2);
  console.log(`PASS ${checks} identity and storage SQL checks: verified ID binding, email reuse, suspension, service-only RPC and private buckets`);
} finally { await db.close(); }
