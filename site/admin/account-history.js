import {esc} from './admin-ui.js';
const roles={manager:'Admin',agent:'Agent',landlord:'Landlord'};
const actions={save:'Account Saved',create_admin:'Admin Created',grant_admin:'Admin Access Granted',revoke_admin:'Admin Access Revoked',remove_admin:'Admin Access Removed',remove_account:'Account Access Removed',onboarding_approved:'Landlord Onboarding Approved'};
export function accountHistoryChanges(entry, buildings=[]) {
  const before=entry.before_record,after=entry.after_record;
  if(!after || typeof after!=='object')return ['Change details were not recorded.'];
  const changes=[];
  const label=id=>buildings.find(b=>b.id===id)?.name || `Property ${id} (no longer available)`;
  if(!before){changes.push(`Account Created: ${after.name || after.email || entry.email}`);if(after.role)changes.push(`Account Type: ${roles[after.role] || after.role}`);}
  else {
    for(const [key,title,format] of [['name','Name',v=>v||'Not provided'],['email','Email',v=>v||'Not provided'],['role','Account Type',v=>roles[v]||v||'Not provided'],['active','Account Status',v=>v?'Active':'Suspended']]) {
      if(Object.hasOwn(before,key)&&Object.hasOwn(after,key)&&before[key]!==after[key])changes.push(`${title}: ${format(before[key])} → ${format(after[key])}`);
    }
  }
  const oldProperties=new Set(before?.property_ids || []),newProperties=new Set(after.property_ids || []);
  const propertyType=(after.role==='landlord'||before?.role==='landlord')?'Property Access':'Marketing Property';
  for(const id of newProperties)if(!oldProperties.has(id))changes.push(`Added ${propertyType}: ${label(id)}`);
  for(const id of oldProperties)if(!newProperties.has(id))changes.push(`Removed ${propertyType}: ${label(id)}`);
  return changes.length?changes:['No account details or property access changed.'];
}
export function renderAccountHistory(history,buildings=[]) {
  if(!history.length)return '<p>No recorded changes yet.</p>';
  return `<ol class="case-history">${history.map(entry=>{
    const date=new Date(entry.created_at),time=Number.isNaN(date.getTime())?entry.created_at:date.toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'});
    return `<li><b>${esc(actions[entry.action] || String(entry.action).replaceAll('_',' '))}</b><small>${esc(entry.actor)} · ${esc(time)}</small>${accountHistoryChanges(entry,buildings).map(change=>`<p>${esc(change)}</p>`).join('')}${entry.reason?`<p>Reason: ${esc(entry.reason)}</p>`:''}</li>`;
  }).join('')}</ol>`;
}
