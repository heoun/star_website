// Portal recovery is driven by durable membership, never a tab's old form state.
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import {createIdentityFixture} from './identity-fixtures.mjs';
import {completeDemoState,DEMO_ENCRYPTION_KEY} from './demo-data.mjs';
import {ids} from '../backend/tools/workspace-fixtures.mjs';
import {pendingOwnedApplications} from '../worker/rental-drafts.js';
const {fixture,env,user,restore}=createIdentityFixture();
await completeDemoState(fixture.state);
const lead=user('resume-lead@example.test'),mate=user('resume-mate@example.test'),other=user('resume-other@example.test');
Object.assign(env,{APP_ENCRYPTION_KEY:DEMO_ENCRYPTION_KEY,RENTAL_AUTOMATION:'on',RENTAL_SCREENING:'mock',LOCAL_EMAIL_SINK:{async send(m){fixture.state.emails.push(m);}}});
const pending=[];let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const call=(path,cookie='',body)=>worker.fetch(new Request('http://127.0.0.1'+path,{method:body?'POST':'GET',headers:{Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env,{waitUntil:p=>pending.push(p)});
const login=async email=>(await call('/api/portal/login','',{email,password:'testing-password'})).headers.get('Set-Cookie').split(';')[0];
const dashboard=async cookie=>{const r=await call('/api/portal/applications',cookie);eq(r.status,200);return r.json();};
try {
 const owner=await login(lead.email),roommate=await login(mate.email),stranger=await login(other.email);
 eq((await call('/api/portal/applications')).status,401);
 const group=crypto.randomUUID();
 eq((await call('/api/apply/invite',owner,{listing_id:ids.listing,draft_group_id:group,roommates:[{email:mate.email,first_name:'Private',last_name:'Roommate'}]})).status,200);
 let page=await dashboard(owner),card=page.pending_applications[0];
 eq(page.applications.length,0);eq(card.group_id,group);eq(card.submitted_count,0);eq(card.listing.title,fixture.state.listings.find(l=>l.id===ids.listing).title);
 eq((await dashboard(roommate)).pending_applications,[]);eq((await dashboard(stranger)).pending_applications,[]);
 eq(await pendingOwnedApplications(env,{email:lead.email,subject:other.id}),[]);
 eq(await pendingOwnedApplications(env,{email:other.email,subject:lead.id}),[]);
 const payload={...fixture.state.applications[0],listing_id:ids.listing,id_type:'passport',id_number:'TEST12345',sales_person:'',roommates:[]};
 eq((await call('/api/apply',roommate,{...payload,group_root:group,account_email:mate.email,invited_email:mate.email})).status,201);
 // Logging in afresh, without the original tab's draft ID, rediscovers the case.
 const returnedOwner=await login(lead.email);
 page=await dashboard(returnedOwner);card=page.pending_applications[0];
 eq(page.applications.length,0);eq(card.group_id,group);eq(card.submitted_count,1);
 const link=new URL(card.continue_url,'http://127.0.0.1');
 eq(link.pathname,'/apply/');eq(link.searchParams.get('id'),ids.listing);eq(link.searchParams.get('group'),group);eq(link.searchParams.get('invited'),lead.email);
 eq(link.searchParams.get('invite').split('.')[0],group);
 eq(Object.keys(card).sort(),['continue_url','created_at','group_id','listing','listing_id','submitted_count']);
 eq(JSON.stringify(card).includes(mate.email),false);eq(JSON.stringify(card).includes('workspace'),false);
 const root=fixture.state.applications.find(a=>a.id===group),saved=structuredClone(root);
 const hidden=async()=>eq((await dashboard(returnedOwner)).pending_applications,[]);
 root.workspace.invitations=[];await hidden(); // canceled live invitation beats stale draft
 Object.assign(root,structuredClone(saved));root.workspace.invitations.find(i=>i.role==='inviter').expires='2000-01-01';await hidden();
 Object.assign(root,structuredClone(saved));root.rental_group_id=crypto.randomUUID();await hidden(); // split/merged away
 Object.assign(root,structuredClone(saved));root.status='lease_signed';await hidden();
 Object.assign(root,structuredClone(saved));root.listing_id=crypto.randomUUID();await hidden();
 Object.assign(root,structuredClone(saved));fixture.state.applications=fixture.state.applications.filter(a=>a!==root);await hidden();
 fixture.state.applications.push(root);
 // Multiple groups for one property retain distinct selectors, including beyond
 // the first database page; an accepted owner must disappear from pending cards.
 const draft=fixture.state.rental_drafts.find(d=>d.id===group);
 const extra=Array.from({length:101},()=>({...structuredClone(draft),id:crypto.randomUUID(),activated:false,invitations:structuredClone(saved.workspace.invitations)}));
 fixture.state.rental_drafts.push(...extra);
 const many=(await dashboard(returnedOwner)).pending_applications;eq(many.length,102);eq(new Set(many.map(c=>c.continue_url)).size,102);
 fixture.state.rental_drafts=[draft];
 const result=await call('/api/apply',returnedOwner,{...payload,group_root:link.searchParams.get('group'),group_invite:link.searchParams.get('invite'),invited_email:lead.email,account_email:lead.email});
 eq(result.status,201);await Promise.all(pending.splice(0));
 page=await dashboard(returnedOwner);eq(page.pending_applications,[]);eq(page.applications.length,1);
 const members=fixture.state.applications.filter(a=>a.rental_group_id===group);eq(members.length,2);eq(members.map(a=>a.email).sort(),[lead.email,mate.email].sort());
 eq((await dashboard(roommate)).applications.length,1);
 console.log(`PASS ${checks} pending application recovery checks: authenticated ownership, fresh login, same group, privacy, cancellation, expiry, removal and pagination`);
} finally {await Promise.allSettled(pending);restore();}
