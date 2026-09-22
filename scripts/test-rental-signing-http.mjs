import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createWorkspaceFixtures,ids} from '../backend/tools/workspace-fixtures.mjs';
import {completeDemoState} from './demo-data.mjs';
import {seedRentalDemo} from './rental-demo-data.mjs';
import {rentalWorkflow} from '../worker/rentals.js';
import {handleRentalSigning,handleDocusignWebhook} from '../worker/signing.js';
const fixture=createWorkspaceFixtures();await completeDemoState(fixture.state);await seedRentalDemo(fixture.state);
const original=globalThis.fetch,records=new Map();let reserves=0,checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
globalThis.fetch=async(url,init={})=>{
 const u=new URL(url),body=init.body?JSON.parse(init.body):{},name=u.pathname.split('/').at(-1);
 if(name==='rental_signing_packages') {
  if(init.method==='POST'){records.set(body.id,{...body});return Response.json([body]);}
  const id=u.searchParams.get('id')?.slice(3),rental=u.searchParams.get('rental_id')?.slice(3);
  // JSONB preserves values, not the insertion order of object keys.
  const persisted=[...records.values()].filter(r=>(!id || r.id===id)&&(!rental || r.rental_id===rental)&&(!u.searchParams.has('reserved') || !!r.reserved===(u.searchParams.get('reserved')==='eq.true')));
  return Response.json(persisted.map(r=>({...r,record:{...r.record,package:{...r.record.package,signers:r.record.package.signers.map(s=>Object.fromEntries(Object.entries(s).sort(([a],[b])=>a.localeCompare(b))))}}})));
 }
 if(name==='reserve_rental_signing') {
  const r=records.get(body.p_id);reserves++;r.reserved=true;const root=fixture.state.applications.find(a=>a.id===r.rental_id);root.workspace.signing={package_id:r.id,phase:'preparing'};root.workspace_version++;return Response.json(r.record);
 }
 return fixture.fetch(url,init);
};
const env={...fixture.env,RENTAL_AUTOMATION:'on',RENTAL_SCREENING:'mock',DOCUSIGN_ENABLED:'on',DOCUSIGN_ENVIRONMENT:'demo',DEV_DOCUSIGN_SEND:'on',DOCUSIGN_INTEGRATION_KEY:'test',DOCUSIGN_USER_ID:'test',DOCUSIGN_ACCOUNT_ID:'test',DOCUSIGN_PRIVATE_KEY:'test',DOCUSIGN_CONNECT_HMAC_SECRET:'test',DOCUSIGN_WEBHOOK_URL:'https://example.test/api/webhooks/docusign',LOCAL_EMAIL_SINK:{send:async()=>{}},ASSETS:{fetch:async()=>new Response(readFileSync('lease/template/lease-template.docx'))}};
env.APPLICANT_DOCS.head=async path=>fixture.state.files[path]?{}:null;
const admin={role:'manager',email:'admin@example.test'},agent={role:'agent',email:'agent-b@example.test'},wrong={role:'agent',email:'agent-a@example.test'};
const url=`http://localhost/api/admin/cases/${ids.b}/signing`;
const get=(who=admin,suffix='')=>handleRentalSigning(new Request(url+suffix),env,who,ids.b);
const post=(body,who=admin)=>handleRentalSigning(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env,who,ids.b);
try {
 const flow=rentalWorkflow(env,new Request(url));await flow.reconcile(ids.b);
 const row=fixture.state.applications.find(a=>a.id===ids.b),landlord=fixture.state.staff.find(s=>s.email===row.workspace.recommendation.landlord_email);
 eq((await get(wrong)).status,404);eq((await get({...admin,owner:true})).status,403);eq((await get(landlord)).status,403);
 eq((await post({action:'prepare',version:row.workspace_version})).status,409);
 await flow.execute(landlord,ids.b,{action:'landlord_accept',version:row.workspace_version,revision:row.workspace.recommendation.revision});
 const version=row.workspace_version;
 // Internal runs cannot send through an unconfigured environment or to other inboxes.
 row.workspace.test_run={id:row.id,account_id:'test-account',created_at:new Date().toISOString()};
 eq((await post({action:'prepare',version},agent)).status,403);
 delete row.workspace.test_run;
 eq((await post({action:'prepare',version:version-1})).status,409);
 const prepared=await post({action:'prepare',version},agent);eq(prepared.status,200);const p=await prepared.json();eq(p.preview,true);eq(p.signing.signers.length,3);eq(reserves,0);
 const fileCount=Object.keys(fixture.state.files).length;
 const reused=await post({action:'prepare',version},agent);eq(reused.status,200);eq((await reused.json()).signing.id,p.signing.id);eq(records.size,1);eq(Object.keys(fixture.state.files).length,fileCount);
 const file=await get(agent,`?package=${p.signing.id}&file=source`);eq(file.status,200);eq(file.headers.get('Cache-Control'),'no-store');eq(new Uint8Array(await file.arrayBuffer())[0],80);
 const notice=p.signing.documents.find(d=>d.layout==='bedbug');assert.ok(notice);checks++;
 const noticeUrl=`?package=${p.signing.id}&file=source&document=${notice.documentId}`;
 eq((await get(wrong,noticeUrl)).status,404);
 const noticeFile=await get(agent,noticeUrl);eq(noticeFile.status,200);eq(noticeFile.headers.get('Cache-Control'),'no-store');
 const bytes=await noticeFile.arrayBuffer();
 eq(Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex'),notice.sha256);
 eq((await get(agent,`?package=${p.signing.id}&file=source&document=unknown`)).status,404);
 eq((await post({action:'send',packageId:p.signing.id,version:version-1},agent)).status,409);
 const savedName=row.name;row.name='Changed applicant';eq((await post({action:'send',packageId:p.signing.id,version},agent)).status,409);row.name=savedName;
 const stored=records.get(p.signing.id).record.package.signers[0];
 for(const [field,value] of Object.entries({email:'other@example.test',recipientId:'99',memberId:ids.a,role:'landlord',routingOrder:2})){
   const before=stored[field];stored[field]=value;
   eq((await post({action:'send',packageId:p.signing.id,version},agent)).status,409);
   stored[field]=before;
 }
 eq(reserves,0);
 eq(p.configuration.placementReviewRequired,false);eq(p.configuration.canSend,true);
 const sent=await post({action:'send',packageId:p.signing.id,version},agent);eq(sent.status,202);eq((await sent.json()).signing.id,p.signing.id);eq(reserves,1);
 // An already-reserved request is still returned idempotently, never resent.
 eq((await post({action:'send',packageId:p.signing.id,version},agent)).status,200);eq(reserves,1);
 await assert.rejects(()=>flow.execute(agent,ids.b,{action:'tenant_signed',version:row.workspace_version,member_id:row.id,reason:'manual'}),e=>e.status===409);checks++;
 eq((await handleDocusignWebhook(new Request('https://example.test/api/webhooks/docusign',{method:'POST',body:'{}'}),env)).status,401);
 const selected=await (await get(agent)).json();eq(selected.signing.id,p.signing.id);eq(JSON.stringify(selected).includes('source_docx-'),false);
 const record=records.get(p.signing.id).record;
 record.phase='in_progress';record.envelope={status:'sent',envelopeId:'existing-envelope',recipients:record.package.signers.map(s=>({recipientId:s.recipientId,status:'pending'}))};
 const progress=await (await get(agent)).json();
 eq(progress.signing.signers.map(s=>s.status),['sent','sent','pending']);
 eq(reserves,1); // Reading legacy state must not resend or reserve another package.
 record.envelope.status='created';
 eq((await(await get(agent)).json()).signing.signers.map(s=>s.status),['pending','pending','pending']);
 console.log(`PASS ${checks} signing HTTP checks: scoped access, readiness, exact source download, stale reviews, signer changes, idempotent send and forged webhook`);
}finally{globalThis.fetch=original;}
