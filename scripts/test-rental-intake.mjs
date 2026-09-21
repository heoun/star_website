import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import worker from '../worker/index.js';
import {createIdentityFixture} from './identity-fixtures.mjs';
import {completeDemoState,DEMO_ENCRYPTION_KEY} from './demo-data.mjs';
import {ids} from '../backend/tools/workspace-fixtures.mjs';
import {rentalWorkflow,reconcileRentals} from '../worker/rentals.js';
import {MAIL_FROM,MAIL_LAYOUT_MARKER} from '../worker/mail-layout.js';
const identity=createIdentityFixture(),{fixture,env,user,restore}=identity;
await completeDemoState(fixture.state);
env.RENTAL_AUTOMATION='on';env.RENTAL_SCREENING='mock';env.APP_ENCRYPTION_KEY=DEMO_ENCRYPTION_KEY;
env.LOCAL_EMAIL_SINK={async send(m){fixture.state.emails.push(m);}};
user('roommate@example.test');const pending=[];let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const call=(path,body,cookie='')=>worker.fetch(new Request(`http://127.0.0.1${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Cookie:cookie},...(body?{body:JSON.stringify(body)}:{})}),env,{waitUntil:p=>pending.push(p)});
const login=async email=>{const r=await call('/api/auth/login',{email,password:'testing-password'});eq(r.status,200);return r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');};
try{
 const cookie=await login('applicant@example.test'),payload={...fixture.state.applications[0],listing_id:ids.listing,id_number:'000112222',sales_person:'agent-a@example.test',roommates:[{first_name:'Room',last_name:'Mate',phone:'212-555-0101',email:'roommate@example.test'}]};
 let response=await call('/api/apply/options?id='+ids.listing);let options=await response.json();eq(options.agents.map(a=>a.email),['agent-a@example.test']);
 const before=fixture.state.applications.length;
 response=await call('/api/apply',{...payload,invited_email:'roommate@example.test'},cookie);eq(response.status,409);eq(fixture.state.applications.length,before);
 response=await call('/api/apply',{...payload,account_email:'roommate@example.test'},cookie);eq(response.status,409);eq(fixture.state.applications.length,before);eq((await response.json()).code,'APPLICANT_ACCOUNT_CHANGED');
 response=await call('/api/apply',{...payload,account_email:'applicant@example.test'});eq(response.status,401);eq(fixture.state.applications.length,before);
 const listing=fixture.state.listings.find(l=>l.id===ids.listing);listing.published=false;
 response=await call('/api/apply',payload,cookie);eq(response.status,404);eq(fixture.state.applications.length,before);
 listing.published=true;
 const chosenAgent=fixture.state.staff.find(s=>s.email===payload.sales_person);chosenAgent.active=false;
 response=await call('/api/apply',payload,cookie);eq(response.status,422);eq(fixture.state.applications.length,before);chosenAgent.active=true;
 response=await call('/api/apply',{...payload,sales_person:'agent-b@example.test'},cookie);eq(response.status,422);eq(fixture.state.applications.length,before);
 response=await call('/api/apply',payload,cookie);if(response.status!==201)console.error(await response.clone().text());eq(response.status,201);await Promise.all(pending.splice(0));
 // Submission tells the office and enrols the applicant for the ready-for-review
 // confirmation; the applicant is not mailed until their own steps are complete.
 const receipts=email=>fixture.state.emails.filter(m=>m.to.includes(email) && m.subject.startsWith('Application received'));
 eq(fixture.state.emails.filter(m=>m.to.includes('applicant@example.test')).length,0);
 eq(fixture.state.emails.map(m=>m.subject),['New rental application: Property A · 2A']);
 for(const notice of fixture.state.emails){eq(notice.from,MAIL_FROM);eq(notice.html.includes(MAIL_LAYOUT_MARKER),true);}
 const lead=fixture.state.applications.find(a=>a.email==='applicant@example.test');eq(lead.responsible_email,'agent-a@example.test');eq(lead.workspace.terms['lease.commencement_date'],'2026-10-01');eq(lead.rental_group_id,lead.id);
 eq(lead.workspace.invitations.length,1);eq(lead.status,'new');eq(lead.workspace.recommendation,undefined);eq(lead.workspace.ready_notice.status,'queued');
 assert(lead.ssn_encrypted && !lead.ssn_encrypted.includes(payload.id_number));checks++;
 // The box on the roommate step was not ticked, so the invitation waits for the lead's fee and goes out on the next reconciliation.
 eq(lead.workspace.invitations[0].delivery,'pending');eq(fixture.state.emails.some(m=>m.to.includes('roommate@example.test')),false);
 const flow=rentalWorkflow(env,new Request('http://127.0.0.1/'));
 lead.workspace.checks={...lead.workspace.checks,fee:'paid'};await flow.reconcile(lead.id);
 // Paid and screened (mock) but no documents yet: still nothing for the applicant.
 eq(fixture.state.applications.find(a=>a.id===lead.id).workspace.screening_result.status,'complete');
 eq(receipts('applicant@example.test').length,0);eq(fixture.state.applications.find(a=>a.id===lead.id).workspace.ready_notice.status,'queued');
 const mail=fixture.state.emails.find(m=>m.to.includes('roommate@example.test'));assert(mail.text.includes('invite='));checks++;
 eq(['sent','preview'].includes(fixture.state.applications.find(a=>a.id===lead.id).workspace.invitations[0].delivery),true);
 const invite=`${lead.id}.${lead.workspace.invitations[0].id}`;
 response=await call('/api/apply',{...payload,roommates:[],group_invite:invite},cookie);eq(response.status,409);
 const mateCookie=await login('roommate@example.test');
 response=await call('/api/apply',{...payload,first_name:'Room',last_name:'Mate',roommates:[],sales_person:'',group_invite:invite},mateCookie);if(response.status!==201)console.error(await response.clone().text());eq(response.status,201);await Promise.all(pending.splice(0));
 const mate=fixture.state.applications.find(a=>a.email==='roommate@example.test');eq(mate.rental_group_id,lead.id);eq(mate.responsible_email,'agent-a@example.test');eq(lead.workspace.invitations[0].accepted,mate.id);
 response=await call('/api/apply',{...payload,roommates:[],group_invite:invite},mateCookie);eq(response.status,409);
 assert(!fixture.state.emails.some(m=>m.subject.startsWith('Application ready')));checks++;
 // The roommate joined enrolled too, and owes everything, so only the lead is
 // confirmed once their documents arrive: once, with one property label, a
 // review promise and a link to their application, while the group waits.
 const row=id=>fixture.state.applications.find(a=>a.id===id);
 const documents=id=>[['government_id_front',1],['government_id_back',1],['job_offer_letter',1],['bank_statement',2]].flatMap(([type,n])=>Array.from({length:n},(_,i)=>({id:crypto.randomUUID(),application_id:id,path:`${id}/${type}-${i}.pdf`,file_name:`${type}-${i}.pdf`,doc_type:type,content_type:'application/pdf',size_bytes:12,created_at:new Date().toISOString()})));
 eq(mate.workspace.ready_notice.status,'queued');
 fixture.state.documents.push(...documents(lead.id));await flow.reconcile(lead.id);
 eq(receipts('applicant@example.test').length,1);eq(receipts('roommate@example.test').length,0);
 const confirmation=receipts('applicant@example.test')[0];
 eq(confirmation.subject,'Application received · Property A · 2A');eq(confirmation.from,MAIL_FROM);
 eq(confirmation.html.includes(MAIL_LAYOUT_MARKER),true);eq(confirmation.html.includes('email-logo-v1.png'),true);
 eq(confirmation.html.includes('>Your application is ready for review</h1>'),true);
 eq((confirmation.html.match(/Property A · 2A/g) || []).length,1);
 eq(confirmation.html.includes(`href="http://127.0.0.1/portal/?application=${lead.id}"`),true);
 eq(confirmation.text.includes(`http://127.0.0.1/portal/?application=${lead.id}`),true);
 eq(/upload|approved|credit score/i.test(confirmation.text),false);
 eq(row(lead.id).workspace.ready_notice.status,'preview');eq(row(lead.id).workspace.recommendation,undefined);
 if(process.env.EMAIL_RECEIPT_PREVIEW)writeFileSync(process.env.EMAIL_RECEIPT_PREVIEW,confirmation.html);
 await flow.reconcile(lead.id);eq(receipts('applicant@example.test').length,1);
 // The roommate's confirmation survives a transport failure that also hit the
 // landlord packet: same key, retried after a pause, delivered exactly once,
 // and still found by the scheduler after the case has moved past review.
 fixture.state.documents.push(...documents(mate.id));row(mate.id).workspace.checks={...row(mate.id).workspace.checks,fee:'paid'};
 const deliver=env.LOCAL_EMAIL_SINK.send;env.LOCAL_EMAIL_SINK.send=async()=>{throw new Error('Mock transport failure');};
 await flow.reconcile(lead.id);
 eq(row(mate.id).workspace.ready_notice.status,'failed');eq(row(mate.id).workspace.ready_notice.attempts,1);eq(receipts('roommate@example.test').length,0);
 eq(row(lead.id).status,'sent_to_landlord');eq(row(lead.id).workspace.delivery.status,'failed');
 env.LOCAL_EMAIL_SINK.send=deliver;
 // Too soon to retry the confirmation; the landlord packet goes out at once.
 await flow.reconcile(lead.id);eq(row(mate.id).workspace.ready_notice.attempts,1);
 eq(fixture.state.emails.filter(m=>m.subject.startsWith('Application ready')).length,1);
 const packet=row(lead.id).workspace.recommendation,owner=fixture.state.staff.find(s=>s.email===packet.landlord_email);
 eq((await flow.execute({role:'landlord',email:owner.email,property_ids:owner.property_ids},lead.id,{action:'landlord_accept',revision:packet.revision,version:row(lead.id).workspace_version})).status,'landlord_approved');
 // Ordinary polling no longer visits an approved case; the owed confirmation is
 // still discovered through its failed notice and sent once its pause has passed.
 const scheduled=()=>reconcileRentals(env,new Request('http://127.0.0.1/'));
 await scheduled();eq(row(mate.id).workspace.ready_notice.attempts,1);eq(receipts('roommate@example.test').length,0);
 row(mate.id).workspace.ready_notice.at=new Date(Date.now()-120000).toISOString();
 await scheduled();
 eq(row(mate.id).workspace.ready_notice.status,'preview');eq(row(mate.id).workspace.ready_notice.attempts,2);
 eq(receipts('roommate@example.test').length,1);eq(receipts('applicant@example.test').length,1);
 await scheduled();eq(receipts('roommate@example.test').length,1);eq(row(lead.id).status,'landlord_approved');
 eq(fixture.state.emails.filter(m=>m.subject.startsWith('Application ready')).length,1);
 // An application that predates enrolment is never mailed, however complete.
 const legacy=fixture.state.applications.find(a=>a.id===ids.a);
 legacy.workspace={...legacy.workspace,rental_flow:'automatic',checks:{fee:'paid',screening:'pending',documents:'verified'}};legacy.rental_group_id=legacy.id;
 fixture.state.documents.push(...documents(legacy.id));await flow.reconcile(legacy.id);
 eq(row(legacy.id).workspace.screening_result.status,'complete');eq(row(legacy.id).workspace.ready_notice,undefined);eq(receipts(legacy.email).length,0);
 // No preference is the deliberate unassigned case; a selected agent above is preserved.
 user('no-agent@example.test');const noAgentCookie=await login('no-agent@example.test');
 response=await call('/api/apply',{...payload,sales_person:'',roommates:[]},noAgentCookie);eq(response.status,201);await Promise.all(pending.splice(0));
 eq(fixture.state.applications.find(a=>a.email==='no-agent@example.test').responsible_email,null);
 // A decline retires an unsent confirmation instead of leaving it for the
 // scheduler to fetch every minute: no email, a cancelled notice, and the case
 // drops out of the owed-notice query. A queued one is retired the same way.
 const solo=fixture.state.applications.find(a=>a.email==='no-agent@example.test');eq(solo.workspace.ready_notice.status,'queued');
 fixture.state.documents.push(...documents(solo.id));row(solo.id).workspace.checks={...row(solo.id).workspace.checks,fee:'paid'};
 env.LOCAL_EMAIL_SINK.send=async()=>{throw new Error('Mock transport failure');};
 await flow.reconcile(solo.id);env.LOCAL_EMAIL_SINK.send=deliver;
 eq(row(solo.id).workspace.ready_notice.status,'failed');eq(row(solo.id).status,'sent_to_landlord');eq((await flow.store.notices()).includes(solo.id),true);
 const soloPacket=row(solo.id).workspace.recommendation,soloOwner=fixture.state.staff.find(s=>s.email===soloPacket.landlord_email);
 eq((await flow.execute({role:'landlord',email:soloOwner.email,property_ids:soloOwner.property_ids},solo.id,{action:'landlord_decline',revision:soloPacket.revision,version:row(solo.id).workspace_version,reason:'Mock decision'})).status,'declined');
 row(solo.id).workspace.ready_notice.at=new Date(Date.now()-120000).toISOString();
 await scheduled();
 eq(row(solo.id).workspace.ready_notice.status,'cancelled');eq(row(solo.id).workspace.ready_notice.attempts,1);
 eq(receipts('no-agent@example.test').length,0);eq((await flow.store.notices()).includes(solo.id),false);
 row(solo.id).workspace.ready_notice={status:'queued',at:new Date().toISOString()};eq((await flow.store.notices()).includes(solo.id),true);
 await scheduled();
 eq(row(solo.id).workspace.ready_notice.status,'cancelled');eq(receipts('no-agent@example.test').length,0);eq((await flow.store.notices()).includes(solo.id),false);
 eq(row(solo.id).status,'declined');
 // Removing a listing from public view must retain its already-submitted applications.
 listing.published=false;eq(fixture.state.applications.find(a=>a.id===lead.id).responsible_email,'agent-a@example.test');
 console.log(`PASS ${checks} automatic intake HTTP checks: property agents, encrypted submission, delayed roommate invite, account-bound group join, no duplicate submission, per-applicant ready-for-review confirmation with retry, enrolment and cancellation on decline, and no premature landlord email`);
}finally{await Promise.allSettled(pending);restore();}
