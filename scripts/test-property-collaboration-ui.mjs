import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {handlePropertyCollaboration} from '../worker/property-collaboration.js';
const db=new PGlite();
await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
await db.exec(readFileSync('supabase/schema.sql','utf8'));await db.exec(readFileSync('supabase/property-collaboration.sql','utf8'));
await db.exec("insert into staff(email,role,name) values('admin@example.test','manager','Test Admin'),('agent@example.test','agent','Test Agent')");
const property=(await db.query("insert into buildings(name) values('Test Property') returning *")).rows[0];
const registry=JSON.parse(readFileSync('lease/schema/fields.json','utf8'));
const oldFetch=globalThis.fetch,files=new Map();
globalThis.fetch=async(input,init)=>{
 if(new URL(input).hostname!=='collab-db.test')return oldFetch(input,init);
 const args=JSON.parse(init.body);
 const result=(await db.query('select property_collaboration_command($1,$2,$3,$4) as r',[args.p_actor,args.p_action,args.p_id,args.p_body])).rows[0].r;
 return Response.json(result);
};
const env={SUPABASE_URL:'https://collab-db.test',SUPABASE_SERVICE_ROLE_KEY:'test-only',APPLICANT_DOCS:{
 async put(path,data){files.set(path,data);},async get(path){return files.has(path)?{body:files.get(path)}:null;},async delete(path){files.delete(path);}
}};
const head=readFileSync('site/admin/index.html','utf8').match(/<head>([\s\S]*?)<\/head>/)[1]+['workspace.css','lease-review.css','signing-confirm.css','case-workspace.css'].map(file=>'<link rel="stylesheet" href="'+file+'">').join('');
const root=resolve('site');
const server=http.createServer(async(req,res)=>{
 try{
 const url=new URL(req.url,'http://127.0.0.1'),role=req.headers.cookie?.includes('role=agent')?'agent':'manager';
 if(url.pathname.startsWith('/api/admin/')){
  let response;
  if(url.pathname==='/api/admin/lease/fields')response=Response.json({registry});
  else if(url.pathname==='/api/admin/staff')response=Response.json({staff:(await db.query('select * from staff')).rows});
  else{
   const data=[];for await(const c of req)data.push(c);
   response=await handlePropertyCollaboration(new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,...(data.length?{body:Buffer.concat(data)}:{})}),env,{email:role==='agent'?'agent@example.test':'admin@example.test',role},url.pathname.replace('/api/admin/','').split('/'));
  }
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
 }
 if(url.pathname==='/admin/lease-template.docx'){res.end(readFileSync('lease/template/lease-template.docx'));return;}
 if(url.pathname==='/admin/test'){
  res.setHeader('Content-Type','text/html');res.end('<html><head>'+head+'</head><body><main style="padding:24px;max-width:1000px;margin:auto" id="test"></main><script type="module">import {renderCollaborationAdmin,renderAgentProperties} from "./property-collaboration.js";const api=async(path,options={})=>{const r=await fetch("/api/admin"+path,options),b=await r.json();if(!r.ok)throw Object.assign(Error(b.error),{code:b.code,status:r.status});return b;};const host=document.querySelector("#test");'+
   (role==='agent'?'await renderAgentProperties(host,{api,buildingId:"'+property.id+'"});':'await renderCollaborationAdmin(host,{api,buildingId:"'+property.id+'"});')+'</script></body></html>');return;
 }
 const path=resolve(root,'.'+url.pathname);if(!path.startsWith(root+'/'))throw Error('Invalid path');
 res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':extname(path)==='.html'?'text/html':extname(path)==='.mjs'?'text/javascript':'text/plain');res.end(readFileSync(path));
 }catch(e){res.writeHead(500);res.end(e.message);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright'),browser=await chromium.launch({headless:true});
const errors=[],agentWrites=[];
try{
 const admin=await browser.newContext(),agent=await browser.newContext();await agent.addCookies([{name:'role',value:'agent',url:base}]);
 const a=await admin.newPage(),g=await agent.newPage();
 g.on('request',request=>{if(request.method()==='POST'||request.method()==='PUT'||request.method()==='PATCH')agentWrites.push(new URL(request.url()).pathname);});
 for(const page of [a,g])page.on('pageerror',e=>errors.push(e.message));
 let verified=false;
 await a.route('**/api/auth/workspace/*',async route=>{
  const action=new URL(route.request().url()).pathname.split('/').at(-1),body=route.request().postDataJSON();
  if(action==='security')return route.fulfill({json:{provider:'gip',email:'admin@example.test',factors:[]}});
  if(action==='reauth-start'){assert.equal(body.password,'test-password');return route.fulfill({json:{factors:[{id:'test-factor',name:'Test Authenticator'}]}});}
  assert.equal(action,'reauth-verify');assert.equal(body.factor_id,'test-factor');
  if(body.code!=='123456')return route.fulfill({status:401,json:{error:'Invalid code.'}});
  verified=true;return route.fulfill({json:{ok:true}});
 });
 await a.route('**/api/admin/property-collaborations',async route=>{
  if(route.request().method()==='POST'&&!verified)return route.fulfill({status:403,json:{error:'Verify again.',code:'mfa_required'}});
  return route.continue();
 });
 await a.goto(base+'/admin/test');await a.getByText('Temporary Property Collaboration',{exact:true}).click();await a.locator('[name=agent_email]').selectOption('agent@example.test');
 await a.locator('[name=days]').fill('5');
 await a.getByRole('button',{name:'Grant Temporary Access',exact:true}).click();
 await a.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await a.locator('[name=days]').inputValue(),'5');
 assert.equal(await a.locator('[name=agent_email]').inputValue(),'agent@example.test');
 await a.getByRole('button',{name:'Grant Temporary Access',exact:true}).click();
 await a.getByRole('dialog').locator('[name=password]').fill('test-password');
 await a.getByRole('dialog').getByRole('button',{name:'Continue',exact:true}).click();
 await a.getByRole('dialog').locator('[name=code]').fill('000000');
 await a.getByRole('dialog').getByRole('button',{name:'Verify & Continue',exact:true}).click();
 await a.getByText('Invalid code.',{exact:true}).waitFor();
 await a.getByRole('dialog').locator('[name=code]').fill('123456');
 await a.getByRole('dialog').getByRole('button',{name:'Verify & Continue',exact:true}).click();
 await a.getByRole('dialog').waitFor({state:'detached'});
 assert.equal(a.url(),base+'/admin/test');
 await a.locator('[data-review-id]').waitFor({state:'attached'});await a.getByText('Temporary Property Collaboration',{exact:true}).click();
 await g.goto(base+'/admin/test');await g.locator('.property-steps').waitFor();
 await g.evaluate(async()=>{
  const {renderAgentProperties}=await import('/admin/property-collaboration.js');
  await renderAgentProperties(document.querySelector('#test'),{api:async path=>{const response=await fetch('/api/admin'+path);if(!response.ok)throw Error('List request failed');return response.json();}});
 });
 assert.equal(await g.locator('.prop-directory .prop-row:not(.is-head)').count(),1);
 assert.equal((await g.locator('.prop-go').innerText()).replace(/\s+/g,' '),'Manage ↗');
 await g.getByText('Lease status',{exact:true}).first().waitFor();
 await g.screenshot({path:'/tmp/property-agent-directory.png',fullPage:true});
 await g.setViewportSize({width:390,height:844});
 assert.equal(await g.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await g.setViewportSize({width:1280,height:720});
 await g.goto(base+'/admin/test');await g.locator('.property-steps').waitFor();
 assert.equal(await g.locator('.property-steps [data-property-step]').count(),15);
 const preview=g.frameLocator('[data-property-preview]');
 await preview.locator('#position').filter({hasText:'Template Section'}).waitFor({timeout:15000}).catch(async error=>{console.error('PREVIEW',await preview.locator('body').innerText(),errors);throw error;});
 const previewDocument=await preview.locator('body').evaluate(()=>{window.previewTestIdentity=crypto.randomUUID();return window.previewTestIdentity;});
 let templateReloads=0;g.on('request',request=>{if(new URL(request.url()).pathname==='/admin/lease-template.docx')templateReloads++;});
 const previewActionsStarted=Date.now();
 const total=await preview.locator('#count').innerText();assert.match(total,/1 \/ [1-9]/);
 assert.equal(await preview.locator('section.docx:not([data-doc-hidden])').count(),1);
 if(!await preview.locator('#next').isDisabled()){
  await preview.locator('#next').click();assert.match(await preview.locator('#count').innerText(),/^2 \/ /);
 }
 await preview.locator('summary').click();assert(await preview.locator('#locations button').count()>0);
 await g.screenshot({path:'/tmp/property-lease-preview.png',fullPage:true});

 await g.locator('#property-address').click();
 await g.locator('#address-street').fill('123 Test Street');
 await g.locator('#address-city').fill('New York');
 await g.locator('#address-zip').fill('10001');
 await g.locator('#address-save').click();
 await g.getByText('Address saved to draft. Admin approval is required.').waitFor();
 await g.locator('.property-steps [data-property-step="management"]').click();
 assert.equal(await g.locator('[data-settings-save="management"]').isDisabled(),true);
 await g.locator('[data-setting="manager.name"]').fill('Temporary change');
 await g.locator('.property-steps [data-property-step="payments"]').click();
 await g.getByRole('button',{name:'Continue Editing',exact:true}).click();
 assert.equal(await g.locator('[data-setting="manager.name"]').inputValue(),'Temporary change');
 await g.locator('[data-settings-cancel]').click();
 assert.equal(await g.locator('[data-setting="manager.name"]').inputValue(),'');
 assert.equal(await g.locator('[data-settings-save="management"]').isDisabled(),true);
 await g.locator('[data-setting="manager.name"]').fill('Draft Property Manager');
 await g.frameLocator('[data-property-preview]').locator('#status').filter({hasText:'Unsaved Preview'}).waitFor();
 await g.frameLocator('[data-property-preview]').locator('.is-current-match').filter({hasText:'Draft Property Manager'}).first().waitFor();

 await g.getByRole('button',{name:'Submit for Review',exact:true}).click();
 await g.getByText('Save or cancel the open section before submitting.').waitFor();
 await g.locator('[data-settings-save="management"]').click();
 await g.getByText('Saved 1 value to the draft. Admin approval is required.').waitFor();
 assert.equal(await g.locator('[data-setting="manager.name"]').inputValue(),'Draft Property Manager');
 assert.equal(await g.locator('[data-settings-save="management"]').isDisabled(),true);
 await g.locator('[data-setting="manager.name"]').fill('Discard this');
 await g.locator('.property-steps [data-property-step="payments"]').click();
 await g.getByRole('dialog').getByRole('button',{name:'Discard Changes',exact:true}).click();
 await g.locator('[data-setting="rent.due_day"]').fill('5');
 await g.locator('.property-steps [data-property-step="signing"]').click();
 await g.getByRole('button',{name:'Save & Continue',exact:true}).click();

 await g.screenshot({path:'/tmp/property-signer-fields.png',fullPage:true});
 await g.locator('#property-signer').click();
 await g.screenshot({path:'/tmp/property-signer-dialog.png',fullPage:true});
 await g.locator('#signer-name').fill('Test Signer');
 await g.locator('#signer-email').fill('signer@example.test');
 await g.locator('#signer-save').click();
 await g.getByText('Signer saved to draft. Admin approval is required.').waitFor();
 assert.equal(await g.frameLocator('[data-property-preview]').locator('body').evaluate(()=>window.previewTestIdentity),previewDocument,'Editing and saves preserve the loaded preview document');
 assert.equal(templateReloads,0,'Steps, dialogs and saves must not reload the template');
 console.log('Preview performance: 0 template reloads across address edit/save, step changes, manager edit/save, signer dialog/save in '+(Date.now()-previewActionsStarted)+' ms including test interaction and screenshots');
 await g.screenshot({path:'/tmp/property-unified-agent-desktop.png',fullPage:true});
 assert.equal((await db.query('select count(*)::int n from lease_settings')).rows[0].n,0);
 assert.equal((await db.query('select city from buildings')).rows[0].city,null);
 assert.equal(await g.locator('input[type=file]').count(),0);
 assert.equal(await g.getByText('Supporting Documents',{exact:true}).count(),0);
 await g.getByRole('button',{name:'Submit for Review',exact:true}).click();
 await g.getByText('Awaiting Review · Access Ends',{exact:false}).waitFor();
 assert.equal(await g.locator('[data-settings-edit], #property-address, #property-signer').count(),0);
 assert.equal(await g.locator('.property-steps [data-property-step]').count(),15);
 await a.reload();await a.getByText('Temporary Property Collaboration',{exact:true}).click();await a.locator('[data-review-id]').click();await a.getByRole('button',{name:'Approve Changes'}).waitFor();
 assert((await a.locator('[data-review-host]').innerText()).includes('New York'));
 await a.screenshot({path:'/tmp/property-collaboration-admin.png',fullPage:true});
 assert.equal(await a.getByText('Supporting Documents',{exact:true}).count(),0);
 await a.getByRole('button',{name:'Approve Changes'}).click();
 await a.getByRole('button',{name:/Approved · Access Ended/,includeHidden:true}).waitFor({state:'attached'});await a.getByText('Temporary Property Collaboration',{exact:true}).click();
 assert.equal((await db.query('select city from buildings')).rows[0].city,'New York');
 await g.reload();await g.getByText('You do not have active collaboration access to this property.').waitFor();
 await a.locator('[name=agent_email]').selectOption('agent@example.test');await a.getByRole('button',{name:'Grant Temporary Access',exact:true}).click();
 await a.getByRole('button',{name:/Test Agent|agent@example.test · Draft/,includeHidden:true}).waitFor({state:'attached'});
 await g.reload();await g.locator('.property-steps').waitFor();
 await g.setViewportSize({width:390,height:844});
 await g.screenshot({path:'/tmp/property-collaboration-agent.png',fullPage:true});
 assert.equal(await g.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 // Admin uses the same preview in the shared editor, with live-save controls.
 await a.evaluate(async()=>{
  const {createPropertyDefaults}=await import('/admin/property-defaults.js');
  const {registry}=await fetch('/api/admin/lease/fields').then(r=>r.json());
  const editor=createPropertyDefaults({api:async()=>({field_values:{}}),setStatus:()=>{},escapeHtml:value=>String(value??''),isManager:()=>true,buildingOf:()=>({street:'123 Test Street',city:'New York',state:'New York',zip:'10001'})});
  const host=document.querySelector('#test'),ui=editor.newDefaultsUi();
  host.innerHTML=editor.defaultsMarkup({fields:registry.fields.filter(f=>f.source==='manager'),values:{},ui,buildingId:'test'});
  editor.syncDefaultsNavigation(host,ui);
  window.propertyLayoutTest={editor,host,ui,fields:registry.fields.filter(f=>f.source==='manager')};
 });
 await a.frameLocator('[data-property-preview]').locator('.is-current-match').filter({hasText:'123 Test Street'}).first().waitFor();
 await a.setViewportSize({width:1920,height:1080});
 await a.locator('#test').evaluate(el=>el.style.maxWidth='1700px');
 const formBox=await a.locator('.property-edit-pane').boundingBox(),previewBox=await a.locator('[data-property-preview]').boundingBox();
 assert(previewBox.x>=formBox.x+formBox.width,'Desktop preview belongs to the right of the settings');
 assert(Math.abs(previewBox.y-formBox.y)<2,'Desktop panels should align at the top');
 await a.screenshot({path:'/tmp/property-admin-lease-preview.png',fullPage:true});
 for (const height of [720, 1080, 1400]) {
  await a.setViewportSize({width:1920,height});
  const workbench=await a.locator('.property-flow').boundingBox();
  assert(Math.abs(workbench.height-(height-32))<2,'Desktop workbench fills the viewport with 16px top/bottom margins');
  const footer=await a.locator('.property-step-footer').boundingBox();
  assert(Math.abs(footer.y+footer.height-workbench.y-workbench.height)<2,'Step navigation remains at the bottom of the workbench');
 }
 await a.setViewportSize({width:1920,height:1080});
 const navBox=await a.locator('.property-steps').boundingBox();
 assert(Math.abs(navBox.y-formBox.y)<2 && Math.abs(navBox.height-previewBox.height)<2 && Math.abs(formBox.height-previewBox.height)<2,'All three columns align and have equal height');
 await a.evaluate(async()=>{
  const {editor,host,ui,fields}=window.propertyLayoutTest;
  const {renderWithPropertyPreview}=await import('/admin/property-preview.js');
  ui.activeSection='payments';ui.editingGroup='payments';
  renderWithPropertyPreview(host,editor.defaultsMarkup({fields,values:{},ui,buildingId:'test'}));
  editor.syncDefaultsNavigation(host,ui);
 });
 const saveBefore=await a.locator('[data-settings-save]').boundingBox();
 const headingBefore=await a.locator('.property-edit-pane .phead').boundingBox();
 const documentScroll=await a.frameLocator('[data-property-preview]').locator('#document').evaluate(el=>el.scrollTop);
 const scroll=await a.locator('.property-edit-pane .pbody').evaluate(el=>{el.scrollTop=el.scrollHeight;return {top:el.scrollTop,height:el.clientHeight,total:el.scrollHeight};});
 assert(scroll.top>0 && scroll.total>scroll.height,'Long form scrolls inside its panel');
 assert.deepEqual(await a.locator('[data-settings-save]').boundingBox(),saveBefore,'Save stays visible while the form scrolls');
 assert.deepEqual(await a.locator('.property-edit-pane .phead').boundingBox(),headingBefore,'Form heading stays fixed');
 assert.equal(await a.frameLocator('[data-property-preview]').locator('#document').evaluate(el=>el.scrollTop),documentScroll,'Form scrolling does not move the lease');
 await a.screenshot({path:'/tmp/property-balanced-payments.png',fullPage:true});

 assert.deepEqual(errors,[]);
 assert(agentWrites.every(path=>path.startsWith('/api/admin/property-collaborations/')),'Agent editor must never call a live settings write');
 assert.equal((await db.query('select field_values from lease_settings')).rows[0].field_values['manager.name'],'Draft Property Manager');
 console.log('PASS collaboration browser flow: grant, save draft without live write, submit, review diff, approval, access closed, fresh assignment, mobile layout');
}finally{await browser.close();server.close();globalThis.fetch=oldFetch;await db.close();}
