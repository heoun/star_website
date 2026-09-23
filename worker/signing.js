import { signingFor, boundedBytes } from '../backend/app/rental-signing.ts';
import { requireConfig, fetchStaff, fetchBuilding, fetchLeaseLayers } from './supabase.js';
import { rentalMode, rentalWorkflow, householdApplication } from './rentals.js';
import { requireDocsBucket } from './portal.js';
import { missingIn, dealValues, resolveValues } from './lease.js';
import { buildSigningLease, sha256 } from './signing-template.js';
import { SIGNING_TEMPLATE_VERSION, SIGNING_LAYOUT_REVIEW_REQUIRED } from '../site/shared/lease-signing-layout.js';
import { internalTesting,internalTestListing,internalTestRoommates } from '../backend/app/internal-testing.ts';
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const error=(message,status=409)=>Object.assign(new Error(message),{status});
const uuid=v=>typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const email=v=>String(v || '').trim().toLowerCase();
const enabled=env=>rentalMode(env) && env.DOCUSIGN_ENABLED==='on';
// JSONB can reorder object keys. Compare signer identity and routing values,
// retaining recipient order because the document anchors use recipient IDs.
const sameSigners=(current,saved)=>Array.isArray(saved) && current.length===saved.length && current.every((signer,index)=>
  ['recipientId','memberId','role','routingOrder','name','email'].every(key=>signer[key]===saved[index]?.[key]));
export function signingConfiguration(env,request) {
  const required=['DOCUSIGN_INTEGRATION_KEY','DOCUSIGN_USER_ID','DOCUSIGN_ACCOUNT_ID','DOCUSIGN_PRIVATE_KEY','DOCUSIGN_CONNECT_HMAC_SECRET','DOCUSIGN_WEBHOOK_URL'];
  const missing=required.filter(k=>!String(env[k] || '').trim());
  if(!['demo','production'].includes(env.DOCUSIGN_ENVIRONMENT))missing.push('DOCUSIGN_ENVIRONMENT');
  let validUrl=false;try{const u=new URL(env.DOCUSIGN_WEBHOOK_URL);validUrl=u.protocol==='https:' && !u.username && !u.password && u.pathname==='/api/webhooks/docusign';}catch{}
  if(!validUrl && !missing.includes('DOCUSIGN_WEBHOOK_URL'))missing.push('DOCUSIGN_WEBHOOK_URL');
  const local=['127.0.0.1','localhost','[::1]'].includes(new URL(request.url).hostname);
  return {enabled:enabled(env),configured:!missing.length,placementReviewRequired:SIGNING_LAYOUT_REVIEW_REQUIRED,environment:env.DOCUSIGN_ENVIRONMENT || 'demo',
    canSend:enabled(env) && !missing.length && (!local || env.DOCUSIGN_ENVIRONMENT==='demo') && (env.DOCUSIGN_ENVIRONMENT!=='demo' || env.DEV_DOCUSIGN_SEND==='on'),
    message:!enabled(env)?'DocuSign signing is not enabled.':missing.length?'DocuSign is not connected. An administrator must finish the signing setup.':local && env.DOCUSIGN_ENVIRONMENT==='production'?'Local development must use the DocuSign demo environment.':env.DOCUSIGN_ENVIRONMENT==='demo' && env.DEV_DOCUSIGN_SEND!=='on'?'Sandbox sending is disabled in the development settings.':'Ready'};
}
export function signingFiles(env) {
  const bucket=requireDocsBucket(env);
  return {
    async put(id,kind,stream) {
      const data=await boundedBytes(stream,kind==='source_docx'?10*1024*1024:25*1024*1024);
      const pdf=kind!=='source_docx';
      if(data.length<5 || (pdf && new TextDecoder().decode(data.subarray(0,5))!=='%PDF-'))throw error('The signing provider returned an invalid PDF.',502);
      const hash=await sha256(data),path=`rental-signing/${id}/${kind}-${hash}.${pdf?'pdf':'docx'}`;
      const contentType=pdf?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      if(kind==='source_docx' || !await bucket.head(path))await bucket.put(path,data,{httpMetadata:{contentType}});
      return {path,name:`${kind}.${pdf?'pdf':'docx'}`,size:data.length,sha256:hash,contentType,uploaded_at:new Date().toISOString()};
    },
    async read(file){const object=await bucket.get(file.path);if(!object)throw error('The saved signing document is unavailable.',503);return object.body;}
  };
}
function safeRecord(record) {
  if(!record)return null;
  const firstOrder=Math.min(...record.package.signers.map(s=>s.routingOrder));
  return {id:record.package.id,phase:record.phase,issue:record.issue || '',updated_at:record.updatedAt,
    template_version:record.package.templateVersion,created_at:record.package.createdAt,
    envelope_id:record.envelope?.envelopeId || null,void_requested:!!record.voidReason,uploading:!!record.creationAttemptedAt,
    signers:record.package.signers.map(s=>{
      const recipient=record.envelope?.recipients.find(r=>r.recipientId===s.recipientId);
      // Older records retained the draft's pending recipients after a successful
      // send. Only the first routing group was invited; never mark the landlord
      // sent until DocuSign reports that their turn has started.
      const status=recipient?.status==='pending' && s.routingOrder===firstOrder && ['sent','delivered'].includes(record.envelope?.status)?'sent':recipient?.status;
      return {...s,...recipient,...(status?{status}:{})};
    }),
    completed:record.phase==='completed',source_sha256:(record.package.reviewFile || record.package.documents[0].file).sha256,
    documents:record.package.documents.map(d=>({documentId:d.documentId,layout:d.layout,tenantRecipientId:d.tenantRecipientId,name:d.name,sha256:d.file.sha256})),values:{'concession.terms':record.package.values['concession.terms']}};
}
async function recipients(env,g,request,reviewOnly=false) {
  const tenants=g.members.map((m,i)=>({recipientId:String(i+1),memberId:m.id,role:'tenant',routingOrder:1,name:String(m.name || '').trim(),email:email(m.email)}));
  const w=g.root.workspace,approvedEmail=email(w?.recommendation?.landlord_email);
  const [allStaff,building]=await Promise.all([fetchStaff(env),fetchBuilding(env,g.root.listings?.building_id)]);
  // An authorized preview uses today's property signer, not an old recommendation.
  const landlordEmail=reviewOnly?email(building?.landlord_signer_email):approvedEmail;
  const staff=allStaff.filter(s=>s.active && s.role==='landlord' && s.property_ids?.includes(g.root.listings?.building_id));
  if(!reviewOnly && (!staff.some(s=>email(s.email)===landlordEmail) || (building?.landlord_signer_email && email(building.landlord_signer_email)!==landlordEmail)))throw error('The approved landlord is no longer this property’s signer. Review the landlord assignment.');
  const signers=[...tenants,{recipientId:String(tenants.length+1),memberId:null,role:'landlord',routingOrder:2,name:String(g.root.lease_snapshot?.['landlord.print_name'] || '').trim(),email:landlordEmail}];
  // Sandbox envelopes hold five recipients, so an internal run signs with at
  // most four tenants, every one of them a designated test inbox.
  const inboxes=[email(env.INTERNAL_TEST_EMAIL),...internalTestRoommates(env)];
  if(w?.test_run && (!internalTesting(env,request) || !internalTestListing(env,g.root.listings?.id) || !tenants.length || tenants.length>4 || tenants.some(t=>!inboxes.includes(t.email)) || landlordEmail!==email(env.INTERNAL_TEST_LANDLORD_EMAIL)))throw error('Internal test signing is limited to the configured test listing and recipient inboxes.',403);
  if(signers.some(s=>!s.name || s.name.length>100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) || (!reviewOnly && new Set(signers.map(s=>s.email)).size!==signers.length))throw error('Each signer needs a legal name (up to 100 characters) and a distinct valid email address.');
  return signers;
}
function assertLease(flow,g) {
  flow.assertReady(g);
  const w=g.root.workspace;
  if(g.root.status!=='landlord_approved' || w?.landlord_decision?.outcome!=='accepted' || w.landlord_decision.revision!==w.recommendation?.revision || !w.lease_preparation || !g.root.lease_snapshot || missingIn(g.root.lease_snapshot).length || Object.keys(w.signature_receipts || {}).length || w.tenant_signature)throw error('A complete, unsigned lease with the current landlord approval is required.');
}
export async function handleRentalSigning(request,env,identity,id,ctx) {
  try {
    if(!['manager','agent'].includes(identity.role) || identity.owner)throw error('Staff access is required.',403);
    const config=signingConfiguration(env,request);
    if(!config.enabled)return json({configuration:config,signing:null},request.method==='GET'?200:503);
    const workflow=rentalWorkflow(env,request),g=await workflow.load(identity,id);
    const reviewOnly=env.APP_ENV==='staging' && identity.role==='manager' && String(env.LEASE_REVIEW_ONLY_CASE_IDS || '').split(',').includes(id);
    if(reviewOnly){config.reviewOnly=true;config.canSend=false;config.message='Admin-authorized review only. Landlord confirmation is skipped for this review; sending is disabled.';}
    if(g.root.id!==id)throw error('Open the shared rental to send its lease.');
    const files=signingFiles(env),flow=signingFor(requireConfig(env),env,files),url=new URL(request.url);
    if(request.method==='GET') {
      const packageId=url.searchParams.get('package');
      if(packageId && !uuid(packageId))throw error('Signing package not found.',404);
      const record=packageId?await flow.store.get(packageId):await flow.store.current(id);
      if(record && record.package.rentalId!==id)throw error('Signing package not found.',404);
      const kind=url.searchParams.get('file');
      if(kind) {
        const file=record && (kind==='source'?(url.searchParams.has('document')?record.package.documents.find(d=>d.documentId===url.searchParams.get('document'))?.file:record.package.reviewFile || record.package.documents[0].file):record.phase==='completed'?kind==='certificate'?record.certificate:kind==='signed'?record.signedPdf:null:null);
        if(!file)throw error('Signing file is unavailable.',404);
        return new Response(await files.read(file),{headers:{'Content-Type':file.contentType,'Content-Disposition':`attachment; filename="${kind==='source'?'lease-for-review.docx':kind==='certificate'?'completion-certificate.pdf':'signed-lease.pdf'}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }
      return json({configuration:config,signing:safeRecord(record)});
    }
    if(request.method!=='POST')return json({error:'Method not allowed.'},405);
    const body=await request.json();
    if(body.action==='prepare') {
      if(!reviewOnly)assertLease(workflow,g);
      if(body.version!==g.root.workspace_version)throw error('The rental changed. Refresh and review it again.');
      const prior=await flow.store.current(id);
      if(prior && !['voided','declined'].includes(prior.phase))return json({configuration:config,signing:safeRecord(prior),reserved:true});
      let values=g.root.lease_snapshot;
      const revision=g.root.workspace?.recommendation?.revision || 0;
      if(reviewOnly){
        const building=await fetchBuilding(env,g.root.listings.building_id),layers=await fetchLeaseLayers(env,g.root.listing_id);
        const deal=dealValues({application:householdApplication(g),listing:g.root.listings,building,today:null});
        values=resolveValues({layers,deal,overrides:{...g.root.workspace?.lease_overrides,...g.root.workspace?.terms}}).values;
      }
      const [signers,previews]=await Promise.all([recipients(env,reviewOnly?{...g,root:{...g.root,lease_snapshot:values}}:g,request,reviewOnly),flow.store.previews(id)]);
      const versions=Object.fromEntries(g.members.map(m=>[m.id,m.workspace_version || 0]));
      const saved=previews.find(p=>p.record.package.templateVersion===SIGNING_TEMPLATE_VERSION && p.record.package.approvalRevision===revision && Object.keys(values).every(key=>p.record.package.values[key]===values[key]) && sameSigners(signers,p.record.package.signers) && Object.keys(p.member_versions).length===g.members.length && g.members.every(m=>p.member_versions[m.id]===versions[m.id]));
      if(saved)return json({configuration:config,signing:safeRecord(saved.record),preview:true});
      const packageId=crypto.randomUUID();
      let document;try{document=await buildSigningLease(env,request,values,signers,Object.fromEntries(g.members.map(m=>[m.id,{'tenant.mailing_address':m.current_address || ''}])));}catch(e){throw error(e.message,409);}
      // Bound storage concurrency instead of paying one round trip per document.
      const sources=[{bytes:document.docx},...document.documents],stored=new Array(sources.length);
      let cursor=0;
      await Promise.all(Array.from({length:4},async()=>{while(cursor<sources.length){const i=cursor++;stored[i]=await files.put(packageId,'source_docx',new Response(sources[i].bytes).body);}}));
      const file=stored[0],documents=document.documents.map((d,i)=>({documentId:d.documentId,layout:d.layout,tenantRecipientId:d.tenantRecipientId,name:d.name,file:stored[i+1]}));
      const pkg={id:packageId,rentalId:id,approvalRevision:revision,templateVersion:document.templateVersion,
        propertyLabel:[g.root.listings?.property_name || g.root.listings?.title,g.root.listings?.unit && `Unit ${g.root.listings.unit}`].filter(Boolean).join(' '),
        values,reviewFile:file,documents,signers,tabs:document.tabs,createdAt:new Date().toISOString(),createdBy:identity.email};
      const record=await flow.store.preview(pkg,versions);
      return json({configuration:config,signing:safeRecord(record),preview:true});
    }
    if(!uuid(body.packageId))throw error('Choose the reviewed signing package.');
    const record=await flow.store.get(body.packageId);
    if(!record || record.package.rentalId!==id)throw error('Signing package not found.',404);
    if(body.action==='send') {
      if(!config.canSend)throw error(config.message,503);
      const prior=await flow.store.current(id);
      if(prior?.package.id===record.package.id)return json({signing:safeRecord(prior),configuration:config});
      assertLease(workflow,g);
      if(body.version!==g.root.workspace_version)throw error('The rental changed. Prepare and review the lease again.');
      const signers=await recipients(env,g,request);
      if(!sameSigners(signers,record.package.signers))throw error('The signers changed. Prepare a new signing package.');
      if(record.package.templateVersion!==SIGNING_TEMPLATE_VERSION)throw error('The signing layout changed. Prepare a new signing package.');
      if(SIGNING_LAYOUT_REVIEW_REQUIRED)throw error('Signature placement review is in progress. Confirm all 15 documents before sending.');
      const reserved=await flow.store.reserve({package:record.package,principal:identity,expectedMemberVersions:Object.fromEntries(g.members.map(m=>[m.id,m.workspace_version || 0]))});
      ctx?.waitUntil(flow.run());
      return json({signing:safeRecord(reserved),configuration:config},202);
    }
    if(body.action==='void') {
      if(!config.canSend)throw error(config.message,503);
      const reason=String(body.reason || '').trim();if(!reason || reason.length>200)throw error('Enter a cancellation reason (up to 200 characters).',422);
      await flow.store.requestVoid(body.packageId,identity.email,reason);
      ctx?.waitUntil(flow.run());
      return json({signing:safeRecord(await flow.store.get(body.packageId)),configuration:config},202);
    }
    throw error('Unknown signing action.',422);
  }catch(e){return json({error:e.status?e.message:'Unable to process this signing request.'},e.status || 500);}
}
export async function handleDocusignWebhook(request,env,ctx) {
  if(!enabled(env))return json({error:'Not found.'},404);
  if(request.method!=='POST')return json({error:'Method not allowed.'},405);
  try {
    const raw=await boundedBytes(request.body,1024*1024),flow=signingFor(requireConfig(env),env,signingFiles(env));
    const notice=await flow.provider.verifyNotice(raw,Object.fromEntries(request.headers));
    if(!notice)return json({error:'Invalid DocuSign signature or account.'},401);
    await flow.store.enqueueNotice(notice,await sha256(raw));
    if(signingConfiguration(env,request).canSend)ctx?.waitUntil(flow.run());
    return json({received:true});
  }catch(e){return json({error:'DocuSign notification could not be saved.'},e.status===413?413:503);}
}
export async function reconcileSigning(env,request) {
  if(!signingConfiguration(env,request).canSend)return;
  const flow=signingFor(requireConfig(env),env,signingFiles(env));
  await flow.run();
  for(const record of await flow.store.expiredPreviews()) {
    if(record.package.reviewFile)await requireDocsBucket(env).delete(record.package.reviewFile.path);
    for(const d of record.package.documents)await requireDocsBucket(env).delete(d.file.path);
    await flow.store.discardPreview(record.package.id);
  }
}
