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
 if(url.pathname==='/admin/test'){
  res.setHeader('Content-Type','text/html');res.end('<html><head>'+head+'</head><body><main style="padding:24px;max-width:1000px;margin:auto" id="test"></main><script type="module">import {renderCollaborationAdmin,renderAgentProperties} from "./property-collaboration.js";const api=async(path,options={})=>{const r=await fetch("/api/admin"+path,options),b=await r.json();if(!r.ok)throw Error(b.error);return b;};const host=document.querySelector("#test");'+
   (role==='agent'?'await renderAgentProperties(host,{api,buildingId:"'+property.id+'"});':'await renderCollaborationAdmin(host,{api,buildingId:"'+property.id+'"});')+'</script></body></html>');return;
 }
 const path=resolve(root,'.'+url.pathname);if(!path.startsWith(root+'/'))throw Error('Invalid path');
 res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'text/plain');res.end(readFileSync(path));
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
 await a.goto(base+'/admin/test');await a.getByText('Temporary Property Collaboration',{exact:true}).click();await a.locator('[name=agent_email]').selectOption('agent@example.test');await a.getByRole('button',{name:'Grant Temporary Access',exact:true}).click();
 await a.locator('[data-review-id]').waitFor({state:'attached'});await a.getByText('Temporary Property Collaboration',{exact:true}).click();
 await g.goto(base+'/admin/test');await g.locator('.property-steps').waitFor();
 assert.equal(await g.locator('.property-steps [data-property-step]').count(),15);
 await g.locator('#property-address').click();
 await g.locator('#address-street').fill('123 Test Street');
 await g.locator('#address-city').fill('New York');
 await g.locator('#address-zip').fill('10001');
 await g.locator('#address-save').click();
 await g.getByText('Address saved to draft. Admin approval is required.').waitFor();
 await g.locator('.property-steps [data-property-step="management"]').click();
 await g.locator('[data-settings-edit="management"]').click();
 await g.locator('[data-setting="manager.name"]').fill('Draft Property Manager');
 await g.getByRole('button',{name:'Submit for Review',exact:true}).click();
 await g.getByText('Save or cancel the open section before submitting.').waitFor();
 await g.locator('[data-settings-save="management"]').click();
 await g.getByText('Saved 1 value to the draft. Admin approval is required.').waitFor();
 await g.locator('.property-steps [data-property-step="signing"]').click();
 await g.locator('#property-signer').click();
 await g.locator('#signer-name').fill('Test Signer');
 await g.locator('#signer-email').fill('signer@example.test');
 await g.locator('#signer-save').click();
 await g.getByText('Signer saved to draft. Admin approval is required.').waitFor();
 await g.screenshot({path:'/tmp/property-unified-agent-desktop.png',fullPage:true});
 assert.equal((await db.query('select count(*)::int n from lease_settings')).rows[0].n,0);
 assert.equal((await db.query('select city from buildings')).rows[0].city,null);
 await g.locator('input[type=file]').setInputFiles({name:'landlord-note.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 Test Only')});
 await g.getByRole('button',{name:'Upload Document',exact:true}).click();
 await g.getByRole('link',{name:'landlord-note.pdf'}).waitFor();
 await g.getByRole('button',{name:'Submit for Review',exact:true}).click();
 await g.getByText('Awaiting Review · Access Ends',{exact:false}).waitFor();
 assert.equal(await g.locator('[data-settings-edit], #property-address, #property-signer').count(),0);
 assert.equal(await g.locator('.property-steps [data-property-step]').count(),15);
 await a.reload();await a.getByText('Temporary Property Collaboration',{exact:true}).click();await a.locator('[data-review-id]').click();await a.getByRole('button',{name:'Approve Changes'}).waitFor();
 assert((await a.locator('[data-review-host]').innerText()).includes('New York'));
 await a.screenshot({path:'/tmp/property-collaboration-admin.png',fullPage:true});
 const download=await admin.request.get(base+(await a.getByRole('link',{name:'landlord-note.pdf'}).getAttribute('href')));
 assert.equal(download.status(),200);
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
 assert.deepEqual(errors,[]);
 assert(agentWrites.every(path=>path.startsWith('/api/admin/property-collaborations/')),'Agent editor must never call a live settings write');
 assert.equal((await db.query('select field_values from lease_settings')).rows[0].field_values['manager.name'],'Draft Property Manager');
 console.log('PASS collaboration browser flow: grant, save draft without live write, upload, submit, review diff, private download, approval, access closed, fresh assignment, mobile layout');
}finally{await browser.close();server.close();globalThis.fetch=oldFetch;await db.close();}
