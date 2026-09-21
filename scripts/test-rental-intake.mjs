import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import worker from '../worker/index.js';
import {createIdentityFixture} from './identity-fixtures.mjs';
import {completeDemoState,DEMO_ENCRYPTION_KEY} from './demo-data.mjs';
import {ids} from '../backend/tools/workspace-fixtures.mjs';
import {rentalWorkflow} from '../worker/rentals.js';
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
 response=await call('/api/apply',{...payload,account_email:'roommate@example.test'},cookie);eq(response.status,409);eq(fixture.state.applications.length,before);
 const listing=fixture.state.listings.find(l=>l.id===ids.listing);listing.published=false;
 response=await call('/api/apply',payload,cookie);eq(response.status,404);eq(fixture.state.applications.length,before);
 listing.published=true;
 const chosenAgent=fixture.state.staff.find(s=>s.email===payload.sales_person);chosenAgent.active=false;
 response=await call('/api/apply',payload,cookie);eq(response.status,422);eq(fixture.state.applications.length,before);chosenAgent.active=true;
 response=await call('/api/apply',{...payload,sales_person:'agent-b@example.test'},cookie);eq(response.status,422);eq(fixture.state.applications.length,before);
 response=await call('/api/apply',payload,cookie);if(response.status!==201)console.error(await response.clone().text());eq(response.status,201);await Promise.all(pending.splice(0));
 const receipt=fixture.state.emails.find(m=>m.to.includes('applicant@example.test') && m.subject.startsWith('We received your application'));
 assert(receipt,'application submission sends a receipt');checks++;
 eq(receipt.from,MAIL_FROM);eq(receipt.html.includes(MAIL_LAYOUT_MARKER),true);
 eq(receipt.html.includes('email-logo-v1.png'),true);eq(receipt.html.includes('max-width:600px'),true);
 eq(receipt.html.includes('href="http://127.0.0.1/portal/"'),true);
 if(process.env.EMAIL_RECEIPT_PREVIEW)writeFileSync(process.env.EMAIL_RECEIPT_PREVIEW,receipt.html);
 for(const notice of fixture.state.emails){eq(notice.from,MAIL_FROM);eq(notice.html.includes(MAIL_LAYOUT_MARKER),true);}
 const lead=fixture.state.applications.find(a=>a.email==='applicant@example.test');eq(lead.responsible_email,'agent-a@example.test');eq(lead.workspace.terms['lease.commencement_date'],'2026-10-01');eq(lead.rental_group_id,lead.id);
 eq(lead.workspace.invitations.length,1);eq(lead.status,'new');eq(lead.workspace.recommendation,undefined);
 assert(lead.ssn_encrypted && !lead.ssn_encrypted.includes(payload.id_number));checks++;
 // The box on the roommate step was not ticked, so the invitation waits for the lead's fee and goes out on the next reconciliation.
 eq(lead.workspace.invitations[0].delivery,'pending');eq(fixture.state.emails.some(m=>m.to.includes('roommate@example.test')),false);
 lead.workspace.checks={...lead.workspace.checks,fee:'paid'};await rentalWorkflow(env,new Request('http://127.0.0.1/')).reconcile(lead.id);
 const mail=fixture.state.emails.find(m=>m.to.includes('roommate@example.test'));assert(mail.text.includes('invite='));checks++;
 eq(['sent','preview'].includes(fixture.state.applications.find(a=>a.id===lead.id).workspace.invitations[0].delivery),true);
 const invite=`${lead.id}.${lead.workspace.invitations[0].id}`;
 response=await call('/api/apply',{...payload,roommates:[],group_invite:invite},cookie);eq(response.status,409);
 const mateCookie=await login('roommate@example.test');
 response=await call('/api/apply',{...payload,first_name:'Room',last_name:'Mate',roommates:[],sales_person:'',group_invite:invite},mateCookie);if(response.status!==201)console.error(await response.clone().text());eq(response.status,201);await Promise.all(pending.splice(0));
 const mate=fixture.state.applications.find(a=>a.email==='roommate@example.test');eq(mate.rental_group_id,lead.id);eq(mate.responsible_email,'agent-a@example.test');eq(lead.workspace.invitations[0].accepted,mate.id);
 response=await call('/api/apply',{...payload,roommates:[],group_invite:invite},mateCookie);eq(response.status,409);
 assert(!fixture.state.emails.some(m=>m.subject.startsWith('Application ready')));checks++;
 // No preference is the deliberate unassigned case; a selected agent above is preserved.
 user('no-agent@example.test');const noAgentCookie=await login('no-agent@example.test');
 response=await call('/api/apply',{...payload,sales_person:'',roommates:[]},noAgentCookie);eq(response.status,201);await Promise.all(pending.splice(0));
 eq(fixture.state.applications.find(a=>a.email==='no-agent@example.test').responsible_email,null);
 // Removing a listing from public view must retain its already-submitted applications.
 listing.published=false;eq(fixture.state.applications.find(a=>a.id===lead.id).responsible_email,'agent-a@example.test');
 console.log(`PASS ${checks} automatic intake HTTP checks: property agents, encrypted submission, delayed roommate invite, account-bound group join, no duplicate submission and no premature landlord email`);
}finally{await Promise.allSettled(pending);restore();}
