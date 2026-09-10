// Exercises the destructive migration against a disposable PostgreSQL instance.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const {PGlite} = await import(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const db = new PGlite();
const schema = readFileSync(new URL("../supabase/schema.sql",import.meta.url),"utf8");
const migration = readFileSync(new URL("../supabase/drop-listing-presentation-fields.sql",import.meta.url),"utf8");
try {
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  await db.exec(schema);
  // Reproduce the previously deployed columns/index, including nonempty values.
  await db.exec(`alter table listings add column price_display text, add column neighborhood text,
    add column kind_label text, add column position integer not null default 0;
    drop index listings_feed_idx;
    create index listings_feed_idx on listings(published,position,created_at desc);`);
  const {rows:[listing]} = await db.query(`insert into listings(category,transaction_type,title,price_amount,price_display,neighborhood,kind_label,position)
    values('residential','rental','Migration test (mock)',3200,'$1','Old area','Old badge',5) returning id`);
  await db.query(`insert into listing_media(listing_id,kind,path,position) values($1,'photo','mock-cover.webp',2)`,[listing.id]);
  await db.exec(migration);
  await db.exec(migration);
  await db.exec(schema);
  const {rows:columns} = await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name='listings'`);
  for (const field of ['price_display','neighborhood','kind_label','position']) assert(!columns.some(row => row.column_name === field));
  const {rows:[saved]} = await db.query(`select id,title,price_amount from listings where id=$1`,[listing.id]);
  assert.equal(saved.id,listing.id); assert.equal(saved.title,'Migration test (mock)'); assert.equal(Number(saved.price_amount),3200);
  const {rows:[media]} = await db.query(`select path,position from listing_media where listing_id=$1`,[listing.id]);
  assert.equal(media.path,'mock-cover.webp'); assert.equal(media.position,2);
  const {rows:[index]} = await db.query(`select indexdef from pg_indexes where indexname='listings_feed_idx'`);
  assert(index.indexdef.includes('created_at DESC, id DESC'));
  console.log('PASS listing migration: four columns dropped, existing listing/price/photo order preserved, new index present, migration and schema rerunnable');
} finally { await db.close(); }
