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
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',req=>requests.push({url:req.url(),method:req.method()}));
let checks=0;const equal=(a,b)=>{assert.deepEqual(a,b);checks++;};
const login=async(email)=>{await page.goto(`${base}/login/`);await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill('testing-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL('**/admin/**');};
const open=async()=>{await page.goto(`${base}/admin/#/properties`);await page.getByRole('button',{name:'New property',exact:true}).click();await page.getByRole('dialog').waitFor();};
const fillProperty=async(name='Imported property')=>{const form=page.locator('[data-new-property-form]');await form.getByLabel('Property name',{exact:true}).fill(name);await form.getByLabel('Street',{exact:true}).fill('10 Example Road');await form.getByLabel('City',{exact:true}).fill('New York');await form.getByLabel('State',{exact:true}).fill('NY');await form.getByLabel('ZIP code',{exact:true}).fill('10001');};
const template=await readFile('lease/template/lease-template.docx');
const xml=`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${source.split('\n').map(line=>`<w:p><w:r><w:t xml:space="preserve">${line.replaceAll('&','&amp;').replaceAll('<','&lt;')}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
const docx=Buffer.from(await replaceEntry(readEntries(template.buffer.slice(template.byteOffset,template.byteOffset+template.byteLength)),'word/document.xml',xml));
const upload=()=>page.locator('#lease-import-file').setInputFiles({name:'example-lease.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:docx});
const select=id=>page.locator(`[data-import-select="${id}"]`),value=id=>page.locator(`[data-import-value="${id}"]`);
function pdf(text){
 const stream=`BT /F1 12 Tf 50 750 Td (${text.replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)')}) Tj ET`;
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];let out='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}const xref=Buffer.byteLength(out);out+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(out);
}
try{
 await login('admin@example.test');await open();await upload();
 await page.locator('.import-summary').waitFor();
 equal(await value('landlord.entity_name').inputValue(),'Example Holdings LLC');equal(await select('fee.returned_payment').isChecked(),true);
 equal(fixture.state.settings[ids.property],original);equal(fixture.state.buildings.length,2);
 await page.screenshot({path:`${artifacts}/new-property-review.png`,fullPage:true});
 await fillProperty();await value('fee.returned_payment').fill('35');await select('manager.name').uncheck();
 await page.locator('[data-import-row="fee.returned_payment"]').scrollIntoViewIfNeeded();await page.screenshot({path:`${artifacts}/new-property-table.png`});
 await page.locator('[data-import-confirm]').check();loseCreationReply=true;
 await page.getByRole('button',{name:'Create property',exact:true}).click();
 await page.getByRole('button',{name:'Retry creation',exact:true}).waitFor();
 equal(fixture.state.buildings.length,3);equal(fixture.state.settings[ids.property],original);
 await page.getByRole('button',{name:'Retry creation',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
 const created=fixture.state.buildings.find(row=>row.name==='Imported property');assert(created);checks++;
 equal(fixture.state.buildings.length,3);equal(fixture.state.settings[created.id]['fee.returned_payment'],'$35.00');equal(fixture.state.settings[created.id]['manager.name'],undefined);equal(fixture.state.settings[created.id]['insurance.required_no'],false);equal(fixture.state.settings[ids.otherProperty],other);
 equal(fixture.state.settings[created.id]['tenant.names'],undefined);equal(fixture.state.settings[ids.property],original);
 await page.waitForURL(`**/admin/#/properties/${created.id}`);await page.reload();await page.locator('#property-defaults').waitFor();equal(await page.locator('[data-property-import]').count(),0);
 await page.locator('[data-property-step="payments"]').first().click();await page.getByText('$35.00',{exact:true}).waitFor();checks++;
 // PDF reader executes in a real browser worker; nothing is persisted on cancel.
 await open();await page.locator('#lease-import-file').setInputFiles({name:'sample.pdf',mimeType:'application/pdf',buffer:pdf('Landlord legal entity: PDF Example Holdings LLC')});await page.locator('.import-summary').waitFor();equal(await value('landlord.entity_name').inputValue(),'PDF Example Holdings LLC');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${artifacts}/new-property-mobile.png`,fullPage:true});equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.locator('[data-import-row="landlord.entity_name"]').scrollIntoViewIfNeeded();await page.screenshot({path:`${artifacts}/new-property-mobile-table.png`});
 await page.getByRole('button',{name:'Close lease import'}).click();equal(fixture.state.buildings.length,3);
 await page.setViewportSize({width:1440,height:1000});await open();
 await page.locator('#lease-import-file').setInputFiles({name:'broken.pdf',mimeType:'application/pdf',buffer:Buffer.from('Not a PDF')});await page.locator('.import-message[data-tone="error"]').waitFor();equal(await page.getByRole('button',{name:'Create property',exact:true}).isDisabled(),true);await page.getByRole('button',{name:'Close lease import'}).click();
 await open();await page.locator('#lease-import-file').setInputFiles({name:'scan.pdf',mimeType:'application/pdf',buffer:pdf('')});await page.locator('.import-message[data-tone="error"]').waitFor();equal((await page.locator('.import-message').textContent()).includes('No readable lease text'),true);await page.getByRole('button',{name:'Close lease import'}).click();
 if(process.env.LEASE_IMPORT_SAMPLE){await open();await page.locator('#lease-import-file').setInputFiles(process.env.LEASE_IMPORT_SAMPLE);await page.locator('.import-summary').waitFor();const detected=await page.locator('.import-summary h3').textContent();assert(!detected.startsWith('0 '));checks++;equal(await page.locator('[name="street"]').inputValue(),'8107 Kew Gardens Road');console.log(`Source file review: ${detected}`);await page.screenshot({path:`${artifacts}/source-new-property.png`,fullPage:true});await page.getByRole('button',{name:'Close lease import'}).click();}
 // Manual creation remains available without forcing a lease upload.
 await open();await page.getByRole('button',{name:'Enter manually'}).click();await fillProperty('Manual property');await page.locator('[data-import-confirm]').check();await page.getByRole('button',{name:'Create property',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});equal(fixture.state.buildings.length,4);
 const invalid=await page.evaluate(async id=>{const post=body=>fetch('/api/admin/buildings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(response=>response.status);return [await post({name:'Must not create',creation_token:crypto.randomUUID(),initial_settings:{'tenant.names':'Private'}}),await post({name:'Must not overwrite',building_id:id,creation_token:crypto.randomUUID(),initial_settings:{}})];},ids.property);equal(invalid,[422,422]);equal(fixture.state.buildings.length,4);equal(fixture.state.settings[ids.property],original);
 for(const email of ['agent-a@example.test','owner@example.test','platform-owner@example.test']){
  await page.locator('[data-sign-out]').first().click();await page.waitForURL('**/login/');await login(email);await page.goto(`${base}/admin/#/properties`);await page.waitForTimeout(250);
  equal(await page.locator('[data-desk-new-property]').count(),0);
  const denied=await page.evaluate(async()=>{const response=await fetch('/api/admin/buildings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Unauthorized',creation_token:crypto.randomUUID(),initial_settings:{}})});return response.status;});equal(denied,403);
 }
 equal(errors,[]);
 console.log(`PASS ${checks} new-property browser checks: upload/manual drafts, reviewed creation, safe retry, reload, no existing-property writes, invalid fields, mobile and role permissions`);
} catch(error){await page.screenshot({path:`${artifacts}/failure.png`,fullPage:true});console.error(await page.locator('.import-message').allTextContents());throw error;}
finally{await context.close();await browser.close();await Promise.allSettled(pending);await new Promise(resolve=>server.close(resolve));restore();}
