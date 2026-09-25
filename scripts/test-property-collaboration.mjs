import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {validateCollaborationDraft,handlePropertyCollaboration} from '../worker/property-collaboration.js';
import {workspaceNavigation} from '../site/shared/workspace-navigation.js';
const db=new PGlite();let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 await db.exec(readFileSync('supabase/schema.sql','utf8'));
 const schema=readFileSync('supabase/property-collaboration.sql','utf8');await db.exec(schema);await db.exec(schema);
 await db.exec("insert into staff(email,role) values('admin@example.test','manager'),('agent@example.test','agent'),('other@example.test','agent')");
 const b=(await db.query("insert into buildings(name) values('Building A') returning *")).rows[0];
 const cmd=async(actor,action,id=null,body={})=>(await db.query('select property_collaboration_command($1,$2,$3,$4) as result',[actor,action,id,body])).rows[0].result;
 const admin='admin@example.test',agent='agent@example.test',other='other@example.test';
 const grant=()=>cmd(admin,'grant',null,{building_id:b.id,agent_email:agent,expires_at:new Date(Date.now()+86400000).toISOString()});
 let r=(await grant()).collaboration;
 eq((await cmd(other,'detail',r.id)).status,403);
 eq((await cmd(agent,'grant',null,{})).status,403);
 eq((await cmd(agent,'list')).collaborations.length,1);
 eq((await cmd(other,'list')).collaborations.length,0);
 eq((await grant()).status,409);
 let result=await cmd(agent,'save',r.id,{version:0,property_patch:{city:'New York'},settings_patch:{'manager.name':'Proposed Manager'}});
 r=result.collaboration;eq(r.version,1);
 eq((await db.query('select city from buildings where id=$1',[b.id])).rows[0].city,null);
 eq((await db.query('select count(*)::int n from lease_settings')).rows[0].n,0);
 eq((await cmd(agent,'save',r.id,{version:0,property_patch:{},settings_patch:{}})).status,409);
 eq((await cmd(agent,'approve',r.id,{version:1})).status,403);
 r=(await cmd(agent,'submit',r.id,{version:1})).collaboration;
 eq((await cmd(agent,'save',r.id,{version:r.version,property_patch:{},settings_patch:{}})).status,403);
 r=(await cmd(admin,'return',r.id,{version:r.version,note:'Please verify the name.'})).collaboration;
 eq(r.state,'draft');
 r=(await cmd(agent,'submit',r.id,{version:r.version})).collaboration;
 r=(await cmd(admin,'approve',r.id,{version:r.version})).collaboration;
 eq(r.state,'approved');
 eq((await db.query('select city from buildings where id=$1',[b.id])).rows[0].city,'New York');
 eq((await db.query('select field_values from lease_settings where building_id=$1',[b.id])).rows[0].field_values['manager.name'],'Proposed Manager');
 eq((await cmd(agent,'detail',r.id)).status,403);
 eq((await cmd(admin,'approve',r.id,{version:r.version})).status,409);
 eq((await cmd(admin,'detail',r.id)).history.length,6);
 // Revocation and expiration block both read and write, with history retained.
 r=(await grant()).collaboration;
 await cmd(admin,'revoke',r.id,{version:0});
 eq((await cmd(agent,'detail',r.id)).status,403);
 eq((await cmd(agent,'save',r.id,{version:1,property_patch:{},settings_patch:{}})).status,403);
 r=(await grant()).collaboration;
 await db.query("update property_collaborations set expires_at=now()-interval '1 second' where id=$1",[r.id]);
 eq((await cmd(agent,'detail',r.id)).status,403);eq((await cmd(agent,'list')).collaborations.length,0);
 eq((await cmd(agent,'submit',r.id,{version:0})).status,403);
 // A stale proposal cannot overwrite newer live values.
 r=(await grant()).collaboration;
 r=(await cmd(agent,'save',r.id,{version:0,property_patch:{city:'Old Proposal'},settings_patch:{}})).collaboration;
 r=(await cmd(agent,'submit',r.id,{version:r.version})).collaboration;
 await db.query("update buildings set city='New Live Value' where id=$1",[b.id]);
 eq((await cmd(admin,'approve',r.id,{version:r.version})).status,409);
 eq((await db.query('select city from buildings where id=$1',[b.id])).rows[0].city,'New Live Value');
 // Deactivated staff cannot read pending drafts.
 await db.query('update staff set active=false where email=$1',[agent]);
 eq((await cmd(agent,'detail',r.id)).status,403);
 await db.query('update staff set active=true where email=$1',[agent]);
 // Direct public database access is forbidden.
 for(const role of ['anon','authenticated']){
 await db.exec('set role '+role);await assert.rejects(()=>cmd(admin,'list'));checks++;
 await assert.rejects(()=>db.query('select * from property_collaborations'));checks++;await db.exec('reset role');}
 // Worker rejects fields that could change a deal or identity outside this property.
 for(const body of [
 {property_patch:{role:'manager'},settings_patch:{}},
 {property_patch:{},settings_patch:{'rent.monthly':'1'}},
 {property_patch:{name:null},settings_patch:{}},
 {property_patch:{},settings_patch:{'insurance.required_yes':'true'}},
 {property_patch:{landlord_signer_email:'bad'},settings_patch:{}}
 ]){assert.throws(()=>validateCollaborationDraft({...body,version:0}));checks++;}
 eq(validateCollaborationDraft({version:0,property_patch:{city:' New York '},settings_patch:{'insurance.required_yes':false}}).property_patch.city,'New York');
 eq(Boolean(workspaceNavigation({role:'agent',property_collaboration_ids:[b.id]}).properties),true);
 eq(Boolean(workspaceNavigation({role:'agent',property_ids:[b.id]}).properties),false);
 for(const role of ['landlord','owner']){
 const response=await handlePropertyCollaboration(new Request('https://test/api/admin/property-collaborations'),{}, {role,owner:role==='owner'},['property-collaborations']);
 eq(response.status,403);}
 console.log('PASS '+checks+' property collaboration checks: isolation, approval, expiry, revocation, stale versions, live conflicts, history, field validation and role boundaries');
}finally{await db.close();}
