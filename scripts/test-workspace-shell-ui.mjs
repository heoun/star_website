import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import worker from '../worker/index.js';
import {createIdentityFixture} from './identity-fixtures.mjs';
const {env,restore}=createIdentityFixture(),root=resolve('dist'),pending=[];
const oldCaches=globalThis.caches;
globalThis.caches={default:{async match(){},async put(){},async delete(){return true;}}};
env.ASSETS={async fetch(request){
 const path=new URL(request.url).pathname,file=resolve(root,'.'+path+(path.endsWith('/')?'index.html':''));
 if(!file.startsWith(root+'/'))return new Response(null,{status:404});
 try{return new Response(await readFile(file),{headers:{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(file)]||'application/octet-stream'}});}catch{return new Response(null,{status:404});}
}};
const server=http.createServer(async(req,res)=>{
 try{const chunks=[];for await(const c of req)chunks.push(c);
 const response=await worker.fetch(new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})}),env,{waitUntil:p=>pending.push(p)});
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch(e){res.writeHead(500);res.end(e.message);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true});
try{
 for(const [email,routes] of [['agent-a@example.test',['applications','listings']],['admin@example.test',['applications','onboarding','properties','listings','staff','requests']],['owner@example.test',['overview','properties','leases']],['platform-owner@example.test',['staff']]]){
  const context=await browser.newContext({javaScriptEnabled:false});
  assert.equal((await context.request.post(base+'/api/auth/workspace/login',{data:{email,password:'testing-password'}})).status(),200);
  const page=await context.newPage();
  for(let i=0;i<2;i++){
   const response=i?await page.reload():await page.goto(base+'/admin/');
   assert.equal(response.headers()['cache-control'],'private, no-store');assert.equal(response.headers()['vary'],'Cookie');
   assert.deepEqual(await page.locator('.nav [data-route]').evaluateAll(links=>links.map(a=>a.dataset.route)),routes);
   assert.equal(await page.locator('#who').textContent(),email);
  }
  await context.close();
 }
 const context=await browser.newContext();await context.request.post(base+'/api/auth/workspace/login',{data:{email:'agent-a@example.test',password:'testing-password'}});
 const page=await context.newPage();let unblock;const delay=new Promise(r=>unblock=r);
 await page.route('**/api/admin/listings',async route=>{await delay;await route.continue();});
 await page.goto(base+'/admin/',{waitUntil:'domcontentloaded'});
 assert.deepEqual(await page.locator('.nav [data-route]').evaluateAll(links=>links.map(a=>a.dataset.route)),['applications','listings']);
 assert.equal(await page.locator('#who').textContent(),'agent-a@example.test');
 unblock();await page.waitForLoadState('networkidle');
 assert.equal((await context.request.get(base+'/api/admin/staff')).status(),403);
 await context.close();
 console.log('PASS server shell: four roles before JavaScript, refresh, delayed data, private cache and forbidden API');
}finally{await browser.close();server.close();await Promise.allSettled(pending);restore();globalThis.caches=oldCaches;}
