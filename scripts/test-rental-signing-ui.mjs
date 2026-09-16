import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=resolve('site');
const pageHtml=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signing test</title><style>body{font:16px system-ui;max-width:850px;margin:24px auto;padding:16px}li{margin:12px 0;overflow-wrap:anywhere}button{margin:12px;padding:12px}label{display:block}</style><main id="host"></main><script type="module">
import {signingMarkup,bindSigning} from '/admin/rental-signing.js';
const record={id:'test-package',phase:'preparing',signers:[{recipientId:'1',role:'tenant',name:'Applicant A',email:'a@example.test'},{recipientId:'2',role:'tenant',name:'Applicant B',email:'b@example.test'},{recipientId:'3',role:'landlord',name:'Landlord A',email:'l@example.test'}]};
window.calls=[];window.ctx={id:'rental-id',row:{status:'landlord_approved',workspace_version:1},w:{lease_preparation:{}},signing:{configuration:{enabled:true,canSend:true,environment:'demo'},signing:null},api:async(path,init)=>{const command=JSON.parse(init.body);window.calls.push(command);if(command.action==='prepare')return{signing:record};if(command.action==='send'){window.ctx.signing.signing={...record,phase:'in_progress'};window.ctx.row.status='lease_sent';}if(command.action==='void')window.ctx.signing.signing.void_requested=true;return{};}};
window.render=()=>{const h=document.querySelector('#host');h.innerHTML=signingMarkup(window.ctx);bindSigning(h,window.ctx,window.render);};window.render();
</script>`;
const server=http.createServer(async(req,res)=>{if(req.url==='/'){res.end(pageHtml);return;}const file=resolve(root,'.'+req.url);if(!file.startsWith(root+'/')){res.writeHead(404);res.end();return;}try{res.setHeader('Content-Type',extname(file)==='.js'?'text/javascript':'text/plain');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}});let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.getByRole('button',{name:'Review signing package',exact:true}).click();
 await page.getByRole('heading',{name:'Review before sending'}).waitFor();
 eq(await page.getByRole('button',{name:'Send with DocuSign'}).isDisabled(),true);
 eq(await page.locator('[data-signing-preview] li').count(),3);
 eq(await page.getByRole('link',{name:'Download this exact lease for review'}).getAttribute('href'),'/api/admin/cases/rental-id/signing?package=test-package&file=source');
 await page.getByRole('checkbox').check();eq(await page.getByRole('button',{name:'Send with DocuSign'}).isEnabled(),true);
 await page.getByRole('checkbox').uncheck();eq(await page.getByRole('button',{name:'Send with DocuSign'}).isDisabled(),true);await page.getByRole('checkbox').check();
 await page.getByRole('button',{name:'Send with DocuSign'}).click();await page.getByText('Signatures in progress',{exact:true}).waitFor();
 eq(await page.evaluate(()=>calls.filter(c=>c.action==='send').length),1);
 await page.locator('li').filter({hasText:'Waiting for all tenants'}).waitFor();checks++;
 await page.setViewportSize({width:390,height:844});eq(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.getByText('Cancel this signing request',{exact:true}).click();await page.getByLabel('Reason',{exact:true}).fill('Wrong lease dates');await page.getByRole('button',{name:'Void envelope',exact:true}).click();await page.getByText('Cancellation requested. Waiting for DocuSign confirmation.').waitFor();checks++;
 await page.evaluate(()=>{ctx.signing.signing.phase='completed';ctx.signing.signing.completed=true;ctx.signing.signing.signers=ctx.signing.signing.signers.map(s=>({...s,status:'completed'}));render();});
 eq(await page.getByRole('link',{name:'Download signed lease'}).count(),1);eq(await page.getByRole('link',{name:'Completion certificate'}).count(),1);
 await page.evaluate(()=>{ctx.signing={configuration:{enabled:false,canSend:false,message:'Not configured'}};ctx.row.status='landlord_approved';render();});
 eq(await page.getByRole('button',{name:'Review signing package'}).isDisabled(),true);
 eq(errors,[]);await mkdir('/tmp/star-signing-qa',{recursive:true});await page.screenshot({path:'/tmp/star-signing-qa/signing-mobile.png',fullPage:true});
 console.log('PASS '+checks+' signing browser checks: review, recipients, confirmation, single send, ordering, cancellation, downloads and disabled setup');
}finally{await browser.close();await new Promise(r=>server.close(r));}
