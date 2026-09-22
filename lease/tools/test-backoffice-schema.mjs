// PGlite is optional, like test-schema.mjs. Never connects to a live database.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const { PGlite } = await import(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const db = new PGlite();
try {
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  await db.exec(readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8"));
  const migration = readFileSync(new URL("../../supabase/backoffice.sql", import.meta.url), "utf8");
  await db.exec(migration); await db.exec(migration);
  const { rows: [building] } = await db.query("insert into buildings(name) values ('Test property') returning id");
  await db.query("insert into staff(email,role,property_ids) values ('owner@example.test','landlord',$1)", [[building.id]]);
  const { rows: [member] } = await db.query("select * from staff where email='owner@example.test'");
  assert.deepEqual(member.property_ids, [building.id]);
  await assert.rejects(() => db.query("insert into staff(email,role) values ('bad@example.test','superadmin')"));
  const { rows: [request] } = await db.query("insert into listing_change_requests(listing_title,message,created_by,building_id) values ('Test unit','Please update the listing description.','owner@example.test',$1) returning *", [building.id]);
  assert.equal(request.status, "open");
  await assert.rejects(() => db.query("update listing_change_requests set status='unknown' where id=$1", [request.id]));
  await assert.rejects(() => db.query("update listing_change_requests set message='short' where id=$1", [request.id]));
  await db.query("update listing_change_requests set status='resolved',response='Description updated.',updated_by='agent@example.test' where id=$1", [request.id]);
  await db.exec("set role authenticated");
  await assert.rejects(() => db.query("select * from listing_change_requests"));
  await assert.rejects(() => db.query("select * from staff"));
  await db.exec("reset role; set role service_role;");
  assert.equal((await db.query("select * from listing_change_requests")).rows.length, 1);
  console.log("PASS back-office migration, rerun, assignments, request constraints, and database access grants");
} finally { await db.close(); }
