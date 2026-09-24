// Split at existing document boundaries; copy the original OOXML and package
// resources verbatim. Single-tenant notices get one independently filled copy.
import {readEntries,readEntryText,replaceEntry} from './zip.js';
import registry from '../lease/schema/fields.json' with {type:'json'};
import {formatLeaseFieldValue} from '../site/shared/lease-values.js';
import {DOCUMENTS} from '../site/shared/lease-documents.js';
import {hasConcession} from '../site/shared/lease-signing-layout.js';
const fieldById=new Map(registry.fields.map(f=>[f.id,f]));
export const INDIVIDUAL_NOTICES=new Set(['window_guards','bedbug','dhcr']);
const unescape=s=>s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n));
const visible=xml=>unescape([...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m=>m[1]).join('')).replace(/\s+/g,' ').trim();
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export function elementsOf(xml){
 const result=[];let depth=0,start=0;
 for(const m of xml.matchAll(/<\/?[\w:]+\b[^>]*>/g)){
  if(m[0].startsWith('</')){depth--;if(!depth)result.push(xml.slice(start,m.index+m[0].length));}
  else {if(!depth)start=m.index;if(!m[0].endsWith('/>'))depth++;else if(!depth)result.push(m[0]);}
 }
 if(depth)throw new Error('The signing document structure is invalid.');return result;
}
// `prepare(xml,document)` may return the standalone body with signing anchors
// added; the merged review copy stays exactly as filled.
export async function splitSigningDocuments(docx,originalXml,values,signers,tenantValues={},prepare=xml=>xml){
 const entries=readEntries(docx.buffer.slice(docx.byteOffset,docx.byteOffset+docx.byteLength));
 const filled=await readEntryText(entries,'word/document.xml');
 const head=filled.slice(0,filled.indexOf('<w:body>')+8),tail='</w:body></w:document>';
 const body=originalXml.slice(originalXml.indexOf('<w:body>')+8,originalXml.indexOf('</w:body>'));
 const nodes=elementsOf(body),finalSection=nodes.pop();
 if(!finalSection.startsWith('<w:sectPr'))throw new Error('The source section settings are missing.');
 const markers=DOCUMENTS.map(d=>({...d,marker:d.starts}));
 const starts=markers.map(d=>({...d,index:nodes.findIndex(n=>visible(n).startsWith(d.marker))})).sort((a,b)=>a.index-b.index);
 if(starts.some(d=>d.index<0) || new Set(starts.map(d=>d.index)).size!==markers.length)throw new Error('A signing document boundary is missing.');
 const fill=(xml,v)=>xml.replace(/\{\{([a-z0-9_.]+)\}\}/g,(_,id)=>escape(formatLeaseFieldValue(fieldById.get(id),v[id])));
 const result=[],review=[];
 for(let i=0;i<starts.length;i++){
  const d=starts[i],chunks=nodes.slice(d.index,starts[i+1]?.index??nodes.length);
  if(d.id==='concession' && !hasConcession(values))continue;
  for(const tenant of INDIVIDUAL_NOTICES.has(d.id)?signers.filter(s=>s.role==='tenant'):[null]){
   const v=tenant?{...values,...tenantValues[tenant.memberId],'tenant.names':tenant.name,'tenant.email':tenant.email}:values;
   const xml=fill(chunks.join(''),v);review.push(xml);
   // The last section's properties belong on the body in a standalone DOCX.
   // Keep its paragraph and every run; only relocate the section properties.
   const sections=[...xml.matchAll(/<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/g)];
   const last=sections.at(-1),section=last?.[0] || finalSection;
   const document={documentId:String(result.length+1),layout:d.id,tenantRecipientId:tenant?.recipientId || null,name:d.name+(tenant?` — ${tenant.name}`:'')};
   const own=prepare(last?xml.slice(0,last.index)+xml.slice(last.index+last[0].length):xml,document);
   result.push({...document,xml:own,bytes:await replaceEntry(entries,'word/document.xml',head+own+section+tail)});
  }
 }
 return {documents:result,review:await replaceEntry(entries,'word/document.xml',head+review.join('')+finalSection+tail)};
}
export {visible as signingVisibleText};
