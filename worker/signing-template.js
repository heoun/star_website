// This manifest is tied to the exact source XML. A changed template fails closed
// until its signature map is reviewed. Only signature areas are reflowed.
import { fillTemplate } from './lease.js';
export const SIGNING_TEMPLATE_VERSION='star-lease-2026-09-16-v1';
const SOURCE_SHA='a53b160ce8d8f3ac51737b580561f0da02ea11c7fd25c28ee82d7c185d5ffc88';
const TENANT_TABLES=[290,367,407,474,535,661,721,837,904,981,1016,1210];
const LANDLORD_TABLES=[313,390,433,498,558,684,744,859,927,1004,1039,1233];
const escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export const sha256=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
const run=(text,white=false)=>`<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="${white?2:18}"/>${white?'<w:color w:val="FFFFFF"/>':''}</w:rPr><w:t xml:space="preserve">${escape(text)}</w:t></w:r>`;
const para=(content,after=0)=>`<w:p><w:pPr><w:spacing w:before="0" w:after="${after}"/><w:ind w:left="0" w:right="0" w:firstLine="0"/></w:pPr>${content}</w:p>`;
export async function buildSigningLease(env,request,values,signers) {
  if(signers.filter(s=>s.role==='tenant').length<1 || signers.filter(s=>s.role==='tenant').length>10 || signers.filter(s=>s.role==='landlord').length!==1)throw new Error('A lease supports one to ten tenants and one landlord signer.');
  const tabs=[];
  const docx=await fillTemplate(env,request,values,async (xml,original)=>{
    if(await sha256(new TextEncoder().encode(original))!==SOURCE_SHA)throw new Error('The lease template changed. Review its DocuSign signature map before sending.');
    const paragraphs=[...xml.matchAll(/<w:p(?=[ >])[\s\S]*?<\/w:p>/g)];
    const replacements=[];
    function anchor(s,location,kind) {
      const value=`/star_${location}_${s.recipientId}_${kind}/`;
      tabs.push({recipientId:s.recipientId,documentId:'1',kind,anchor:value,xOffset:0,yOffset:kind==='date_signed'?-4:-12,units:'pixels'});
      return run(value,true);
    }
    function table(role,location,kind='signature') {
      const rows=signers.filter(s=>s.role===role).map(s=>{
        const cell=(content,width)=>`<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:vAlign w:val="bottom"/></w:tcPr>${content}</w:tc>`;
        return `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="650" w:hRule="atLeast"/></w:trPr>`+
          cell(para(run(`${role==='tenant'?'Tenant':'Landlord'}: ${s.name}`)),3600)+
          cell(para(anchor(s,location,kind),120)+para(run(kind==='initial'?'Initials':'Signature')),3900)+
          cell(para(anchor(s,location,'date_signed'),120)+para(run('Date')),2100)+'</w:tr>';
      });
      return `<w:tbl><w:tblPr><w:tblW w:w="9600" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="3600"/><w:gridCol w:w="3900"/><w:gridCol w:w="2100"/></w:tblGrid>${rows.join('')}</w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>`;
    }
    const stack=[],tables=[];
    for(const m of xml.matchAll(/<w:tbl(?=[ >])[^>]*>|<\/w:tbl>/g)) {
      if(m[0].startsWith('</')){const start=stack.pop();tables.push({start,end:m.index+m[0].length});}else stack.push(m.index);
    }
    function replaceTable(index,role,label) {
      const p=paragraphs[index],matches=tables.filter(t=>t.start<p.index && t.end>p.index).sort((a,b)=>(a.end-a.start)-(b.end-b.start));
      if(!matches.length)throw new Error('Signing table is missing.');
      replacements.push({...matches[0],value:table(role,label)});
    }
    function replaceParagraph(index,value) {const p=paragraphs[index];replacements.push({start:p.index,end:p.index+p[0].length,value});}
    TENANT_TABLES.forEach((index,i)=>replaceTable(index,'tenant',`doc${i}_tenant`));
    LANDLORD_TABLES.forEach((index,i)=>replaceTable(index,'landlord',`doc${i}_landlord`));
    replaceParagraph(266,table('tenant','jury','initial'));replaceParagraph(270,table('tenant','class','initial'));
    replaceParagraph(772,table('tenant','window'));[773,774,775].forEach(i=>replaceParagraph(i,''));
    replaceParagraph(817,table('tenant','bedbug'));replaceParagraph(821,table('landlord','bedbug'));
    replaceParagraph(872,table('landlord','allergen'));[873,874,875,876,877].forEach(i=>replaceParagraph(i,''));
    replaceTable(1090,'landlord','dhcr');replaceTable(1124,'tenant','dhcr');
    // Reuse the signature whitespace on official forms rather than pushing the
    // form's footer or its last signer onto an otherwise empty page.
    [778,780,815,816,818,819,820,1094,1095,1121,1122,1123].forEach(i=>replaceParagraph(i,''));
    let last=xml.length;
    for(const r of replacements.sort((a,b)=>b.start-a.start)) {
      if(r.end>last)throw new Error('Overlapping lease signing regions.');
      xml=xml.slice(0,r.start)+r.value+xml.slice(r.end);last=r.start;
    }
    for(const tab of tabs)if(xml.split(tab.anchor).length!==2)throw new Error('A signing anchor is missing or duplicated.');
    return xml;
  });
  return {docx,tabs,templateVersion:SIGNING_TEMPLATE_VERSION};
}
