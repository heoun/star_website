import assert from 'node:assert/strict';
import {workspaceInvitationStates} from '../worker/workspace-invitation-state.js';
import {sendWorkspaceInvitation} from '../worker/workspace-invitations.js';
const env={SUPABASE_URL:'https://db.example.test',SUPABASE_SERVICE_ROLE_KEY:'test'};
const email='same@example.test', realFetch=globalThis.fetch;
let setup=false, linked=true, accepted=false, revoked=false, expired=false, workspace=true, mutations=0;
globalThis.fetch=async(url,init={})=>{
 const u=new URL(url); if(init.method && init.method!=='GET')mutations++;
 if(u.pathname.endsWith('/app_users')){assert.equal(u.searchParams.get('realm'),'eq.workspace');return Response.json(workspace?[{id:'workspace-id',email,password_setup_required:setup}]:[]);}
 if(u.pathname.endsWith('/staff'))return Response.json([{email,active:true,role:'agent',user_id:linked?'workspace-id':null,access_state:linked?'active':'invited'}]);
 if(u.pathname.endsWith('/workspace_invitations'))return Response.json([{email,accepted_at:accepted?'now':null,revoked_at:revoked?'now':null,expires_at:new Date(Date.now()+(expired?-10000:10000)).toISOString()}]);
 throw Error('Unexpected request '+u.pathname);
};
const state=async()=>(await workspaceInvitationStates(env,[email])).get(email);
try {
 assert.deepEqual(await state(),{activated:true,pending:false});
 assert.deepEqual(await sendWorkspaceInvitation(new Request('https://site.example.test'),env,email),{status:'already_activated'});assert.equal(mutations,0);
 setup=true;assert.deepEqual(await state(),{activated:false,pending:true});
 accepted=true;assert.deepEqual(await state(),{activated:false,pending:false});
 accepted=false;revoked=true;assert.equal((await state()).pending,false);
 revoked=false;expired=true;assert.equal((await state()).pending,false);
 expired=false;setup=false;linked=false;assert.deepEqual(await state(),{activated:false,pending:true});
 linked=true;workspace=false;assert.deepEqual(await state(),{activated:false,pending:true});
 assert.equal((await workspaceInvitationStates(env,[])).size,0);
 console.log('PASS invitation lifecycle: activated send blocked, migration setup, accepted/revoked/expired invitations, separate realms');
} finally {globalThis.fetch=realFetch;}
