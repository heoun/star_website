// Screen-only marks on the values the lease filled into a saved signing copy.
//
// Nothing here reaches the bytes DocuSign receives. A mark wraps text the
// renderer has already laid out, adds no padding or border that could move
// it, and never splits an anchor span, so the signing boxes measured from
// those spans land exactly where they did before.
//
// The saved copy carries no trace of which words were filled in: the Worker
// replaces each placeholder with plain text inside whatever run held it. The
// trace lives on the lease screen instead, which keeps the template rendered
// by this same renderer with every placeholder wrapped (lease-doc.js). A
// signing copy holds the very paragraphs of the template it was cut from, in
// the same order — the anchor tokens add runs, never paragraphs — so each
// value is found by its paragraph's position and confirmed by the paragraph's
// text. Text alone would not do: 48 template paragraphs are a bare
// placeholder ("Tenant", "$50"), and the same words print as fixed text
// elsewhere on the same page.

const TOKEN=/^\\[A-Z]+-R\d+-[A-Z]+\d*\\$/;
const norm=text=>String(text || '').replace(/\s+/g,' ').trim();
// The body's top-level nodes as the renderer lays them out: a paragraph or a
// table each. Headers and footers are elsewhere, and a copy inherits none.
const bodyNodes=host=>[...host.querySelectorAll('section.docx > article > *')];
const paragraphsIn=nodes=>nodes.flatMap(node=>node.matches('p')?[node]:[...node.querySelectorAll('p')]);

// Every body paragraph of the mounted copy, in order.
export function documentParagraphs(host){return paragraphsIn(bodyNodes(host));}

// The paragraphs of one copy, cut from the rendered template the way the
// Worker cuts the filled document (signing-documents.js): from the top-level
// node whose text opens the copy up to the node that opens the next one.
// `markers` are {id, starts} for every copy the package makes.
export function copyParagraphs(host,markers,id){
 const nodes=bodyNodes(host);
 const starts=markers.map(m=>({id:m.id,index:nodes.findIndex(n=>norm(n.textContent).startsWith(norm(m.starts)))})).filter(m=>m.index>=0).sort((a,b)=>a.index-b.index);
 const at=starts.findIndex(m=>m.id===id);
 return at<0?[]:paragraphsIn(nodes.slice(starts[at].index,starts[at+1]?.index??nodes.length));
}

// Whitespace folded the way locate compares paragraphs: any run of it is one
// space, none survives at either end. `at[i]` records where normalized
// character i came from, so a range can be drawn back onto the text nodes.
function fold(pieces){
 let text='',pending=null;const at=[];
 for(const piece of pieces){
  const s=piece.text;
  for(let i=0;i<s.length;i++){
   const ch=s[i];
   if(/\s/.test(ch)){if(text && !pending)pending={node:piece.node,offset:i};continue;}
   if(pending){text+=' ';at.push(pending);pending=null;}
   if(piece.mark){if(piece.mark.start<0)piece.mark.start=text.length;piece.mark.end=text.length+1;}
   text+=ch;at.push({node:piece.node,offset:i});
  }
 }
 return {text,at};
}

// Lease screen side: where each value prints in these template paragraphs.
// `overrides` are values the copy carries instead of the screen's own (a
// tenant's own name on that tenant's notice); `labelOf` names a field for
// the mark's tooltip.
export function valueMarks(paragraphs,{overrides={},labelOf=id=>id}={}){
 const marks=[];
 paragraphs.forEach((p,index)=>{
  if(!p.querySelector('[data-lease-slot]'))return;
  const pieces=[],values=[];
  const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);
  for(let node=walker.nextNode();node;node=walker.nextNode()){
   const slot=node.parentElement?.closest('[data-lease-slot]');
   if(!slot){pieces.push({text:node.nodeValue || ''});continue;}
   if(node!==slot.firstChild)continue;
   const id=slot.dataset.leaseSlot;
   const text=Object.hasOwn(overrides,id)?String(overrides[id] ?? ''):slot.classList.contains('is-missing')?'':(node.nodeValue || '');
   const mark={id,label:labelOf(id),start:-1,end:-1};
   pieces.push({text,mark});values.push(mark);
  }
  const {text}=fold(pieces),found=values.filter(v=>v.start>=0);
  if(found.length)marks.push({paragraph:index,context:text,values:found});
 });
 return {count:paragraphs.length,marks};
}

export function clearValueMarks(host){
 const parents=new Set();
 for(const mark of host.querySelectorAll('mark.signing-value')){parents.add(mark.parentNode);mark.replaceWith(...mark.childNodes);}
 for(const parent of parents)parent.normalize();
}

// Frame side: draws the marks onto the mounted copy. Returns how many values
// were marked and how many could not be, which is zero unless the copy and
// the template on the lease screen disagree about a paragraph.
export function showValueMarks(host,plan){
 clearValueMarks(host);
 const total=(plan?.marks || []).reduce((n,m)=>n+m.values.length,0);
 if(!total)return {marked:0,unmatched:0};
 const paragraphs=documentParagraphs(host);
 if(paragraphs.length!==plan.count)return {marked:0,unmatched:total};
 let marked=0,serial=0;
 for(const item of plan.marks){
  const p=paragraphs[item.paragraph];if(!p)continue;
  const nodes=[],pieces=[];
  const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);
  for(let node=walker.nextNode();node;node=walker.nextNode()){
   if(TOKEN.test(node.parentElement?.textContent || ''))continue;
   pieces.push({text:node.nodeValue || '',node:nodes.length});nodes.push(node);
  }
  const {text,at}=fold(pieces);
  if(text!==item.context)continue;
  const segments=[];
  for(const value of item.values){
   const first=at[value.start],last=at[value.end-1];
   if(!first || !last)continue;
   serial+=1;marked+=1;
   // A value the document set in more than one run is one mark per run.
   for(let n=first.node;n<=last.node;n++)segments.push({node:n,from:n===first.node?first.offset:0,to:n===last.node?last.offset+1:nodes[n].length,value,serial});
  }
  // Later text first: wrapping splits the node and leaves the offsets before the split unchanged.
  segments.sort((a,b)=>b.node-a.node || b.from-a.from);
  for(const s of segments){
   if(s.to<=s.from)continue;
   const range=document.createRange();range.setStart(nodes[s.node],s.from);range.setEnd(nodes[s.node],s.to);
   const mark=document.createElement('mark');
   mark.className='signing-value';mark.dataset.field=s.value.id;mark.dataset.signingValue=String(s.serial);mark.title=s.value.label || s.value.id;
   range.surroundContents(mark);
  }
 }
 return {marked,unmatched:total-marked};
}
