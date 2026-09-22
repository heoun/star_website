import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import worker from '../worker/index.js';
import {ids} from '../backend/tools/workspace-fixtures.mjs';
export async function runJourneyBrowser({env,fixture,pending,advance}) {
  const previousCaches=globalThis.caches;
  globalThis.caches={default:{async match(){return undefined;},async put(){},async delete(){return true;}}};
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright'),root=resolve('dist');
  env.ASSETS={async fetch(request){const path=new URL(request.url).pathname,file=resolve(root,`.${path}${path.endsWith('/')?'index.html':''}`);if(!file.startsWith(root+'/'))return new Response(null,{status:404});try{return new Response(await readFile(file),{headers:{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)] || 'application/octet-stream'}});}catch{return new Response(null,{status:404});}}};
  const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const response=await worker.fetch(new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})}),env,{waitUntil:p=>pending.push(p)});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(e){res.writeHead(500);res.end(e.message);}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  const out='/tmp/star-journey-ui';await mkdir(out,{recursive:true});page.on('pageerror',e=>errors.push(e.message));let checks=0;
  const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
  const login=async(email)=>{const r=await context.request.post(base+(email===env.INTERNAL_TEST_EMAIL?'/api/auth/login':'/api/auth/workspace/login'),{data:{email,password:'testing-password'}});eq(r.status(),200);};
  try {
    await login(env.INTERNAL_TEST_EMAIL);
    await page.goto(`${base}/property/?id=${ids.listing}`);
    await page.locator(`a[href*="apply/?id=${ids.listing}"]`).first().click();
    // Sample data never overrides a roommate answer already given: an
    // invitation may have gone out from that step.
    await page.locator('input[name="has_roommates"][value="yes"]').check();
    await page.locator('#rep-roommates .repeat-card [data-field="email"]').first().fill('roommate@example.test');
    await page.getByRole('button',{name:'Fill With Sample Data'}).click();
    eq(await page.locator('input[name="has_roommates"]:checked').inputValue(),'yes');
    eq(await page.locator('#rep-roommates .repeat-card [data-field="email"]').first().inputValue(),'roommate@example.test');
    await page.locator('input[name="has_roommates"][value="no"]').check();
    eq(await page.locator('[name=email]').inputValue(),env.INTERNAL_TEST_EMAIL);
    eq(await page.locator('#consent').isChecked(),false);
    await page.screenshot({path:out+'/sample-application.png',fullPage:true});
    for(let i=0;i<6;i++)await page.locator('#step-next').click();
    // A required marker used to become a third grid child, placing this
    // paragraph in the checkbox's 22px column. Check the rendered layout.
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});
      await page.locator('.consent-caption .required-mark').waitFor();
      const layout=await page.locator('label.consent:has(#consent)').evaluate(label=>{
        const input=label.querySelector('input').getBoundingClientRect(),text=label.querySelector('.consent-caption').getBoundingClientRect(),box=label.getBoundingClientRect();
        return {width:text.width/box.width,aligned:Math.abs(input.top-text.top)<6,textToRight:text.left>input.right,overflow:document.documentElement.scrollWidth>innerWidth};
      });
      eq(layout.width>.75&&layout.aligned&&layout.textToRight&&!layout.overflow,true);
      await page.locator('label.consent:has(#consent)').screenshot({path:out+`/application-consent-${width}.png`});
    }
    await page.setViewportSize({width:1440,height:1000});
    eq(await page.locator('#consent').isChecked(),false);
    await page.locator('#consent').check();
    await page.getByRole('button',{name:'Submit Application',exact:true}).click();
    await page.getByRole('link',{name:'Continue to Payment & Documents'}).click();
    await page.getByRole('button',{name:'Pay $20.00',exact:true}).waitFor();
    const id=await page.locator('[data-test-panel]').getAttribute('data-test-panel');
    eq(await page.locator('[data-upload]:enabled').count(),0);
    await page.screenshot({path:out+'/application-fee.png',fullPage:true});
    // A blank card number stays in the browser: no request, an inline message.
    await page.locator('[name=card_number]').fill('');
    await page.getByRole('button',{name:'Pay $20.00',exact:true}).click();
    await page.getByText('Enter a valid card number.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Use Declined Test Card'}).click();
    await page.getByRole('button',{name:'Pay $20.00',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Your card was declined'}).waitFor();
    eq(await page.locator('[data-upload]:enabled').count(),0);
    await page.getByRole('button',{name:'Use Approved Test Card'}).click();
    await page.getByRole('button',{name:'Pay $20.00',exact:true}).click();
    await page.getByText(/Application fee paid/).waitFor();
    await page.getByRole('button',{name:'Upload Front of Government ID',exact:true}).waitFor({state:'visible'});
    const governmentId=page.getByRole('region',{name:'Government ID',exact:true});
    eq(await governmentId.count(),1);
    for(const side of ['Front','Back']) {
      const chooser=page.waitForEvent('filechooser');
      await governmentId.getByRole('button',{name:`Upload ${side} of Government ID`,exact:true}).click();
      await (await chooser).setFiles('scripts/demo-assets/supporting-document-mock.pdf');
      await governmentId.locator('.doc-side').filter({has:page.getByRole('button',{name:`Add Another ${side} of Government ID`,exact:true})}).waitFor();
      const badge=governmentId.locator(':scope > .doc-type-head .doc-req');
      eq((await badge.textContent()).trim(),side==='Front'?'Required · 1/2 Sides':'Received');
      eq(await page.getByRole('button',{name:'Authorize and Submit',exact:true}).isDisabled(),true);
    }
    await governmentId.screenshot({path:out+'/government-id.png'});
    await page.getByRole('button',{name:'Upload Sample Documents'}).click();
    await page.getByText('All required documents received. Thank you',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Authorize and Submit',exact:true}).isEnabled();
    await page.screenshot({path:out+'/credit-screening.png',fullPage:true});
    // Consent is checked in the browser before anything is sent.
    await page.getByRole('button',{name:'Authorize and Submit',exact:true}).click();
    await page.getByText('Authorize the screening to continue.',{exact:true}).waitFor();
    await page.locator('[data-screening-consent]').check();
    await page.getByRole('button',{name:'Authorize and Submit',exact:true}).click();
    await page.getByText('Preparing Your Report',{exact:true}).waitFor();
    await page.screenshot({path:out+'/screening-processing.png',fullPage:true});
    advance();await page.getByRole('button',{name:'Refresh Status'}).click();
    await page.getByText('Report Complete',{exact:true}).waitFor();
    await page.getByText('Landlord email preview only, not sent',{exact:true}).waitFor();checks++;
    await page.screenshot({path:out+'/screening-complete.png',fullPage:true});
    const row=fixture.state.applications.find(a=>a.id===id);eq(row.status,'sent_to_landlord');
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:out+'/portal-mobile.png',fullPage:true});eq(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.setViewportSize({width:1440,height:1000});
    await login(row.workspace.recommendation.landlord_email);
    // The applicant's own confirmation carries the same run stamp and goes out first; the decision links are in the landlord's mail.
    const link=fixture.state.emails.find(m=>m.subject.includes(id.slice(0,8)) && m.subject.includes('Application ready')).text.match(/Agree to proceed: (\S+)/)[1];
    await page.goto(link);await page.getByRole('button',{name:'Confirm Agree to Proceed',exact:true}).click();
    await page.getByRole('heading',{name:'Decision recorded'}).waitFor();eq(row.status,'landlord_approved');
    await page.screenshot({path:out+'/landlord-approved.png',fullPage:true});
    await login('admin@example.test');await page.goto(`${base}/admin/#/applications/${id}`);
    await page.getByRole('button',{name:'Lease & Decision',exact:false}).click();
    await page.getByRole('button',{name:'Review Lease for Signatures',exact:true}).waitFor();checks++;
    // An invitation opened under the lead's session starts invitee account
    // creation directly and preserves the complete return URL.
    await login(env.INTERNAL_TEST_EMAIL);
    await page.goto(`${base}/apply/?id=${ids.listing}&invited=roommate@example.test`);
    await page.getByRole('heading',{name:'Create your account'}).waitFor();checks++;
    await page.screenshot({path:out+'/invitation-other-account.png',fullPage:true});
    eq(await page.locator('#reg-email').inputValue(),'roommate@example.test');
    eq(await page.locator('#reg-email').getAttribute('readonly'),'');
    eq(new URL(page.url()).searchParams.get('next'),`/apply/?id=${ids.listing}&invited=roommate@example.test`);
    await page.getByRole('link',{name:'Sign in',exact:true}).click();
    eq(await page.locator('#login-email').inputValue(),'roommate@example.test');
    eq(errors,[]);console.log(`PASS ${checks} journey browser checks; screenshots: ${out}`);
  } catch(error){await page.screenshot({path:out+'/failure.png',fullPage:true});console.error((await page.locator('body').innerText()).slice(-5000));throw error;}
  finally {globalThis.caches=previousCaches;await context.close();await browser.close();await Promise.allSettled(pending.splice(0));server.closeAllConnections();await new Promise(r=>server.close(r));}
}
