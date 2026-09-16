import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};const reject=async fn=>{await assert.rejects(fn);checks++;};
try {
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const name of ['schema','backoffice','workspace','rental-flow','rental-signing','rental-signing'])await db.exec(readFileSync(`supabase/${name}.sql`,'utf8'));
 await db.exec("insert into staff(email,role)values('admin@example.test','manager'),('agent@example.test','agent'),('other@example.test','agent')");
 const listing=(await db.query("insert into listings(title,category,transaction_type)values('Unit','residential','rental')returning id")).rows[0].id;
 const insert=async(name,email)=>(await db.query("insert into applications(listing_id,name,email,responsible_email)values($1,$2,$3,'agent@example.test')returning *",[listing,name,email])).rows[0];
 const root=await insert('Tenant A','a@example.test'),mate=await insert('Tenant B','b@example.test');
 await db.query('update applications set rental_group_id=$1 where id=$2',[root.id,mate.id]);
 const values={'landlord.print_name':'Landlord A','rent.monthly':'2500'};
 const w={rental_flow:'automatic',recommendation:{revision:4},landlord_decision:{outcome:'accepted',revision:4},lease_preparation:{by:'system'},activity:[]};
 await db.query("update applications set status='landlord_approved',workspace=$1,lease_snapshot=$2 where id=$3",[w,values,root.id]);
 const versions=async()=>Object.fromEntries((await db.query('select id,workspace_version from applications where rental_group_id=$1',[root.id])).rows.map(a=>[a.id,a.workspace_version]));
 const make=async()=>{
  const id=crypto.randomUUID(),pkg={id,rentalId:root.id,approvalRevision:4,values,signers:[{recipientId:'1',role:'tenant',memberId:root.id},{recipientId:'2',role:'tenant',memberId:mate.id},{recipientId:'3',role:'landlord',memberId:null}],createdAt:new Date().toISOString()};
  const record={package:pkg,version:0,phase:'preparing',envelope:null},v=await versions();
  await db.query('insert into rental_signing_packages(id,rental_id,record,member_versions)values($1,$2,$3,$4)',[id,root.id,record,v]);
  return {id,record,v};
 };
 const s=await make();
 const reserve=(actor,v=s.v,id=s.id)=>db.query('select reserve_rental_signing($1,$2,$3)',[id,actor,v]);
 await reject(()=>reserve('other@example.test'));await reject(()=>reserve('missing@example.test'));
 await reject(()=>reserve('admin@example.test',{...s.v,[root.id]:999}));
 await reserve('agent@example.test');eq((await db.query('select active from rental_signing_packages where id=$1',[s.id])).rows[0].active,true);
 await reserve('agent@example.test');checks++;
 for(const sql of ["update applications set name='Changed' where id=$1","update applications set workspace=workspace||'{\"tenant_signature\":{}}'::jsonb where id=$1",'delete from applications where id=$1'])await reject(()=>db.query(sql,[root.id]));
 await reject(()=>db.query("update applications set name='Changed' where id=$1",[mate.id]));
 await db.query("update applications set notes='A staff note' where id=$1",[root.id]);checks++;
 await reject(()=>db.query("insert into application_documents(application_id,doc_type,path,file_name,content_type,size_bytes,uploaded_by)values($1,'bank_statement','x/a.pdf','a.pdf','application/pdf',20,'applicant')",[mate.id]));
 const claim=(await db.query('select claim_rental_signing(1) as c')).rows[0].c[0];
 eq((await db.query('select claim_rental_signing(1) as c')).rows[0].c,[]);
 const save=(record,version=s.record.version,token=claim.claimToken)=>db.query('select save_rental_signing($1,$2,$3,$4)',[s.id,record,version,token]);
 s.record.envelope={accountId:'account',envelopeId:crypto.randomUUID(),status:'sent',recipients:[{recipientId:'1',status:'completed',signedAt:'2026-09-16'},{recipientId:'2',status:'sent'},{recipientId:'3',status:'pending'}]};s.record.phase='in_progress';
 await reject(()=>save(s.record,0,crypto.randomUUID()));
 await save(s.record);s.record.version++;
 const row=async()=>(await db.query('select * from applications where id=$1',[root.id])).rows[0];
 eq((await row()).status,'lease_sent');eq(Object.keys((await row()).workspace.signature_receipts),[root.id]);eq((await row()).workspace.tenant_signature,undefined);
 await reject(()=>save({...s.record,phase:'completed'}));
 s.record.envelope.status='completed';s.record.envelope.recipients=s.record.envelope.recipients.map(r=>({...r,status:'completed',signedAt:'2026-09-16'}));
 await reject(()=>save({...s.record,phase:'completed'}));
 s.record.phase='completed';s.record.signedPdf={path:'private/signed.pdf'};s.record.certificate={path:'private/certificate.pdf'};
 await save(s.record);s.record.version++;
 eq((await row()).status,'lease_signed');eq((await row()).workspace.signed_lease.path,'private/signed.pdf');
 await reject(()=>save({...s.record,phase:'in_progress'}));
 await reject(()=>db.query('select void_rental_signing($1,$2,$3)',[s.id,'admin@example.test','Cancel']));
 await db.query('select enqueue_rental_signing($1,$2)',[{accountId:'account',envelopeId:s.record.envelope.envelopeId},'eventhash']);
 await db.query('select enqueue_rental_signing($1,$2)',[{accountId:'account',envelopeId:s.record.envelope.envelopeId},'eventhash']);
 eq((await db.query('select count(*)::int n from rental_signing_inbox')).rows[0].n,1);
 await db.query('select release_rental_signing($1,$2,null)',[s.id,claim.claimToken]);
 eq((await db.query('select claim_rental_signing(1) as c')).rows[0].c.length,1);
 for(const role of ['anon','authenticated']) {
  await db.exec(`set role ${role}`);await reject(()=>db.query('select * from rental_signing_packages'));await reject(()=>db.query('select claim_rental_signing(1)'));await db.exec('reset role');
 }
 console.log(`PASS ${checks} signing database checks: migration, access, stale review, locks, claims, per-person receipts, completion archive and webhook deduplication`);
}finally{await db.close();}
