import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};const rejects=async fn=>{await assert.rejects(fn);checks++;};
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const name of ['schema','backoffice','workspace','rental-flow','rental-flow'])await db.exec(readFileSync(`supabase/${name}.sql`,'utf8'));
 const listing=(await db.query("insert into listings(title,category,transaction_type)values('Mock unit','residential','rental')returning id")).rows[0].id;
 const submit=async(data,root=null,invite=null)=>(await db.query('select to_jsonb(submit_rental_application($1,$2,$3)) as a',[{listing_id:listing,...data},root,invite])).rows[0].a;
 const invite={id:crypto.randomUUID(),email:'mate@example.test',name:'Mate',expires:'2099-01-01T00:00:00Z'};
 const lead=await submit({name:'Lead',email:'lead@example.test',workspace:{invitations:[invite]}});
 eq(lead.rental_group_id,lead.id);eq(lead.workspace.rental_flow,'automatic');
 const external = await submit({name:"External fixture",email:"external@example.test"});
 await db.query("insert into application_documents(application_id,doc_type,path,uploaded_by)values($1,'external_source','fixture/external.pdf','staff')",[external.id]);
 await rejects(()=>db.query("insert into application_documents(application_id,doc_type,path,uploaded_by)values($1,'external_source','fixture/rejected.pdf','applicant')",[lead.id]));

 await rejects(()=>submit({name:'Wrong',email:'wrong@example.test'},lead.id,invite.id));
 eq((await db.query('select count(*)::int n from applications')).rows[0].n,2);
 const mate=await submit({name:'Mate',email:'mate@example.test'},lead.id,invite.id);eq(mate.rental_group_id,lead.id);
 await rejects(()=>submit({name:'Mate',email:'mate@example.test'},lead.id,invite.id));
 const all=async()=> (await db.query('select * from applications where rental_group_id=$1 order by id',[lead.id])).rows;
 const commit=async(patches,versions)=>db.query('select commit_rental_group($1,$2,$3,$4,null)',[lead.id,versions || Object.fromEntries((await all()).map(a=>[a.id,a.workspace_version])),patches,'admin@example.test']);
 const stale=Object.fromEntries((await all()).map(a=>[a.id,a.workspace_version]));
 await commit({[mate.id]:{workspace:{checks:{screening:'received'}}}});
 await rejects(()=>commit({[lead.id]:{status:'landlord_approved'}},stale));
 eq((await all()).find(a=>a.id===lead.id).status,'new');
 await rejects(()=>commit({[lead.id]:{email:'forged@example.test'}}));
 await commit({[lead.id]:{responsible_email:'agent@example.test',collaborator_emails:['helper@example.test'],workspace:{recommendation:{revision:5},rental_flow:'automatic'},status:'sent_to_landlord'}});
 eq((await all()).find(a=>a.id===mate.id).responsible_email,'agent@example.test');
 await db.query("update applications set income_note='80000' where id=$1",[mate.id]);
 eq((await all()).find(a=>a.id===lead.id).workspace.recommendation,undefined);
 await commit({[lead.id]:{workspace:{recommendation:{revision:8},rental_flow:'automatic'},status:'landlord_approved'}});
 await db.query("insert into application_documents(application_id,doc_type,path,file_name,content_type,size_bytes,uploaded_by) values($1,'bank_statement','mock/file.pdf','file.pdf','application/pdf',20,'applicant')",[mate.id]);
 eq((await all()).find(a=>a.id===lead.id).status,'review');
 const third=await submit({name:'Third',email:'third@example.test'});
 const joinedVersions={...Object.fromEntries((await all()).map(a=>[a.id,a.workspace_version])),[third.id]:third.workspace_version};
 await db.query('select commit_rental_group($1,$2,$3,$4,$5)',[lead.id,joinedVersions,{[lead.id]:{workspace:{rental_flow:'automatic',recommendation:{revision:10}}}},'admin@example.test',third.id]);
 eq((await db.query('select rental_group_id from applications where id=$1',[third.id])).rows[0].rental_group_id,lead.id);
 await db.query('delete from applications where id=$1',[third.id]);eq((await all()).find(a=>a.id===lead.id).workspace.recommendation,undefined);
 await commit({[lead.id]:{status:'lease_sent'}});
 await rejects(()=>db.query("update applications set name='Changed' where id=$1",[mate.id]));
 await rejects(()=>db.query("delete from application_documents where application_id=$1",[mate.id]));
 await rejects(()=>db.query('delete from applications where id=$1',[mate.id]));
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await rejects(()=>submit({name:'Forbidden',email:'forbidden@example.test'}));await rejects(()=>commit({},{}));await db.exec('reset role');}
 console.log(`PASS ${checks} rental database checks: group join, invitation account binding, atomic rollback, version protection, reassignment, invalidation and signing locks`);
}finally{await db.close();}
