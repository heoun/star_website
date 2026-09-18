// Preserve each form's OOXML. Individual notices get a copy for each tenant.
import {fillTemplate} from './lease.js';
import {splitSigningDocuments,signingVisibleText} from './signing-documents.js';
import {signingFields,SIGNING_TEMPLATE_VERSION} from '../site/shared/lease-signing-layout.js';
export {SIGNING_TEMPLATE_VERSION};
const SOURCE_SHA='a53b160ce8d8f3ac51737b580561f0da02ea11c7fd25c28ee82d7c185d5ffc88';
export const sha256=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
export async function buildSigningLease(env,request,values,signers,tenantValues={}){
 let source;
 const filled=await fillTemplate(env,request,values,async(xml,original)=>{
  if(await sha256(new TextEncoder().encode(original))!==SOURCE_SHA)throw new Error('The lease template changed. Review its DocuSign signature map before sending.');
  source=original;return xml;
 });
 const {documents,review}=await splitSigningDocuments(filled,source,values,signers,tenantValues),tabs=[];
 for(const d of documents){
  const people=d.tenantRecipientId?signers.filter(s=>s.role==='landlord' || s.recipientId===d.tenantRecipientId):signers;
  const fields=signingFields(people,d.layout,values),text=signingVisibleText(d.xml);
  for(const anchor of new Set(fields.map(t=>t.anchor)))if(text.split(anchor).length!==2)throw new Error(`A signing anchor is missing or duplicated in ${d.name}.`);
  tabs.push(...fields.map(t=>({...t,id:`${d.documentId}-${t.id}`,documentId:d.documentId})));
 }
 return {docx:review,documents,tabs,templateVersion:SIGNING_TEMPLATE_VERSION};
}
