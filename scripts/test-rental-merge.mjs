import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createWorkspaceFixtures,ids} from '../backend/tools/workspace-fixtures.mjs';
import {reportFixture} from '../backend/tools/screening-fixtures.mjs';
import {completeDemoState} from './demo-data.mjs';
import {seedRentalDemo} from './rental-demo-data.mjs';
import {rentalWorkflow} from '../worker/rentals.js';
import {handleCaseWorkspace} from '../worker/backoffice.js';
import {mergeLock} from '../backend/core/rentals.ts';
// Two people who applied separately for the same home are joined by staff at
// any stage before signing starts. Synthetic records only; no network.
const fixture=createWorkspaceFixtures();await completeDemoState(fixture.state);await seedRentalDemo(fixture.state);
const original=globalThis.fetch;globalThis.fetch=fixture.fetch;
const keys=new Set();
const env={...fixture.env,RENTAL_AUTOMATION:'on',RENTAL_SCREENING:'mock',LOCAL_EMAIL_SINK:{async send(m,key){if(!keys.has(key)){keys.add(key);fixture.state.emails.push(m);}}}};
const request=new Request('http://127.0.0.1:8792/api/admin/cases'),flow=rentalWorkflow(env,request);
const admin={role:'manager',email:'admin@example.test'},agentA={role:'agent',email:'agent-a@example.test'},agentB={role:'agent',email:'agent-b@example.test'};
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const rejects=async(fn,status,pattern)=>{await assert.rejects(fn,e=>(!status || e.status===status) && (!pattern || pattern.test(e.message)));checks++;};
const state=fixture.state,row=id=>state.applications.find(a=>a.id===id),docsOf=id=>state.documents.filter(d=>d.application_id===id);
const template=row(ids.shared);let seq=0;
// One independent applicant for a unit, complete (paid, verified, reported) or not yet paid.
function independent(name,{listing=template.listing_id,agent='agent-a@example.test',complete=true}={}) {
 const id=crypto.randomUUID(),[first,...rest]=name.split(' ');
 const a={...structuredClone(template),id,rental_group_id:id,name,first_name:first,last_name:rest.join(' '),email:`${name.toLowerCase().replace(/\s+/g,'-')}-${++seq}@example.test`,listing_id:listing,responsible_email:agent,collaborator_emails:[],status:'review',lease_snapshot:null,workspace_version:0,
  workspace:{rental_flow:'automatic',terms:structuredClone(template.workspace.terms),invitations:[],activity:[{action:'note',by:'system',at:'2026-09-08T10:00:00Z',detail:`${name} applied independently`}],
   checks:complete ? {...template.workspace.checks} : {fee:'pending',screening:'pending',documents:'pending'}}};
 if(complete) a.workspace.screening_result=reportFixture(id);
 state.applications.push(a);
 for(const d of docsOf(ids.shared)) state.documents.push({...structuredClone(d),id:crypto.randomUUID(),application_id:id,path:`${id}/${d.file_name}`});
 return id;
}
const command=(dest,src,extra={})=>({action:'merge',version:row(dest).workspace_version,application_id:src,source_version:row(src).workspace_version,confirmed:true,...extra});
const landlord=()=>({role:'landlord',email:'owner@example.test',property_ids:[ids.property]});
const accept=async id=>{const v=await flow.get(landlord(),id);return flow.execute(landlord(),id,{action:'landlord_accept',version:v.workspace_version,revision:v.recommendation.revision});};
const cleared=id=>{const w=row(id).workspace;return [w.landlord_decision,w.lease_draft,w.lease_preparation,w.tenant_signature,w.signature_receipts,row(id).lease_snapshot];};
try {
 // 1. Both applicants complete and each already with the landlord; the guest even approved.
 const host=independent('Host Applicant'),guest=independent('Guest Applicant');
 await flow.reconcile(host);await flow.reconcile(guest);
 eq(row(host).status,'sent_to_landlord');eq(row(guest).status,'sent_to_landlord');eq(row(host).workspace.recommendation.members.length,1);
 await accept(guest);eq(row(guest).status,'landlord_approved');eq(!!row(guest).workspace.lease_draft,true);eq(row(guest).workspace.landlord_decision.outcome,'accepted');
 const hostRevision=row(host).workspace.recommendation.revision,mailBefore=state.emails.length;
 const evidence={checks:structuredClone(row(guest).workspace.checks),report:structuredClone(row(guest).workspace.screening_result),documents:docsOf(guest).map(d=>d.id),activity:row(guest).workspace.activity.length};
 // Refused before anything changes: unconfirmed, stale on either side, a landlord, or staff without the other case.
 await rejects(()=>flow.execute(admin,host,command(host,guest,{confirmed:false})),422);
 await rejects(()=>flow.execute(admin,host,command(host,guest,{source_version:-1})),409);
 await rejects(()=>flow.execute(admin,host,command(host,guest,{version:-1})),409);
 await rejects(()=>flow.execute(admin,host,command(host,guest,{application_id:''})),422);
 await rejects(()=>flow.execute(landlord(),host,command(host,guest)),403);
 await rejects(()=>flow.execute(agentB,host,command(host,guest)),404);
 eq(row(guest).rental_group_id,guest);eq(row(guest).status,'landlord_approved');
 const joined=await flow.execute(agentA,host,command(host,guest));
 eq(joined.household.members.length,2);eq(row(guest).rental_group_id,host);eq(row(guest).responsible_email,row(host).responsible_email);
 // The guest keeps their own evidence and history; their approval, draft and terms are gone.
 eq(row(guest).workspace.checks,evidence.checks);eq(row(guest).workspace.screening_result,evidence.report);eq(docsOf(guest).map(d=>d.id),evidence.documents);
 eq(row(guest).workspace.activity.length,evidence.activity+1);eq(row(guest).workspace.activity.at(-1).action,'merge_member');
 eq(cleared(guest),[undefined,undefined,undefined,undefined,undefined,null]);eq(row(guest).workspace.recommendation,undefined);eq(row(guest).workspace.terms,undefined);eq(row(guest).status,'review');
 eq(row(host).workspace.terms,template.workspace.terms);
 // The combined household is complete, so a fresh packet went out; the old revision cannot be approved.
 eq(row(host).status,'sent_to_landlord');eq(row(host).workspace.recommendation.members.length,2);assert(row(host).workspace.recommendation.revision>hostRevision);checks++;
 assert(row(host).workspace.recommendation.tenant_name.includes('Guest Applicant'));checks++;
 eq(state.emails.length,mailBefore+1);eq(cleared(host),[undefined,undefined,undefined,undefined,undefined,null]);
 eq(row(host).workspace.activity.filter(a=>a.action==='merge_member').length,1);
 await rejects(()=>flow.execute(landlord(),host,{action:'landlord_accept',version:row(host).workspace_version,revision:hostRevision}),409);
 await accept(host);eq(row(host).status,'landlord_approved');eq(row(host).workspace.recommendation.members.map(m=>m.id).sort(),[host,guest].sort());
 // Split still works afterwards and each applicant keeps their evidence.
 const split=await flow.execute(admin,host,{action:'split_member',version:row(host).workspace_version,member_id:guest,reason:'Testing split after join',confirmed:true});
 eq(split.household.members.length,1);eq(row(guest).rental_group_id,guest);eq(row(guest).workspace.screening_result,evidence.report);eq(cleared(host),[undefined,undefined,undefined,undefined,undefined,null]);
 // 2. A landlord-approved case takes an applicant who has not paid: approval and draft cleared, group waits, no charge.
 const lead=independent('Lead Applicant'),late=independent('Late Applicant',{complete:false});
 await flow.reconcile(lead);await accept(lead);eq(row(lead).status,'landlord_approved');
 const quiet=state.emails.length;
 const waiting=await flow.execute(agentA,lead,command(lead,late));
 eq(waiting.status,'review');eq(waiting.household.members.length,2);eq(waiting.household.join_lock,'');
 eq(row(lead).workspace.recommendation,undefined);eq(cleared(lead),[undefined,undefined,undefined,undefined,undefined,null]);
 assert(waiting.household.issues.some(i=>/Late Applicant: application payment pending/.test(i)));checks++;
 eq(row(late).workspace.checks.fee,'pending');eq(row(late).workspace.screening_result,undefined);eq(row(late).status,'review');eq(state.emails.length,quiet);
 // 3. The direction does not matter: an early case can take a landlord-approved one.
 const early=independent('Early Applicant',{complete:false}),approved=independent('Approved Applicant');
 await flow.reconcile(approved);await accept(approved);
 const taken=await flow.execute(admin,early,command(early,approved));
 eq(taken.household.members.length,2);eq(row(approved).rental_group_id,early);eq(row(approved).status,'review');eq(cleared(approved),[undefined,undefined,undefined,undefined,undefined,null]);
 eq(row(early).status,'review');eq(row(early).workspace.recommendation,undefined);
 // 4. Self, another unit, the same person, a combined source, pending invitations and a full home are refused.
 const other=independent('Other Unit Applicant',{listing:ids.otherListing,agent:'agent-b@example.test'});
 await rejects(()=>flow.execute(admin,early,command(early,early)),422,/different application/);
 await rejects(()=>flow.execute(admin,early,command(early,other)),422,/same unit/);
 const third=independent('Third Applicant'),twin=independent('Twin Applicant');row(twin).email=row(third).email.toUpperCase();
 await rejects(()=>flow.execute(admin,third,command(third,twin)),422,/already in the group/);
 await rejects(()=>flow.execute(admin,third,command(third,early)),422,/more than one applicant/);
 row(third).workspace.invitations=[{id:crypto.randomUUID(),email:'friend@example.test',name:'Friend',expires:'2099-01-01T00:00:00Z'}];
 const fourth=independent('Fourth Applicant');
 await rejects(()=>flow.execute(admin,fourth,command(fourth,third)),422,/pending invitations/);
 row(third).workspace.invitations=[];
 await rejects(()=>flow.execute(admin,early,command(early,third)),422,/takes up to 2 applicants/);
 eq(row(third).rental_group_id,third);eq(row(other).rental_group_id,other);
 // 5. A DocuSign envelope on either side is voided through its own flow first; signatures, executed and closed cases never join.
 const envelopeHost=independent('Envelope Host'),envelopeGuest=independent('Envelope Guest');
 row(envelopeHost).workspace.signing={package_id:crypto.randomUUID(),phase:'in_progress'};
 await rejects(()=>flow.execute(admin,envelopeHost,command(envelopeHost,envelopeGuest)),409,/Void the envelope/);
 await rejects(()=>flow.execute(admin,envelopeGuest,command(envelopeGuest,envelopeHost)),409,/Void the DocuSign signing request for Envelope Host first\.$/);
 eq((await flow.get(admin,envelopeHost)).household.join_lock,'Void the DocuSign signing request for Envelope Host first.');
 row(envelopeHost).workspace.signature_receipts={[envelopeHost]:{reference:'envelope',by:'docusign',at:'2026-09-20T00:00:00Z'}};
 await rejects(()=>flow.execute(admin,envelopeGuest,command(envelopeGuest,envelopeHost)),409,/A signature is already on that envelope/);
 row(envelopeHost).workspace.signing.phase='voided';delete row(envelopeHost).workspace.signature_receipts;
 eq(mergeLock({root:row(envelopeHost),members:[row(envelopeHost)]}),'');
 const voided=await flow.execute(admin,envelopeGuest,command(envelopeGuest,envelopeHost));eq(voided.household.members.length,2);eq(row(envelopeHost).workspace.signing.phase,'voided');
 const signedHost=independent('Signed Host'),signedGuest=independent('Signed Guest');
 row(signedHost).workspace.tenant_signature={reference:'receipt',by:'agent-a@example.test',at:'2026-09-20T00:00:00Z'};row(signedHost).status='lease_sent';
 await rejects(()=>flow.execute(admin,signedHost,command(signedHost,signedGuest)),409,/Signatures are already recorded for Signed Host/);
 await rejects(()=>flow.execute(admin,signedGuest,command(signedGuest,signedHost)),409,/Signatures are already recorded for Signed Host/);
 row(signedHost).status='lease_signed';row(signedHost).workspace.signed_lease={path:'x/lease.pdf',name:'lease.pdf',size:1,uploaded_at:'2026-09-20T00:00:00Z'};
 await rejects(()=>flow.execute(admin,signedGuest,command(signedGuest,signedHost)),409,/already executed/);
 await rejects(()=>flow.execute(admin,signedHost,command(signedHost,signedGuest)),409,/already executed/);
 const declined=independent('Declined Applicant');row(declined).status='declined';
 await rejects(()=>flow.execute(admin,signedGuest,command(signedGuest,declined)),409,/is closed/);
 await rejects(()=>flow.execute(admin,declined,command(declined,signedGuest)),409,/is closed/);
 eq(row(signedGuest).rental_group_id,signedGuest);eq(row(declined).rental_group_id,declined);
 eq((await flow.list(admin)).find(r=>r.id===signedHost).household.join_lock,'The lease for Signed Host is already executed.');
 // 6. The HTTP action boundary carries the same command and answer.
 const httpHost=independent('Http Host'),httpGuest=independent('Http Guest');
 const post=body=>handleCaseWorkspace(new Request(`http://localhost/api/admin/cases/${httpHost}/actions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env,admin,httpHost,'actions',{waitUntil(){}});
 let response=await post(command(httpHost,httpGuest,{confirmed:false}));eq(response.status,422);eq(row(httpGuest).rental_group_id,httpGuest);
 response=await post(command(httpHost,httpGuest));eq(response.status,200);const body=await response.json();eq(body.case.household.members.length,2);eq(body.case.household.join_lock,'');
 // 7. Nothing joins automatically because of a shared email or unit once a case has moved on.
 const inviter=independent('Inviter Applicant'),invited=independent('Invited Applicant');
 await flow.reconcile(invited);await accept(invited);
 row(inviter).workspace.invitations=[{id:crypto.randomUUID(),email:row(invited).email,name:'Invited Applicant',expires:'2099-01-01T00:00:00Z',delivery:'preview'}];
 await flow.adoptInvited(inviter);eq(row(invited).rental_group_id,invited);eq(row(invited).status,'landlord_approved');
}finally{globalThis.fetch=original;}
// Real SQL: stage rules, signature and signing locks, atomic rollback, replay and service-only access.
const db=new PGlite();
try {
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const name of ['schema','backoffice','workspace','rental-flow','rental-signing','rental-membership','rental-flow'])await db.exec(readFileSync(`supabase/${name}.sql`,'utf8'));
 const listing=(await db.query("insert into listings(title,category,transaction_type) values('Unit','residential','rental') returning id")).rows[0].id;
 const elsewhere=(await db.query("insert into listings(title,category,transaction_type) values('Other unit','residential','rental') returning id")).rows[0].id;
 const insert=async(name,status='review',workspace={},listingId=listing)=>{
  const id=crypto.randomUUID();
  await db.query("insert into applications(id,listing_id,rental_group_id,name,email,status,responsible_email,workspace) values($1,$2,$1,$3,$4,$5,'agent@example.test',$6)",[id,listingId,name,`${id}@example.test`,status,{rental_flow:'automatic',checks:{fee:'paid'},screening_result:{status:'complete',reference:id},...workspace}]);
  return id;
 };
 const get=async id=>(await db.query('select * from applications where id=$1',[id])).rows[0];
 const members=async root=>(await db.query('select * from applications where rental_group_id=$1 order by created_at,id',[root])).rows;
 const strip=w=>{const c={...w};for(const k of ['recommendation','landlord_decision','delivery','lease_draft','lease_preparation','tenant_signature','landlord_signature','signature_receipts'])delete c[k];return c;};
 const join=async(root,source,{stale=false}={})=>{
  const rows=[...await members(root),await get(source)],r=await get(root),s=await get(source),at=new Date().toISOString();
  const versions=Object.fromEntries(rows.map(m=>[m.id,stale ? -1 : m.workspace_version]));
  const patches={[root]:{workspace:{...strip(r.workspace),activity:[...(r.workspace.activity || []),{action:'merge_member',by:'admin@example.test',at,detail:'Joined'}]},status:'review',lease_snapshot:null},
   [source]:{workspace:{...strip(s.workspace),activity:[...(s.workspace.activity || []),{action:'merge_member',by:'admin@example.test',at,detail:'Joined'}]},status:'review',lease_snapshot:null}};
  return db.query('select commit_rental_group($1,$2,$3,$4,$5)',[root,versions,patches,'admin@example.test',source]);
 };
 const fresh=async()=>[await insert('Fresh Host'),await insert('Fresh Guest')];
 // Sent to landlord takes a landlord-approved case; both rows are rewritten in one transaction.
 const host=await insert('Host','sent_to_landlord',{recommendation:{revision:3},delivery:{revision:3,status:'sent'}});
 const guest=await insert('Guest','landlord_approved',{recommendation:{revision:2},landlord_decision:{outcome:'accepted',revision:2},lease_preparation:{by:'system'},lease_draft:{values:{},missing:[]}});
 await db.query('update applications set lease_snapshot=$1 where id=$2',[{'tenant.names':'Guest'},guest]);
 const hv=(await get(host)).workspace_version,gv=(await get(guest)).workspace_version;
 await join(host,guest);
 eq((await members(host)).length,2);
 const g=await get(guest),h=await get(host);
 eq([g.rental_group_id,g.status,g.lease_snapshot,g.workspace.landlord_decision,g.workspace.lease_draft,g.workspace.screening_result.reference,g.responsible_email],[host,'review',null,undefined,undefined,guest,'agent@example.test']);
 eq([h.status,h.workspace.recommendation,h.workspace.delivery,h.workspace.activity.at(-1).action],['review',undefined,undefined,'merge_member']);
 assert(g.workspace_version>gv && h.workspace_version>hv);checks++;
 // A stale version rolls the whole join back: membership, status and snapshot untouched.
 const third=await insert('Third','landlord_approved',{landlord_decision:{outcome:'accepted',revision:1}});
 await db.query('update applications set lease_snapshot=$1 where id=$2',[{'tenant.names':'Third'},third]);
 await rejects(()=>join(host,third,{stale:true}));
 const t=await get(third);eq([t.rental_group_id,t.status,t.lease_snapshot,t.workspace.landlord_decision.outcome,(await members(host)).length],[third,'landlord_approved',{'tenant.names':'Third'},'accepted',2]);
 // Two staff acting on the same versions: the first join commits, the second is refused and changes nothing.
 const one=await insert('Concurrent One'),two=await insert('Concurrent Two'),base=await members(host);
 const attempt=async src=>db.query('select commit_rental_group($1,$2,$3,$4,$5)',[host,{...Object.fromEntries(base.map(m=>[m.id,m.workspace_version])),[src]:(await get(src)).workspace_version},{[src]:{status:'review'}},'admin@example.test',src]);
 await attempt(one);eq((await get(one)).rental_group_id,host);
 await rejects(()=>attempt(two));eq((await get(two)).rental_group_id,two);eq((await members(host)).length,3);
 // Replaying a committed join is refused.
 await rejects(()=>attempt(one));
 // Signing, signed and closed cases never join, in either direction.
 for(const [status,workspace] of [['lease_sent',{}],['lease_signed',{}],['declined',{}],['review',{tenant_signature:{reference:'r'}}],['review',{landlord_signature:{reference:'r'}}],['review',{signature_receipts:{x:{reference:'r'}}}],['review',{signed_lease:{path:'p'}}],['review',{signing:{package_id:'p',phase:'in_progress'}}],['review',{signing:{package_id:'p',phase:'needs_attention'}}]]) {
  for(const side of ['guest','host']) {
   const [fh,fg]=await fresh();
   await db.query('update applications set status=$1,workspace=workspace||$2 where id=$3',[status,workspace,side==='guest' ? fg : fh]);
   await rejects(()=>join(fh,fg));eq((await get(fg)).rental_group_id,fg);eq((await get(fh)).status,side==='host' ? status : 'review');
  }
 }
 // A voided or declined envelope no longer blocks.
 for(const phase of ['voided','declined']){const [vh,vg]=await fresh();await db.query('update applications set workspace=workspace||$1 where id=$2',[{signing:{package_id:'p',phase}},vg]);await join(vh,vg);eq((await get(vg)).rental_group_id,vh);}
 // An active signing package on either side is refused by the signing guard.
 for(const side of ['guest','host']){const [ph,pg]=await fresh();await db.query("insert into rental_signing_packages(id,rental_id,record,member_versions,active) values($1,$2,'{}','{}',true)",[crypto.randomUUID(),side==='guest' ? pg : ph]);await rejects(()=>join(ph,pg));eq((await get(pg)).rental_group_id,pg);}
 // Another unit, self and a combined source are refused.
 const [uh,ug]=await fresh(),away=await insert('Elsewhere','review',{},elsewhere);
 await rejects(()=>join(uh,away));await rejects(()=>join(uh,uh));eq((await get(away)).rental_group_id,away);
 await join(uh,ug);const [ch]=await fresh();await rejects(()=>join(ch,uh));eq((await members(uh)).length,2);
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await rejects(()=>db.query('select commit_rental_group($1,$2,$3,$4,$5)',[ch,{},{},'forged',ug]));await db.exec('reset role');}
 console.log(`PASS ${checks} case merge checks: stages before signing on both sides, evidence retained, approvals and drafts invalidated, fresh landlord decision, invalid and cross-unit joins, envelope and signature locks, HTTP boundary, no automatic joins, SQL atomicity, replay and service-only access.`);
}finally{await db.close();}
