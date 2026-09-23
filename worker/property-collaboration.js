import {requireConfig} from './supabase.js';
import {accountSecurityEnabled,recentMfa} from './account-security.js';
import {storageBucket} from './storage.js';
import {LEASE_REGISTRY,isManagerField} from './lease.js';
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const propertyFields=['name','street','city','state','state_abbr','zip','landlord_signer_email'];
export async function collaborationCommand(env,identity,action,id=null,body={}) {
 const {url,key}=requireConfig(env);
 const response=await fetch(url+'/rest/v1/rpc/property_collaboration_command',{method:'POST',signal:AbortSignal.timeout(15000),
 headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},
 body:JSON.stringify({p_actor:identity.email,p_action:action,p_id:id,p_body:body})});
 if(!response.ok)throw Object.assign(Error('Property collaboration is temporarily unavailable.'),{status:503});
 const result=await response.json();
 if(result.error)throw Object.assign(Error(result.error),{status:result.status});
 return result;
}
export async function propertyCollaborationAccess(env,identity) {
 if(identity.role!=='agent'||identity.owner)return [];
 const {collaborations}=await collaborationCommand(env,identity,'list');
 return [...new Set(collaborations.map(row=>row.building_id))];
}
async function bytesOf(request,limit) {
 const reader=request.body?.getReader();if(!reader)throw Object.assign(Error('A request body is required.'),{status:400});
 const chunks=[];let size=0;
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;
 if(size>limit){await reader.cancel();throw Object.assign(Error('File or form is too large.'),{status:413});}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
export function validateCollaborationDraft(body) {
 const out={version:body.version,property_patch:{},settings_patch:{}};
 for(const group of ['property_patch','settings_patch']) {
  if(!body[group]||typeof body[group]!=='object'||Array.isArray(body[group]))throw Object.assign(Error('Invalid draft.'),{status:422});
  for(const [id,value] of Object.entries(body[group])) {
   const field=LEASE_REGISTRY.fields.find(f=>f.id===id);
   if(group==='property_patch'?!propertyFields.includes(id):!isManagerField(id))throw Object.assign(Error('This field cannot be edited in property settings.'),{status:422});
   if(value!==null && (typeof value!=='string' && !(group==='settings_patch'&&field.type==='checkbox'&&typeof value==='boolean')))throw Object.assign(Error('Invalid field value.'),{status:422});
   if(typeof value==='string'&&(value.length>(group==='property_patch'?200:400)||/[\r\n\x00]/.test(value)))throw Object.assign(Error('Field value is too long or contains invalid characters.'),{status:422});
   if(group==='settings_patch'&&value!==null&&(field.type==='checkbox'?typeof value!=='boolean':field.type==='choice'&&!field.options.includes(value)))throw Object.assign(Error('Choose a valid field value.'),{status:422});
   out[group][id]=typeof value==='string'?(value.trim()||null):value;
  }
 }
 if(Object.hasOwn(out.property_patch,'name')&&!out.property_patch.name)throw Object.assign(Error('Property name is required.'),{status:422});
 if(out.property_patch.landlord_signer_email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.property_patch.landlord_signer_email))throw Object.assign(Error('Enter a valid signer email.'),{status:422});
 return out;
}
export async function handlePropertyCollaboration(request,env,identity,segments) {
 if(identity.owner||!['agent','manager'].includes(identity.role))return json({error:'Property collaboration is not available for this role.'},403);
 const [,id,action,fileId]=segments;
 try {
  if(id&&!uuid.test(id))return json({error:'Assignment not found.'},404);
  if(request.method==='GET') {
   if(action==='documents'&&uuid.test(fileId||'')) {
    const {collaboration:r}=await collaborationCommand(env,identity,'detail',id);
    const doc=r.documents.find(d=>d.id===fileId);if(!doc)return json({error:'Document not found.'},404);
    const object=await storageBucket(env,'applicant-docs').get('property-collaboration/'+id+'/'+fileId);
    if(!object)return json({error:'Document not found.'},404);
    return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(doc.name),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
   }
   if(action)return json({error:'Unknown endpoint.'},404);
   return json(await collaborationCommand(env,identity,id?'detail':'list',id||null,id?{}:{building_id:new URL(request.url).searchParams.get('building_id')||undefined}));
  }
  if(request.method!=='POST')return json({error:'Method not allowed.'},405);
  if((!id||['approve','return','revoke'].includes(action))&&accountSecurityEnabled(env)&&!recentMfa(identity))return json({error:'Verify your authenticator again before granting or reviewing property access.',code:'mfa_required'},403);
  if(id&&action==='documents') {
   const {collaboration:r}=await collaborationCommand(env,identity,'detail',id);
   if(identity.role!=='agent'||r.state!=='draft')return json({error:'Only the assigned Agent can upload to an open draft.'},403);
   const type=request.headers.get('Content-Type')?.split(';')[0];
   if(!['application/pdf','image/jpeg','image/png','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(type))return json({error:'Upload a PDF, DOCX, JPG or PNG.'},422);
   const data=await bytesOf(request,10*1024*1024),docId=crypto.randomUUID();
   const name=(new URL(request.url).searchParams.get('name')||'Document').replace(/[\x00-\x1f]/g,'').slice(0,200);
   const path='property-collaboration/'+id+'/'+docId,bucket=storageBucket(env,'applicant-docs');
   await bucket.put(path,data,{httpMetadata:{contentType:type}});
   try{return json(await collaborationCommand(env,identity,'document',id,{version:r.version,document:{id:docId,name,type,size:data.length}}));}
   catch(error){await bucket.delete(path);throw error;}
  }
  const body=JSON.parse(new TextDecoder().decode(await bytesOf(request,128000)));
  if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'Invalid form.'},422);
  if(!id) {
   if(!uuid.test(body.building_id||'')||!Number.isFinite(Date.parse(body.expires_at)))return json({error:'Choose a property and expiry.'},422);
   return json(await collaborationCommand(env,identity,'grant',null,{building_id:body.building_id,agent_email:String(body.agent_email||'').trim().toLowerCase(),expires_at:body.expires_at}),201);
  }
  if(!['save','submit','approve','return','revoke'].includes(action)||!Number.isInteger(body.version))return json({error:'Invalid action or draft version.'},422);
  return json(await collaborationCommand(env,identity,action,id,action==='save'?validateCollaborationDraft(body):{version:body.version,note:String(body.note||'').slice(0,1000)}));
 } catch(error){return json({error:error instanceof SyntaxError?'Invalid form.':error.status?error.message:'Unable to complete property collaboration.'},error instanceof SyntaxError?400:error.status||500);}
}
