// Writes each field's anchor token into the signing document.
//
// A token is a run of 2-point white text: invisible on paper and screen,
// but ordinary text to DocuSign's converter, which locates it in its own PDF
// and places the tab on it. Tokens go where the signature goes: the empty
// underlined cell of a signature table, the start of an underlined tab
// segment, or a bordered paragraph following a signature label. Empty targets
// are left-aligned and retain their original font metrics with a nonbreaking
// space; their underline borders and the surrounding text remain unchanged.
import {elementsOf,signingVisibleText} from './signing-documents.js';
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
// A token placed inside an underlined segment keeps the segment's line
// unbroken: the underline is drawn in black under the white text.
const tokenRun=(token,underlined=false)=>`<w:r><w:rPr><w:color w:val="FFFFFF"/><w:sz w:val="4"/><w:szCs w:val="4"/>${underlined?'<w:u w:val="single" w:color="000000"/>':''}</w:rPr><w:t xml:space="preserve">${escape(token)}</w:t></w:r>`;
const rows=table=>[...table.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map(m=>m[0]);
const cells=row=>[...row.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(m=>m[0]);
const paragraphs=xml=>[...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g)].map(m=>m[0]);
const hasText=p=>/<w:t\b[^>]*>[^<]*[^\s<][^<]*<\/w:t>/.test(p);

function leftAligned(p){
 return /<w:jc\b/.test(p)?p.replace(/<w:jc\b[^>]*\/>/,'<w:jc w:val="left"/>'):p.replace(/<\/w:pPr>/,'<w:jc w:val="left"/></w:pPr>');
}
function appendRun(p,run){
 if(p.endsWith('/>'))return p.slice(0,-2)+'>'+run+'</w:p>';
 return p.slice(0,p.lastIndexOf('</w:p>'))+run+'</w:p>';
}
// Where the token goes inside one paragraph.
function placeInParagraph(p,placement,token){
 if(placement.beforeUnderlined!==undefined){
  // Count the document's own underlined runs; tokens already written into
  // this paragraph are underlined too and must not shift later slots.
  const runs=[...p.matchAll(/<w:r\b[\s\S]*?<\/w:r>/g)].filter(m=>/<w:u w:val="single"/.test(m[0]) && !/<w:color w:val="FFFFFF"\/>/.test(m[0]));
  const run=runs[placement.beforeUnderlined];
  if(!run)throw new Error('The signing line for this field is missing from the document.');
  return p.slice(0,run.index)+tokenRun(token,true)+p.slice(run.index);
 }
 if(!placement.append)throw new Error('Unknown signing placement.');
 return appendRun(p,tokenRun(token));
}
// An empty underlined paragraph in a signature cell: the token becomes its
// anchor content, alongside an invisible original-size spacing run.
function placeInCell(cell,token){
 const list=paragraphs(cell);
 if(!list.length)throw new Error('The signature cell for this field is empty.');
 const last=list[list.length-1];
 if(hasText(last) || !/<w:bottom\b[^>]*w:val="single"/.test(last))throw new Error('The signature cell for this field is not an empty underlined line.');
 const index=cell.lastIndexOf(last);
 // An empty paragraph takes its height from the paragraph-mark formatting.
 // Once a 2pt token is inserted Word uses that run instead, moving the border
 // upward. A non-breaking space with the ORIGINAL run properties preserves
 // the line height without adding visible text or changing the paragraph border.
 const mark=last.match(/<w:pPr>[\s\S]*?(<w:rPr>[\s\S]*?<\/w:rPr>)[\s\S]*?<\/w:pPr>/)?.[1];
 if(!mark)throw new Error('The signing line has no paragraph font metrics.');
 const strut=`<w:r>${mark}<w:t xml:space="preserve">\u00a0</w:t></w:r>`;
 return cell.slice(0,index)+appendRun(leftAligned(last),tokenRun(token)+strut)+cell.slice(index+last.length);
}

function findParagraph(nodes,spec){
 const all=[];
 for(const [i,node] of nodes.entries())for(const p of paragraphs(node)){
  const text=signingVisibleText(p);
  if(spec.is?text===spec.is:spec.starts?text.startsWith(spec.starts):text.includes(spec.contains))all.push({node:i,p});
 }
 const hit=spec.nth!==undefined?all[spec.nth]:all.length===1?all[0]:null;
 if(!hit)throw new Error(`The paragraph "${spec.is || spec.starts || spec.contains}" is missing or repeated in the signing document.`);
 return hit;
}

export function injectSigningAnchors(xml,fields){
 const nodes=elementsOf(xml);
 const tables=nodes.map((n,i)=>n.startsWith('<w:tbl')?i:-1).filter(i=>i>=0);
 for(const f of fields){
  const {placement,anchor}=f;
  if(placement.table!==undefined){
   const at=tables[placement.table];
   if(at===undefined)throw new Error('The signature table for this field is missing from the document.');
   const table=nodes[at],trs=rows(table),tr=trs[placement.row];
   const tcs=tr?cells(tr):[],tc=tcs[placement.cell];
   if(!tc)throw new Error('The signature cell for this field is missing from the document.');
   const newTr=tr.slice(0,tr.indexOf(tc))+placeInCell(tc,anchor)+tr.slice(tr.indexOf(tc)+tc.length);
   nodes[at]=table.slice(0,table.indexOf(tr))+newTr+table.slice(table.indexOf(tr)+tr.length);
  } else {
   const hit=findParagraph(nodes,placement.paragraph);
   if(placement.nextLine){
    const at=hit.node+1;
    if(!nodes[at]?.startsWith('<w:p'))throw new Error('The signing line after the label is missing.');
    nodes[at]=placeInCell(nodes[at],anchor);
   } else {
    const node=nodes[hit.node];
    nodes[hit.node]=node.slice(0,node.indexOf(hit.p))+placeInParagraph(hit.p,placement,anchor)+node.slice(node.indexOf(hit.p)+hit.p.length);
   }
  }
 }
 return nodes.join('');
}
