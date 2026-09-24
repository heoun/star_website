import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,extname} from 'node:path';
import worker from '../worker/index.js';
import {createIdentityFixture} from './identity-fixtures.mjs';
import {completeDemoState} from './demo-data.mjs';
import {seedRentalDemo} from './rental-demo-data.mjs';
import {rentalWorkflow} from '../worker/rentals.js';
import {ids} from '../backend/tools/workspace-fixtures.mjs';

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
globalThis.fetch=async(input,init={})=>{const u=new URL(input);if(u.pathname.endsWith('/rental_signing_packages')){if(init.method==='POST'){const row=JSON.parse(init.body);packages.set(row.id,row);return Response.json([row]);}const selected=u.searchParams.get('id')?.slice(3);return Response.json([...packages.values()].reverse().filter(p=>(!selected || p.id===selected)&&(!u.searchParams.has('reserved') || !!p.reserved===(u.searchParams.get('reserved')==='eq.true'))));}return upstream(input,init);};
env.APPLICANT_DOCS.head=async path=>fixture.state.files[path]?{}:null;
const root=resolve('dist'),pending=[];
env.ASSETS={async fetch(request){const path=new URL(request.url).pathname,file=resolve(root,`.${path}${path.endsWith('/')?'index.html':''}`);if(!file.startsWith(root+'/'))return new Response(null,{status:404});try{return new Response(await readFile(file),{headers:{'Content-Type':({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)] || 'application/octet-stream'}});}catch{return new Response(null,{status:404});}}};
const server=http.createServer(async(req,res)=>{try{const parts=[];for await(const c of req)parts.push(c);const response=await worker.fetch(new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,...(parts.length?{body:Buffer.concat(parts)}:{})}),env,{waitUntil:p=>pending.push(p)});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(e){console.error(e);res.writeHead(500);res.end('Failed');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
if(process.argv.includes('--serve')){
 const flow=rentalWorkflow(env,new Request(base));await flow.reconcile(ids.b);
 const row=fixture.state.applications.find(a=>a.id===ids.b),owner=fixture.state.staff.find(s=>s.email===row.workspace.recommendation.landlord_email);
 await flow.execute(owner,ids.b,{action:'landlord_accept',version:row.workspace_version,revision:row.workspace.recommendation.revision});
 env.DEV_ADMIN_EMAIL='admin@example.test';env.DEV_ADMIN_ROLE='manager';
 console.log(`Synthetic review verification: ${base}/admin/#/applications/${ids.b}`);
 await new Promise(()=>{});
}
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1600,height:1080},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
if(process.env.DEBUG_REVIEW){page.on('response',r=>{if(r.status()>=400)console.log('HTTP',r.status(),r.url());});page.on('console',m=>{if(m.type()==='error')console.log(m.text());});}
const out='/tmp/star-lease-review-ui';await mkdir(out,{recursive:true});let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const login=async email=>{await page.goto(`${base}/login/`);await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill('testing-password');await page.getByRole('button',{name:'Sign In',exact:true}).click();await page.waitForURL('**/admin/**');};
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
 eq(await page.getByRole('button',{name:'Download PDF',exact:true}).isVisible(),true);
 await page.route('**/api/admin/cases/*/signing',async route=>{
  if(route.request().method()==='POST' && route.request().postDataJSON()?.action==='download_pdf')return route.fulfill({status:200,contentType:'application/pdf',body:'%PDF-test-download'});
  return route.fallback();
 });
 const pdfDownload=page.waitForEvent('download');
 await page.getByRole('button',{name:'Download PDF',exact:true}).click();
 eq((await pdfDownload).suggestedFilename(),'lease-for-review.pdf');
 await page.getByText('Lease PDF downloaded.',{exact:true}).waitFor();
 await page.unroute('**/api/admin/cases/*/signing');
 const valueStarts=await panel.locator('[data-ws-row="property.address_full"]>.ws-review-value,[data-ws-row="lease.effective_date"]>summary>.ws-review-value,[data-ws-row="lease.commencement_date"]>summary>.ws-review-value').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().left));
 assert.ok(Math.max(...valueStarts)-Math.min(...valueStarts)<1);checks++;
 await panel.getByRole('tab',{name:'E-sign Recipients',exact:true}).click();
 await panel.getByRole('button',{name:'Add CC Recipient',exact:true}).click();
 await panel.locator('[data-cc-name]').fill('Agent Copy');
 await panel.locator('[data-cc-email]').fill('copy@example.test');
 await panel.getByRole('button',{name:'Save CC Recipients',exact:true}).click();
 await page.getByText('CC recipients saved. No email has been sent.',{exact:true}).waitFor();
 await page.reload();await panel.getByRole('tab',{name:'E-sign Recipients',exact:true}).click();
 eq(await panel.locator('[data-cc-email]').inputValue(),'copy@example.test');
 await panel.getByRole('button',{name:'Remove',exact:true}).click();
 await panel.getByRole('button',{name:'Save CC Recipients',exact:true}).click();
 await page.getByText('CC recipients saved. No email has been sent.',{exact:true}).waitFor();
 await panel.getByRole('tab',{name:'Lease Information',exact:true}).click();
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
 // Closing the screen while its package is still being prepared must not let
 // that stale work reach the reopened screen.
 const frame=page.frameLocator('iframe[title="Lease for Signing"]');
 const preparePattern='**/api/admin/cases/*/signing';
 await page.route(preparePattern,async route=>{if(route.request().method()!=='POST')return route.fallback();await new Promise(r=>setTimeout(r,1500));await route.continue();});
 const prepared=page.waitForResponse(r=>r.request().method()==='POST' && /\/signing$/.test(r.url()));
 await panel.getByRole('tab',{name:'Documents',exact:true}).click();
 eq(await panel.locator('[data-ws-doc=""]').count(),0);eq(await panel.locator('[data-ws-doc]').count(),16);
 eq(await panel.locator('[data-preview-status="loading"]').count(),1);
 eq(await page.locator('#lease-draft').isDisabled(),true);
 await page.getByRole('button',{name:/Back to Rental/}).click();
 await page.getByRole('tab',{name:'Lease & Decision',exact:true}).waitFor();
 await page.goto(`${base}/admin/#/leases/${ids.b}`);
 await panel.getByRole('heading',{name:'Landlord & Signer',exact:true}).waitFor();
 await (await prepared).finished();await page.waitForTimeout(400);
 eq(await page.locator('iframe[title="Lease for Signing"]').count(),0);
 eq(await page.locator('#lease-doc-name').innerText(),'New York Residential Lease Agreement');
 eq(await page.locator('#lease-review-feedback').isHidden(),true);
 eq(await page.locator('#lease-draft').isEnabled(),true);
 eq(await panel.getByRole('tab',{selected:true}).innerText(),'Lease Information');
 eq(packages.size,3);
 await page.unroute(preparePattern);
 // A slow frame with a quick switch draws only the last selection, and
 // previewing one document does not count as reviewing the package.
 const mergedPattern='**/api/admin/cases/*/signing?package=*&file=source';
 await page.route(mergedPattern,async route=>{await new Promise(r=>setTimeout(r,1500));await route.continue();});
 await panel.getByRole('tab',{name:'Documents',exact:true}).click();
 await panel.locator('[data-ws-doc="utilities"]').click();eq(await page.locator('#lease-doc-name').innerText(),'Utilities Rider');
 await panel.locator('[data-ws-doc="packages"]').click();
 await frame.locator('[data-signing-field="packages-1-signature"].current').waitFor();
 eq(await frame.locator('[data-signing-field^="utilities-"],[data-signing-field^="lease-"]').count(),0);
 eq(await page.locator('#lease-doc-name').innerText(),'Packages Rider');
 eq(await panel.locator('[data-workspace-document-preview]').evaluate(el=>el.previousElementSibling?.getAttribute('data-ws-doc')),'packages');
 eq(await page.locator('#lease-draft').isVisible(),true);
 await page.unroute(mergedPattern);
 await panel.getByRole('tab',{name:'E-sign Recipients',exact:true}).click();
 await panel.getByText('Draft preview · Not sent. Sending without opening the signing package requires confirmation.',{exact:true}).waitFor();
 await panel.getByRole('tab',{name:'Documents',exact:true}).click();
 await frame.locator('[data-signing-field="packages-1-signature"].current').waitFor();
 // An explicit review while a document is shown opens the whole package and marks it reviewed.
 await page.locator('#lease-draft').click();
 await page.getByText('Review the lease and signer details, then send with DocuSign.',{exact:true}).waitFor();
 eq(await page.locator('#lease-all-documents').getAttribute('aria-pressed'),'true');
 eq(await panel.locator('[data-workspace-document-preview]').count(),0);
 eq(await page.locator('#lease-draft').isHidden(),true);
 eq(packages.size,3);
 await panel.locator('[data-ws-doc="utilities"]').click();
 await frame.locator('[data-signing-field="utilities-1-signature"].current').waitFor();
 eq(await page.locator('#lease-draft').isHidden(),true);
 await page.getByRole('button',{name:'View All Documents',exact:true}).click();eq(await page.locator('#lease-all-documents').getAttribute('aria-pressed'),'true');
 eq(await panel.locator('[data-workspace-document-preview]').count(),0);
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
 eq(await rent.locator('.ws-money-input>span').innerText(),'$');
 eq(await rent.locator('[data-ws-value]').innerText(),'$3,100.00');
 eq(await page.locator('[data-lease-slot="rent.monthly"]').first().innerText(),'$3,100.00');
 eq(await page.getByRole('button',{name:'Review Lease for Signatures',exact:true}).isDisabled(),true);
 await rent.getByRole('button',{name:'Done',exact:true}).click();eq(await rent.getAttribute('open'),null);
 await panel.getByRole('tab',{name:'E-sign Recipients',exact:true}).click();
 eq(await panel.locator('.ws-signer').count(),3);
 eq(await panel.locator('.ws-signer-order').allTextContents(),['1','1','2']);
 await panel.getByText(owner.email,{exact:true}).waitFor();checks++;
 eq(await panel.getByRole('button',{name:'Review Lease for Signatures',exact:true}).count(),0);
 await panel.getByRole('tab',{name:'Lease Information',exact:true}).click();
 const landlord=panel.locator('[data-ws-row="landlord.address"]');await landlord.locator(':scope > summary').click();await landlord.locator('input').fill('LEASE ONLY CORRECTION');
 const defaults=JSON.stringify(fixture.state.settings);page.once('dialog',d=>d.accept());
 await page.getByRole('button',{name:'Save & Request Approval',exact:true}).click();
 await page.getByText('Corrections saved. A new landlord approval is required.',{exact:true}).waitFor();
 eq(row.status,'sent_to_landlord');eq(row.lease_snapshot,null);eq(JSON.stringify(fixture.state.settings),defaults);
 eq(await page.getByRole('button',{name:'Review Lease for Signatures',exact:true}).isDisabled(),true);
 await flow.execute(owner,ids.b,{action:'landlord_accept',version:row.workspace_version,revision:row.workspace.recommendation.revision});
 await page.reload();await panel.getByRole('heading',{name:'Landlord & Signer',exact:true}).waitFor();
 await panel.getByRole('tab',{name:'E-sign Recipients',exact:true}).click();
 eq(await panel.locator('.ws-signer').count(),3);
 eq(await panel.locator('.signing-recipients').count(),0);
 eq(await panel.getByRole('button',{name:'Review Lease Draft',exact:true}).count(),0);
 eq(await panel.getByRole('button',{name:'Send With DocuSign',exact:true}).count(),0);
 eq(await page.getByRole('button',{name:'Send With DocuSign',exact:true}).isEnabled(),true);
 eq(packages.size,3); // Prepared once for the first approval when Documents opened; a new approval needs a new package.
 await panel.getByRole('tab',{name:'Lease Information',exact:true}).click();
 await page.getByRole('button',{name:'Review Lease for Signatures',exact:true}).click();
 await page.getByText('Review the lease and signer details, then send with DocuSign.',{exact:true}).waitFor();
 eq(packages.size,4);
 const savedFrame=page.frameLocator('iframe[title="Lease for Signing"]');
 const savedPackage=[...packages.values()].at(-1);
 const qaSource=await page.request.get(`${base}/api/admin/cases/${ids.b}/signing?package=${savedPackage.id}&file=source`);
 await writeFile(`${out}/main-signing-review.docx`,await qaSource.body());
 await savedFrame.locator('section.docx').first().waitFor();
 eq(await savedFrame.locator('#status').isHidden(),true);
 eq(await page.getByRole('button',{name:'Send With DocuSign',exact:true}).isEnabled(),true);
 await panel.getByRole('tab',{name:'E-sign Recipients',exact:true}).click();
 eq(await panel.locator('.ws-signer').count(),3);
 eq(await page.getByRole('button',{name:'Send With DocuSign',exact:true}).count(),1);
 eq(await page.getByRole('button',{name:'Review Lease for Signatures',exact:true}).count(),0);
 await page.getByText('Signing package opened for review · Not sent.',{exact:true}).waitFor();
 await page.screenshot({path:`${out}/signing-recipients.png`,fullPage:true});
 // Selecting a document under Documents shows its own signing copy with the
 // fields drawn on it. No separate document selector or preview button remains.
 await panel.getByRole('tab',{name:'Documents',exact:true}).click();
 eq(await panel.locator('[data-signing-layout],[data-signing-tenant],.ws-signing-preview').count(),0);
 eq(await page.getByRole('button',{name:'Preview Signing Fields',exact:true}).count(),0);
 const detail=panel.locator('[data-workspace-document-preview]');
 await panel.locator('[data-ws-doc="lease"]').click();
 await page.getByText('New York Residential Lease Agreement · Signing field preview only. Nothing has been sent.',{exact:true}).waitFor();
 eq(await detail.count(),1);
 eq(await detail.evaluate(el=>el.previousElementSibling?.getAttribute('data-ws-doc')),'lease');
 eq(await detail.locator('[data-preview-status]').getAttribute('data-preview-status'),'ready');
 eq(await detail.locator('.ws-field-legend li').allTextContents(),['Tenants','Landlord','Date Signed, entered when that person signs','Filled Values']);
 eq(await detail.locator('[data-preview-signing-fields][aria-pressed="true"]').getAttribute('data-preview-signing-fields'),'lease-38-1-initial');
 eq(await savedFrame.locator('.signing-field-box').count(),10);
 eq(await savedFrame.locator('.signing-field-box[data-kind="initial"]').count(),4);
 eq(await savedFrame.locator('.signing-field-box[data-kind="full_name"]').count(),3);
 // Opening a copy starts on its first page even though its first field sits
 // pages down; only a click on a field moves the page, and zoom stays put.
 const frameTop=()=>savedFrame.locator('body').evaluate(()=>window.scrollY);
 const currentInView=()=>savedFrame.locator('.signing-field-box.current').evaluate(el=>{const r=el.getBoundingClientRect();return r.width>80 && r.top>=0 && r.bottom<innerHeight;});
 eq(await frameTop(),0);
 eq(await savedFrame.locator('.signing-field-box.current').evaluate(el=>el.getBoundingClientRect().top>innerHeight),true);
 // Every value the lease filled into this copy is marked on it, in the order
 // it prints, and nothing else is: the same words and numbers set as fixed
 // text stay plain, and an empty value leaves no mark. The expectation is read
 // off the template the screen renders, slot by slot.
 // The copy's paragraphs are cut the way the Worker cuts the filled document:
 // from the body node whose words open the copy to the node opening the next.
 const expectedValues=(id,{overrides={}}={})=>page.evaluate(async([id,overrides])=>{
  const {DOCUMENTS}=await import('/shared/lease-documents.js');
  const fold=t=>String(t).replace(/\s+/g,' ').trim();
  const nodes=[...document.querySelectorAll('#lease-doc section.docx > article > *')];
  const starts=DOCUMENTS.map(d=>({id:d.id,index:nodes.findIndex(n=>fold(n.textContent).startsWith(fold(d.starts)))})).sort((a,b)=>a.index-b.index);
  const at=starts.findIndex(s=>s.id===id);
  const paragraphs=nodes.slice(starts[at].index,starts[at+1]?.index??nodes.length).flatMap(n=>n.matches('p')?[n]:[...n.querySelectorAll('p')]);
  const slots=paragraphs.flatMap(p=>[...p.querySelectorAll('[data-lease-slot]')]);
  const values=slots.map(s=>[s.dataset.leaseSlot,fold(Object.hasOwn(overrides,s.dataset.leaseSlot)?overrides[s.dataset.leaseSlot]:s.textContent)]);
  return {values:values.filter(([,v])=>v),empty:values.filter(([,v])=>!v).length};
 },[id,overrides]);
 const markedValues=()=>savedFrame.locator('#lease-doc').evaluate(host=>{
  const groups=new Map();
  for(const m of host.querySelectorAll('mark.signing-value')){const key=m.dataset.signingValue;if(!groups.has(key))groups.set(key,[m.dataset.field,'']);groups.get(key)[1]+=m.textContent;}
  return [...groups.values()].map(([id,v])=>[id,v.replace(/\s+/g,' ').trim()]);
 });
 // Fixed text that repeats a marked value word for word ("New York" in the
 // Good Cause notice, a date, a fee) and carries no mark of its own.
 const plainTwins=()=>savedFrame.locator('#lease-doc').evaluate(host=>{
  const fold=t=>t.replace(/\s+/g,' ').trim();
  const marked=[...new Set([...host.querySelectorAll('mark.signing-value')].map(m=>fold(m.textContent)))].filter(v=>v.length>=4);
  const plain=p=>{const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);let text='';for(let n=walker.nextNode();n;n=walker.nextNode())if(!n.parentElement.closest('mark.signing-value'))text+=n.nodeValue;return fold(text);};
  return [...host.querySelectorAll('section.docx > article p')].filter(p=>{const t=plain(p);return marked.some(v=>t.includes(v));}).length;
 });
 const valueCounts=()=>Promise.all([detail.locator('[data-preview-values]').getAttribute('data-preview-values'),detail.locator('[data-preview-values]').getAttribute('data-preview-unmatched')]);
 const leaseValues=await expectedValues('lease');
 eq(await markedValues(),leaseValues.values);
 assert.ok(leaseValues.values.length>=30);checks++;
 assert.ok(leaseValues.values.filter(([id])=>id==='tenant.names').length>=2);checks++;
 eq(leaseValues.values.some(([id,v])=>id==='rent.monthly' && /3,?100/.test(v)),true);
 eq(await valueCounts(),[String(leaseValues.values.length),'0']);
 assert.match(await detail.locator('[data-preview-values]').innerText(),/filled values are highlighted on this document\.$/);checks++;
 const rentTitle=await savedFrame.locator('mark.signing-value[data-field="rent.monthly"]').first().getAttribute('title');
 assert.ok(rentTitle && rentTitle!=='rent.monthly');checks++; // the field's own label, for the tooltip
 // Marks are paint only: no box that could move a word or an anchor.
 eq(await savedFrame.locator('#lease-doc').evaluate(host=>[...host.querySelectorAll('mark.signing-value')].every(m=>{const s=getComputedStyle(m);return s.paddingLeft==='0px' && s.paddingRight==='0px' && s.borderLeftWidth==='0px' && s.display==='inline';})),true);
 const leaseMarks=await savedFrame.locator('mark.signing-value').count();
 await page.locator('[data-lease-zoom="1"]').click();
 await page.locator('#lease-zoom-label').filter({hasText:'110%'}).waitFor();
 await savedFrame.locator('[data-signing-field="lease-38-1-initial"].current').waitFor();
 eq(await frameTop(),0);
 eq(await savedFrame.locator('mark.signing-value').count(),leaseMarks);
 eq(await savedFrame.locator('.signing-field-box').count(),10);
 await page.locator('[data-lease-zoom="-1"]').click();
 await page.locator('#lease-zoom-label').filter({hasText:'100%'}).waitFor();
 await page.screenshot({path:`${out}/filled-values-lease.png`,fullPage:true});
 // The marking itself, on a copy built by hand: a value the document set in
 // two runs gets one mark per run, fixed twins of a value stay plain, clearing
 // restores the text nodes, and a copy with a different paragraph count marks
 // nothing rather than guessing.
 const synthetic=await savedFrame.locator('#lease-doc').evaluate(async()=>{
  const {copyParagraphs,valueMarks,showValueMarks,clearValueMarks}=await import('/admin/signing-value-highlight.js');
  const host=document.createElement('div'),template=document.createElement('div');
  host.innerHTML='<section class="docx"><header><p>Page 1</p></header><article><p>Monthly rent is <span><b>$2,</b></span><span>500</span>  due on the 1st.</p><p>Tenant</p><p><span>Payable to </span><span>Tenant</span></p><p>$2,500</p><p>Deposit <span style="color:#fff">\\LEASE-R1-SIG\\</span>$2,500</p></article><footer><p>1</p></footer></section>';
  template.innerHTML='<section class="docx"><header><p>Page 1</p></header><article><p>Monthly rent is <span class="lease-slot" data-lease-slot="rent.monthly">$2,500</span> due on the 1st.</p><p>Tenant</p><p><span>Payable to </span><span class="lease-slot" data-lease-slot="utility.gas">Tenant</span></p><p><span class="lease-slot" data-lease-slot="deposit.amount">$2,500</span></p><p>Deposit <span class="lease-slot" data-lease-slot="deposit.amount">$2,500</span><span class="lease-slot is-empty" data-lease-slot="deposit.bank_name"></span></p></article><footer><p>1</p></footer></section>';
  const plan=valueMarks(copyParagraphs(template,[{id:'lease',starts:'Monthly rent'}],'lease'),{labelOf:id=>id.toUpperCase()});
  const before=host.textContent,result=showValueMarks(host,plan);
  const marks=[...host.querySelectorAll('mark.signing-value')].map(m=>[m.dataset.field,m.dataset.signingValue,m.textContent,m.title]);
  const plain=[...host.querySelectorAll('p')].filter(p=>!p.querySelector('mark')).map(p=>p.textContent);
  const same=host.textContent===before;
  clearValueMarks(host);
  const restored=host.textContent===before && !host.querySelector('mark') && host.querySelector('article p').childNodes.length===4;
  host.querySelector('article').append(document.createElement('p'));
  return {count:plan.count,contexts:plan.marks.map(m=>m.context),result,marks,plain,same,restored,refused:showValueMarks(host,plan)};
 });
 eq(synthetic,{count:5,contexts:['Monthly rent is $2,500 due on the 1st.','Payable to Tenant','$2,500','Deposit $2,500'],result:{marked:4,unmatched:0},
  marks:[['rent.monthly','1','$2,','RENT.MONTHLY'],['rent.monthly','1','500','RENT.MONTHLY'],['utility.gas','2','Tenant','UTILITY.GAS'],['deposit.amount','3','$2,500','DEPOSIT.AMOUNT'],['deposit.amount','4','$2,500','DEPOSIT.AMOUNT']],
  plain:['Page 1','Tenant','1'],same:true,restored:true,refused:{marked:0,unmatched:4}});
 let twins=0,empties=0;
 await page.screenshot({path:`${out}/signing-fields-38.png`,fullPage:true});
 await detail.locator('[data-preview-signing-fields="lease-39-1-initial"]').click();
 await savedFrame.locator('[data-signing-field="lease-39-1-initial"].current').waitFor();
 await page.screenshot({path:`${out}/signing-fields-39.png`,fullPage:true});
 await detail.locator('[data-preview-signing-fields="lease-1-signature"]').click();
 await savedFrame.locator('[data-signing-field="lease-1-signature"].current').waitFor();
 eq(await currentInView(),true);assert.ok(await frameTop()>0);checks++;
 eq(await savedFrame.locator('[data-signing-field="lease-3-full_name"]').innerText(),owner.name);
 await page.screenshot({path:`${out}/signing-fields-47.png`,fullPage:true});
 // Every rider opens its own copy with its original tenant/landlord lines and navigation.
 for(const layout of ['utilities','packages','keys','insurance','rules','fines']){
  await panel.locator(`[data-ws-doc="${layout}"]`).click();
  await savedFrame.locator(`[data-signing-field="${layout}-1-signature"].current`).waitFor();
  eq(await savedFrame.locator('.signing-field-box').count(),6);
  eq(await savedFrame.locator('.signing-field-box[data-kind="initial"]').count(),0);
  const riderValues=await expectedValues(layout);
  eq(await markedValues(),riderValues.values);eq(await valueCounts(),[String(riderValues.values.length),'0']);
  twins+=await plainTwins();empties+=riderValues.empty;
  if(layout==='utilities')await page.screenshot({path:`${out}/filled-values-utilities.png`,fullPage:true});
  eq(await savedFrame.locator(`[data-signing-field="${layout}-3-full_name"]`).innerText(),owner.name);
  eq(await frameTop(),0);
  eq(await detail.evaluate(el=>el.previousElementSibling?.getAttribute('data-ws-doc')),layout);
  eq(await page.locator('#lease-doc-name').innerText(),({utilities:'Utilities Rider',packages:'Packages Rider',keys:'Key Rider',insurance:'Renters Insurance Rider',rules:'Community Rules Rider',fines:'Fine Schedule'})[layout]);
  await detail.locator(`[data-preview-signing-fields="${layout}-3-signature"]`).click();
  await savedFrame.locator(`[data-signing-field="${layout}-3-signature"].current`).waitFor();
  eq(await currentInView(),true);
  await page.screenshot({path:`${out}/signing-fields-${layout}.png`,fullPage:true});
 }
 eq(await detail.locator('[data-preview-layout]').allTextContents(),[]);
 // Switching quickly settles on the last document only.
 await panel.locator('[data-ws-doc="utilities"]').click();
 await panel.locator('[data-ws-doc="packages"]').click();
 await savedFrame.locator('[data-signing-field="packages-1-signature"].current').waitFor();
 await page.getByText('Packages Rider · Signing field preview only. Nothing has been sent.',{exact:true}).waitFor();
 eq(await savedFrame.locator('[data-signing-field^="utilities-"]').count(),0);
 eq(await markedValues(),(await expectedValues('packages')).values);
 eq(await savedFrame.locator('mark.signing-value[data-field^="utility."]').count(),0);
 eq(await detail.evaluate(el=>el.previousElementSibling?.getAttribute('data-ws-doc')),'packages');
 eq(await page.locator('#lease-doc-name').innerText(),'Packages Rider');
 // Fields are drawn on the anchor tokens the saved document carries, so a
 // signer the package was not prepared for cannot be previewed into it.
 await panel.locator('[data-ws-doc="fines"]').click();
 await savedFrame.locator('[data-signing-field="fines-1-signature"].current').waitFor();
 const slotCheck=await savedFrame.locator('#lease-doc').evaluate(async host=>{
  const {showSigningFields,clearSigningFields}=await import('/admin/signing-field-preview.js');
  const doc=await import('/admin/lease-doc.js');doc.showSections(null);
  const tenants=Array.from({length:8},(_,i)=>({recipientId:String(i+1),role:'tenant',name:`Tenant ${i+1}`,email:`tenant-${i+1}@example.test`}));
  const signers=[...tenants,{recipientId:'9',role:'landlord',name:'Landlord',email:'landlord@example.test'}];
  let refused='';
  try{showSigningFields(host,signers,'fines-8-full_name','fines',{standalone:true});}catch(error){refused=error.message;}
  const tokens=[...host.querySelectorAll('section.docx span')].filter(s=>/^\\FINES-R\d+-(SIG|NAME)\\$/.test(s.textContent));
  const tiny=tokens.every(s=>parseFloat(getComputedStyle(s).fontSize)<4 && getComputedStyle(s).color==='rgb(255, 255, 255)');
  clearSigningFields();return [refused.includes('anchors'),tokens.length,tiny];
 });
 eq(slotCheck,[true,6,true]);
 // A tenant's own notice carries that tenant's details where the household's print.
 const copyOverrides=recipientId=>{const s=savedPackage.record.package.signers.find(x=>x.recipientId===recipientId),r=fixture.state.applications.find(a=>a.id===s.memberId);return {'tenant.names':s.name,'tenant.email':s.email,'tenant.mailing_address':r?.current_address || ''};};
 for(const layout of ['window_guards','bedbug','sprinkler','allergen','alarms','smoking','concession','dhcr','good_cause']){
  await panel.locator(`[data-ws-doc="${layout}"]`).click();
  const recipient=layout==='allergen'?'3':'1';
  await savedFrame.locator(`[data-signing-field="${layout}-${recipient}-signature"].current`).waitFor();
  eq(await frameTop(),0);
  const individual=['window_guards','bedbug','dhcr'].includes(layout);
  const noticeValues=await expectedValues(layout,{overrides:individual?copyOverrides('1'):{}});
  eq(await markedValues(),noticeValues.values);eq(await valueCounts(),[String(noticeValues.values.length),'0']);
  twins+=await plainTwins();empties+=noticeValues.empty;
  eq(await savedFrame.locator('.signing-field-box').count(),({window_guards:2,bedbug:4,allergen:3,dhcr:4})[layout] || 6);
  eq(await savedFrame.locator('.signing-field-box[data-kind="date_signed"]').count(),({window_guards:1,bedbug:2,allergen:1,dhcr:2})[layout] || 0);
  if(layout==='bedbug')eq(await savedFrame.locator('.signing-field-box[data-kind="date_signed"]').first().evaluate(el=>getComputedStyle(el).borderTopStyle),'dashed');
  eq(await detail.locator('[data-preview-tenant]').count(),['window_guards','bedbug','dhcr'].includes(layout)?2:0);
  for(const button of await detail.locator('[data-preview-signing-fields]').all()){
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
   await detail.locator('[data-preview-tenant="2"]').click();
   await savedFrame.locator(`[data-signing-field="${layout}-2-signature"].current`).waitFor();
   eq(await frameTop(),0);
   eq(await savedFrame.locator('.signing-field-box[data-recipient="1"]').count(),0);
   eq(await savedFrame.locator(`[data-signing-field="${layout}-2-signature"]`).innerText(),'T2 · Signature');
   assert.match(await savedFrame.locator('#lease-doc').innerText(),/Applicant E/);checks++;
   const twinValues=await expectedValues(layout,{overrides:copyOverrides('2')});
   eq(await markedValues(),twinValues.values);eq(await valueCounts(),[String(twinValues.values.length),'0']);
   eq(twinValues.values.some(([id,v])=>id==='tenant.names' && v==='Applicant E'),true);
   if(layout==='dhcr')await page.screenshot({path:`${out}/filled-values-dhcr-tenant-2.png`,fullPage:true});
   await detail.locator('[data-preview-tenant="1"]').click();
   await savedFrame.locator(`[data-signing-field="${layout}-1-signature"].current`).waitFor();
   eq(await markedValues(),noticeValues.values);
  }
 }
 assert.ok(twins>0);checks++; // fixed twins of a marked value exist and stay plain
 assert.ok(empties>0);checks++; // some fields print nothing, and got no mark
 // E-sign Recipients keeps the signing order and DocuSign status only.
 await panel.getByRole('tab',{name:'E-sign Recipients',exact:true}).click();
 eq(await panel.locator('.ws-signer').count(),3);
 eq(await panel.locator('.ws-signing-preview,.ws-signing-targets,[data-signing-layout],[data-preview-signing-fields]').count(),0);
 // Reopening Documents shows the selected document's fields again.
 await panel.getByRole('tab',{name:'Documents',exact:true}).click();
 await detail.locator('[data-preview-status="ready"]').waitFor();
 eq(await detail.evaluate(el=>el.previousElementSibling?.getAttribute('data-ws-doc')),'good_cause');
 eq(await markedValues(),(await expectedValues('good_cause')).values);
 // A copy that fails to load says so under the document and can be retried.
 const partPattern='**/api/admin/cases/*/signing?package=*&file=source&document=*';
 await page.route(partPattern,route=>route.fulfill({status:503,contentType:'text/plain',body:'unavailable'}));
 await panel.locator('[data-ws-doc="keys"]').click();
 await detail.locator('[data-preview-status="error"]').waitFor();
 eq(await savedFrame.locator('.signing-field-box').count(),0);
 await page.unroute(partPattern);
 await detail.getByRole('button',{name:'Try Again',exact:true}).click();
 await savedFrame.locator('[data-signing-field="keys-1-signature"].current').waitFor();
 eq(await detail.locator('[data-preview-status]').getAttribute('data-preview-status'),'ready');
 await page.screenshot({path:`${out}/documents-signing-fields.png`,fullPage:true});
 for(const part of savedPackage.record.package.documents){
  if(part.tenantRecipientId && part.tenantRecipientId!=='1')continue;
  const response=await page.request.get(`${base}/api/admin/cases/${ids.b}/signing?package=${savedPackage.id}&file=source&document=${part.documentId}`);
  const bytes=await response.body();await writeFile(`${out}/signing-${part.layout}.docx`,bytes);
  // Marking is paint on the screen only: the saved copy's bytes are what they were.
  eq(createHash('sha256').update(bytes).digest('hex'),part.file.sha256);
 }
 await page.getByRole('button',{name:'View All Documents',exact:true}).click();
 await savedFrame.locator('#lease-doc').filter({hasText:'LEASE ONLY CORRECTION'}).waitFor();
 eq(await savedFrame.locator('mark.signing-value').count(),0);
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
 eq(packages.size,4); // The reviewed package is reused after navigating back.
 await panel.getByRole('tab',{name:'Documents',exact:true}).click();
 await panel.locator('[data-ws-doc="smoking"]').click();
 await savedFrame.locator('[data-signing-field="smoking-1-signature"].current').waitFor();
 eq(packages.size,4);
 await panel.getByRole('tab',{name:'Lease Information',exact:true}).click();
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
 // With unsaved corrections the document still opens; its signing fields wait for a saved, approved lease.
 await panel.getByRole('tab',{name:'Documents',exact:true}).click();
 await panel.locator('[data-ws-doc="lease"]').click();
 eq(await detail.locator('[data-preview-status]').getAttribute('data-preview-status'),'unavailable');
 assert.match(await detail.locator('[data-preview-status]').innerText(),/Save your corrections/);checks++;
 eq(await page.locator('iframe[title="Lease for Signing"]').count(),0);
 eq(await page.locator('#lease-doc-name').innerText(),'New York Residential Lease Agreement');
 eq(await page.locator('#lease-doc section.docx:not([data-doc-hidden])').count()>0,true);
 await panel.getByRole('tab',{name:'Lease Information',exact:true}).click();
 await reviewedRent.locator(':scope > summary').click();
 await reviewedRent.locator('input').fill('3100');await reviewedRent.getByRole('button',{name:'Done',exact:true}).click();
 // A rider without signing fields shows its content and says so, drawing nothing.
 const signingPattern='**/api/admin/cases/*/signing';
 await page.route(signingPattern,async route=>{if(route.request().method()!=='POST')return route.fallback();const response=await route.fetch();const body=await response.json();if(body.signing?.values)body.signing.values['concession.terms']='';await route.fulfill({response,json:body});});
 await panel.getByRole('tab',{name:'Documents',exact:true}).click();
 await panel.locator('[data-ws-doc="concession"]').click();
 await detail.locator('[data-preview-status="empty"]').waitFor();
 assert.match(await detail.locator('[data-preview-status]').innerText(),/No rent concession is specified/);checks++;
 await savedFrame.locator('section.docx:not([data-doc-hidden])').first().waitFor();
 eq(await savedFrame.locator('.signing-field-box').count(),0);
 eq(await detail.locator('[data-preview-signing-fields]').count(),0);
 eq(await page.locator('#lease-doc-name').innerText(),'Rent Concession Rider');
 // Its own copy is mounted and its filled values are still marked, with no box to draw.
 const concessionValues=await expectedValues('concession');
 eq(await markedValues(),concessionValues.values);eq(concessionValues.values.map(([id])=>id),['concession.terms']);
 eq(await valueCounts(),['1','0']);eq(await detail.locator('[data-preview-status]').getAttribute('data-preview-status'),'empty');
 await page.unroute(signingPattern);
 await page.screenshot({path:`${out}/documents-no-fields.png`,fullPage:true});
 // No send here: the isolated signing tests cover dispatch and confirmation.
 await panel.getByRole('tab',{name:'Lease Information',exact:true}).click();
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Lease Information',exact:true}).click();
 eq(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 await page.screenshot({path:`${out}/mobile.png`,fullPage:true});
 await page.setViewportSize({width:1600,height:1080});
 await login('agent-b@example.test');await page.goto(`${base}/admin/#/leases/${ids.b}`);await panel.getByRole('heading',{name:'Landlord & Signer',exact:true}).waitFor();
 eq(await panel.locator('[data-ws-row="landlord.address"] input').count(),0);
 eq(await panel.locator('[data-ws-row="rent.monthly"] input').count(),1);
 // Delayed dispatch must update the open review without recreating its document.
 const reserved=[...packages.values()].at(-1);reserved.reserved=true;
 reserved.record.phase='preparing';reserved.record.updatedAt=new Date().toISOString();
 row.workspace.signing={package_id:reserved.id,phase:'preparing'};row.workspace_version++;
 await page.goto(`${base}/admin/#/applications`);await page.goto(`${base}/admin/#/leases/${ids.b}`);
 await page.locator('#lease-final').filter({hasText:'View Signing Status'}).waitFor();
 await page.locator('#lease-final').click();
 await panel.getByText('Queued for DocuSign.',{exact:false}).waitFor();
 eq(await panel.locator('.signing-steps [aria-current="step"]').textContent(),'Uploaded');
 await page.locator('#lease-review-feedback').filter({hasText:'Status checked at'}).waitFor();checks++;
 eq(await page.locator('#lease-bar').getByText('Preparing to send',{exact:true}).count(),1);
 await page.evaluate(()=>window.reviewDocument=document.querySelector('.lease-pane-doc'));
 reserved.record.phase='sending';reserved.record.updatedAt=new Date().toISOString();
 await panel.getByText('Sending invitations',{exact:true}).waitFor({timeout:15000});checks++;
 reserved.record.phase='in_progress';reserved.record.updatedAt=new Date().toISOString();
 reserved.record.envelope={envelopeId:'test-envelope',recipients:reserved.record.package.signers.map(s=>({recipientId:s.recipientId,status:s.role==='tenant'?'sent':'pending'}))};
 await panel.getByText('Signatures in progress',{exact:true}).waitFor({timeout:15000});checks++;
 eq(await page.evaluate(()=>window.reviewDocument===document.querySelector('.lease-pane-doc')),true);
 eq(await panel.getByText('Invitation Sent',{exact:true}).count(),reserved.record.package.signers.filter(s=>s.role==='tenant').length);
 eq(await panel.getByText('Waiting for all tenants',{exact:true}).count(),1);
 const failedStatus='**/api/admin/cases/*/signing';
 await page.route(failedStatus,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Status temporarily unavailable'})}));
 await page.locator('#lease-final').click();
 await page.locator('#lease-review-feedback').filter({hasText:'Unable to refresh signing status'}).waitFor();checks++;
 eq(await page.locator('#lease-final').isEnabled(),true);
 await page.unroute(failedStatus);await page.locator('#lease-final').click();
 await page.locator('#lease-review-feedback').filter({hasText:'Status checked at'}).waitFor();checks++;
 await page.screenshot({path:`${out}/signing-status.png`,fullPage:true});
 eq(errors,[]);console.log(`PASS ${checks} lease review UI checks: compact groups, exact household recipients, document navigation, per-document signing fields, local edits, approval reset, lease-only saves, preview and mobile`);
}finally{if(process.env.DEBUG_REVIEW)console.log((await page.locator('body').innerText()).slice(-3500));await browser.close();await new Promise(r=>server.close(r));await Promise.allSettled(pending);restore();}
