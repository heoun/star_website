// One required-field convention across dynamically rendered forms.
const style=document.createElement('style');
style.textContent='.required-mark::after{content:" *"}.required-mark{color:#b3261e!important;font-weight:700;margin-left:3px}.optional{display:none!important}';
document.head.append(style);
let queued=false;
const observer=new MutationObserver(()=>{if(!queued){queued=true;queueMicrotask(sync);}});
function sync(){
 queued=false;observer.disconnect();
 const wanted=new Set();
 document.querySelectorAll('input[required],select[required],textarea[required]').forEach(input=>{
  if(input.disabled)return;
  const group=input.type==='radio'?input.closest('fieldset')?.querySelector('legend'):null;
  const labels=group?[group]:[...(input.labels || [])];
  labels.forEach(label=>wanted.add(label));
 });
 document.querySelectorAll('[data-auto-required]').forEach(mark=>{if(!wanted.has(mark.closest('label,legend') || mark.parentElement))mark.remove();});
 wanted.forEach(label=>{
  if(label.querySelector('.required-mark'))return;
  const mark=document.createElement('span');mark.className='required-mark';mark.dataset.autoRequired='';mark.setAttribute('aria-hidden','true');
  // Compound labels keep the required marker inside their text, so it cannot
  // displace the checkbox or caption into another grid cell.
  const caption=label.querySelector(':scope > .demo-field-caption, :scope > .desk-check-caption, :scope > .consent-caption');
  if(caption)caption.append(mark);
  else label.insertBefore(mark,[...label.children].find(el=>el.matches('input,select,textarea')) || null);
 });
 document.querySelectorAll('label,legend,.field-label').forEach(label=>{
  for(const node of label.childNodes)if(node.nodeType===Node.TEXT_NODE){const next=node.textContent.replace(/\s*\(optional\)/gi,'');if(next!==node.textContent)node.textContent=next;}
 });
 observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['required','disabled']});
}
sync();
