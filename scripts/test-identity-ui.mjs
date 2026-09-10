// Browser -> real Worker -> synthetic Supabase. Runs without cloud accounts.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import worker from "../worker/index.js";
import { createIdentityFixture } from "./identity-fixtures.mjs";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const {env,restore}=createIdentityFixture();
env.DEV_REAL_EMAIL="true"; // Synthetic transport above; never sends email.
const root=resolve("dist"), pending=[];
env.ASSETS={async fetch(request){
  const path=new URL(request.url).pathname;
  const file=resolve(root,`.${path}${path.endsWith("/")?"index.html":""}`);
  if(!file.startsWith(`${root}/`))return new Response(null,{status:404});
  try{return new Response(await readFile(file),{headers:{"Content-Type":({".html":"text/html",".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml"})[extname(file)] || "application/octet-stream"}});}catch{return new Response(null,{status:404});}
}};
const server=http.createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const request=new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
    const response=await worker.fetch(request,env,{waitUntil:p=>pending.push(p)});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});let checks=0;
const screenshotDir=process.env.IDENTITY_UI_ARTIFACTS || "/tmp/star-identity-ui";
await mkdir(screenshotDir,{recursive:true});
const context=await browser.newContext({viewport:{width:1360,height:900}}),page=await context.newPage();
const errors=[];page.on("pageerror",error=>errors.push(error.message));
try{
  await page.goto(`${base}/admin/`);await page.waitForURL("**/login/?next=admin");checks++;
  await page.screenshot({path:`${screenshotDir}/login-desktop.png`,fullPage:true});
  assert.equal(await page.locator(".brand svg").count(),1);checks++;
  await page.getByLabel("Email address").fill("admin@example.test");await page.getByLabel("Password",{exact:true}).fill("wrong");await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await page.getByRole("status").filter({hasText:"Email or password is incorrect"}).waitFor();checks++;
  await page.getByLabel("Password",{exact:true}).fill("testing-password");await page.getByRole("button",{name:"Sign in",exact:true}).click();await page.waitForURL("**/admin/**");checks++;
  await page.goto(`${base}/admin/#/staff`);await page.getByRole("tab",{name:/Agents/}).click();await page.getByRole("button",{name:"Add Agent",exact:true}).click();
  await page.locator('#account-form [name="email"]').fill("browser-agent@example.test");await page.locator('#account-form [name="name"]').fill("Browser Agent");await page.getByRole("button",{name:"Save account",exact:true}).click();
  await page.getByRole("status").filter({hasText:"activation code has been emailed"}).waitFor();checks++;
  await page.locator("[data-sign-out]").first().click();await page.waitForURL("**/login/");checks++;
  await page.getByRole("button",{name:"Activate an invited account"}).click();await page.getByLabel("Email address").fill("browser-agent@example.test");await page.getByRole("button",{name:"Send email code"}).click();
  await page.getByLabel("Email code",{exact:true}).fill("123456");await page.getByLabel("New password",{exact:true}).fill("browser-password");await page.getByLabel("Confirm password").fill("browser-password");await page.getByRole("button",{name:"Save password & sign in"}).click();await page.waitForURL("**/admin/**");checks++;
  assert.equal(await page.locator('nav a[href="#/staff"]:visible').count(),0);checks++;
  await page.locator("[data-sign-out]").first().click();await page.waitForURL("**/login/");
  await page.getByRole("button",{name:"Forgot password?"}).click();await page.getByLabel("Email address").fill("browser-agent@example.test");await page.getByRole("button",{name:"Send email code"}).click();
  await page.getByLabel("Email code",{exact:true}).fill("123456");await page.getByLabel("New password",{exact:true}).fill("browser-reset-password");await page.getByLabel("Confirm password").fill("browser-reset-password");await page.getByRole("button",{name:"Save password & sign in"}).click();await page.waitForURL("**/admin/**");checks++;
  await page.locator("[data-sign-out]").first().click();await page.waitForURL("**/login/");
  await page.getByLabel("Email address").fill("platform-owner@example.test");await page.getByLabel("Password",{exact:true}).fill("testing-password");await page.getByRole("button",{name:"Sign in",exact:true}).click();await page.waitForURL("**/admin/#/staff");checks++;
  assert.equal(await page.locator('.nav a[href="#/applications"]:visible').count(),0);checks++;
  await page.locator("[data-sign-out]").first().click();await page.waitForURL("**/login/");
  await page.getByLabel("Email address").fill("owner@example.test");await page.getByLabel("Password",{exact:true}).fill("testing-password");await page.getByRole("button",{name:"Sign in",exact:true}).click();await page.waitForURL("**/admin/**");checks++;
  assert.equal(await page.locator('.nav a[href="#/staff"]:visible').count(),0);checks++;
  await page.locator("[data-sign-out]").first().click();await page.waitForURL("**/login/");
  await page.getByLabel("Email address").fill("applicant@example.test");await page.getByLabel("Password",{exact:true}).fill("testing-password");await page.getByRole("button",{name:"Sign in",exact:true}).click();await page.getByRole("status").filter({hasText:"not set up"}).waitFor();checks++;
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${screenshotDir}/login-mobile.png`,fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));checks++;
  assert.deepEqual(errors,[]);checks++;
  console.log(`PASS ${checks} browser checks: sign in, create/invite, activation, recovery, sign out, role navigation and mobile layout`);
}finally{await context.close();await browser.close();await Promise.allSettled(pending);await new Promise(resolve=>server.close(resolve));restore();}
