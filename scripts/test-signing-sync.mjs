import assert from 'node:assert/strict';
import {makeRentalSigning} from '../backend/core/rental-signing.ts';
import {makeDocusign} from '../backend/adapters/esign-docusign/index.ts';
const now=Date.now(),stamp=n=>new Date(now+n).toISOString();let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
let record,notices,reads,downloads,retry;
const reset=()=>{record={package:{id:crypto.randomUUID(),signers:[{recipientId:'1'},{recipientId:'2'}]},version:0,phase:'in_progress',envelope:{accountId:'account',envelopeId:crypto.randomUUID(),status:'sent',statusChangedAt:stamp(-10000),recipients:[{recipientId:'1',status:'sent'},{recipientId:'2',status:'pending'}]},nextReadAt:stamp(16*60000),updatedAt:stamp(-10000)};notices=[];reads=downloads=0;};
const store={get:async()=>structuredClone(record),notices:async()=>structuredClone(notices),claimDue:async()=>[{packageId:record.package.id,claimToken:'claim'}],release:async(_id,_token,time)=>{retry=time;},save:async(r,v)=>{eq(v,record.version);record={...structuredClone(r),version:v+1};}};
const provider={read:async()=>{reads++;return structuredClone(record.envelope);},download:async()=>{downloads++;return new Response('%PDF-fixture').body;}};
const files={put:async(_id,kind)=>({path:kind})};
const flow=makeRentalSigning(store,provider,files);
const push=(status,recipients,at=stamp(-1000))=>notices.push({accountId:record.envelope.accountId,envelopeId:record.envelope.envelopeId,event:`envelope-${status}`,generatedAt:at,envelope:{...structuredClone(record.envelope),status,recipients,statusChangedAt:at}});
reset();await flow.run();eq(reads,0);eq(record.phase,'in_progress');
const completed=[{recipientId:'1',status:'completed',signedAt:stamp(-2000)},{recipientId:'2',status:'completed',signedAt:stamp(-1000)}];
push('completed',completed);await flow.run();eq(record.phase,'completed');eq(reads,0);eq(downloads,2);eq(retry,null);eq(!!record.signedPdf && !!record.certificate,true);
await flow.run();eq(downloads,2);
reset();push('sent',[completed[0],{recipientId:'2',status:'sent'}]);await flow.run();eq(record.envelope.recipients[0].status,'completed');eq(record.phase,'in_progress');eq(reads,0);
push('sent',[{recipientId:'1',status:'sent'},{recipientId:'2',status:'pending'}],stamp(-5000));await flow.run();eq(record.envelope.recipients[0].status,'completed');
// A later message with lagging recipient data cannot erase a signature either.
push('sent',[{recipientId:'1',status:'delivered'},{recipientId:'2',status:'pending'}],stamp(-500));await flow.run();eq(record.envelope.recipients[0].status,'completed');eq(record.envelope.recipients[1].status,'sent');
for(const invalid of ['wrong account','wrong envelope','wrong recipient','duplicate recipient','partial','future']){
 reset();push('completed',structuredClone(completed));const n=notices[0];
 if(invalid==='wrong account')n.envelope.accountId='another';if(invalid==='wrong envelope')n.envelope.envelopeId=crypto.randomUUID();
 if(invalid==='wrong recipient')n.envelope.recipients[0].recipientId='9';if(invalid==='duplicate recipient')n.envelope.recipients[0].recipientId='2';
 if(invalid==='partial')n.envelope.recipients.pop();if(invalid==='future')n.generatedAt=stamp(600000);
 await flow.run();eq(record.phase,'in_progress');eq(downloads,0);eq(reads,0);
}
reset();push('completed',completed);let fail=true;
const recovering=makeRentalSigning(store,{...provider,download:async(_id,kind)=>{if(kind==='certificate' && fail){fail=false;throw new Error('Temporary archive failure');}return new Response('%PDF-fixture').body;}},files);
await recovering.run();eq(record.phase,'archiving');eq(record.signedPdf.path,'signed_pdf');eq(Date.parse(retry)-Date.now()<16000,true);
await recovering.run();eq(record.phase,'completed');eq(reads,0);
// The adapter authenticates raw bytes before parsing and strips unrelated data.
const cfg={environment:'demo',accountId:'account',hmacSecret:'synthetic-hmac'},adapter=makeDocusign(cfg);
const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(cfg.hmacSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
const body={event:'envelope-completed',generatedDateTime:stamp(-1000),data:{accountId:'account',envelopeId:crypto.randomUUID(),envelopeSummary:{status:'completed',statusChangedDateTime:stamp(-1000),documentsUri:'https://untrusted.test/file',recipients:{signers:completed.map(s=>({...s,signedDateTime:s.signedAt,email:'private@example.test'}))}}}};
async function verify(b){const raw=new TextEncoder().encode(JSON.stringify(b)),signature=Buffer.from(await crypto.subtle.sign('HMAC',key,raw)).toString('base64');return adapter.verifyNotice(raw,{'x-docusign-signature-1':signature});}
let verified=await verify(body);eq(verified.envelope.status,'completed');eq(JSON.stringify(verified).includes('private@example.test'),false);eq(JSON.stringify(verified).includes('untrusted.test'),false);
body.data.envelopeSummary.recipients.signers[0].signedDateTime='invalid';verified=await verify(body);eq(verified.envelope,undefined);
console.log(`PASS ${checks} signing sync checks: authenticated push bypasses polling delay, exact signer binding, replay safety, monotonic progress and prompt archive retry.`);
