import {renderWithPropertyPreview} from "./property-preview.js";
import {verifyWorkspaceIdentity} from "../shared/workspace-verify.js";
import {propertyDirectory, propertyDirectoryRow} from "./property-directory.js";
import {readiness} from "./property-sections.js";
import {resolve, signerEmailKnown} from "./property-defaults.js";
import {esc} from './admin-ui.js';
import {PROPERTY_LABELS} from './property-form-layout.js';
import {createPropertyDefaults} from './property-defaults.js';
const endpoint='/property-collaborations';
const propertyFields={name:'Property Name',street:'Street',city:'City',state:'State',state_abbr:'State Abbreviation',zip:'ZIP Code',landlord_signer_email:'Landlord Signing Email'};
const time=value=>new Date(value).toLocaleString();
const display=value=>value===null||value===undefined||value===''?'Not Provided':typeof value==='boolean'?(value?'Yes':'No'):String(value);
const post=async(api,path,body)=>{
 const send=()=>api(path,{method:'POST',body:JSON.stringify(body)});
 try{return await send();}catch(error){
  if(error.code!=='mfa_required')throw error;
  await verifyWorkspaceIdentity();
  return send();
 }
};
const statusLabel=r=>['draft','submitted'].includes(r.state)&&Date.parse(r.expires_at)<=Date.now()?'Expired':({draft:'Draft',submitted:'Awaiting Review',approved:'Approved · Access Ended',revoked:'Access Ended'}[r.state]||r.state);
const label=(id,fields)=>propertyFields[id]||PROPERTY_LABELS[id]||fields.find(f=>f.id===id)?.label||id;
function changes(r,fields) {
 return ['property','settings'].flatMap(group=>Object.entries(r[group+'_patch']||{}).filter(([id,value])=>JSON.stringify(r['base_'+group][id]??null)!==JSON.stringify(value??null)).map(([id,value])=>({label:label(id,fields),before:r['base_'+group][id],after:value})));
}
function diffMarkup(r,fields) {
 const rows=changes(r,fields);
 return rows.length?'<div class="collab-diff"><table><thead><tr><th>Field</th><th>Before</th><th>Proposed</th></tr></thead><tbody>'+rows.map(row=>'<tr><th>'+esc(row.label)+'</th><td>'+esc(display(row.before))+'</td><td>'+esc(display(row.after))+'</td></tr>').join('')+'</tbody></table></div>':'<p>No setting changes.</p>';
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
 host.innerHTML='<h3>'+esc(r.agent_email)+'</h3><p>'+esc(statusLabel(r))+' · Expires '+esc(time(r.expires_at))+'</p>'+diffMarkup(r,registry.fields)+
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
 host.innerHTML='<details class="case-disclosure"><summary>Temporary Property Collaboration</summary><p>Assign an Agent to prepare changes for this property. Your approval is required before settings take effect. Marketing access is separate.</p>'+
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
export async function renderAgentProperties(host,{api,buildingId}) {
 host.innerHTML='<p>Loading property assignments…</p>';
 try {
  const {collaborations}=await api(endpoint);
  if(!buildingId){
   const [{registry},details]=await Promise.all([api('/lease/fields'),Promise.all(collaborations.map(r=>api(endpoint+'/'+r.id)))]);
   const fields=registry.fields.filter(f=>f.source==='manager');
   const rows=details.map(({collaboration:r})=>{
    const building={...r.base_property,...r.property_patch,id:r.building_id};
    const values={...r.base_settings,...r.settings_patch};
    const field=id=>fields.find(f=>f.id===id);
    const ready=readiness({fields,answered:f=>resolve(f,values).answered,hasSigner:signerEmailKnown(building)?Boolean(building.landlord_signer_email):true});
    return propertyDirectoryRow({building,entity:resolve(field('landlord.entity_name'),values),signer:resolve(field('landlord.print_name'),values),ready,
     note:statusLabel(r)+' · Access Ends '+time(r.expires_at),action:r.state==='draft'?'Manage':'View'});
   }).join('');
   host.innerHTML='<div class="pagehead"><div><span class="k">Configuration</span><h1>Properties</h1><p>Prepare property settings for Admin review. Lease status reflects your draft.</p></div></div>'+(rows?propertyDirectory(rows):'<div class="empty"><h2>No active property assignments.</h2></div>');
   return;
  }
  const assignment=collaborations.find(r=>r.building_id===buildingId);
  if(!assignment){host.innerHTML='<p role="alert">You do not have active collaboration access to this property.</p>';return;}
  const [detail,{registry}]=await Promise.all([api(endpoint+'/'+assignment.id),api('/lease/fields')]);
  let r=detail.collaboration;
  const editable=r.state==='draft',fields=registry.fields.filter(f=>f.source==='manager');
  const property=()=>({...r.base_property,...r.property_patch});
  const settings=()=>({...r.base_settings,...r.settings_patch});
  host.innerHTML='<a href="#/properties">← All Properties</a><div class="pagehead"><div><h1>'+esc(assignment.name)+'</h1><p>'+esc(statusLabel(r))+' · Access Ends '+esc(time(r.expires_at))+'</p><p>Changes remain in draft until an Admin approves them.</p></div></div>'+
   (r.note?'<p class="status">Admin Feedback: '+esc(r.note)+'</p>':'')+
   '<div data-collaboration-editor></div><p class="status" data-draft-status role="status"></p>'+
   (editable?'<div class="actions property-review-actions"><button type="button" class="primary" data-submit-draft>Submit for Review</button></div>':'')+
   '<div data-collaboration-documents>'+'</div>'+
   '<div data-collaboration-history>'+historyMarkup(detail.history,fields)+'</div>';
  const editorHost=host.querySelector('[data-collaboration-editor]');
  const setStatus=(message,tone='')=>{const status=host.querySelector('[data-draft-status]');status.textContent=message;status.dataset.tone=tone;};
  // This transport never forwards a live settings/building write. It translates
  // the shared editor's operations into the versioned collaboration draft.
  let busy=false;
  const draftApi=async(path,options={})=>{
   const method=options.method||'GET';
   if(method==='GET'&&path==='/lease/settings?scope=building&building_id='+encodeURIComponent(buildingId))return {field_values:settings()};
   const layerWrite=path==='/lease/settings'&&method==='PUT';
   const propertyWrite=path==='/buildings/'+encodeURIComponent(buildingId)&&method==='PATCH';
   if(!editable||(!layerWrite&&!propertyWrite))throw Error('This operation is not available in a property draft.');
   const body=JSON.parse(options.body);
   if(layerWrite&&(body.scope!=='building'||body.building_id!==buildingId))throw Error('This draft belongs to a different property.');
   const next={version:r.version,property_patch:{...r.property_patch},settings_patch:{...r.settings_patch}};
   for(const [key,value] of Object.entries(layerWrite?body.field_values:body)){
    const group=layerWrite?'settings':'property',normalized=typeof value==='string'?(value.trim()||null):value;
    if(JSON.stringify(normalized)===JSON.stringify(r['base_'+group][key]??null))delete next[group+'_patch'][key];
    else next[group+'_patch'][key]=normalized;
   }
   const result=await post(api,endpoint+'/'+r.id+'/save',next);r=result.collaboration;
   return {building:property(),settings:{field_values:settings()}};
  };
  const editor=createPropertyDefaults({api:draftApi,setStatus,escapeHtml:esc,canEdit:()=>editable,buildingOf:()=>property(),draftMode:true});
  const ui=editor.newDefaultsUi();
  await editor.loadLayer(buildingId);
  const rerender=async()=>{
   host.querySelector('.pagehead h1').textContent=property().name;
   editor.rememberDefaultsNavigation(editorHost,ui);
   renderWithPropertyPreview(editorHost,editor.defaultsMarkup({fields,values:editor.layerOf(buildingId),ui,buildingId}));
   editor.syncDefaultsNavigation(editorHost,ui);
  };
  await rerender();
  const refreshHistory=async()=>{
   const current=await api(endpoint+'/'+r.id);
   host.querySelector('[data-collaboration-history]').innerHTML=historyMarkup(current.history,fields);
  };
  editorHost.onclick=async event=>{
   if(busy)return;
   busy=true;
   try{await editor.handleDefaultsClick(event,{host:editorHost,buildingId,fields,ui,rerender,onSaved:refreshHistory});}
   catch(error){setStatus(error.message,'error');}
   finally{busy=false;}
  };
  const pendingEdits=()=>ui.dirty||ui.addressOpen||ui.signerOpen;
  const submit=host.querySelector('[data-submit-draft]');
  if(submit)submit.onclick=async()=>{
   if(busy)return;
   if(pendingEdits()){setStatus('Save or cancel the open section before submitting.','error');return;}
   busy=true;submit.disabled=true;
   try{await post(api,endpoint+'/'+r.id+'/submit',{version:r.version});await renderAgentProperties(host,{api,buildingId});}
   catch(error){setStatus(error.message,'error');submit.disabled=false;}
   finally{busy=false;}
  };

 }catch(error){host.innerHTML='<p role="alert">'+esc(error.message)+'</p>';}
}
