import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {makeDocusign,boundedBytes} from '../backend/adapters/esign-docusign/index.ts';
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const pair=generateKeyPairSync('rsa',{modulusLength:2048}),id=crypto.randomUUID();
for(const format of ['pkcs1','pkcs8']) {
 const calls=[];let status='created';
 const config={environment:'demo',integrationKey:'integration',userId:'sender',accountId:'account',privateKey:pair.privateKey.export({type:format,format:'pem'}).replaceAll('\n','\\n'),hmacSecret:'secret',webhookUrl:'https://app.example.test/api/webhooks/docusign'};
 const mock=async(url,init={})=>{
  calls.push({url,method:init.method || 'GET',body:init.body});
  if(url.endsWith('/oauth/token')) {
   const jwt=init.body.get('assertion'),[head,payload,sig]=jwt.split('.');
   eq(verify('RSA-SHA256',Buffer.from(`${head}.${payload}`),pair.publicKey,Buffer.from(sig,'base64url')),true);
   const claims=JSON.parse(Buffer.from(payload,'base64url'));eq(claims.scope,'signature impersonation');eq(claims.aud,'account-d.docusign.com');eq(claims.sub,'sender');
   return Response.json({access_token:'test-token'});
  }
  eq(init.headers.Authorization,'Bearer test-token');
  if(url.endsWith('/oauth/userinfo'))return Response.json({accounts:[{account_id:'account',base_uri:'https://demo.docusign.net'}]});
  if(url.endsWith('/envelopes') && init.method==='POST'){
   const definition=JSON.parse(init.body);eq(definition.status,'created');
   eq(definition.eventNotification.deliveryMode,'SIM');
   eq(definition.eventNotification.includeHMAC,'true');
   eq(definition.eventNotification.eventData,{version:'restv2.1',format:'json',includeData:['recipients']});
   eq(definition.eventNotification.events.includes('envelope-completed'),true);
   return Response.json({envelopeId:id});
  }
  if(url.includes('/envelopes/status?'))return Response.json({envelopes:[{envelopeId:id}]});
  if(url.endsWith('/recipients'))return Response.json({signers:[{recipientId:'1',status:'completed',signedDateTime:'2026-09-16T00:00:00Z'}]});
  if(url.endsWith('/documents/combined') || url.endsWith('/documents/certificate'))return new Response('%PDF-test');
  if(init.method==='PUT'){status=JSON.parse(init.body).status;return Response.json({envelopeId:id});}
  return Response.json({envelopeId:id,status,statusChangedDateTime:'2026-09-16T00:00:00Z'});
 };
 const api=makeDocusign(config,mock),pkg={id:crypto.randomUUID(),tabs:[],signers:[{recipientId:'1',name:'Tenant',email:'tenant@example.test',routingOrder:1}]};
 eq((await api.createDraft({package:pkg,documents:[{documentId:'1',bytes:new Uint8Array([1,2,3])}]})).envelopeId,id);
 await api.send(id);eq((await api.read(id)).status,'sent');
 eq((await api.findByTransactionId(pkg.id)).envelopeId,id);
 eq(new TextDecoder().decode(await boundedBytes(await api.download(id,'signed_pdf'),100)),'%PDF-test');
 await api.void(id,'Cancelled');eq((await api.read(id)).status,'voided');
 eq(calls.filter(c=>c.url.endsWith('/oauth/token')).length,1);
 eq(calls.some(c=>c.url===`https://demo.docusign.net/restapi/v2.1/accounts/account/envelopes/status?transaction_ids=${pkg.id}` && c.method==='PUT'),true);
 eq(calls.some(c=>JSON.stringify(c).includes(config.privateKey)),false);
}
await assert.rejects(()=>boundedBytes(new Response('12345').body,4));checks++;
console.log(`PASS ${checks} DocuSign API checks: PKCS#1/PKCS#8 JWT, account discovery, draft/send, transaction recovery, downloads and void`);
