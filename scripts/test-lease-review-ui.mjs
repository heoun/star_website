import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import worker from '../worker/index.js';
import {createIdentityFixture} from './identity-fixtures.mjs';
import {completeDemoState} from './demo-data.mjs';
import {seedRentalDemo} from './rental-demo-data.mjs';
import {rentalWorkflow} from '../worker/rentals.js';
import {ids} from '../backend/tools/workspace-fixtures.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const identity=createIdentityFixture(),{fixture,env,restore,user}=identity;
await completeDemoState(fixture.state);await seedRentalDemo(fixture.state);
const concessionExample='A one-time $500 rent credit applies to October 2026. October rent due is $2,600; the regular monthly rent of $3,100 resumes in November 2026.';
const concessionRow=fixture.state.applications.find(a=>a.id===ids.b);
concessionRow.concession_terms=concessionExample;concessionRow.workspace.terms['concession.terms']=concessionExample;
for(const s of fixture.state.staff)if(!identity.users.has(s.email))user(s.email);
env.RENTAL_AUTOMATION='on';env.RENTAL_SCREENING='mock';
const keys=new Set();env.LOCAL_EMAIL_SINK={async send(m,key){if(!keys.has(key)){keys.add(key);fixture.state.emails.push(m);}}};
Object.assign(env,{DOCUSIGN_ENABLED:'on',DOCUSIGN_ENVIRONMENT:'demo',DEV_DOCUSIGN_SEND:'on',DOCUSIGN_INTEGRATION_KEY:'test',DOCUSIGN_USER_ID:'test',DOCUSIGN_ACCOUNT_ID:'test',DOCUSIGN_PRIVATE_KEY:'test',DOCUSIGN_CONNECT_HMAC_SECRET:'test',DOCUSIGN_WEBHOOK_URL:'https://example.test/api/webhooks/docusign'});
const packages=new Map(),upstream=globalThis.fetch;
globalThis.fetch=async(input,init={})=>{const u=new URL(input);if(u.pathname.endsWith('/rental_signing_packages')){if(init.method==='POST'){const row=JSON.parse(init.body);packages.set(row.id,row);return Response.json([row]);}const selected=u.searchParams.get('id')?.slice(3);return Response.json([...packages.values()].filter(p=>(!selected || p.id===selected)&&(!u.searchParams.has('reserved') || p.reserved)));}return upstream(input,init);};
env.APPLICANT_DOCS.head=async path=>fixture.state.files[path]?{}:null;
const root=resolve('dist'),pending=[];
env.ASSETS={async fetch(request){const path=new URL(request.url).pathname,file=resolve(root,`.${path}${path.endsWith('/')?'index.html':''}`);if(!file.startsWith(root+'/'))return new Response(null,{status:404});try{return new Response(await readFile(file),{headers:{'Content-Type':({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)] || 'application/octet-stream'}});}catch{return new Response(null,{status:404});}}};
const server=http.createServer(async(req,res)=>{try{const parts=[];for await(const c of req)parts.push(c);const response=await worker.fetch(new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,...(parts.length?{body:Buffer.concat(parts)}:{})}),env,{waitUntil:p=>pending.push(p)});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(e){console.error(e);res.writeHead(500);res.end('Failed');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1600,height:1080},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
if(process.env.DEBUG_REVIEW){page.on('response',r=>{if(r.status()>=400)console.log('HTTP',r.status(),r.url());});page.on('console',m=>{if(m.type()==='error')console.log(m.text());});}
const out='/tmp/star-lease-review-ui';await mkdir(out,{recursive:true});let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const login=async email=>{await page.goto(`${base}/login/`);await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill('testing-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL('**/admin/**');};
try{
 const flow=rentalWorkflow(env,new Request(base));await flow.reconcile(ids.b);
 const row=fixture.state.applications.find(a=>a.id===ids.b);
 const owner=fixture.state.staff.find(s=>s.email===row.workspace.recommendation.landlord_email);
 await flow.execute(owner,ids.b,{action:'landlord_accept',version:row.workspace_version,revision:row.workspace.recommendation.revision});
 await login('admin@example.test');await page.goto(`${base}/admin/#/leases/${ids.b}`);
 await page.getByRole('heading',{name:'Landlord & Signer',exact:true}).waitFor();
 const panel=page.locator('#lease-fields');
 eq(await panel.getByRole('tab').allTextContents(),['Lease Information','Documents','E-sign Recipients']);
 eq(await panel.getByRole('heading',{level:3}).allTextContents(),['Tenants','Property & Lease Terms','Rent & Deposit','Landlord & Signer','Property Terms & Disclosures']);
 eq(await panel.locator('[data-lease-input]:visible').count(),0);
 eq(await page.locator('#lease-alarm').isVisible(),false);
 const valueStarts=await panel.locator('[data-ws-row="property.address_full"]>.ws-review-value,[data-ws-row="lease.effective_date"]>summary>.ws-review-value,[data-ws-row="lease.commencement_date"]>summary>.ws-review-value').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().left));
 assert.ok(Math.max(...valueStarts)-Math.min(...valueStarts)<1);checks++;
 const typeRow=panel.locator('[data-ws-row="dhcr.mark_vacancy"]');
 await typeRow.locator(':scope > summary').click();
 eq(await panel.locator('[data-ws-row="dhcr.mark_renewal"]').count(),0);
 await panel.locator('[data-ws-lease-type]').selectOption('renewal');
 eq(await panel.locator('[data-ws-lease-type-value]').innerText(),'Renewal');
 const marks=()=>page.evaluate(async()=>{const doc=await import('/admin/lease-doc.js');return ['dhcr.mark_vacancy','dhcr.mark_renewal'].map(id=>doc.contextsForField(id).join(' '));});
 const renewalMarks=await marks();assert.match(renewalMarks[0],/\[ \]/);assert.match(renewalMarks[1],/\[X\]/);checks++;
 await panel.locator('[data-ws-lease-type]').selectOption('new');
 eq(await panel.locator('[data-ws-lease-type-value]').innerText(),'New Lease');
 await typeRow.getByRole('button',{name:'Done',exact:true}).click();
 eq(await page.getByRole('button',{name:'Save & Request Approval',exact:true}).isVisible(),false);
 await page.screenshot({path:`${out}/desktop.png`,fullPage:true});
 await panel.locator('[data-lease-locate="property.address_full"]').click();
 const draftTotal=Number((await page.locator('#lease-match-count').innerText()).split(' of ')[1]);
 assert.ok(draftTotal>1);checks++;
 await page.getByRole('button',{name:'Next Match',exact:true}).click();
 eq(await page.locator('#lease-match-count').innerText(),`2 of ${draftTotal}`);
 await page.getByRole('button',{name:'Previous Match',exact:true}).click();
 eq(await page.locator('#lease-match-count').innerText(),`1 of ${draftTotal}`);
 await page.getByRole('button',{name:'Previous Match',exact:true}).click();
 eq(await page.locator('#lease-match-count').innerText(),`${draftTotal} of ${draftTotal}`);
 eq(await page.locator('#lease-doc .is-current-match').count(),1);
 eq(await page.locator('#lease-doc .is-current-match').isVisible(),true);
 assert.notEqual(await page.locator('#lease-doc-name').innerText(),'New York Residential Lease Agreement');checks++;
 await panel.getByRole('tab',{name:'Documents',exact:true}).click();
 eq(await panel.locator('[data-ws-doc=""]').count(),0);eq(await panel.locator('[data-ws-doc]').count(),15);
 await panel.locator('[data-ws-doc="utilities"]').click();eq(await page.locator('#lease-doc-name').innerText(),'Utilities Rider');
 await page.getByRole('button',{name:'View All Documents',exact:true}).click();eq(await page.locator('#lease-all-documents').getAttribute('aria-pressed'),'true');
 await panel.getByRole('tab',{name:'Lease Information',exact:true}).click();
 const start=panel.locator('[data-ws-row="lease.commencement_date"]');await start.locator(':scope > summary').click();
 await start.locator('input').fill('11/01/2026');eq(await panel.locator('[data-lease-input="lease.end_date"]').inputValue(),'10/31/2027');
 await start.locator('input').fill('10/01/2026');eq(await panel.locator('[data-lease-input="lease.end_date"]').inputValue(),'09/30/2027');
 eq(await page.getByRole('button',{name:'Save & Request Approval',exact:true}).isVisible(),false);
 await start.getByRole('button',{name:'Done',exact:true}).click();
 const end=panel.locator('[data-ws-row="lease.end_date"]');await end.locator(':scope > summary').click();
 await end.locator('input').fill('10/31/2027');eq(await panel.locator('[data-ws-term]').innerText(),'Custom Term');
 await end.locator('input').fill('09/30/2027');eq(await panel.locator('[data-ws-term]').innerText(),'12 Months');
 await end.getByRole('button',{name:'Done',exact:true}).click();
 const rent=panel.locator('[data-ws-row="rent.monthly"]');await rent.locator(':scope > summary').click();await rent.locator('input').fill('3100');
 eq(await page.getByRole('button',{name:'Review Signing Package',exact:true}).isDisabled(),true);
 await rent.getByRole('button',{name:'Done',exact:true}).click();eq(await rent.getAttribute('open'),null);
 await panel.getByRole('tab',{name:'E-sign Recipients',exact:true}).click();
 eq(await panel.locator('.ws-signer').count(),3);
 eq(await panel.locator('.ws-signer-order').allTextContents(),['1','1','2']);
 await panel.getByText(owner.email,{exact:true}).waitFor();checks++;
 eq(await panel.getByRole('button',{name:'Review Signing Package',exact:true}).count(),0);
 await panel.getByRole('tab',{name:'Lease Information',exact:true}).click();
 const landlord=panel.locator('[data-ws-row="landlord.address"]');await landlord.locator(':scope > summary').click();await landlord.locator('input').fill('LEASE ONLY CORRECTION');
 const defaults=JSON.stringify(fixture.state.settings);page.once('dialog',d=>d.accept());
 await page.getByRole('button',{name:'Save & Request Approval',exact:true}).click();
 await page.getByText('Corrections saved. A new landlord approval is required.',{exact:true}).waitFor();
 eq(row.status,'sent_to_landlord');eq(row.lease_snapshot,null);eq(JSON.stringify(fixture.state.settings),defaults);
 eq(await page.getByRole('button',{name:'Review Signing Package',exact:true}).isDisabled(),true);
 await flow.execute(owner,ids.b,{action:'landlord_accept',version:row.workspace_version,revision:row.workspace.recommendation.revision});
 await page.reload();await panel.getByRole('heading',{name:'Landlord & Signer',exact:true}).waitFor();
 await panel.getByRole('tab',{name:'E-sign Recipients',exact:true}).click();
 eq(await panel.locator('.ws-signer').count(),3);
 eq(await panel.locator('.signing-recipients').count(),0);
 eq(await panel.getByRole('button',{name:'Review Lease Draft',exact:true}).count(),0);
 eq(await panel.getByRole('button',{name:'Send With DocuSign',exact:true}).count(),0);
 eq(await page.getByRole('button',{name:'Send With DocuSign',exact:true}).isDisabled(),true);
 eq(packages.size,0);
 await panel.getByRole('tab',{name:'Lease Information',exact:true}).click();
 await page.getByRole('button',{name:'Review Signing Package',exact:true}).click();
 await page.getByText('Review the lease and signer details, then send with DocuSign.',{exact:true}).waitFor();
 eq(packages.size,1);
 const savedFrame=page.frameLocator('iframe[title="Lease for Signing"]');
 const savedPackage=[...packages.values()][0];
 const qaSource=await page.request.get(`${base}/api/admin/cases/${ids.b}/signing?package=${savedPackage.id}&file=source`);
 await writeFile(`${out}/main-signing-review.docx`,await qaSource.body());
 await savedFrame.locator('section.docx').first().waitFor();
 eq(await savedFrame.locator('#status').isHidden(),true);
 eq(await page.getByRole('button',{name:'Send With DocuSign',exact:true}).isDisabled(),true);
 await panel.getByRole('tab',{name:'E-sign Recipients',exact:true}).click();
 eq(await panel.locator('.ws-signer').count(),3);
 eq(await page.getByRole('button',{name:'Send With DocuSign',exact:true}).count(),1);
 eq(await page.getByRole('button',{name:'Review Signing Package',exact:true}).count(),0);
 await page.getByText('Signing package opened for review · Not sent.',{exact:true}).waitFor();
 await page.screenshot({path:`${out}/signing-recipients.png`,fullPage:true});
 await panel.getByRole('button',{name:'Preview Signing Fields',exact:true}).click();
 await page.getByText('New York Residential Lease Agreement · Signing field preview only. Nothing has been sent.',{exact:true}).waitFor();
 eq(await savedFrame.locator('.signing-field-box').count(),10);
 eq(await savedFrame.locator('.signing-field-box[data-kind="initial"]').count(),4);
 eq(await savedFrame.locator('.signing-field-box[data-kind="full_name"]').count(),3);
 await page.screenshot({path:`${out}/signing-fields-38.png`,fullPage:true});
 await panel.locator('.ws-signing-targets [data-preview-signing-fields="main-39-1-initial"]').click();
 await savedFrame.locator('[data-signing-field="main-39-1-initial"].current').waitFor();
 await page.screenshot({path:`${out}/signing-fields-39.png`,fullPage:true});
 await panel.locator('[data-preview-signing-fields="main-47-1-signature"]').click();
 await savedFrame.locator('[data-signing-field="main-47-1-signature"].current').waitFor();
 eq(await savedFrame.locator('[data-signing-field="main-47-3-full_name"]').innerText(),owner.name);
 await page.screenshot({path:`${out}/signing-fields-47.png`,fullPage:true});
 // Every new document has its own original tenant/landlord lines and navigation.
 for(const layout of ['utilities','packages','keys','insurance','rules','fines']){
  await panel.locator('[data-signing-layout]').selectOption(layout);
  await savedFrame.locator(`[data-signing-field="${layout}-1-signature"].current`).waitFor();
  eq(await savedFrame.locator('.signing-field-box').count(),6);
  eq(await savedFrame.locator('.signing-field-box[data-kind="initial"]').count(),0);
  eq(await savedFrame.locator(`[data-signing-field="${layout}-3-full_name"]`).innerText(),owner.name);
  eq(await savedFrame.locator('.signing-field-box.current').evaluate(el=>{const r=el.getBoundingClientRect();return r.width>80 && r.top>=0 && r.bottom<innerHeight;}),true);
  await panel.locator(`[data-preview-signing-fields="${layout}-3-signature"]`).click();
  await savedFrame.locator(`[data-signing-field="${layout}-3-signature"].current`).waitFor();
  await page.screenshot({path:`${out}/signing-fields-${layout}.png`,fullPage:true});
 }
 // The second row remains available in the standalone Fine Schedule.
 const slotCheck=await savedFrame.locator('#lease-doc').evaluate(async host=>{
  const {showSigningFields,clearSigningFields}=await import('/admin/signing-field-preview.js');
  const doc=await import('/admin/lease-doc.js');doc.showSections(null);
  const tenants=Array.from({length:8},(_,i)=>({recipientId:String(i+1),role:'tenant',name:`Tenant ${i+1}`,email:`tenant-${i+1}@example.test`}));
  const signers=[...tenants,{recipientId:'9',role:'landlord',name:'Landlord',email:'landlord@example.test'}];
  const {SIGNING_DOCUMENTS}=await import('/shared/lease-signing-layout.js');
  const results=[];
  for(const layout of SIGNING_DOCUMENTS.filter(d=>d.id==='fines')){
   showSigningFields(host,signers,`${layout.id}-8-full_name`,layout.id,{standalone:true});
   const table=host.querySelectorAll('table')[1],ps=table.querySelectorAll('p');
   const p=ps[21+(layout.tenantParagraphOffset || 0)].getBoundingClientRect();
   const box=host.querySelector(`[data-signing-field="${layout.id}-8-full_name"]`).getBoundingClientRect();
   results.push([host.querySelectorAll('.signing-field-box').length,Math.abs(box.left-p.left)<1]);
  }
  clearSigningFields();return results;
 });
 eq(slotCheck,[[18,true]]);
 for(const layout of ['window_guards','bedbug','sprinkler','allergen','alarms','smoking','concession','dhcr','good_cause']){
  await panel.locator('[data-signing-layout]').selectOption(layout);
  const recipient=layout==='allergen'?'3':'1';
  await savedFrame.locator(`[data-signing-field="${layout}-${recipient}-signature"].current`).waitFor();
  eq(await savedFrame.locator('.signing-field-box').count(),({window_guards:2,bedbug:4,allergen:3,dhcr:4})[layout] || 6);
  eq(await savedFrame.locator('.signing-field-box[data-kind="date_signed"]').count(),({window_guards:1,bedbug:2,allergen:1,dhcr:2})[layout] || 0);
  for(const button of await panel.locator('.ws-signing-targets [data-preview-signing-fields]').all()){
   const id=await button.getAttribute('data-preview-signing-fields');await button.click();
   const box=savedFrame.locator(`[data-signing-field="${id}"].current`);await box.waitFor();
   // Clicking an already-selected field redraws its overlay asynchronously.
   // Resolve the current node within one frame, rather than measuring a
   // detached overlay captured before its replacement.
   await page.waitForFunction(id=>{
    const frame=document.querySelector('iframe[title="Lease for Signing"]');
    const el=frame?.contentDocument?.querySelector(`[data-signing-field="${id}"].current`),r=el?.getBoundingClientRect();
    return r && r.width>30 && r.height>8 && r.top>=0 && r.bottom<frame.contentWindow.innerHeight;
   },id);checks++;
  }
  await page.screenshot({path:`${out}/signing-fields-${layout}.png`,fullPage:true});
  if(['window_guards','bedbug','dhcr'].includes(layout)){
   await panel.locator('[data-signing-tenant]').selectOption('2');
   await savedFrame.locator(`[data-signing-field="${layout}-2-signature"].current`).waitFor();
   eq(await savedFrame.locator('.signing-field-box[data-recipient="1"]').count(),0);
   eq(await savedFrame.locator(`[data-signing-field="${layout}-2-signature"]`).innerText(),'T2 · Signature');
   assert.match(await savedFrame.locator('#lease-doc').innerText(),/Applicant E/);checks++;
   await panel.locator('[data-signing-tenant]').selectOption('1');
   await savedFrame.locator(`[data-signing-field="${layout}-1-signature"].current`).waitFor();
  }
 }
 for(const part of savedPackage.record.package.documents){
  if(part.tenantRecipientId && part.tenantRecipientId!=='1')continue;
  const response=await page.request.get(`${base}/api/admin/cases/${ids.b}/signing?package=${savedPackage.id}&file=source&document=${part.documentId}`);
  await writeFile(`${out}/signing-${part.layout}.docx`,await response.body());
 }
 await page.getByRole('button',{name:'View All Documents',exact:true}).click();
 await savedFrame.locator('#lease-doc').filter({hasText:'LEASE ONLY CORRECTION'}).waitFor();
 await panel.getByRole('tab',{name:'Lease Information',exact:true}).click();
 assert.match(await savedFrame.locator('#lease-doc').textContent(),/LEASE ONLY CORRECTION/);checks++;
 // Locate must navigate the visible saved package, including from another rider.
 await panel.getByRole('tab',{name:'Documents',exact:true}).click();
 await panel.locator('[data-ws-doc="utilities"]').click();
 await panel.getByRole('tab',{name:'Lease Information',exact:true}).click();
 await panel.locator('[data-lease-locate="property.address_full"]').click();
 await page.locator('#lease-review-feedback').filter({hasText:'located and highlighted in the signing document.'}).waitFor();
 eq(await savedFrame.locator('.signing-located').first().isVisible(),true);
 eq(await savedFrame.locator('.signing-located').first().evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0 && r.top<innerHeight;}),true);
 assert.match(await savedFrame.locator('.signing-located').first().innerText(),/RENTAL UNIT/);checks++;
 assert.notEqual(await page.locator('#lease-doc-name').innerText(),'Utilities Rider');checks++;
 await page.screenshot({path:`${out}/located-signing-field.png`,fullPage:true});
 const savedTotal=Number((await page.locator('#lease-match-count').innerText()).split(' of ')[1]);
 assert.ok(savedTotal>1);checks++;
 await page.getByRole('button',{name:'Next Match',exact:true}).click();
 await page.locator('#lease-match-count').filter({hasText:`2 of ${savedTotal}`}).waitFor();
 await page.getByRole('button',{name:'Previous Match',exact:true}).click();
 await page.locator('#lease-match-count').filter({hasText:`1 of ${savedTotal}`}).waitFor();
 await page.getByRole('button',{name:'Previous Match',exact:true}).click();
 await page.locator('#lease-match-count').filter({hasText:`${savedTotal} of ${savedTotal}`}).waitFor();
 eq(await savedFrame.locator('.is-current-match').count(),1);
 eq(await savedFrame.locator('.is-current-match').evaluate(el=>{const r=el.getBoundingClientRect();return r.bottom>0 && r.top<innerHeight;}),true);
 await page.screenshot({path:`${out}/match-navigation.png`,fullPage:true});
 assert.notEqual(await page.locator('#lease-doc-name').innerText(),'New York Residential Lease Agreement');checks++;
 for(const [id,clause] of [['rent.monthly',/Monthly Rent/],['deposit.amount',/Security Deposit/i]]){
   const field=panel.locator(`[data-ws-row="${id}"]`);
   await field.locator(':scope > summary').click();
   await field.locator('[data-lease-locate]').click();
   await savedFrame.locator('.signing-located').filter({hasText:clause}).first().waitFor();
   assert.match(await savedFrame.locator('.signing-located').first().innerText(),clause);checks++;
   await field.getByRole('button',{name:'Done',exact:true}).click();
 }
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Lease Information',exact:true}).click();
 await panel.locator('[data-lease-locate="property.address_full"]').click();
 await page.locator('iframe[title="Lease for Signing"]').waitFor({state:'visible'});
 await savedFrame.locator('.signing-located').filter({hasText:'RENTAL UNIT'}).first().waitFor();
 eq(await savedFrame.locator('.signing-located').first().evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0 && r.top<innerHeight;}),true);
 await page.setViewportSize({width:1600,height:1080});
 await page.screenshot({path:`${out}/saved-signing-package.png`,fullPage:true});
 await page.getByRole('button',{name:/Back to Rental/}).click();
 await page.getByRole('tab',{name:'Lease & Decision',exact:true}).click();
 eq(await page.getByRole('button',{name:'Review Lease Draft',exact:true}).count(),1);
 await page.getByRole('button',{name:'Review Lease Draft',exact:true}).click();
 await page.locator('#lease-final').filter({hasText:'Send With DocuSign'}).waitFor();
 eq(packages.size,1); // The reviewed package is reused after navigating back.
 // A saved document with different bytes must never be marked as reviewed.
 await page.getByRole('button',{name:/Back to Rental/}).click();
 const sourcePattern='**/api/admin/cases/**/signing?package=*&file=source';
 await page.route(sourcePattern,async route=>{const response=await route.fetch();await route.fulfill({response,body:Buffer.concat([await response.body(),Buffer.from('changed')])});});
 await page.getByRole('button',{name:'Review Lease Draft',exact:true}).click();
 await page.getByText('The saved signing document does not match this package. Prepare it again.',{exact:true}).waitFor();
 eq(await page.locator('iframe[title="Lease for Signing"]').count(),0);
 eq(await page.locator('#lease-final').innerText(),'Send With DocuSign');
 await page.unroute(sourcePattern);
 await page.locator('#lease-draft').click();
 await page.frameLocator('iframe[title="Lease for Signing"]').locator('#status').waitFor({state:'hidden'});
 // Editing an approved value clears the opened-package state immediately.
 const reviewedRent=panel.locator('[data-ws-row="rent.monthly"]');
 await reviewedRent.locator(':scope > summary').click();await reviewedRent.locator('input').fill('3200');
 eq(await page.locator('iframe[title="Lease for Signing"]').count(),0);
 eq(await page.locator('#lease-final').isDisabled(),true);
 await reviewedRent.locator('input').fill('3100');await reviewedRent.getByRole('button',{name:'Done',exact:true}).click();
 // No send here: the isolated signing tests cover dispatch and confirmation.
 await panel.getByRole('tab',{name:'Lease Information',exact:true}).click();
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Lease Information',exact:true}).click();
 eq(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 await page.screenshot({path:`${out}/mobile.png`,fullPage:true});
 await page.setViewportSize({width:1600,height:1080});
 await login('agent-b@example.test');await page.goto(`${base}/admin/#/leases/${ids.b}`);await panel.getByRole('heading',{name:'Landlord & Signer',exact:true}).waitFor();
 eq(await panel.locator('[data-ws-row="landlord.address"] input').count(),0);
 eq(await panel.locator('[data-ws-row="rent.monthly"] input').count(),1);
 eq(errors,[]);console.log(`PASS ${checks} lease review UI checks: compact groups, exact household recipients, document navigation, local edits, approval reset, lease-only saves, preview and mobile`);
}finally{if(process.env.DEBUG_REVIEW)console.log((await page.locator('body').innerText()).slice(-3500));await browser.close();await new Promise(r=>server.close(r));await Promise.allSettled(pending);restore();}
