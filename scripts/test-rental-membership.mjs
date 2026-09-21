import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createWorkspaceFixtures,ids} from '../backend/tools/workspace-fixtures.mjs';
import {completeDemoState} from './demo-data.mjs';
import {seedRentalDemo} from './rental-demo-data.mjs';
import {rentalWorkflow} from '../worker/rentals.js';
import {handleCaseWorkspace} from '../worker/backoffice.js';
const fixture=createWorkspaceFixtures();await completeDemoState(fixture.state);await seedRentalDemo(fixture.state);
const original=globalThis.fetch;globalThis.fetch=fixture.fetch;
const env={...fixture.env,RENTAL_AUTOMATION:'on',RENTAL_SCREENING:'mock'},flow=rentalWorkflow(env,new Request('http://localhost'));
const admin={role:'manager',email:'admin@example.test'},agent={role:'agent',email:'agent-b@example.test'},wrong={role:'agent',email:'agent-a@example.test'};
const snapshot=structuredClone(fixture.state.applications);let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const rejects=async(fn,status)=>{await assert.rejects(fn,e=>!status || e.status===status);checks++;};
const reset=()=>{fixture.state.applications=structuredClone(snapshot);return fixture.state.applications.find(a=>a.id===ids.b);};
const mate=()=>fixture.state.applications.find(a=>a.rental_group_id===ids.b && a.id!==ids.b);
const command=(root,m,action='split_member')=>({action,version:root.workspace_version,member_id:m.id,reason:'Roommate withdrew',confirmed:true,confirm_name:m.name});
try {
 let root=reset(),member=mate();
 await rejects(()=>flow.execute(wrong,root.id,command(root,member)),404);
 await rejects(()=>flow.execute(agent,root.id,command(root,member,'remove_member')),403);
 await rejects(()=>flow.execute(admin,root.id,{...command(root,member),confirmed:false}),422);
 await rejects(()=>flow.execute(admin,root.id,{...command(root,member),version:-1}),409);
 await rejects(()=>flow.execute(admin,root.id,{...command(root,member,'remove_member'),confirm_name:'someone else'}),422);
 root.workspace.signing={package_id:'test',phase:'in_progress'};
 await rejects(()=>flow.execute(admin,root.id,command(root,member)),409);
 root=reset();member=mate();root.status='landlord_approved';root.workspace.recommendation={revision:9};root.workspace.landlord_decision={outcome:'approved'};root.lease_snapshot={'tenant.names':'Old group'};
 root.workspace.invitations=[{id:crypto.randomUUID(),email:member.email,name:member.name,accepted:member.id,expires:'2099-01-01'}];
 const evidence=structuredClone(member.workspace.screening_result),documents=structuredClone(member.application_documents);
 const split=await flow.execute(agent,root.id,command(root,member));
 eq(split.household.members.length,1);eq(member.rental_group_id,member.id);eq(member.workspace.screening_result,evidence);eq(member.application_documents,documents);
 eq(root.workspace.recommendation,undefined);eq(root.workspace.landlord_decision,undefined);eq(root.lease_snapshot,null);eq(root.workspace.invitations,[]);
 eq((await flow.get(admin,member.id)).household.members.length,1);
 root=reset();member=mate();const oldRoot=root.id;
 const swapped=await flow.execute(admin,root.id,command(root,root));
 eq(swapped.id,member.id);eq(root.rental_group_id,root.id);eq(member.rental_group_id,member.id);eq(swapped.workspace.activity.at(-1).action,'split_member');
 root=reset();member=mate();const removed=await flow.execute(admin,root.id,command(root,root,'remove_member'));
 eq(removed.id,member.id);eq(fixture.state.applications.some(a=>a.id===oldRoot),false);eq(removed.household.members.length,1);
 root=reset();member=mate();await flow.execute(admin,root.id,command(root,member,'remove_member'));
 eq(fixture.state.applications.some(a=>a.id===member.id),false);eq((await flow.get(admin,root.id)).household.members.length,1);
 // Exercise the HTTP action boundary and the private attachment cleanup.
 root=reset();member=mate();
 const files=new Map([[`${root.id}/keep.pdf`,true],[`${member.id}/remove.pdf`,true]]),pending=[];
 const httpEnv={...env,APPLICANT_DOCS:{async list({prefix}){return {objects:[...files.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key})),truncated:false};},async delete(keys){keys.forEach(key=>files.delete(key));}}};
 const request=body=>new Request(`http://localhost/api/admin/cases/${root.id}/actions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const context={waitUntil(p){pending.push(p);}};
 let response=await handleCaseWorkspace(request({...command(root,member,'remove_member'),confirm_name:'wrong'}),httpEnv,admin,root.id,'actions',context);
 eq(response.status,422);eq(pending.length,0);eq(files.size,2);
 response=await handleCaseWorkspace(request(command(root,member,'remove_member')),httpEnv,admin,root.id,'actions',context);
 eq(response.status,200);await Promise.all(pending);
 eq(files.has(`${member.id}/remove.pdf`),false);eq(files.has(`${root.id}/keep.pdf`),true);
}finally{globalThis.fetch=original;}
// Real SQL: versions, group transfer, deletion cascades and transactional rollback.
const db=new PGlite();
try {
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const name of ['schema','backoffice','workspace','rental-flow','rental-signing','rental-membership','rental-membership'])await db.exec(readFileSync(`supabase/${name}.sql`,'utf8'));
 const listing=(await db.query("insert into listings(title,category,transaction_type) values('Unit','residential','rental') returning id")).rows[0].id;
 async function household(){
  const root=crypto.randomUUID(),member=crypto.randomUUID();
  for(const [id,name] of [[root,'Lead'],[member,'Mate']])await db.query("insert into applications(id,listing_id,rental_group_id,name,email,workspace) values($1,$2,$3,$4,$5,$6)",[id,listing,root,name,`${id}@example.test`,{checks:{fee:'paid'},screening_result:{status:'complete',reference:id},rental_flow:'automatic'}]);
  return {root,member};
 }
 const rows=async root=>(await db.query('select * from applications where rental_group_id=$1',[root])).rows;
 async function separate(g,remove=false,primary=false,stale=false){
  const members=await rows(g.root),target=primary?g.root:g.member,remaining=primary?g.member:g.root;
  const versions=Object.fromEntries(members.map(m=>[m.id,stale?-1:m.workspace_version]));
  const patches=Object.fromEntries(members.map(m=>[m.id,{workspace:{...m.workspace,activity:[{action:remove?'remove_member':'split_member',by:'admin@example.test',at:new Date().toISOString(),detail:'Test withdrawal'}]},status:'review',lease_snapshot:null}]));
  return db.query('select separate_rental_member($1,$2,$3,$4,$5,$6,$7)',[g.root,versions,target,remaining,remove,patches,'admin@example.test']);
 }
 let g=await household();await rejects(()=>separate(g,false,false,true));eq((await rows(g.root)).length,2);
 await separate(g);eq((await rows(g.root)).length,1);eq((await rows(g.member)).length,1);eq((await rows(g.member))[0].workspace.screening_result.reference,g.member);
 g=await household();await separate(g,false,true);eq((await rows(g.root)).length,1);eq((await rows(g.member)).length,1);
 g=await household();await db.query("insert into application_documents(application_id,doc_type,path,file_name,content_type,size_bytes,uploaded_by) values($1,'bank_statement','mock/delete.pdf','file.pdf','application/pdf',20,'applicant')",[g.root]);
 await separate(g,true,true);eq((await rows(g.member)).length,1);eq((await db.query('select * from applications where id=$1',[g.root])).rows.length,0);eq((await db.query('select * from application_documents where application_id=$1',[g.root])).rows.length,0);
 g=await household();await db.query("update applications set status='lease_sent' where id=$1",[g.root]);await rejects(()=>separate(g,true));eq((await rows(g.root)).length,2);
 g=await household();await db.query("insert into rental_signing_packages(id,rental_id,record,member_versions,active) values($1,$2,'{}','{}',true)",[crypto.randomUUID(),g.root]);await rejects(()=>separate(g));eq((await rows(g.root)).length,2);
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await rejects(()=>db.query('select separate_rental_member($1,$2,$3,$4,false,$5,$6)',[g.root,{},g.member,g.root,{},'forged']));await db.exec('reset role');}
 console.log(`PASS ${checks} membership checks: staff scope, confirmation, CAS, split, primary replacement, targeted deletion, independent evidence, SQL atomicity, file cascade, signing lock and service-only access.`);
}finally{await db.close();}
