import assert from 'node:assert/strict';
import {createWorkspaceFixtures,ids} from '../backend/tools/workspace-fixtures.mjs';
import {completeDemoState} from './demo-data.mjs';
import {seedRentalDemo} from './rental-demo-data.mjs';
import {normalizeDemoNames,alphabet} from './demo-names.mjs';
const {state}=createWorkspaceFixtures();await completeDemoState(state);await seedRentalDemo(state);
const a=state.applications.find(a=>a.id===ids.a),b=state.applications.find(a=>a.id===ids.b),mate=state.applications.find(a=>a.id==='aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
// Simulate an existing saved demo with realistic and duplicated names.
delete state.demo_names;
a.name='Old Person One';a.first_name='Old';a.last_name='Person One';a.email='old.person@example.test';
b.name='Old Person Two';mate.name='Old Roommate';
state.buildings[0].name='Old Building';state.listings[0].title='Old Building · 2A';state.listings[0].property_name='Old Building';
state.staff[0].name='Old Administrator';state.staff[1].name='Old Agent';
state.settings[ids.property]['landlord.print_name']='Old Signer';
b.workspace.recommendation={tenant_name:'Old Person Two & Old Roommate',members:[{id:b.id,name:b.name},{id:mate.id,name:mate.name}],revision:4};b.status='sent_to_landlord';
b.workspace.lease_draft={values:{'tenant.names':'Old Person Two and Old Roommate'},missing:[]};
state.emails=[{to:'owner@example.test',subject:'Old Building · Old Person Two & Old Roommate',text:`Old Person Two and Old Roommate: http://localhost/landlord-decision/#id=${b.id}`}];
const signature=()=>JSON.stringify({apps:state.applications.map(a=>[a.id,a.status,a.rental_group_id,a.listing_id,a.workspace_version,a.workspace?.checks,a.workspace?.screening_result]),staff:state.staff.map(s=>[s.role,s.property_ids,s.active]),docs:state.documents,files:state.files});
const before=signature();normalizeDemoNames(state);let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
eq(a.name,'Applicant A');eq(a.email,'applicant-a@example.test');eq(b.name,'Applicant B');eq(mate.name,'Applicant E');eq(state.buildings[0].name,'Property A');eq(state.listings[0].property_name,'Property A');eq(state.listings[0].title,'Property A · Unit 2A');
eq(b.workspace.recommendation.tenant_name,'Applicant B & Applicant E');eq(b.workspace.recommendation.members.map(m=>m.name),['Applicant B','Applicant E']);eq(b.workspace.lease_draft.values['tenant.names'],'Applicant B and Applicant E');
eq(state.emails[0].subject,'Property A · Applicant B & Applicant E');eq(state.emails[0].text.includes('Old'),false);eq(signature(),before);
for(const app of state.applications){eq(app.name,`${app.first_name} ${app.last_name}`);eq(/^Applicant [A-Z]+$/.test(app.name),true);for(const inv of app.workspace?.invitations || [])eq(/^Applicant [A-Z]+$/.test(inv.name),true);}
const snapshot=JSON.stringify(state);normalizeDemoNames(state);eq(JSON.stringify(state),snapshot);
// Reordering records, adding another applicant and restarting retain earlier labels.
state.applications.reverse();normalizeDemoNames(state);eq(a.name,'Applicant A');eq(b.name,'Applicant B');
const newcomer={...structuredClone(a),id:crypto.randomUUID(),name:'Another Person',email:'new-person@example.test'};state.applications.push(newcomer);normalizeDemoNames(state);eq(newcomer.name!=='Applicant A',true);eq(a.name,'Applicant A');
a.name='Duplicate Person';b.name='Duplicate Person';state.emails=[{subject:'Duplicate Person',text:`http://localhost/landlord-decision/#id=${b.id}`}];normalizeDemoNames(state);eq(a.name,'Applicant A');eq(b.name,'Applicant B');eq(state.emails[0].subject,'Applicant B');
eq(alphabet(25),'Z');eq(alphabet(26),'AA');
// Independent seed batches must never share a generated roommate account.
const fresh=createWorkspaceFixtures().state;
fresh.buildings.push({id:crypto.randomUUID(),name:'Property C'});
await completeDemoState(fresh);await seedRentalDemo(fresh);
const pending=fresh.applications.flatMap(a=>(a.workspace?.invitations || []).filter(i=>!i.accepted).map(i=>i.email));
eq(new Set(pending).size,pending.length);
// Repair an already-normalized duplicate, including its declared roommate and local email.
const c=fresh.applications.find(a=>a.id===ids.unassigned),d=fresh.applications.find(a=>a.id===ids.shared);
const original=structuredClone(c.workspace.invitations[0]);d.workspace.invitations=[{...original,id:crypto.randomUUID()}];d.roommates=[{name:original.name,email:original.email}];
fresh.emails=[{to:original.email,text:`${original.name}: /apply/?group=${d.id}`}];
delete fresh.demo_roommate_seed;const priorVersion=d.workspace_version;normalizeDemoNames(fresh);
eq(c.workspace.invitations[0].email,original.email);eq(d.workspace.invitations[0].email!==original.email,true);eq(d.workspace.invitations[0].name!==original.name,true);
eq(d.roommates[0].email,d.workspace.invitations[0].email);eq(fresh.emails[0].to,d.workspace.invitations[0].email);eq(fresh.emails[0].text.includes(d.workspace.invitations[0].name),true);eq(d.workspace_version,priorVersion+1);
const repaired=JSON.stringify(fresh);normalizeDemoNames(fresh);
if(JSON.stringify(fresh)!==repaired){const diff=(a,b,path='')=>{if(JSON.stringify(a)===JSON.stringify(b))return;if(a&&b&&typeof a==='object'&&typeof b==='object'){for(const k of new Set([...Object.keys(a),...Object.keys(b)]))diff(a[k],b[k],path+'.'+k);}else console.error(path,a,b);};diff(JSON.parse(repaired),fresh);throw new Error('Repair must be stable across normalization');}checks++;
// An explicitly linked, submitted person is not split just because another group references them.
delete fresh.demo_roommate_seed;const actual=fresh.applications.find(a=>a.id===ids.b);c.workspace.invitations=[{email:actual.email,name:actual.name,accepted:actual.id}];d.workspace.invitations=[{email:actual.email,name:actual.name,accepted:actual.id}];normalizeDemoNames(fresh);
eq(c.workspace.invitations[0].email,actual.email);eq(d.workspace.invitations[0].email,actual.email);
console.log(`PASS ${checks} global demo-name checks: stable identity, duplicate-safe labels, packets, email, frozen lease, relationships, idempotence and new records`);
