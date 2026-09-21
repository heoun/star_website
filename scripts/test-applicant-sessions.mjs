// Two tabs share a cookie jar but select different authenticated sessions.
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import {createIdentityFixture} from './identity-fixtures.mjs';
import {completeDemoState,DEMO_ENCRYPTION_KEY} from './demo-data.mjs';
import {ids} from '../backend/tools/workspace-fixtures.mjs';
const {fixture,env,user,restore}=createIdentityFixture();
await completeDemoState(fixture.state);
Object.assign(env,{APP_ENCRYPTION_KEY:DEMO_ENCRYPTION_KEY,RENTAL_AUTOMATION:'on',RENTAL_SCREENING:'mock',LOCAL_EMAIL_SINK:{async send(m){fixture.state.emails.push(m);}}});
const lead=user('parallel-lead@example.test'),mate=user('parallel-mate@example.test');
const a=crypto.randomUUID(),b=crypto.randomUUID(),jar=new Map(),pending=[];
let checks=0;const eq=(x,y)=>{assert.deepEqual(x,y);checks++;};
async function call(path,selector,body,method=body?'POST':'GET') {
 const response=await worker.fetch(new Request('http://127.0.0.1'+path,{method,headers:{Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...(selector===undefined?{}:{'X-Applicant-Session':selector}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env,{waitUntil:p=>pending.push(p)});
 for(const cookie of response.headers.getSetCookie()){const [name,...value]=cookie.split(';')[0].split('=');if(cookie.includes('Max-Age=0'))jar.delete(name);else jar.set(name,value.join('='));}
 return response;
}
const login=(email,selector)=>call('/api/portal/login',selector,{email,password:'testing-password'});
const me=async selector=>{const r=await call('/api/portal/me',selector);return{status:r.status,...await r.json()};};
try {
 eq((await login(lead.email,a)).status,200);eq((await login(mate.email,b)).status,200);
 eq(jar.size,2);eq((await me(a)).email,lead.email);eq((await me(b)).email,mate.email);
 // Unknown/invalid selectors never borrow another slot, including legacy cookies.
 await login('applicant@example.test');
 eq((await me()).email,'applicant@example.test');eq((await me(crypto.randomUUID())).status,401);
 eq((await me('invalid')).status,401);eq((await login(lead.email,'invalid')).status,400);
 eq((await call('/api/portal/me?applicant_session='+b,a)).status,401);
 // Refresh and logout touch exactly the selected cookie and provider session.
 const nameA=`star_portal_${a}`,nameB=`star_portal_${b}`,mateCookie=jar.get(nameB);
 const decoded=JSON.parse(Buffer.from(jar.get(nameA),'base64url'));
 jar.set(nameA,Buffer.from(JSON.stringify({...decoded,at:'expired'})).toString('base64url'));
 eq((await me(a)).email,lead.email);eq(jar.get(nameB),mateCookie);
 const payload={...fixture.state.applications[0],listing_id:ids.listing,id_type:'passport',id_number:'TEST12345',sales_person:'',roommates:[]};
 const group=crypto.randomUUID();
 eq((await call('/api/apply/invite',a,{listing_id:ids.listing,draft_group_id:group,roommates:[{email:mate.email,first_name:'Parallel',last_name:'Mate'}]})).status,200);
 eq((await call('/api/apply',b,{...payload,group_root:group,account_email:lead.email})).status,409);
 const mateResponse=await call('/api/apply',b,{...payload,group_root:group,account_email:mate.email,invited_email:mate.email});eq(mateResponse.status,201);
 const leadResponse=await call('/api/apply',a,{...payload,draft_group_id:group,account_email:lead.email});eq(leadResponse.status,201);
 const leadId=(await leadResponse.json()).application_id,mateId=(await mateResponse.json()).application_id;
 eq(fixture.state.applications.find(r=>r.id===leadId).email,lead.email);eq(fixture.state.applications.find(r=>r.id===mateId).email,mate.email);
 eq(fixture.state.applications.filter(r=>r.rental_group_id===group).length,2);
 const doc={id:crypto.randomUUID(),application_id:leadId,path:`${leadId}/test.pdf`,file_name:'test.pdf',content_type:'application/pdf',doc_type:'government_id_front',size_bytes:20};
 fixture.state.documents.push(doc);fixture.state.files[doc.path]=[...new TextEncoder().encode('%PDF-1.4 synthetic')];
 eq((await call(`/api/portal/documents/${doc.id}?applicant_session=${a}`)).status,200);
 eq((await call(`/api/portal/documents/${doc.id}?applicant_session=${b}`)).status,404);
 eq((await call('/api/portal/sign-out',b,{})).status,200);await Promise.all(pending.splice(0));
 eq((await me(b)).status,401);eq((await me(a)).email,lead.email);eq((await me()).email,'applicant@example.test');
 eq(jar.has(nameB),false);eq(jar.has(nameA),true);
 // The browser selector holds no credentials and each page captures its own
 // context, including when a new invitation opens in a duplicated tab.
 const original={fetch:globalThis.fetch,location:globalThis.location,sessionStorage:globalThis.sessionStorage};
 const storage=new Map();let requestHeaders;
 globalThis.sessionStorage={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)};
 globalThis.location={href:'http://127.0.0.1/apply/',origin:'http://127.0.0.1'};
 globalThis.fetch=async(input,options)=>{requestHeaders=options.headers;return Response.json({});};
 try {
  const {createApplicantSession}=await import('../site/shared/applicant-session.js');
  const tabA=createApplicantSession(lead.email);await tabA.fetch('/api/portal/me');const selectorA=requestHeaders.get('X-Applicant-Session');
  const tabB=createApplicantSession(mate.email);await tabB.fetch('/api/portal/me');const selectorB=requestHeaders.get('X-Applicant-Session');
  assert.notEqual(selectorA,selectorB);checks++;
  await tabA.fetch('/api/apply',{method:'POST'});eq(requestHeaders.get('X-Applicant-Session'),selectorA);
  eq(createApplicantSession(mate.email).documentUrl('/api/portal/documents/test'),`/api/portal/documents/test?applicant_session=${selectorB}`);
  eq(Object.keys(JSON.parse(storage.get('star-applicant-context'))).sort(),['email','id']);
 } finally {Object.assign(globalThis,original);}
 console.log(`PASS ${checks} simultaneous applicant session checks: shared cookies, isolated identities, refresh/logout, roommate-first intake, private documents and tab selection`);
} finally {await Promise.allSettled(pending);restore();}
