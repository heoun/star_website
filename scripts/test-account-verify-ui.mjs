import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
const root=resolve('site');
const server=http.createServer((req,res)=>{
 try{
  if(req.url==='/admin/test'){res.setHeader('Content-Type','text/html');res.end('<main id="test"></main>');return;}
  const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
  if(!path.startsWith(root+'/'))throw Error('Invalid path');
  res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':'text/plain');res.end(readFileSync(path));
 }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();
 let verified=false,verificationAttempts=0;
 await page.route('**/api/auth/workspace/*',async route=>{
  const action=route.request().url().split('/').pop(),body=route.request().postDataJSON();
  if(action==='security')return route.fulfill({json:{provider:'gip',email:'admin@example.test'}});
  if(action==='reauth-start'){assert.equal(body.password,'test-password');return route.fulfill({json:{factors:[{id:'test-factor'}]}});}
  assert.equal(action,'reauth-verify');verificationAttempts++;
  if(body.code!=='123456')return route.fulfill({status:403,json:{error:'Invalid code'}});
  verified=true;await page.evaluate(()=>window.verified=true);return route.fulfill({json:{ok:true}});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/admin/test`);
 await page.evaluate(async()=>{
  const {renderAccounts}=await import('/admin/accounts.js');
  window.writes=[];window.attempts=[];window.verified=false;
  const member={email:'agent@example.test',name:'Original',role:'agent',active:true,property_ids:[],account_version:1,allowed_actions:['save']};
  const api=async(path,options={})=>{
   if(!options.method){if(path==='/staff')return {staff:[member],owner:'owner@example.test',you:{owner:true}};if(path==='/buildings')return {buildings:[]};return {history:[]};}
   const body=JSON.parse(options.body);window.attempts.push(body);
   if(!window.verified)throw Object.assign(Error('Verify again'),{code:'mfa_required'});
   window.writes.push(body);member.name=body.name;return {};
  };
  await renderAccounts(document.querySelector('#test'),{api,session:{owner:true},tab:'agent',selected:member.email});
 });
 const name=page.locator('#account-form [name=name]');
 await name.fill('Updated name');await page.getByRole('button',{name:'Save Account',exact:true}).click();
 await page.locator('dialog').waitFor();await page.locator('dialog [data-cancel]').click();
 assert.equal(await name.inputValue(),'Updated name');assert.equal(await page.evaluate(()=>writes.length),0);
 await page.getByRole('button',{name:'Save Account',exact:true}).click();
 await page.locator('dialog [name=password]').fill('test-password');await page.locator('dialog button[type=submit]').click();
 await page.locator('dialog [name=code]').fill('000000');await page.locator('dialog button[type=submit]').click();
 await page.getByText('Invalid code',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>writes.length),0);
 await page.locator('dialog [name=code]').fill('123456');await page.locator('dialog button[type=submit]').click();
 await page.getByText('Account saved.',{exact:true}).waitFor();
 assert.equal(verified,true);assert.equal(verificationAttempts,2);
 assert.equal(await page.evaluate(()=>writes.length),1);
 assert.deepEqual(await page.evaluate(()=>attempts.at(-1)),await page.evaluate(()=>attempts.at(-2)));
 assert.equal(await name.inputValue(),'Updated name');assert(page.url().endsWith('/admin/test'));
 console.log('PASS account verification: in-page password/MFA, cancellation preserves edits, wrong code cannot save, one exact retry after verification, no navigation');
}finally{await browser.close();await new Promise(r=>server.close(r));}
