// Browser interaction regression; all identity responses are synthetic.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
const root=resolve('site');let checks=0,browser;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost'),file=resolve(root,'.'+url.pathname+(url.pathname.endsWith('/')?'index.html':''));
 if(!file.startsWith(root+'/')){res.writeHead(404);res.end();return;}
 try{const content=await readFile(file);res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream'});res.end(content);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
try{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true});
 const context=await browser.newContext(),page=await context.newPage(),errors=[],calls=[];
 page.on('pageerror',e=>errors.push(e.message));
 let signed=false,mfa=false,password='workspace-password',accepted=false,reset=false,appSigned=false;
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),body=req.postDataJSON()||{},path=url.pathname;
  calls.push({path,body});let data={},status=200;
  if(path.endsWith('/options'))data={provider:'gip',secure:true};
  else if(path.endsWith('/workspace-invitation')){if(body.invite==='a'.repeat(64))data={email:'member@example.invalid',role:'agent'};else{status=410;data={error:'This invitation is expired, replaced or already accepted.'};}}
  else if(path.endsWith('/workspace-code'))data=reset?{ok:true,existing_account:true}:{ok:true,activation_ready:true};
  else if(path.endsWith('/check-action'))data={email:'member@example.invalid',requestType:'PASSWORD_RESET'};
  else if(path.endsWith('/verify-reset')){password=body.password;reset=true;data={ok:true,sign_in_required:true};}
  else if(path.endsWith('/request-reset'))data={ok:true,email_link:true};
  else if(path==='/api/auth/workspace/login'){
   if(body.password!==password){status=401;data={error:'Email or password is incorrect.'};}
   else data={mfa_required:true,factors:[{id:'totp',name:'Authenticator'}]};
  }else if(path.endsWith('/mfa-login')){if(body.code!=='123456'){status=401;data={error:'Enter a valid authenticator code.'};}else{signed=true;mfa=true;data={ok:true};}}
  else if(path.endsWith('/workspace-accept')){assert.ok(signed&&mfa);accepted=true;data={ok:true};}
  else if(path.endsWith('/security'))data={provider:'gip',email:'member@example.invalid',factors:[{id:'totp',status:'verified'}],verified:mfa,recent_mfa:mfa,mfa_required:true};
  else if(path==='/api/admin/me')data={role:'agent'};
  else if(path==='/api/portal/login'){if(body.password!=='applicant-password'){status=401;data={error:'Email or password is incorrect.'};}else{appSigned=true;data={ok:true};}}
  else if(path==='/api/portal/applications'){if(!appSigned){status=401;data={error:'Sign In.',auth_realm:'applicant'};}else data={email:'member@example.invalid',applications:[],document_types:[]};}
  else if(path==='/api/portal/sign-out'){appSigned=false;data={ok:true};}
  else{status=404;data={error:'Unsupported synthetic route'};}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
 });
 // An invitation opens activation, not a generic welcome screen.
 await page.goto(base+'/login/#invite='+'a'.repeat(64));await page.getByRole('heading',{name:'Activate your account',exact:true}).waitFor();checks++;
 assert.equal(await page.getByLabel('Email address').inputValue(),'member@example.invalid');assert.equal(new URL(page.url()).hash,'');checks++;
 await page.getByLabel('New password',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Send Email Link'}).count(),0);checks++;
 // Set the password directly from the invitation, without another email link.
 await page.getByLabel('New password',{exact:true}).fill('changed-workspace-password');await page.getByLabel('Confirm password').fill('mismatch-password');
 await page.getByRole('button',{name:'Save Password'}).click();await page.getByText('The passwords do not match.',{exact:true}).waitFor();assert.equal(reset,false);checks++;
 await page.getByLabel('Confirm password').fill('changed-workspace-password');await page.getByRole('button',{name:'Save Password'}).click();await page.getByRole('heading',{name:'Two-step verification'}).waitFor();assert.equal(signed,false);checks++;
 await page.getByRole('button',{name:'Back to Sign In',exact:true}).click();
 await page.getByLabel('Password',{exact:true}).fill('wrong-password');await page.getByRole('button',{name:'Sign In',exact:true}).click();await page.getByText('Email or password is incorrect.',{exact:true}).waitFor();checks++;
 await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign In',exact:true}).click();await page.getByRole('heading',{name:'Two-step verification'}).waitFor();assert.equal(accepted,false);checks++;
 await page.getByLabel('Verification code').fill('000000');await page.getByRole('button',{name:'Verify & Sign In'}).click();await page.getByText('Enter a valid authenticator code.',{exact:true}).waitFor();checks++;
 await page.getByLabel('Verification code').fill('123456');await page.getByRole('button',{name:'Verify & Sign In'}).click();await page.waitForURL('**/admin/**');assert.equal(accepted,true);checks++;
 // An existing workspace account accepts an invitation with its current password.
 await page.goto(base+'/login/#invite='+'a'.repeat(64));
 await page.getByText('Sign In with your current password to accept your invitation.',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('New password',{exact:true}).count(),0);checks++;
 // Expired invitation cannot pin subsequent sign-in to an unusable token.
 await page.goto(base+'/login/#invite='+'b'.repeat(64));await page.getByText('This invitation is expired, replaced or already accepted.',{exact:true}).waitFor();assert.equal(await page.getByLabel('Email address').getAttribute('readonly'),null);checks++;
 // Applicant UI mounts GIP; workspace password cannot enter it.
 await page.goto(base+'/portal/');await page.getByRole('button',{name:'Sign In',exact:true}).waitFor();
 await page.getByLabel('Email address').fill('member@example.invalid');await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign In',exact:true}).click();await page.getByText('Email or password is incorrect.',{exact:true}).waitFor();checks++;
 await page.getByLabel('Password',{exact:true}).fill('applicant-password');await page.getByRole('button',{name:'Sign In',exact:true}).click();await page.getByRole('button',{name:'Sign Out',exact:true}).waitFor();checks++;
 await page.getByRole('button',{name:'Sign Out',exact:true}).click();await page.getByRole('button',{name:'Sign In',exact:true}).waitFor();assert.equal(signed,true);checks++;
 await page.getByRole('button',{name:'Forgot Password?',exact:true}).click();await page.getByText('reset only your applicant password',{exact:false}).waitFor();checks++;
 assert.deepEqual(errors,[]);checks++;
 assert.equal(await page.evaluate(()=>Object.values(localStorage).some(v=>/synthetic-action|workspace-password|applicant-password/.test(v))),false);checks++;
 console.log(`PASS ${checks} GIP browser activation, action-link navigation, password/MFA, invitation and applicant form checks.`);
}finally{await browser?.close();await new Promise(r=>server.close(r));}
