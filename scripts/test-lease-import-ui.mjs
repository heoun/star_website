// Real browser -> real Worker -> isolated fixtures, never production data.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import worker from '../worker/index.js';
import {readEntries,replaceEntry} from '../worker/zip.js';
import {ids} from '../backend/tools/workspace-fixtures.mjs';
import {createIdentityFixture} from './identity-fixtures.mjs';
import {source} from './test-lease-import.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {env,fixture,restore}=createIdentityFixture(), root=resolve('dist');
fixture.state.settings[ids.property]={'fee.returned_payment':'$45.00','manager.name':'Existing Manager'};
const original=structuredClone(fixture.state.settings[ids.property]),other=structuredClone(fixture.state.settings[ids.otherProperty]);
const requests=[]; let loseCreationReply=false;
env.ASSETS={async fetch(request){
 const path=new URL(request.url).pathname,file=resolve(root,`.${path}${path.endsWith('/')?'index.html':''}`);
 if(!file.startsWith(`${root}/`))return new Response(null,{status:404});
 try{return new Response(await readFile(file),{headers:{'Content-Type':({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream'}});}catch{return new Response(null,{status:404});}
}};
const pending=[],server=http.createServer(async(req,res)=>{
 try{const chunks=[];for await(const c of req)chunks.push(c);const response=await worker.fetch(new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})}),env,{waitUntil:p=>pending.push(p)});if(loseCreationReply && req.method==='POST' && req.url==='/api/admin/buildings' && response.ok){loseCreationReply=false;res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Synthetic lost creation reply'}));return;}res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(error){res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
const artifacts=process.env.IMPORT_UI_ARTIFACTS || '/tmp/star-lease-import-ui';await mkdir(artifacts,{recursive:true});
page.setDefaultTimeout(15000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',req=>requests.push({url:req.url(),method:req.method()}));
let checks=0;const equal=(a,b)=>{assert.deepEqual(a,b);checks++;};
const login=async(email)=>{await page.goto(`${base}/login/`);await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill('testing-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL('**/admin/**');};
const open=async(method='lease')=>{await page.goto(`${base}/admin/#/properties`);await page.getByRole('button',{name:'New property',exact:true}).click();await page.getByRole('dialog').waitFor();equal(await page.locator('#lease-import-file').isVisible(),false);equal(await page.locator('[data-new-property-form]').count(),0);equal(await page.locator('[data-import-save]').isVisible(),false);if(method)await page.getByRole('button',{name:method==='manual'?'Enter Manually':'Autoread from a Previous Lease',exact:true}).click();};
const go=async id=>page.locator(`[data-draft-step="${id}"]`).click();
const fillProperty=async(name='Imported property')=>{await go('property');const form=page.locator('[data-new-property-form]');await form.getByLabel('Property name',{exact:true}).fill(name);await form.getByLabel('Street',{exact:true}).fill('10 Example Road');await form.getByLabel('City',{exact:true}).fill('New York');await form.getByLabel('State',{exact:true}).fill('NY');await form.getByLabel('ZIP code',{exact:true}).fill('10001');await go('signing');await page.locator('[name="landlord_signer_email"]').fill('signer@example.test');};
const template=await readFile('lease/template/lease-template.docx');
const docxFrom=async text=>Buffer.from(await replaceEntry(readEntries(template.buffer.slice(template.byteOffset,template.byteOffset+template.byteLength)),'word/document.xml',`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.split('\n').map(line=>`<w:p><w:r><w:t xml:space="preserve">${line.replaceAll('&','&amp;').replaceAll('<','&lt;')}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`));
const docx=await docxFrom(source);
const drop=async files=>{
 const transfer=await page.evaluateHandle(items=>{const dt=new DataTransfer();for(const item of items)dt.items.add(new File([new Uint8Array(item.bytes)],item.name,{type:item.type}));return dt;},files.map(f=>({...f,bytes:Array.from(f.bytes)})));
 try {
  const zone=page.locator('.import-upload');await zone.dispatchEvent('dragenter',{dataTransfer:transfer});
  equal(await zone.evaluate(el=>el.classList.contains('is-dragover')),true);
  await zone.dispatchEvent('dragover',{dataTransfer:transfer});
  await page.screenshot({path:`${artifacts}/lease-drop-highlight.png`});
  await zone.dispatchEvent('drop',{dataTransfer:transfer});
  equal(await zone.evaluate(el=>el.classList.contains('is-dragover')),false);
 } finally {await transfer.dispose();}
};
const value=id=>page.locator(`[data-import-value="${id}"]`);
function pdf(text){
 const stream=`BT /F1 12 Tf 50 750 Td (${text.replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)')}) Tj ET`;
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];let out='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}const xref=Buffer.byteLength(out);out+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(out);
}
try{
 await login('admin@example.test');await open();
 await drop([{name:'notes.txt',type:'text/plain',bytes:Buffer.from('not a lease')}]);
 await page.getByText('Choose a PDF or DOCX lease.',{exact:true}).waitFor();
 await drop([{name:'one.pdf',type:'application/pdf',bytes:pdf('First lease')},{name:'two.pdf',type:'application/pdf',bytes:pdf('Second lease')}]);
 await page.getByText('Drop one PDF or DOCX lease at a time.',{exact:true}).waitFor();
 equal(fixture.state.buildings.length,2);
 await drop([{name:'example-lease.docx',type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:docx}]);
 await page.locator('.import-summary').waitFor();
 equal(await value('landlord.entity_name').inputValue(),'Example Holdings LLC');equal(await value('fee.returned_payment').inputValue(),'$25.00');
 // No selection column: what the form holds is what the new property gets.
 equal(await page.locator('[data-import-select]').count(),0);equal(await page.getByRole('button',{name:'Select Detected Fields',exact:true}).count(),0);
 // One paired choice shows one source; optional rows say so; a spare Other utility parks at N/A until it is named.
 equal(await page.locator('tr.draft-pair:has([data-import-pair="insurance.required_yes"]) details.import-source').count(),1);
 equal(await page.locator('tr.draft-pair:has([data-import-pair="insurance.required_yes"]) .import-detected').count(),1);
 equal(await page.locator('[data-import-row="utility.other1_label"] .import-muted').textContent(),'Optional');
 equal(await value('utility.other1').inputValue(),'N/A');
 await go('utilities');await value('utility.other1_label').fill('Bicycle storage');equal(await value('utility.other1').inputValue(),'');
 await value('utility.other1_label').fill('');equal(await value('utility.other1').inputValue(),'N/A');
 // A typed value is saved as entered; a cleared one is left unset.
 await go('payments');await value('guest.consecutive_days').fill('4');
 equal(fixture.state.settings[ids.property],original);equal(fixture.state.buildings.length,2);
 await page.screenshot({path:`${artifacts}/new-property-review.png`,fullPage:true});
 await fillProperty();await go('payments');await value('fee.returned_payment').fill('35');await go('management');await value('manager.name').fill('');await go('payments');
 await page.locator('[data-import-row="fee.returned_payment"]').scrollIntoViewIfNeeded();await page.screenshot({path:`${artifacts}/new-property-table.png`});
 await page.getByRole('button',{name:'Fill these in on the document',exact:true}).click();
 const importedFrame=page.frameLocator('iframe[title="New property lease defaults"]');
 // The document opens on a required blank, names required blanks and prints optional ones as blank lines.
 await importedFrame.locator('#draft-field').waitFor();
 equal(await importedFrame.locator('label[for="draft-field"] .required-mark').count(),1);
 equal(await importedFrame.locator('[data-lease-slot="utility.other1_label"]').first().evaluate(el=>[el.textContent,el.classList.contains('is-empty')]),['',true]);
 equal((await importedFrame.locator('[data-lease-slot="deposit.bank_name"]').first().textContent()).startsWith('«'),true);
 await importedFrame.getByLabel('Edit Field',{exact:true}).selectOption('utility.other1_label');
 equal(await importedFrame.locator('label[for="draft-field"] .optional-mark').textContent(),'Optional');
 await importedFrame.getByLabel('Edit Field',{exact:true}).selectOption('fee.returned_payment');
 equal(await importedFrame.locator('#draft-field').inputValue(),'35');
 await importedFrame.getByLabel('Edit Field',{exact:true}).selectOption('manager.name');
 equal(await importedFrame.locator('#draft-field').inputValue(),'');
 await page.getByRole('button',{name:'Back to Form',exact:false}).click();
 await go('good_cause');await page.locator('[data-import-confirm]').check();loseCreationReply=true;
 await page.getByRole('button',{name:'Create property',exact:true}).click();
 await page.getByRole('button',{name:'Retry creation',exact:true}).waitFor();
 equal(fixture.state.buildings.length,3);equal(fixture.state.settings[ids.property],original);
 // Reload after a lost response must retain the original idempotency token.
 await page.reload();await open(null);await page.getByRole('button',{name:'Continue Draft',exact:true}).click();
 await page.getByRole('button',{name:'Retry creation',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
 const created=fixture.state.buildings.find(row=>row.name==='Imported property');assert(created);checks++;
 equal(fixture.state.buildings.length,3);equal(fixture.state.settings[created.id]['fee.returned_payment'],'$35.00');equal(fixture.state.settings[created.id]['manager.name'],undefined);equal(fixture.state.settings[created.id]['guest.consecutive_days'],'4');equal(fixture.state.settings[created.id]['utility.other1'],'N/A');equal(fixture.state.settings[created.id]['utility.other1_label'],undefined);equal(fixture.state.settings[created.id]['insurance.required_no'],false);equal(fixture.state.settings[ids.otherProperty],other);
 equal(fixture.state.settings[created.id]['tenant.names'],undefined);equal(fixture.state.settings[ids.property],original);
 await page.waitForURL(`**/admin/#/properties/${created.id}`);await page.reload();await page.locator('#property-defaults').waitFor();equal(await page.locator('[data-property-import]').count(),0);
 await page.locator('[data-property-step="payments"]').first().click();await page.getByText('$35.00',{exact:true}).waitFor();checks++;
 // PDF reader executes in a real browser worker; nothing is persisted on cancel.
 await open();await drop([{name:'sample.pdf',type:'application/pdf',bytes:pdf('Landlord legal entity: PDF Example Holdings LLC')}]);await page.locator('.import-summary').waitFor();equal(await value('landlord.entity_name').inputValue(),'PDF Example Holdings LLC');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${artifacts}/new-property-mobile.png`,fullPage:true});equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await go('signing');await page.locator('[data-import-row="landlord.entity_name"]').scrollIntoViewIfNeeded();await page.screenshot({path:`${artifacts}/new-property-mobile-table.png`});
 await page.getByRole('button',{name:'Close lease import'}).click();equal(fixture.state.buildings.length,3);
 await page.setViewportSize({width:1440,height:1000});await open();
 await page.locator('#lease-import-file').setInputFiles({name:'broken.pdf',mimeType:'application/pdf',buffer:Buffer.from('Not a PDF')});await page.locator('.import-message[data-tone="error"]').waitFor();equal(await page.locator('[data-import-save]').isDisabled(),true);await page.getByRole('button',{name:'Close lease import'}).click();
 await open();await page.locator('#lease-import-file').setInputFiles({name:'scan.pdf',mimeType:'application/pdf',buffer:pdf('')});await page.locator('.import-message[data-tone="error"]').waitFor();equal((await page.locator('.import-message').textContent()).includes('No readable lease text'),true);await page.getByRole('button',{name:'Close lease import'}).click();
 if(process.env.LEASE_IMPORT_SAMPLE){await open();await page.locator('#lease-import-file').setInputFiles(process.env.LEASE_IMPORT_SAMPLE);await page.locator('.import-summary').waitFor();const detected=await page.locator('.import-summary h3').textContent();assert(!detected.startsWith('0 '));checks++;equal(await page.locator('[name="street"]').inputValue(),'81-07 Kew Gardens Road');console.log(`Source file review: ${detected}`);await page.screenshot({path:`${artifacts}/source-new-property.png`,fullPage:true});await page.getByRole('button',{name:'Close lease import'}).click();}
 // Preserve role columns; one building written two ways is one address, two buildings are a review.
 await open();
 const paragraph=text=>`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
 const cell=text=>`<w:tc>${paragraph(text)}</w:tc>`;
 const tableXml=propertyLine=>`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph('Residential Lease Agreement')}${paragraph('Tenant Names: ______')}${paragraph('Address: 10-20 Garden Road, Queens, NY 11415')}${paragraph(propertyLine)}<w:tbl><w:tr>${cell('Property Manager')}${cell('Landlord')}</w:tr><w:tr>${cell('Name: Management LLC')}${cell('Name: Owner LLC')}</w:tr><w:tr>${cell('Address: 20 Office Avenue, Queens, NY 11101')}${cell('Address: 30 Owner Road, Brooklyn, NY 11201')}</w:tr></w:tbl><w:tbl><w:tr>${cell('NSF Fee')}${cell('$45')}</w:tr></w:tbl></w:body></w:document>`;
 const layoutDoc=async propertyLine=>Buffer.from(await replaceEntry(readEntries(template.buffer.slice(template.byteOffset,template.byteOffset+template.byteLength)),'word/document.xml',tableXml(propertyLine)));
 const uploadLayout=async propertyLine=>{await page.locator('#lease-import-file').setInputFiles({name:'different-layout.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:await layoutDoc(propertyLine)});await page.locator('.import-summary').waitFor();};
 await uploadLayout('Property Address: 1020 Garden Road, Queens, NY 11415');
 equal(await page.locator('[name="street"]').inputValue(),'10-20 Garden Road');
 equal(await page.locator('[name="city"]').inputValue(),'Queens');
 equal(await page.locator('[data-import-address]').count(),1);
 equal(await value('manager.address').inputValue(),'20 Office Avenue, Queens, NY 11101');
 equal(await value('landlord.address').inputValue(),'30 Owner Road, Brooklyn, NY 11201');
 equal(await value('fee.returned_payment').inputValue(),'$45.00');
 await page.getByRole('button',{name:'Close lease import'}).click();
 await open();await uploadLayout('Property Address: 30 Other Road, Queens, NY 11415');
 equal(await page.locator('[name="street"]').inputValue(),'');
 equal(await page.locator('[data-import-address]').count(),2);
 await page.locator('.import-address-evidence div').filter({has:page.locator('b',{hasText:'10-20 Garden Road'})}).getByRole('button').click();
 equal(await page.locator('[name="street"]').inputValue(),'10-20 Garden Road');
 equal(await page.locator('[name="city"]').inputValue(),'Queens');
 await page.getByRole('button',{name:'Close lease import'}).click();
 // Two readings of one setting start blank and are chosen from the listed sources.
 await open();await page.locator('#lease-import-file').setInputFiles({name:'conflict.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:await docxFrom(`${source}\nLandlord legal entity: Different Holdings LLC\n`)});await page.locator('.import-summary').waitFor();
 equal(await value('landlord.entity_name').inputValue(),'');equal(await page.locator('[data-import-row="landlord.entity_name"] .import-flag').count(),1);
 await go('signing');assert((await page.locator('[data-import-choice="landlord.entity_name"]').count())>=2);checks++;
 await page.locator('[data-import-row="landlord.entity_name"] .import-source > div').filter({has:page.locator('b',{hasText:'Different Holdings LLC'})}).getByRole('button').click();
 equal(await value('landlord.entity_name').inputValue(),'Different Holdings LLC');equal(await page.locator('[data-import-row="landlord.entity_name"] .import-flag').count(),0);
 await page.getByRole('button',{name:'Close lease import'}).click();
 // Manual creation remains available without forcing a lease upload.
 await open('manual');equal(await page.locator('#lease-import-file').isVisible(),false);equal(await page.getByRole('button',{name:'Change Lease',exact:true}).count(),0);await fillProperty('Manual property');
 const signer=page.locator('[name="landlord_signer_email"]');equal(await signer.getAttribute('required'),'');
 await signer.fill('');await go('good_cause');await page.locator('[data-import-confirm]').check();await page.getByRole('button',{name:'Create property',exact:true}).click();equal(fixture.state.buildings.length,3);await signer.fill('signer@example.test');
 await page.getByRole('button',{name:'Expand New Property',exact:true}).click();
 equal(await page.locator('dialog.property-import').evaluate(el=>{const r=el.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height),Math.round(r.x),Math.round(r.y)];}),[1440,1000,0,0]);
 await page.getByRole('button',{name:'Collapse New Property',exact:true}).click();
 equal(await page.locator('dialog.property-import').evaluate(el=>el.getBoundingClientRect().width<innerWidth),true);
 await go('management');await value('manager.name').fill('Manual Property Manager');
 const beforeDraft=requests.filter(r=>r.method==='POST' && r.url.endsWith('/api/admin/buildings')).length;
 await page.getByRole('button',{name:'Fill these in on the document',exact:true}).click();
 equal(await page.locator('dialog.property-import').evaluate(el=>{const r=el.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)];}),[1440,1000]);
 const frame=page.frameLocator('iframe[title="New property lease defaults"]');
 await frame.locator('[data-lease-slot="manager.name"]').first().getByText('Manual Property Manager',{exact:true}).waitFor();
 await frame.locator('#draft-field').waitFor();
 equal(await frame.getByLabel('Edit Field',{exact:true}).inputValue(),'landlord.entity_name');
 equal(await frame.getByRole('button',{name:'Previous Field',exact:true}).isDisabled(),true);
 await frame.getByRole('button',{name:'Next Field',exact:true}).click();
 assert.notEqual(await frame.getByLabel('Edit Field',{exact:true}).inputValue(),'landlord.entity_name');checks++;
 await frame.getByRole('button',{name:'Previous Field',exact:true}).click();
 equal(await frame.getByLabel('Edit Field',{exact:true}).inputValue(),'landlord.entity_name');
 const tenantSlot=frame.locator('[data-lease-slot="tenant.names"]').first();
 equal(await tenantSlot.getAttribute('data-editable'),null);
 equal(await tenantSlot.getAttribute('data-source-field'),'Application Form');
 equal((await tenantSlot.textContent()).includes('Application Form'),true);
 equal(await frame.locator('[data-lease-slot="property.unit"]').first().getAttribute('data-source-field'),'Listing');
 equal(await frame.locator('[data-lease-slot="deposit.amount"]').first().getAttribute('data-source-field'),'Lease Preparation');
 equal(await frame.locator('.document-purpose').isVisible(),true);

 await frame.getByLabel('Edit Field',{exact:true}).selectOption('property.street');
 equal(await frame.locator('#draft-field').inputValue(),'10 Example Road');
 await frame.locator('#draft-field').fill('20 Document Road');
 await page.waitForFunction(()=>document.querySelector('[name="street"]')?.value==='20 Document Road');
 await frame.getByLabel('Edit Field',{exact:true}).selectOption('landlord_signer_email');
 equal(await frame.locator('#draft-field').inputValue(),'signer@example.test');
 await frame.locator('#draft-field').fill('document-signer@example.test');
 await page.waitForFunction(()=>document.querySelector('[data-import-value="owner_rep.email"]')?.value==='document-signer@example.test');
 await frame.getByLabel('Edit Field',{exact:true}).selectOption('insurance.required_no');
 await frame.locator('#draft-field').selectOption('true');
 await page.waitForFunction(()=>document.querySelector('[data-import-pair="insurance.required_yes"]')?.value==='no');
 equal(await value('insurance.required_yes').inputValue(),'false');
 await frame.getByLabel('Edit Field',{exact:true}).selectOption('landlord.phone');
 await frame.locator('#draft-field').fill('212-555-0199');
 await page.waitForFunction(()=>document.querySelector('[data-import-value="landlord.phone"]')?.value==='212-555-0199');
 await frame.locator('[data-lease-slot="manager.name"][data-editable]').first().click();
 await frame.getByLabel('Property manager — name',{exact:true}).fill('Draft Property Manager');
 // Live edits sync without a separate submit click.
 await page.waitForFunction(()=>document.querySelector('[data-import-value="manager.name"]')?.value==='Draft Property Manager');
 equal(await value('manager.name').inputValue(),'Draft Property Manager');
 equal(requests.filter(r=>r.method==='POST' && r.url.endsWith('/api/admin/buildings')).length,beforeDraft);
 await page.screenshot({path:`${artifacts}/new-property-document.png`,fullPage:true});
 await page.setViewportSize({width:390,height:844});
 equal(await page.locator('dialog.property-import').evaluate(el=>{const r=el.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)];}),[390,844]);
 equal(await frame.locator('body').evaluate(el=>el.scrollWidth<=innerWidth),true);
 await page.screenshot({path:`${artifacts}/new-property-document-mobile.png`,fullPage:true});
 await page.setViewportSize({width:1440,height:1000});
 // Refresh directly from the document restores both values and the document view.
 await page.reload();await open(null);await page.getByRole('button',{name:'Continue Draft',exact:true}).click();
 await frame.locator('[data-lease-slot="manager.name"]').first().getByText('Draft Property Manager',{exact:true}).waitFor();
 equal(await page.locator('dialog.property-import').evaluate(el=>el.classList.contains('is-document-view')),true);
 await page.getByRole('button',{name:'Back to Form',exact:false}).click();
 equal(await value('manager.name').inputValue(),'Draft Property Manager');
 equal(await page.locator('[name="street"]').inputValue(),'20 Document Road');
 equal(await page.locator('[name="landlord_signer_email"]').inputValue(),'document-signer@example.test');
 equal(await page.locator('[data-draft-step][aria-current="step"]').getAttribute('data-draft-step'),'management');
 equal(await page.locator('dialog.property-import').evaluate(el=>el.getBoundingClientRect().width<innerWidth),true);
 await value('manager.name').fill('Final Property Manager');
 await page.getByRole('button',{name:'Fill these in on the document',exact:true}).click();
 await frame.locator('[data-lease-slot="manager.name"]').first().getByText('Final Property Manager',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Back to Form',exact:false}).click();
 // Close and reopen also keep the current section and manually typed progress.
 await page.getByRole('button',{name:'Close lease import'}).click();await open(null);
 await page.getByRole('button',{name:'Continue Draft',exact:true}).click();
 equal(await value('manager.name').inputValue(),'Final Property Manager');
 await go('signing');
 await value('landlord.signer_mailing_address').fill('123 Example Signer Lane');
 await value('landlord.phone').fill('212-555-0199');
 await go('good_cause');await page.locator('[data-import-confirm]').check();await page.getByRole('button',{name:'Create property',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});equal(fixture.state.buildings.length,4);

 equal(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('star.new-property.')).length),0);
 const manualProperty=fixture.state.buildings.find(b=>b.name==='Manual property');
 equal(fixture.state.settings[manualProperty.id]['manager.name'],'Final Property Manager');
 equal(fixture.state.settings[manualProperty.id]['insurance.required_yes'],false);
 equal(fixture.state.settings[manualProperty.id]['insurance.required_no'],true);
 equal(fixture.state.settings[manualProperty.id]['landlord.signer_mailing_address'],'123 Example Signer Lane');
 equal(fixture.state.settings[manualProperty.id]['landlord.phone'],'212-555-0199');
 await page.locator('.property-steps [data-property-step="signing"]').click();
 equal(await page.locator('[data-group-panel="signing"] [data-setting-row]').count(),6);
 await page.locator('[data-settings-edit="signing"]').click();
 await page.locator('[data-setting="landlord.phone"]').fill('212-555-0188');
 await page.locator('[data-settings-save="signing"]').click();
 await page.locator('[data-settings-edit="signing"]').waitFor();
 await page.reload();await page.locator('.property-steps [data-property-step="signing"]').click();
 equal((await page.locator('[data-setting-row="landlord.phone"]').textContent()).includes('212-555-0188'),true);
 equal((await page.locator('[data-setting-row="landlord.signer_mailing_address"]').textContent()).includes('123 Example Signer Lane'),true);
 const invalid=await page.evaluate(async id=>{const post=body=>fetch('/api/admin/buildings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(response=>response.status);return [await post({name:'Must not create',creation_token:crypto.randomUUID(),landlord_signer_email:'signer@example.test',initial_settings:{'tenant.names':'Private'}}),await post({name:'Must not overwrite',landlord_signer_email:'signer@example.test',building_id:id,creation_token:crypto.randomUUID(),initial_settings:{}})];},ids.property);equal(invalid,[422,422]);
 const emailRejections=await page.evaluate(async id=>{const request=(url,method,body)=>fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.status);return [await request('/api/admin/buildings','POST',{name:'Missing email'}),await request('/api/admin/buildings/'+id,'PATCH',{landlord_signer_email:''}),await request('/api/admin/buildings','POST',{name:'Invalid email',landlord_signer_email:'wrong'})];},ids.property);equal(emailRejections,[422,422,422]);equal(fixture.state.buildings.length,4);equal(fixture.state.settings[ids.property],original);
 for(const email of ['agent-a@example.test','owner@example.test','platform-owner@example.test']){
  await page.locator('[data-sign-out]').first().click();await page.waitForURL('**/login/');await login(email);await page.goto(`${base}/admin/#/properties`);await page.waitForTimeout(250);
  equal(await page.locator('[data-desk-new-property]').count(),0);
  const denied=await page.evaluate(async()=>{const response=await fetch('/api/admin/buildings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Unauthorized',creation_token:crypto.randomUUID(),initial_settings:{}})});return response.status;});equal(denied,403);
 }
 await page.route('**/api/portal/me',route=>route.fulfill({json:{email:'applicant@example.test'}}));
 let bedrooms=1;
 await page.route('**/data/property.json?*',route=>route.fulfill({json:{id:ids.listing,title:'Mock rental',bedrooms,price:'$3300',unit:'7C'}}));
 for(const n of [1,0,2]){
  bedrooms=n;await page.goto(`${base}/apply/?id=${ids.listing}`);await page.locator('#first_name').waitFor({state:n<2?'visible':'attached'});
  equal(await page.locator('#header-step').textContent(),`Rental Application · Step 1 of ${n<2?6:7}`);
  equal(await page.locator('.step-link[data-step="1"]').isVisible(),n>=2);
  if(n<2){equal(await page.locator('.step-link[data-step="2"] .step-index > span').textContent(),'1');equal(await page.locator('#step-back').isVisible(),false);await page.getByRole('button',{name:'Continue →',exact:true}).click();equal(await page.locator('#header-step').textContent(),'Rental Application · Step 1 of 6');}
  await page.screenshot({path:`${artifacts}/application-${n}-bedrooms.png`,fullPage:true});
 }
 equal(errors,[]);
 console.log(`PASS ${checks} new-property browser checks: file picker and drag/drop validation, fullscreen form/document, live two-way sync, tab draft recovery, upload/manual creation, safe retry, invalid fields, mobile and role permissions`);
} catch(error){await page.screenshot({path:`${artifacts}/failure.png`,fullPage:true});console.error(await page.locator('.import-message').allTextContents());throw error;}
finally{await context.close();await browser.close();await Promise.allSettled(pending);await new Promise(resolve=>server.close(resolve));restore();}
