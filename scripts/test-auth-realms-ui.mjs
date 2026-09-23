// Browser forms + real authentication handlers; synthetic providers supplied by test-auth-realms.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {handleAuthRequest,readSession} from '../worker/auth.js';
import {handlePortalRequest} from '../worker/portal.js';
export async function testRealmUi(env,ctx,email,staffPassword,applicantPassword,reservedEmail) {
 const root=resolve('site');let checks=0;
 const server=http.createServer(async(req,res)=>{
  try {
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const request=new Request('http://'+req.headers.host+req.url,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
   const url=new URL(request.url);let response;
   if(url.pathname==='/api/portal/applications'){
    const session=await readSession(request,env,'applicant');
    response=session?Response.json({email:session.email,applications:[],document_types:[]}):await handlePortalRequest(request,env,ctx,url.pathname);
   } else if(url.pathname.startsWith('/api/portal/')||url.pathname.startsWith('/api/auth/workspace/')) {
    response=await handleAuthRequest(request,env,ctx,url.pathname.split('/').at(-1));
   } else {
    const file=resolve(root,'.'+url.pathname+(url.pathname.endsWith('/')?'index.html':''));
    if(!file.startsWith(root+'/'))response=new Response(null,{status:404});
    else {try{response=new Response(await readFile(file),{headers:{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream'}})}catch{response=new Response(null,{status:404})}}
   }
   const headers=Object.fromEntries(response.headers);if(response.headers.getSetCookie().length)headers['set-cookie']=response.headers.getSetCookie();
   res.writeHead(response.status,headers);res.end(Buffer.from(await response.arrayBuffer()));
  } catch {res.writeHead(500);res.end('Fixture request failed')}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 let browser;
 try {
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext();const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  assert.equal((await context.request.post(base+'/api/auth/workspace/login',{data:{email,password:staffPassword}})).status(),200);checks++;
  await page.goto(base+'/portal/');
  await page.getByText('Your applicant account and password are separate', {exact:false}).waitFor();checks++;
  await page.getByLabel('Email',{exact:true}).fill(email);
  await page.getByLabel('Password',{exact:true}).fill(staffPassword);
  await page.getByRole('button',{name:'Sign In',exact:true}).click();
  await page.getByText('Email or password is incorrect.',{exact:true}).waitFor();checks++;
  await page.getByLabel('Password',{exact:true}).fill(applicantPassword);
  await page.getByRole('button',{name:'Sign In',exact:true}).click();
  await page.getByRole('button',{name:'Sign Out',exact:true}).click();
  await page.getByRole('button',{name:'Sign In',exact:true}).waitFor();checks++;
  assert.equal((await context.request.get(base+'/api/auth/workspace/me')).status(),200);checks++;
  await page.getByRole('link',{name:'Create an account',exact:true}).click();
  await page.getByLabel('Email',{exact:true}).fill(reservedEmail);
  await page.locator('#reg-password').fill('browser-applicant-password');await page.locator('#reg-confirm').fill('browser-applicant-password');
  await page.locator('#register-form button[type=submit]').click();await page.locator('#login-code').fill('123456');
  await page.locator('#code-form button[type=submit]').click();
  await page.getByRole('button',{name:'Sign Out',exact:true}).click();
  await page.getByLabel('Email',{exact:true}).fill(reservedEmail);await page.getByLabel('Password',{exact:true}).fill('browser-applicant-password');
  await page.getByRole('button',{name:'Sign In',exact:true}).click();
  await page.getByRole('button',{name:'Sign Out',exact:true}).click();checks++;
  await page.getByRole('link',{name:'Forgot your password?',exact:true}).click();
  await page.getByText('This resets only your applicant password.',{exact:false}).waitFor();checks++;
  await page.locator('#reset-email').fill(reservedEmail);await page.locator('#reset-form button[type=submit]').click();
  await page.locator('#login-code').fill('123456');await page.locator('#new-password').fill('browser-reset-password');await page.locator('#new-confirm').fill('browser-reset-password');
  await page.locator('#reset-code-form button[type=submit]').click();
  await page.getByRole('button',{name:'Sign Out',exact:true}).click();
  await page.getByLabel('Email',{exact:true}).fill(reservedEmail);await page.getByLabel('Password',{exact:true}).fill('browser-reset-password');
  await page.getByRole('button',{name:'Sign In',exact:true}).click();
  await page.getByRole('button',{name:'Sign Out',exact:true}).waitFor();checks++;
  assert.equal((await context.request.get(base+'/api/auth/workspace/me')).status(),200);checks++;
  assert.deepEqual(errors,[]);checks++;
  console.log(`PASS ${checks} browser auth realm checks: independent passwords, registration, logout/login, recovery, session coexistence and clear account copy.`);
 } finally {await browser?.close();await new Promise(r=>server.close(r));}
}
