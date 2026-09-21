import assert from 'node:assert/strict';
import {sendEmail} from '../worker/email.js';
import {MAIL_FROM,MAIL_LAYOUT_MARKER,mailShell} from '../worker/mail-layout.js';
const originalFetch=globalThis.fetch;
const base={to:['recipient@example.test'],subject:'Receipt <test>',text:'Hello <script>\n\nhttps://example.test/portal/?x=1&y=2',reply_to:'office@example.test'};
let checks=0;
function verify(message){
  assert.equal(message.from,MAIL_FROM);assert(message.html.includes(MAIL_LAYOUT_MARKER));
  assert(message.html.includes('max-width:600px'));assert(message.html.includes('email-logo-v1.png'));
  assert.equal(message.reply_to,base.reply_to);assert.equal(message.text,base.text);checks+=6;
}
try {
  // Check the actual JSON sent to Resend, not just a template helper.
  for(const html of [undefined,'<div>Old unbranded email</div>',mailShell({}, {title:base.subject,heading:'Receipt',body:'<p>Branded body</p>'})]){
    let delivered,headers;
    globalThis.fetch=async(url,init)=>{assert.equal(url,'https://api.resend.com/emails');checks++;delivered=JSON.parse(init.body);headers=init.headers;return Response.json({id:'fixture-mail'});};
    const ok=await sendEmail(new Request('https://example.test'),{RESEND_API_KEY:'fixture-only'}, {...base,from:'Old sender',html},{idempotencyKey:'receipt/test'});
    assert.equal(ok,true);assert.equal(headers['Idempotency-Key'],'receipt/test');checks+=2;verify(delivered);
    if(html?.includes(MAIL_LAYOUT_MARKER)){assert.equal(delivered.html,html);checks++;}
    else {assert(delivered.html.includes('&lt;script&gt;'));assert(delivered.html.includes('href="https://example.test/portal/?x=1&amp;y=2"'));checks+=2;}
  }
  let preview;
  await sendEmail(new Request('http://localhost'),{LOCAL_EMAIL_SINK:{async send(m){preview=m;}}},base);
  verify(preview);
  console.log(`PASS ${checks} outbound email branding checks: Resend payload, legacy HTML, plain-text receipts, branded content, sender, escaping, links, reply-to, idempotency and local preview.`);
}finally{globalThis.fetch=originalFetch;}
