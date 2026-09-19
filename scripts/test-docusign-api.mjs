import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {makeDocusign,boundedBytes,envelopeDefinition} from '../backend/adapters/esign-docusign/index.ts';
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const pair=generateKeyPairSync('rsa',{modulusLength:2048}),id=crypto.randomUUID();
for(const format of ['pkcs1','pkcs8']) {
 const calls=[];let status='created',creationTimeout=false,bounced=false;
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
   if(creationTimeout)throw new DOMException('Timed out','TimeoutError');
   const definition=JSON.parse(init.body);eq(definition.status,'created');
   eq(definition.eventNotification.deliveryMode,'SIM');
   eq(definition.eventNotification.includeHMAC,'true');
   eq(definition.eventNotification.eventData,{version:'restv2.1',format:'json',includeData:['recipients']});
   eq(definition.eventNotification.events.includes('envelope-completed'),true);eq(definition.eventNotification.events.includes('recipient-autoresponded'),true);
   return Response.json({envelopeId:id});
  }
  if(url.includes('/envelopes/status?'))return Response.json({envelopes:[{envelopeId:id}]});
  if(url.endsWith('/recipients'))return Response.json({signers:[bounced?{recipientId:'1',status:'autoresponded',autoRespondedReason:'Mailbox unavailable\nTry again'}:{recipientId:'1',status:'completed',signedDateTime:'2026-09-16T00:00:00Z'}]});
  if(url.endsWith('/documents/combined') || url.endsWith('/documents/certificate'))return new Response('%PDF-test');
  if(init.method==='PUT'){status=JSON.parse(init.body).status;return Response.json({envelopeId:id});}
  return Response.json({envelopeId:id,status,statusChangedDateTime:'2026-09-16T00:00:00Z'});
 };
 const api=makeDocusign(config,mock),pkg={id:crypto.randomUUID(),documents:[{documentId:'1',name:'New York Residential Lease Agreement'}],tabs:[],signers:[{recipientId:'1',name:'Tenant',email:'tenant@example.test',routingOrder:1}]};
 const timeout=AbortSignal.timeout,deadlines=[];
 AbortSignal.timeout=ms=>{deadlines.push(ms);return timeout(ms);};
 try {
  eq((await api.createDraft({package:pkg,documents:[{documentId:'1',bytes:new Uint8Array([1,2,3])}]})).envelopeId,id);
  eq(deadlines,[20000,20000,120000]);
  await api.send(id,pkg);eq(deadlines.at(-1),30000);
 } finally {AbortSignal.timeout=timeout;}
 eq((await api.read(id)).status,'sent');
 bounced=true;const failed=(await api.read(id)).recipients[0];eq(failed.status,'delivery_failed');eq(failed.deliveryIssue,'Mailbox unavailable Try again');bounced=false;
 eq((await api.findByTransactionId(pkg.id)).envelopeId,id);
 eq(new TextDecoder().decode(await boundedBytes(await api.download(id,'signed_pdf'),100)),'%PDF-test');
 await api.void(id,'Cancelled');eq((await api.read(id)).status,'voided');
 eq(calls.filter(c=>c.url.endsWith('/oauth/token')).length,1);
 eq(calls.some(c=>c.url===`https://demo.docusign.net/restapi/v2.1/accounts/account/envelopes/status?transaction_ids=${pkg.id}` && c.method==='PUT'),true);
 eq(calls.some(c=>JSON.stringify(c).includes(config.privateKey)),false);
 creationTimeout=true;
 await assert.rejects(()=>api.createDraft({package:pkg,documents:[]}),/document preparation timed out.*existing request is retained/);checks++;
}
// Envelope-wide anchor scope: discard matches in other documents, then fail
// closed when a field is missing, duplicated, or overlaps another.
{
 const pkg={templateVersion:'star-lease-2026-09-19-anchor-v8',signers:[{recipientId:'1',role:'landlord',name:'Owner',email:'owner@example.test',routingOrder:2}],documents:[{documentId:'1',layout:'lease'},{documentId:'2',layout:'utilities'}],tabs:[
  {recipientId:'1',documentId:'1',kind:'signature',anchor:'\\LEASE-R1-SIG\\',xOffset:0,yOffset:3.33,width:120,height:44,scale:.6,units:'pixels'},
  {recipientId:'1',documentId:'1',kind:'full_name',anchor:'\\LEASE-R1-NAME\\',xOffset:0,yOffset:3.33,width:120,height:14.67,fontSize:'Size11',units:'pixels'}]};
 const definition=envelopeDefinition(pkg,[],'https://example.test/hook');
 const sign=definition.recipients.signers[0].tabs.signHereTabs[0];
 eq(sign.anchorUnits,'inches');eq(sign.anchorXOffset,'0');eq(Number(sign.anchorYOffset),3.33/96);eq(sign.scaleValue,'0.6');eq(sign.anchorMatchWholeWord,'false');
 eq(definition.recipients.signers[0].tabs.fullNameTabs[0].fontSize,'Size11');
 let tabs={signHereTabs:[{tabId:'s',tabLabel:'star-lease-field-0-v3',documentId:'1',pageNumber:'1',xPosition:'100',yPosition:'200',width:'120',height:'29'},{tabId:'wrong',tabLabel:'star-lease-field-0-v3',documentId:'2',pageNumber:'1',xPosition:'100',yPosition:'200'}],fullNameTabs:[{tabId:'n',tabLabel:'star-lease-field-1-v3',documentId:'1',pageNumber:'1',xPosition:'100',yPosition:'240',width:'200',height:'15'}]};
 let sent=0,deleted=0;
 const http=async(url,init={})=>{
  if(url.endsWith('/oauth/token'))return Response.json({access_token:'fake'});
  if(url.endsWith('/oauth/userinfo'))return Response.json({accounts:[{account_id:'account',base_uri:'https://demo.docusign.net'}]});
  if(url.includes('/tabs')){
   if(init.method==='DELETE'){const body=JSON.parse(init.body);for(const kind of Object.keys(body))tabs[kind]=tabs[kind].filter(t=>!body[kind].some(d=>d.tabId===t.tabId));deleted++;}
   if(init.method==='PUT')throw new Error('Tabs are never rewritten after conversion.');
   return Response.json(tabs);
  }
  if(init.method==='PUT' && JSON.parse(init.body).status==='sent'){sent++;return Response.json({});}
  throw new Error('Unexpected mock endpoint');
 };
 const api=makeDocusign({environment:'demo',integrationKey:'integration',userId:'sender',accountId:'account',privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}),hmacSecret:'test',webhookUrl:'https://example.test/hook'},http);
 await api.send(id,pkg);eq(sent,1);eq(deleted,1);eq(tabs.signHereTabs.length,1);
 await api.send(id,pkg);eq(deleted,1);eq(sent,2);
 // Two of one signer's fields on the same page and spot.
 tabs.fullNameTabs[0].yPosition='220';
 await assert.rejects(()=>api.send(id,pkg),/overlap/);checks++;eq(sent,2);
 // A signature control's transparent footer may cover the name control.
 // Its visible stamp still must not touch the name itself.
 pkg.tabs[0].inkHeight=20;pkg.tabs[0].inkLift=12;
 await api.send(id,pkg);eq(sent,3);
 tabs.fullNameTabs[0].yPosition='208';
 await assert.rejects(()=>api.send(id,pkg),/overlap/);checks++;eq(sent,3);
 delete pkg.tabs[0].inkHeight;delete pkg.tabs[0].inkLift;
 await assert.rejects(()=>api.send(id,{...pkg,templateVersion:'star-lease-2026-09-19-anchor-v7'}),/outdated signing layout/);checks++;eq(sent,3);
 tabs.fullNameTabs=[];
 await assert.rejects(()=>api.send(id,pkg),/does not match the reviewed signing fields/);checks++;eq(sent,3);
 tabs.fullNameTabs=[{tabId:'n',tabLabel:'star-lease-field-1-v3',documentId:'1',pageNumber:'1',xPosition:'100',yPosition:'240'}];
 tabs.signHereTabs.push({...tabs.signHereTabs[0],tabId:'duplicate'});
 await assert.rejects(()=>api.send(id,pkg),/does not match the reviewed signing fields/);checks++;eq(sent,3);
}
await assert.rejects(()=>boundedBytes(new Response('12345').body,4));checks++;
console.log(`PASS ${checks} DocuSign API checks: PKCS#1/PKCS#8 JWT, account discovery, draft/send, transaction recovery, downloads and void`);
