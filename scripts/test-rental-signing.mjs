import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {makeRentalSigning} from '../backend/core/rental-signing.ts';
import {makeDocusign,envelopeDefinition} from '../backend/adapters/esign-docusign/index.ts';
import {buildSigningLease,sha256} from '../worker/signing-template.js';
import {signingConfiguration} from '../worker/signing.js';
import {SIGNING_DOCUMENTS,hasConcession} from '../site/shared/lease-signing-layout.js';
import {readEntries,readEntryText} from '../worker/zip.js';
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};const reject=async f=>{await assert.rejects(f);checks++;};
const template=readFileSync('lease/template/lease-template.docx');
const registry=JSON.parse(readFileSync('lease/schema/fields.json','utf8'));
const values=Object.fromEntries(registry.fields.map(f=>[f.id,f.default??'Example']));
const signers=[{recipientId:'1',memberId:'a',role:'tenant',name:'Tenant A',email:'a@example.test',routingOrder:1},{recipientId:'2',memberId:'b',role:'tenant',name:'Tenant B',email:'b@example.test',routingOrder:1},{recipientId:'3',memberId:null,role:'landlord',name:'Landlord',email:'l@example.test',routingOrder:2}];
const document=await buildSigningLease({ASSETS:{fetch:async()=>new Response(template)}},new Request('http://localhost/'),values,signers);
eq(document.tabs.length,99);eq(document.documents.length,19);
for(const signer of signers){eq(document.tabs.filter(t=>t.recipientId===signer.recipientId && t.kind==='signature').length,signer.role==='tenant'?15:17);eq(document.tabs.filter(t=>t.recipientId===signer.recipientId && t.kind==='full_name').length,signer.role==='tenant'?12:13);}
eq(document.tabs.filter(t=>t.kind==='initial').length,4);
eq(document.tabs.filter(t=>t.kind==='date_signed').length,11);
for(const layout of ['utilities','packages','keys','insurance','rules','fines']){
 const tabs=document.tabs.filter(t=>t.layout===layout);
 eq(tabs.length,6);eq(new Set(tabs.map(t=>t.id)).size,6);
 for(const signer of signers)eq(tabs.filter(t=>t.recipientId===signer.recipientId).map(t=>t.kind),['signature','full_name']);
}
const entries=b=>readEntries(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
// Resources and signature tables are retained. Each one-line notice is a separate copy.
for(const d of document.documents){
 for(const name of ['word/styles.xml','word/numbering.xml'])eq(await readEntryText(entries(d.bytes),name),await readEntryText(entries(template),name));
 const fields=document.tabs.filter(t=>t.documentId===d.documentId);
 eq(fields.every(t=>t.layout===d.layout),true);
 if(d.tenantRecipientId){
  eq(fields.filter(t=>t.role==='tenant').every(t=>t.recipientId===d.tenantRecipientId),true);
  eq(d.xml.includes(signers.find(s=>s.recipientId===d.tenantRecipientId).name),true);
 }
 if(d.layout==='allergen')eq(fields.map(t=>[t.role,t.kind]),[['landlord','signature'],['landlord','full_name'],['landlord','date_signed']]);
}
for(const text of ['', '  ', 'None', 'N/A', 'No rent concession in this mock tenancy.','MOCK TEST ONLY — NOT A REAL TENANCY'])eq(hasConcession({'concession.terms':text}),false);
const noConcession=await buildSigningLease({ASSETS:{fetch:async()=>new Response(template)}},new Request('http://localhost/'),{...values,'concession.terms':''},signers);
eq(noConcession.tabs.some(t=>t.layout==='concession'),false);
eq(hasConcession({'concession.terms':'A one-time $500 credit against October rent.'}),true);
const pkg={id:crypto.randomUUID(),rentalId:'rental',createdAt:new Date().toISOString(),createdBy:'agent@example.test',signers,tabs:document.tabs,documents:await Promise.all(document.documents.map(async d=>({documentId:d.documentId,name:d.name,file:{sha256:await sha256(d.bytes)}})))};
const definition=envelopeDefinition(pkg,document.documents,'https://example.test/api/webhooks/docusign');
eq(definition.status,'created');eq(definition.recipients.signers.map(s=>s.routingOrder),['1','1','2']);eq(definition.recipients.signers[0].tabs.signHereTabs.every(t=>t.anchorIgnoreIfNotPresent==='false'),true);
eq(definition.eventNotification.includeHMAC,'true');eq(definition.allowReassign,'false');
// Generate every supported tenant slot; each gets its own complete signature set.
const many=Array.from({length:8},(_,i)=>({...signers[0],recipientId:String(i+1),memberId:String(i),name:`Tenant ${i+1}`}));
const large=await buildSigningLease({ASSETS:{fetch:async()=>new Response(template)}},new Request('http://localhost/'),values,[...many,{...signers[2],recipientId:'9'}]);eq(large.documents.length,37);
eq(large.tabs.length,315);
eq(definition.recipients.signers[0].tabs.fullNameTabs.length,12);
eq(definition.recipients.signers[0].tabs.dateSignedTabs.length,3);
await reject(()=>buildSigningLease({ASSETS:{fetch:async()=>new Response(template)}},new Request('http://localhost/'),values,[...many,...signers]));
const config={environment:'demo',integrationKey:'key',userId:'user',accountId:'account',privateKey:'',hmacSecret:'hmac-test-secret',webhookUrl:'https://example.test/api/webhooks/docusign'};
const provider=makeDocusign(config);
const raw=new TextEncoder().encode(JSON.stringify({event:'envelope-completed',generatedDateTime:'2026-09-16T00:00:00Z',data:{accountId:'account',envelopeId:crypto.randomUUID()}}));
const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(config.hmacSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,raw)).toString('base64');
eq((await provider.verifyNotice(raw,{'x-docusign-signature-1':signature})).accountId,'account');
eq(await provider.verifyNotice(new TextEncoder().encode('{}'),{'x-docusign-signature-1':signature}),null);eq(await provider.verifyNotice(raw,{}),null);
eq(await makeDocusign({...config,accountId:'wrong'}).verifyNotice(raw,{'x-docusign-signature-1':signature}),null);
// Actual core state machine with an in-memory CAS repository and provider.
let state,remote,creates,sends,downloads,retry,failCreate,failArchive;
function reset(){state={package:structuredClone(pkg),phase:'preparing',version:0,envelope:null};remote=null;creates=sends=downloads=0;failCreate=failArchive=false;}
const store={get:async()=>structuredClone(state),claimDue:async()=>[{packageId:pkg.id,claimToken:'claim'}],release:async(_id,_t,r)=>{retry=r;},save:async(record,v)=>{assert.equal(state.version,v);state={...structuredClone(record),version:v+1};}};
const fake={findByTransactionId:async()=>structuredClone(remote),createDraft:async()=>{creates++;remote={accountId:'account',envelopeId:'envelope',status:'created',recipients:signers.map(s=>({recipientId:s.recipientId,status:'pending'}))};if(failCreate){failCreate=false;throw new Error('Response lost');}return structuredClone(remote);},read:async()=>structuredClone(remote),send:async()=>{sends++;remote.status='sent';},void:async()=>{remote.status='voided';},download:async()=>{downloads++;if(failArchive){failArchive=false;throw new Error('Archive retry');}return new Response('%PDF-test').body;}};
const files={read:async file=>new Response(document.documents[pkg.documents.findIndex(d=>d.file.sha256===file.sha256)]?.bytes || document.docx).body,put:async(_id,kind)=>({path:kind})};
const flow=makeRentalSigning(store,fake,files);
reset();await flow.run();eq([creates,sends,state.phase],[1,1,'in_progress']);await flow.run();eq([creates,sends],[1,1]);
remote.status='completed';remote.recipients=remote.recipients.map(r=>({...r,status:'completed',signedAt:'2026-09-16T00:00:00Z'}));failArchive=true;
state.nextReadAt=undefined;await flow.run();eq(state.phase,'archiving');eq(!!retry,true);state.nextReadAt=undefined;await flow.run();eq(state.phase,'completed');eq(state.certificate.path,'certificate');eq(retry,null);
reset();failCreate=true;await flow.run();eq(state.phase,'needs_attention');await flow.run();eq([creates,sends,state.phase],[1,1,'in_progress']);
reset();state.package.createdAt='2020-01-01';await flow.run();eq(state.phase,'needs_attention');eq(creates,0);eq(retry,null);
reset();state.voidReason='Cancelled before dispatch';await flow.run();eq(state.phase,'voided');eq(creates,0);
reset();await flow.run();state.voidReason='Wrong dates';await flow.run();eq(state.phase,'voided');eq(sends,1);
reset();await flow.run();remote.status='declined';await flow.run();eq(state.phase,'declined');eq(retry,null);
reset();await flow.run();remote.status='completed';await flow.run();eq(state.phase,'needs_attention');eq(downloads,0);
reset();state.package.documents[0].file.sha256='tampered';await flow.run();eq(creates,0);eq(state.phase,'needs_attention');
const env={RENTAL_AUTOMATION:'on',DOCUSIGN_ENABLED:'on',DOCUSIGN_ENVIRONMENT:'demo',DOCUSIGN_INTEGRATION_KEY:'key',DOCUSIGN_USER_ID:'user',DOCUSIGN_ACCOUNT_ID:'account',DOCUSIGN_PRIVATE_KEY:'key',DOCUSIGN_CONNECT_HMAC_SECRET:'secret',DOCUSIGN_WEBHOOK_URL:'https://example.test/api/webhooks/docusign'};
eq(signingConfiguration(env,new Request('http://localhost/')).canSend,false);
eq(signingConfiguration(env,new Request('https://example.test/')).canSend,false); // scheduled dev cannot evade the sandbox switch
const on={...env,DEV_DOCUSIGN_SEND:'on'};eq(signingConfiguration(on,new Request('http://localhost/')).canSend,true);
eq(signingConfiguration({...on,DOCUSIGN_ENVIRONMENT:'production'},new Request('http://localhost/')).canSend,false);
console.log(`PASS ${checks} signing checks: anchors, recipients, HMAC, recovery, cancellation, archives and development safeguards`);
