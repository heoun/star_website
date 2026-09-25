import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import worker from '../worker/index.js';
import {createIdentityFixture} from './identity-fixtures.mjs';
import {completeDemoState} from './demo-data.mjs';
import {seedRentalDemo} from './rental-demo-data.mjs';
import {rentalWorkflow} from '../worker/rentals.js';
import {ids} from '../backend/tools/workspace-fixtures.mjs';
import {reportFixture} from '../backend/tools/screening-fixtures.mjs';
// Staff join two independent applications from the workspace after landlord
// review. Synthetic records, an ephemeral port and a headless browser only.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const identity=createIdentityFixture(),{fixture,env,restore,user}=identity;
await completeDemoState(fixture.state);await seedRentalDemo(fixture.state);
for(const s of fixture.state.staff)if(!identity.users.has(s.email))user(s.email);
env.RENTAL_AUTOMATION='on';env.RENTAL_SCREENING='mock';
const keys=new Set();env.LOCAL_EMAIL_SINK={async send(m,key){if(!keys.has(key)){keys.add(key);fixture.state.emails.push(m);}}};
const root=resolve('dist'),pending=[];
env.ASSETS={async fetch(request){const path=new URL(request.url).pathname,file=resolve(root,`.${path}${path.endsWith('/')?'index.html':''}`);if(!file.startsWith(root+'/'))return new Response(null,{status:404});try{return new Response(await readFile(file),{headers:{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)] || 'application/octet-stream'}});}catch{return new Response(null,{status:404});}}};
const server=http.createServer(async(req,res)=>{try{const parts=[];for await(const c of req)parts.push(c);const response=await worker.fetch(new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,...(parts.length?{body:Buffer.concat(parts)}:{})}),env,{waitUntil:p=>pending.push(p)});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(e){res.writeHead(500);res.end(String(e));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1600,height:1080},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const out='/tmp/star-rental-merge-ui';await mkdir(out,{recursive:true});let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const state=fixture.state,row=id=>state.applications.find(a=>a.id===id),template=row(ids.shared);let seq=0;
function independent(name,complete=true) {
 const id=crypto.randomUUID(),[first,...rest]=name.split(' ');
 const a={...structuredClone(template),id,rental_group_id:id,name,first_name:first,last_name:rest.join(' '),email:`${name.toLowerCase().replace(/\s+/g,'-')}-${++seq}@example.test`,responsible_email:'agent-a@example.test',collaborator_emails:[],status:'review',lease_snapshot:null,workspace_version:0,
  workspace:{rental_flow:'automatic',terms:structuredClone(template.workspace.terms),invitations:[],activity:[],checks:complete ? {...template.workspace.checks} : {fee:'pending',screening:'pending',documents:'pending'}}};
 if(complete) a.workspace.screening_result=reportFixture(id);
 state.applications.push(a);
 for(const d of state.documents.filter(d=>d.application_id===ids.shared)) state.documents.push({...structuredClone(d),id:crypto.randomUUID(),application_id:id,path:`${id}/${d.file_name}`});
 return id;
}
const login=async email=>{await page.goto(`${base}/login/`);await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill('testing-password');await page.getByRole('button',{name:'Sign In',exact:true}).click();await page.waitForURL('**/admin/**');};
try{
 const flow=rentalWorkflow(env,new Request(base)),landlord={role:'landlord',email:'owner@example.test',property_ids:[ids.property]};
 const host=independent('Host Applicant'),guest=independent('Guest Applicant'),signed=independent('Signed Applicant'),locked=independent('Locked Applicant');
 await flow.reconcile(host);await flow.reconcile(guest);
 const view=await flow.get(landlord,host);await flow.execute(landlord,host,{action:'landlord_accept',version:view.workspace_version,revision:view.recommendation.revision});
 eq(row(host).status,'landlord_approved');eq(row(guest).status,'sent_to_landlord');
 row(signed).status='lease_sent';row(signed).workspace.tenant_signature={reference:'receipt',by:'agent-a@example.test',at:'2026-09-20T00:00:00Z'};
 row(locked).status='landlord_approved';row(locked).workspace.signing={package_id:crypto.randomUUID(),phase:'in_progress'};
 await login('admin@example.test');
 // A landlord-approved case still offers the join, without the intake-only invitation form.
 await page.goto(`${base}/admin/#/applications/${host}`);await page.getByRole('heading',{name:'Lease Details',exact:true}).waitFor();
 await page.getByText('Lease ready for review',{exact:true}).or(page.getByText('Lease needs information',{exact:true})).first().waitFor();checks++;
 await page.getByRole('button',{name:'Manage applicants',exact:true}).click();
 await page.getByText('Joining another applicant clears the landlord approval and lease draft. The landlord decides again on the combined household.',{exact:true}).waitFor();checks++;
 eq(await page.getByText('Invite a roommate',{exact:true}).count(),0);
 await page.getByText('Join an existing application',{exact:true}).click();
 const choices=page.locator('.rg-merge-choice');await choices.first().waitFor();
 eq(await choices.filter({hasText:'Guest Applicant'}).count(),1);
 eq(await choices.filter({hasText:'Signed Applicant'}).count(),0);eq(await choices.filter({hasText:'Locked Applicant'}).count(),0);
 eq(await choices.filter({hasText:'Guest Applicant'}).filter({hasText:'Awaiting landlord decision'}).count(),1);
 const choice=choices.filter({hasText:'Guest Applicant'});
 // The browser refuses the unconfirmed form itself; nothing is sent.
 await choice.getByRole('button',{name:'Join this application',exact:true}).click();
 eq(await choice.getByRole('checkbox').evaluate(input=>input.validity.valueMissing),true);
 eq(row(guest).rental_group_id,guest);
 await choice.getByRole('checkbox').check();await choice.getByRole('button',{name:'Join this application',exact:true}).click();
 await page.locator('.rg-page-header').getByText(/2 submitted/).waitFor();checks++;
 eq(row(guest).rental_group_id,host);eq(row(host).status,'sent_to_landlord');eq(row(host).workspace.recommendation.members.length,2);eq(row(host).workspace.landlord_decision,undefined);eq(row(host).lease_snapshot,null);
 eq(await page.getByRole('button',{name:/Guest Applicant/}).count(),1);
 await page.getByText('Awaiting landlord decision',{exact:true}).first().waitFor();checks++;
 await page.screenshot({path:`${out}/joined-after-approval.png`,fullPage:true});
 // A case with an active envelope offers no membership tools at all.
 await page.goto(`${base}/admin/#/applications/${locked}`);await page.getByRole('heading',{name:'Lease Details',exact:true}).waitFor();
 await page.getByText('Signatures in progress',{exact:true}).first().waitFor();checks++;
 eq(await page.getByRole('button',{name:'Manage applicants',exact:true}).count(),0);
 eq(errors,[]);console.log(`PASS ${checks} case merge browser checks: join offered after landlord approval, candidates at any stage before signing, signed and signing cases excluded, confirmation required, joined household shown, no tools while an envelope is active`);
}catch(e){await page.screenshot({path:`${out}/failure.png`,fullPage:true});console.error(await page.locator('main').innerText().catch(()=>''));throw e;}
finally{await context.close();await browser.close();await Promise.allSettled(pending);await new Promise(r=>server.close(r));restore();}
