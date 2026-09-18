// A separate document owns the renderer's blob URLs; removing the frame releases
// them. The bytes are the immutable source that the send endpoint reserves.
import * as doc from './lease-doc.js';
import {SIGNING_DOCUMENTS} from '../shared/lease-signing-layout.js';
import {mapDocuments} from '../shared/lease-documents.js';
import {showSigningFields,clearSigningFields} from './signing-field-preview.js';
const params=new URLSearchParams(location.search),id=params.get('rental'),packageId=params.get('package'),hash=params.get('sha');
const host=document.querySelector('#lease-doc'),status=document.querySelector('#status');
let documents=[],currentDocument=null;
const sourceUrl=`/api/admin/cases/${encodeURIComponent(id)}/signing?package=${encodeURIComponent(packageId)}&file=source`;
async function mountSaved(part=null){
 if(currentDocument===(part?.documentId || 'all'))return;
 clearSigningFields();fieldPreview=null;
 const summary=await doc.mountDocument(host,{templatePath:sourceUrl+(part?`&document=${encodeURIComponent(part.documentId)}`:''),expectedSha256:part?.sha256 || hash});
 if(summary.fields.length || summary.textBoxes || summary.tablesIndented===false || summary.pagesNumbered===false)throw new Error('This signing document cannot be fully displayed. Prepare the package again.');
 if(!part)documents=mapDocuments(summary.sectionTexts);
 currentDocument=part?.documentId || 'all';
}
function clearLocation(){host.querySelectorAll('.signing-located').forEach(p=>p.classList.remove('signing-located','is-current-match'));}
let fieldPreview=null;
function show(id){fieldPreview=null;clearSigningFields();clearLocation();const item=documents.find(d=>d.id===id);doc.showSections(item?.from??null,item?.to);window.scrollTo(0,0);}
function locate(fieldId,contexts,index=0){
 clearLocation();
 const targets=new Set((Array.isArray(contexts)?contexts:[]).filter(t=>typeof t==='string').map(t=>t.replace(/\s+/g,' ').trim()).filter(Boolean));
 const matches=[...host.querySelectorAll('section.docx p')].filter(p=>targets.has(p.textContent.replace(/\s+/g,' ').trim()));
 index=matches.length?((Math.trunc(Number(index)||0)%matches.length)+matches.length)%matches.length:0;
 const first=matches[index];
 if(!first){parent.postMessage({type:'signing-document-located',packageId,fieldId,found:false},location.origin);return;}
 const sections=[...host.querySelectorAll('.docx-wrapper > section.docx')],section=sections.indexOf(first.closest('section.docx'));
 const owner=documents.find(d=>section>=d.from && section<=d.to);
 show(owner?.id || '');
 matches.forEach(p=>p.classList.add('signing-located'));
 first.classList.add('is-current-match');
 first.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
 parent.postMessage({type:'signing-document-located',packageId,fieldId,found:true,index,total:matches.length,document:owner?.id || ''},location.origin);
}
let messages=Promise.resolve();
window.addEventListener('message',event=>{
 if(event.source!==parent || event.origin!==location.origin || event.data?.packageId!==packageId)return;
 messages=messages.then(async()=>{
 if(event.data.type==='signing-document-view'){await mountSaved();show(event.data.document);}
 if(event.data.type==='signing-document-locate'){await mountSaved();locate(event.data.fieldId,event.data.contexts,event.data.index);}
 if(event.data.type==='signing-fields-preview'){
  try{
   const layout=SIGNING_DOCUMENTS.find(d=>d.id===(event.data.layout || 'lease'));
   if(!layout)throw new Error('Signing positions are not configured for this document.');
   const part=event.data.document;
   if(!part || part.layout!==layout.id || !/^[0-9]+$/.test(part.documentId) || !/^[a-f0-9]{64}$/.test(part.sha256))throw new Error('Prepare a new signing package to preview this document.');
   await mountSaved(part);doc.showSections(null);clearLocation();
   const signers=part.tenantRecipientId?event.data.signers.filter(s=>s.role==='landlord' || s.recipientId===part.tenantRecipientId):event.data.signers;
   fieldPreview={signers,selected:event.data.selected,layout:layout.id,options:{standalone:true,values:event.data.values,tenantOrder:event.data.signers.filter(s=>s.role==='tenant').map(s=>s.recipientId)}};
   const result=showSigningFields(host,fieldPreview.signers,fieldPreview.selected,fieldPreview.layout,fieldPreview.options);
   parent.postMessage({type:'signing-fields-ready',packageId,...result},location.origin);
  }catch(error){parent.postMessage({type:'signing-fields-error',packageId,message:error.message},location.origin);}
 }
 if(event.data.type==='signing-document-zoom')host.style.zoom=String(Math.max(.5,Math.min(1.5,Number(event.data.zoom)||1)));
 if(event.data.type==='signing-document-zoom' && fieldPreview)showSigningFields(host,fieldPreview.signers,fieldPreview.selected,fieldPreview.layout,fieldPreview.options);
 }).catch(error=>parent.postMessage({type:'signing-fields-error',packageId,message:error.message},location.origin));
});
window.addEventListener('resize',()=>{if(fieldPreview)showSigningFields(host,fieldPreview.signers,fieldPreview.selected,fieldPreview.layout,fieldPreview.options);});
try {
 if(!/^[a-f0-9-]{36}$/i.test(id||'') || !/^[a-f0-9-]{36}$/i.test(packageId||'') || !/^[a-f0-9]{64}$/i.test(hash||''))throw new Error('Invalid signing package.');
 await mountSaved();show('');status.hidden=true;
 parent.postMessage({type:'signing-document-ready',packageId},location.origin);
} catch(error){host.textContent='';status.textContent=error.message;parent.postMessage({type:'signing-document-error',packageId,message:error.message},location.origin);}
