// Preserve each form's OOXML. Individual notices get a copy for each tenant.
import {fillTemplate} from './lease.js';
import {splitSigningDocuments,signingVisibleText} from './signing-documents.js';
import {signingFields,SIGNING_TEMPLATE_VERSION} from '../site/shared/lease-signing-layout.js';
import {injectSigningAnchors} from './signing-anchors.js';
export {SIGNING_TEMPLATE_VERSION};
const SOURCE_SHA='68d9bef6a87d705afef435d88c5050037f4ce1003685ab1c97666adb2da610bb';
export const sha256=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
export async function buildSigningLease(env,request,values,signers,tenantValues={}){
 let source;
 const filled=await fillTemplate(env,request,values,async(xml,original)=>{
  if(await sha256(new TextEncoder().encode(original))!==SOURCE_SHA)throw new Error('The lease template changed. Review its DocuSign signature map before sending.');
  source=original;return xml;
 });
 const fieldsFor=d=>signingFields(d.tenantRecipientId?signers.filter(s=>s.role==='landlord' || s.recipientId===d.tenantRecipientId):signers,d.layout,values);
 // Each standalone document carries its own signers' anchor tokens.
 const {documents,review}=await splitSigningDocuments(filled,source,values,signers,tenantValues,(xml,d)=>injectSigningAnchors(xml,fieldsFor(d))),tabs=[];
 for(const d of documents){
  const fields=fieldsFor(d),text=signingVisibleText(d.xml);
  for(const anchor of fields.map(t=>t.anchor))if(text.split(anchor).length!==2)throw new Error(`A signing anchor is missing or duplicated in ${d.name}.`);
  tabs.push(...fields.map(({placement,...t})=>({...t,id:`${d.documentId}-${t.id}`,documentId:d.documentId})));
 }
 return {docx:review,documents,tabs,templateVersion:SIGNING_TEMPLATE_VERSION};
}
