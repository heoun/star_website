import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const migration=readFileSync('supabase/listing-publication.sql','utf8');
try {
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  await db.exec(readFileSync('supabase/schema.sql','utf8'));
  const {rows:[l]}=await db.query("insert into listings(category,transaction_type,title,price_amount,published) values('residential','rental','Original',3000,true) returning id");
  const {rows:[m]}=await db.query("insert into listing_media(listing_id,kind,path) values($1,'photo','old.webp') returning id",[l.id]);
  await db.exec(migration);await db.exec(migration);
  const read=async()=> (await db.query('select * from listings where id=$1',[l.id])).rows[0];
  let row=await read();assert.equal(row.published_snapshot.title,'Original');assert.equal(row.published_revision,1);
  await db.query("update listings set title='Draft',price_amount=4000 where id=$1",[l.id]);
  await db.query("update listing_media set caption='Draft caption' where id=$1",[m.id]);
  row=await read();assert.equal(row.draft_revision,3);assert.equal(row.published_snapshot.price_amount,3000);assert.equal(row.published_snapshot.listing_media[0].caption,null);
  assert.equal((await db.query('select publish_listing($1,1) as r',[l.id])).rows[0].r,null);
  assert.equal((await db.query('select publish_listing($1,3) as r',[l.id])).rows[0].r.title,'Draft');
  row=await read();assert.equal(row.published_revision,3);assert.equal(row.draft_revision,3);
  await db.query('delete from listing_media where id=$1',[m.id]);
  row=await read();assert.equal(row.draft_revision,4);assert.equal(row.published_snapshot.listing_media[0].path,'old.webp');
  await db.exec(migration);assert.equal((await read()).published_snapshot.listing_media.length,1);
  await db.query('select publish_listing($1,4)',[l.id]);assert.equal((await read()).published_snapshot.listing_media.length,0);
  await db.query('update listings set published=false where id=$1',[l.id]);assert.equal((await read()).published,false);
  await db.exec('set role anon');
  await assert.rejects(db.query('select publish_listing($1,4)',[l.id]),/permission denied/);
  await db.exec('reset role');
  console.log('PASS publication schema: migration preservation and repeatability, draft isolation, media revisions, stale publish rejection, atomic snapshot, unpublish, restricted RPC');
} finally {await db.close();}
