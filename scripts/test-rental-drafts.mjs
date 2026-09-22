import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const rejects=async fn=>{await assert.rejects(fn);checks++;};
try {
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const name of ['schema','backoffice','workspace','rental-flow','rental-membership','rental-drafts','rental-drafts'])await db.exec(readFileSync(`supabase/${name}.sql`,'utf8'));
 const listing=(await db.query("insert into listings(title,category,transaction_type,bedrooms) values('Invitation fixture','residential','rental',2) returning id")).rows[0].id;
 const owner='owner-subject',email='owner@example.test',mate='mate@example.test';
 const save=async(id=crypto.randomUUID(),actor=owner,inbox=email,roommates=[{email:mate,name:'Roommate'}],test=null)=>(await db.query('select to_jsonb(save_rental_draft($1,$2,$3,$4,$5,$6)) d',[id,listing,actor,inbox,roommates,test])).rows[0].d;
 const submit=async(id,inbox,actor='roommate-subject',extra={},token=null)=>(await db.query('select submit_draft_application($1,$2,$3,$4) result',[id,actor,{listing_id:listing,email:inbox,name:inbox,workspace:{terms:{'rent.monthly':'3000'}},...extra},token])).rows[0].result;
 const rows=async id=>(await db.query('select * from applications where rental_group_id=$1',[id])).rows;
 const draft=await save();eq((await rows(draft.id)).length,0);
 eq((await save(draft.id)).invitations.length,2);
 await rejects(()=>save(draft.id,'different-owner'));
 await rejects(()=>save(draft.id,owner,email,[{email:'third@example.test'}]));
 await rejects(()=>submit(draft.id,'stranger@example.test'));
 await rejects(()=>submit(draft.id,email,'different-owner'));
 await rejects(()=>submit(draft.id,mate,'mate',{},crypto.randomUUID()));
 // Roommate first: a real, complete application, plus an unconsumed inviter.
 await rejects(()=>submit(draft.id,mate,'roommate-subject',{listing_id:crypto.randomUUID()}));
 await db.query('select record_draft_invite_delivery($1,$2)',[draft.id,[mate]]);
 eq((await db.query('select invitations from rental_drafts where id=$1',[draft.id])).rows[0].invitations.find(i=>i.email===mate).delivery,'sent');
 const first=await submit(draft.id,mate);eq(first.application.id,draft.id);eq(first.replayed,false);
 eq(first.application.workspace.invitations.find(i=>i.role==='inviter').accepted,undefined);
 eq((await rows(draft.id)).length,1);
 const replay=await submit(draft.id,mate,'roommate-subject',{name:'Must not overwrite'});eq(replay.replayed,true);eq(replay.application.name,mate);
 const second=await submit(draft.id,email,owner,{responsible_email:'agent@example.test'});eq((await rows(draft.id)).every(a=>a.responsible_email==='agent@example.test'),true);eq(second.application.rental_group_id,draft.id);eq((await rows(draft.id)).length,2);
 eq((await rows(draft.id)).find(a=>a.id===draft.id).workspace.invitations.every(i=>i.accepted),true);
 eq((await submit(draft.id,email,owner)).replayed,true);
 await rejects(()=>save(draft.id));
 // Lead-first and internal repeated runs use the identical transaction.
 const run=crypto.randomUUID(),test=await save(run,owner,email,[{email:mate,name:'Mate'}],{id:run,account_id:owner,created_at:new Date().toISOString()});
 const lead=await submit(test.id,email,owner);eq(lead.application.id,test.id);eq(lead.application.workspace.test_run.member_of,test.id);
 const pair=await Promise.all([submit(test.id,mate),submit(test.id,mate)]);
 eq(pair.map(r=>r.replayed),[false,true]);eq(pair[0].application.id,pair[1].application.id);eq((await rows(test.id)).length,2);
 const roommate=pair[0];eq(roommate.application.rental_group_id,test.id);eq(roommate.application.workspace.test_run.id,run);
 await db.query('select record_draft_invite_delivery($1,$2)',[test.id,[mate]]);
 eq((await rows(test.id)).find(a=>a.id===test.id).workspace.invitations.find(i=>i.email===mate).delivery,'sent');
 // A closed or removed group never resurrects via its old draft record.
 const closed=await save(crypto.randomUUID(),owner,'new-owner@example.test',[{email:'new-mate@example.test'}]);
 await submit(closed.id,'new-mate@example.test');
 await db.query("update applications set status='sent_to_landlord' where id=$1",[closed.id]);
 await rejects(()=>submit(closed.id,'new-owner@example.test',owner));
 await db.query("update applications set status='new',workspace=jsonb_set(workspace,'{invitations}','[]') where id=$1",[closed.id]);
 await rejects(()=>submit(closed.id,'new-owner@example.test',owner));
 await db.query('delete from applications where id=$1',[closed.id]);
 await rejects(()=>submit(closed.id,'new-owner@example.test',owner));
 const expired=await save(crypto.randomUUID(),owner,'expired-owner@example.test',[{email:'expired@example.test'}]);
 await db.query("update rental_drafts set invitations=jsonb_set(invitations,'{1,expires}','\"2000-01-01T00:00:00Z\"') where id=$1",[expired.id]);
 await rejects(()=>submit(expired.id,'expired@example.test'));
 eq((await rows(expired.id)).length,0);
 // Ordinary duplicate applications remain blocked, atomically.
 const duplicate=await save();await rejects(()=>submit(duplicate.id,mate));eq((await rows(duplicate.id)).length,0);
 for(const role of ['anon','authenticated']){
  await db.exec(`set role ${role}`);
  await rejects(()=>db.query('select * from rental_drafts'));
  await rejects(()=>save());await rejects(()=>submit(draft.id,mate));
  await rejects(()=>db.query('select record_draft_invite_delivery($1,$2)',[draft.id,[mate]]));
  await db.exec('reset role');
 }
 console.log(`PASS ${checks} durable invitation database checks`);
} finally {await db.close();}
