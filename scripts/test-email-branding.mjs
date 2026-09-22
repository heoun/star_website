import assert from 'node:assert/strict';
import {sendEmail} from '../worker/email.js';
import {MAIL_FROM,MAIL_LAYOUT_MARKER,mailShell,mailPlace,readyMail} from '../worker/mail-layout.js';
const originalFetch=globalThis.fetch;
const base={to:['recipient@example.test'],subject:'Receipt <test>',text:'Hello <script>\n\nhttps://example.test/portal/?x=1&y=2',reply_to:'office@example.test'};
let checks=0;
function verify(message){
  assert.equal(message.from,MAIL_FROM);assert(message.html.includes(MAIL_LAYOUT_MARKER));
  assert(message.html.includes('max-width:600px'));assert(message.html.includes('email-logo-v1.png'));
  assert.equal(message.reply_to,base.reply_to);assert.equal(message.text,base.text);checks+=6;
}
try {
  // The canonical sender every notification is stamped with.
  assert.equal(MAIL_FROM,'Star Real Estate <no-reply@starreusa.com>');checks++;
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
  // One property label for every notification: a title that already spells the
  // building and unit, whatever its dashes and spacing, is not repeated after them.
  const label=(title,property_name,unit)=>mailPlace({title,property_name,unit},'this home');
  for(const [title,name,unit,expected] of [
    ['DocuSign Sandbox — MOCK TEST · TEST-1','DocuSign Sandbox — MOCK TEST','TEST-1','DocuSign Sandbox — MOCK TEST · TEST-1'],
    ['DocuSign Sandbox - MOCK TEST TEST-1','DocuSign Sandbox — MOCK TEST','TEST-1','DocuSign Sandbox — MOCK TEST · TEST-1'],
    ['Property A · Unit 2A','Property A','2A','Property A · 2A'],
    ['Sunny 2BR near the park','The Ashland','4B','Sunny 2BR near the park · The Ashland · 4B'],
    ['The Ashland penthouse','The Ashland','PH1','The Ashland penthouse · PH1'],
    ['The Ashland · 4B','The Ashland 4B','4B','The Ashland 4B'],
    ['','The Ashland 4B','4B','The Ashland 4B'],
    ['Sunny 2BR near the park','The Ashland 4B','4B','Sunny 2BR near the park · The Ashland 4B'],
    ['','Ashland','Ashland 4B','Ashland 4B'],
    ['Sunny loft 4B','','4B','Sunny loft 4B'],
    ['Old marketing title','','','Old marketing title'],
    ['','The Ashland','4B','The Ashland · 4B'],
    ['','','4B','this home · 4B'],
    ['','','','this home']
  ]){assert.equal(label(title,name,unit),expected);checks++;}
  // The ready-for-review confirmation: the place once, a review promise, the
  // application link, and neither a document checklist nor a verdict.
  const link='https://example.test/portal/?application=abc',ready=readyMail({},{place:'Property A · 2A',link,test:''});
  assert.equal(ready.subject,'Application received · Property A · 2A');
  assert.equal((ready.html.match(/Property A · 2A/g) || []).length,1);
  assert(ready.html.includes('>Your application is ready for review</h1>'));
  assert(ready.html.includes(MAIL_LAYOUT_MARKER) && ready.html.includes(`href="${link}"`) && ready.text.includes(link));
  assert(!/upload|approved|credit score|passed/i.test(ready.text));
  assert.equal(readyMail({},{place:'P',link,test:'11111111-2222'}).subject,'[Internal Test 11111111] Application received · P');
  checks+=6;
  console.log(`PASS ${checks} outbound email branding checks: Resend payload, legacy HTML, plain-text receipts, branded content, sender, escaping, links, reply-to, idempotency, local preview, property labels and the ready-for-review confirmation.`);
}finally{globalThis.fetch=originalFetch;}
