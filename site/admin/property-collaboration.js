import {esc} from './admin-ui.js';
import {PROPERTY_LABELS} from './property-form-layout.js';
import {sectionsFor} from './property-sections.js';
const endpoint='/property-collaborations';
const propertyFields={name:'Property Name',street:'Street',city:'City',state:'State',state_abbr:'State Abbreviation',zip:'ZIP Code',landlord_signer_email:'Landlord Signing Email'};
const time=value=>new Date(value).toLocaleString();
const display=value=>value===null||value===undefined||value===''?'Not Provided':typeof value==='boolean'?(value?'Yes':'No'):String(value);
const post=(api,path,body)=>api(path,{method:'POST',body:JSON.stringify(body)});
const statusLabel=r=>['draft','submitted'].includes(r.state)&&Date.parse(r.expires_at)<=Date.now()?'Expired':({draft:'Draft',submitted:'Awaiting Review',approved:'Approved · Access Ended',revoked:'Access Ended'}[r.state]||r.state);
const label=(id,fields)=>propertyFields[id]||PROPERTY_LABELS[id]||fields.find(f=>f.id===id)?.label||id;
function changes(r,fields) {
 return ['property','settings'].flatMap(group=>Object.entries(r[group+'_patch']||{}).filter(([id,value])=>JSON.stringify(r['base_'+group][id]??null)!==JSON.stringify(value??null)).map(([id,value])=>({label:label(id,fields),before:r['base_'+group][id],after:value})));
}
function diffMarkup(r,fields) {
 const rows=changes(r,fields);
 return rows.length?'<div class="collab-diff"><table><thead><tr><th>Field</th><th>Before</th><th>Proposed</th></tr></thead><tbody>'+rows.map(row=>'<tr><th>'+esc(row.label)+'</th><td>'+esc(display(row.before))+'</td><td>'+esc(display(row.after))+'</td></tr>').join('')+'</tbody></table></div>':'<p>No setting changes.</p>';
}
function documents(r) {
 return '<h3>Supporting Documents</h3>'+(r.documents.length?'<ul>'+r.documents.map(d=>'<li><a href="/api/admin/property-collaborations/'+encodeURIComponent(r.id)+'/documents/'+encodeURIComponent(d.id)+'">'+esc(d.name)+'</a></li>').join('')+'</ul>':'<p>No documents uploaded.</p>');
}
function historyMarkup(history,fields) {
 const titles={grant:'Temporary Access Granted',save:'Draft Saved',submit:'Submitted for Review',document:'Document Uploaded',approve:'Changes Approved · Access Ended',return:'Returned for Correction',revoke:'Access Ended'};
 return '<details class="case-disclosure"><summary>Collaboration History</summary>'+history.map(h=>{
  const after=h.details.after,before=h.details.before;
  const delta=after&&before?{base_property:{...before.base_property,...before.property_patch},base_settings:{...before.base_settings,...before.settings_patch},property_patch:after.property_patch,settings_patch:after.settings_patch}:null;
  return '<article><h4>'+esc(titles[h.action]||h.action)+'</h4><p>'+esc(h.actor)+' · '+esc(time(h.created_at))+'</p>'+
   (h.action==='save'&&delta?diffMarkup(delta,fields):'')+
   (h.action==='return'?'<p>'+esc(after.note)+'</p>':'')+
   (h.action==='grant'?'<p>'+esc(after.agent_email)+' · Expires '+esc(time(after.expires_at))+'</p>':'')+
   (h.action==='document'?'<p>'+esc(after.documents.at(-1)?.name||'')+'</p>':'')+'</article>';
 }).join('')+'</details>';
}
async function review(host,api,id,refresh) {
 const [{collaboration:r,history},{registry}]=await Promise.all([api(endpoint+'/'+id),api('/lease/fields')]);
 host.innerHTML='<h3>'+esc(r.agent_email)+'</h3><p>'+esc(statusLabel(r))+' · Expires '+esc(time(r.expires_at))+'</p>'+diffMarkup(r,registry.fields)+documents(r)+
 (['draft','submitted'].includes(r.state)?'<form class="desk-form" data-review><label>Review Notes<textarea name="note" maxlength="1000"></textarea></label><div class="actions">'+(r.state==='submitted'?'<button class="primary" name="action" value="approve">Approve Changes</button><button name="action" value="return">Return for Correction</button>':'')+'<button name="action" value="revoke">End Access</button></div><p role="status"></p></form>':'')+historyMarkup(history,registry.fields);
 const form=host.querySelector('[data-review]');
 if(form)form.onsubmit=async event=>{event.preventDefault();const action=event.submitter.value;const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 try{await post(api,endpoint+'/'+id+'/'+action,{version:r.version,note:new FormData(form).get('note')});await refresh();}
 catch(error){form.querySelector('[role=status]').textContent=error.message;buttons.forEach(b=>b.disabled=false);}};
}
export async function renderCollaborationAdmin(host,{api,buildingId,onApproved}) {
 try {
 const [{collaborations},{staff}]=await Promise.all([api(endpoint+'?building_id='+encodeURIComponent(buildingId)),api('/staff')]);
 const agents=staff.filter(s=>s.active&&s.role==='agent');
 host.innerHTML='<details class="case-disclosure" open><summary>Temporary Property Collaboration</summary><p>Assign an Agent to prepare changes for this property. Your approval is required before settings take effect. Marketing access is separate.</p>'+
 '<form class="desk-form" data-grant><label>Agent<select name="agent_email" required><option value="">Select an Agent</option>'+agents.map(s=>'<option value="'+esc(s.email)+'">'+esc(s.name||s.email)+'</option>').join('')+'</select></label><label>Access Duration (Days)<input type="number" name="days" value="7" min="1" max="90" required></label><button class="primary">Grant Temporary Access</button><p role="status"></p></form>'+
 '<div class="collab-assignments">'+collaborations.map(r=>'<button type="button" data-review-id="'+esc(r.id)+'">'+esc(r.agent_email)+' · '+esc(statusLabel(r))+' · '+esc(time(r.expires_at))+'</button>').join('')+'</div><div data-review-host></div></details>';
 const refresh=async()=>{if(onApproved){await onApproved();return;}await renderCollaborationAdmin(host,{api,buildingId,onApproved});};
 host.querySelector('[data-grant]').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('button'),data=new FormData(form);button.disabled=true;
  try{await post(api,endpoint,{building_id:buildingId,agent_email:data.get('agent_email'),expires_at:new Date(Date.now()+Number(data.get('days'))*86400000).toISOString()});await refresh();}
  catch(error){form.querySelector('[role=status]').textContent=error.message;button.disabled=false;}
 };
 host.querySelectorAll('[data-review-id]').forEach(button=>button.onclick=()=>review(host.querySelector('[data-review-host]'),api,button.dataset.reviewId,refresh).catch(error=>{host.querySelector('[data-review-host]').textContent=error.message;}));
 } catch(error){host.innerHTML='<p role="alert">'+esc(error.message)+'</p>';}
}
function control(group,id,field,value) {
 const attrs=' data-group="'+group+'" name="'+esc(id)+'"';
 if(field.type==='checkbox')return '<select'+attrs+'><option value="">Not Provided</option><option value="true"'+(value===true?' selected':'')+'>Yes</option><option value="false"'+(value===false?' selected':'')+'>No</option></select>';
 if(field.type==='choice')return '<select'+attrs+'><option value="">Not Provided</option>'+field.options.map(v=>'<option value="'+esc(v)+'"'+(v===value?' selected':'')+'>'+esc(v)+'</option>').join('')+'</select>';
 return '<input'+attrs+' maxlength="'+(group==='property'?200:400)+'" value="'+esc(value??'')+'">';
}
export async function renderAgentProperties(host,{api,buildingId}) {
 host.innerHTML='<p>Loading property assignments…</p>';
 try{
 const {collaborations}=await api(endpoint);
 if(!buildingId){host.innerHTML='<div class="pagehead"><div><span class="k">Temporary Collaboration</span><h1>Properties & Settings</h1><p>Prepare changes for Admin review.</p></div></div>'+collaborations.map(r=>'<a class="prop-row" href="#/properties/'+encodeURIComponent(r.building_id)+'"><b>'+esc(r.name)+'</b><span>'+esc(statusLabel(r))+'</span><span>Expires '+esc(time(r.expires_at))+'</span></a>').join('')+(collaborations.length?'':'<p>No active property assignments.</p>');return;}
 const assignment=collaborations.find(r=>r.building_id===buildingId);
 if(!assignment){host.innerHTML='<p role="alert">You do not have active collaboration access to this property.</p>';return;}
 const [{collaboration:r,history},{registry}]=await Promise.all([api(endpoint+'/'+assignment.id),api('/lease/fields')]);
 const fields=registry.fields.filter(f=>f.source==='manager'),editable=r.state==='draft';
 const values={property:{...r.base_property,...r.property_patch},settings:{...r.base_settings,...r.settings_patch}};
 host.innerHTML='<a href="#/properties">← All Properties</a><div class="pagehead"><div><h1>'+esc(assignment.name)+'</h1><p>'+esc(statusLabel(r))+' · Access Ends '+esc(time(r.expires_at))+'</p><p>Changes remain in draft until an Admin approves them.</p></div></div>'+
 (r.note?'<p class="status">Admin Feedback: '+esc(r.note)+'</p>':'')+
 (editable?'<form class="desk-form" data-draft><details class="case-disclosure" open><summary>Property Details</summary>'+Object.entries(propertyFields).map(([id,title])=>'<label>'+esc(title)+control('property',id,{type:'text'},values.property[id])+'</label>').join('')+'</details>'+
 sectionsFor(fields).filter(s=>s.fields.length).map(section=>'<details class="case-disclosure"><summary>'+esc(section.label)+'</summary>'+section.fields.map(f=>'<label>'+esc(label(f.id,fields))+control('settings',f.id,f,values.settings[f.id])+'</label>').join('')+'</details>').join('')+
 '<div class="actions"><button class="primary" name="action" value="save">Save Draft</button><button name="action" value="submit">Submit for Review</button></div><p role="status"></p></form>':diffMarkup(r,fields))+
 documents(r)+(editable?'<form class="desk-form" data-upload><label>Add Supporting Document<input name="file" type="file" accept=".pdf,.docx,.jpg,.jpeg,.png" required></label><button>Upload Document</button><p role="status"></p></form>':'')+historyMarkup(history,fields);
 let version=r.version;
 const save=async()=>{
  const patch={version,property_patch:{},settings_patch:{}};
  host.querySelectorAll('[data-group]').forEach(input=>{
   const group=input.dataset.group,f=fields.find(f=>f.id===input.name);
   const value=input.value===''?null:group==='settings'&&f?.type==='checkbox'?input.value==='true':input.value.trim()||null;
   if(JSON.stringify(value)!==JSON.stringify(r['base_'+group][input.name]??null))patch[group+'_patch'][input.name]=value;
  });
  const {collaboration}=await post(api,endpoint+'/'+r.id+'/save',patch);version=collaboration.version;
 };
 const form=host.querySelector('[data-draft]');
 if(form)form.onsubmit=async event=>{event.preventDefault();const action=event.submitter.value;const buttons=[...host.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 try{await save();if(action==='submit'){await post(api,endpoint+'/'+r.id+'/submit',{version});await renderAgentProperties(host,{api,buildingId});}
 else form.querySelector('[role=status]').textContent='Draft saved. Live settings are unchanged.';}
 catch(error){form.querySelector('[role=status]').textContent=error.message;}finally{buttons.forEach(b=>b.disabled=false);}};
 const upload=host.querySelector('[data-upload]');
 if(upload)upload.onsubmit=async event=>{event.preventDefault();const file=new FormData(upload).get('file');const buttons=[...host.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 try{if(file.size>10*1024*1024)throw Error('Maximum file size is 10 MB.');await save();
 const response=await fetch('/api/admin'+endpoint+'/'+r.id+'/documents?name='+encodeURIComponent(file.name),{method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type||'application/octet-stream'},body:file});
 const result=await response.json();if(!response.ok)throw Error(result.error||'Upload failed.');await renderAgentProperties(host,{api,buildingId});
 }catch(error){upload.querySelector('[role=status]').textContent=error.message;}finally{buttons.forEach(b=>b.disabled=false);}};
 }catch(error){host.innerHTML='<p role="alert">'+esc(error.message)+'</p>';}
}
