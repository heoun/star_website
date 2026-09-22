// Local demo identity catalogue. No production code imports this module.
export const alphabet = index => { let label='';for(let n=index+1;n>0;n=Math.floor((n-1)/26))label=String.fromCharCode(65+(n-1)%26)+label;return label; };
const fixedApplicants={
 '55555555-5555-4555-8555-555555555555':'Applicant A',
 '66666666-6666-4666-8666-666666666666':'Applicant B',
 '88888888-8888-4888-8888-888888888888':'Applicant C',
 '99999999-9999-4999-8999-999999999999':'Applicant D',
 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa':'Applicant E'
};
const emailFor=name=>`${name.toLowerCase().replaceAll(' ','-')}@example.test`;
export function normalizeDemoNames(state) {
 repairDemoRoommates(state);
 const catalog=state.demo_names ||= {applicants:{...fixedApplicants},properties:{},staff:{},aliases:{}};
 const allocate=(kind,key,prefix)=>{if(!catalog[kind][key]){const used=new Set(Object.values(catalog[kind]));let i=0;while(used.has(`${prefix} ${alphabet(i)}`))i++;catalog[kind][key]=`${prefix} ${alphabet(i)}`;}return catalog[kind][key];};
 const canonicalLabel=/^(Applicant|Property|Landlord|Admin|Agent|Property Manager|Authorized Recipient|Supervisor|Previous Supervisor|Reference|Emergency Contact) [A-Z]+(?: LLC)?$/;
 for(const key of Object.keys(catalog.aliases))if(canonicalLabel.test(key))delete catalog.aliases[key];
 const aliases=new Map(),ambiguous=new Set();
 const remember=(old,value)=>{if(!old || old===value || canonicalLabel.test(old))return;if(aliases.has(old)&&aliases.get(old)!==value){ambiguous.add(old);return;}aliases.set(old,value);};
 const names=new Map(),byEmail=new Map();
 // Assign submitted members before invitations so an invited account keeps its name.
 for(const a of state.applications){const prior=byEmail.get(a.email) || catalog.applicants[`email:${a.email}`];const name=prior || allocate('applicants',a.id,'Applicant');catalog.applicants[a.id]=name;names.set(a.id,name);byEmail.set(a.email,name);remember(a.name,name);remember(a.email,emailFor(name));}
 for(const a of state.applications)for(const person of [...(a.roommates || []),...(a.workspace?.invitations || [])]){
  if(!person.email)continue;
  const name=byEmail.get(person.email) || allocate('applicants',`email:${person.email}`,'Applicant');byEmail.set(person.email,name);
 }
 for(const member of state.staff){const name=member.email==='platform-owner@example.test'?'Platform Owner':allocate('staff',member.email,({manager:'Admin',agent:'Agent',landlord:'Landlord'})[member.role] || 'Account');remember(member.name,name);member.name=name;
  if(!/^(admin|peer-admin|platform-owner|owner|other-owner|agent-[ab]|property-[a-f0-9-]+)@example\.test$/.test(member.email)){remember(member.email,emailFor(name));}
}
 for(const b of state.buildings){const name=allocate('properties',b.id,'Property');remember(b.name,name);b.name=name;
  const owner=state.staff.find(s=>s.email===b.landlord_signer_email) || state.staff.find(s=>s.role==='landlord'&&s.property_ids?.includes(b.id));
  const settings=state.settings?.[b.id];if(settings){const signer=owner?.name || 'Landlord A',entity=`${signer} LLC`;
   for(const key of ['landlord.entity_name','payee.name']){remember(settings[key],entity);settings[key]=entity;}
   for(const key of ['landlord.print_name','owner_rep.name']){remember(settings[key],signer);settings[key]=signer;}
   remember(settings['manager.name'],`Property Manager ${name.slice(9)}`);settings['manager.name']=`Property Manager ${name.slice(9)}`;
   remember(settings['legal_notice.name'],`Authorized Recipient ${name.slice(9)}`);settings['legal_notice.name']=`Authorized Recipient ${name.slice(9)}`;
  }
 }
 for(const l of state.listings){const b=state.buildings.find(b=>b.id===l.building_id);if(!b)continue;const title=`${b.name} · Unit ${l.unit || '1A'}`;remember(l.title,title);l.title=title;l.property_name=b.name;}
 // Contextual replacement handles legacy duplicate names used for unrelated people.
 const rewrite=(value,map)=>{
  if(typeof value==='string') {const entries=[...map].filter(([a,b])=>a&&a!==b).sort((a,b)=>b[0].length-a[0].length);if(!entries.length)return value;const lookup=new Map(entries);const pattern=entries.map(([v])=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');return value.replace(new RegExp(pattern,'g'),match=>lookup.get(match));}
  if(Array.isArray(value))return value.map(v=>rewrite(v,map));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rewrite(v,map)]));
  return value;
 };
 for(const a of state.applications){
  if(a.current_employer){remember(a.current_employer.supervisor_name,'Supervisor A');remember(a.current_employer.employer,'Employer A');}
  if(a.student)remember(a.student.school_name,'School A');
  for(const [i,e] of (a.employment_history || []).entries())remember(e.supervisor_name,`Previous Supervisor ${alphabet(i)}`);
  for(const [i,r] of (a.rental_history || []).entries())remember(r.contact,`Previous Landlord ${alphabet(i)}`);
  for(const [i,r] of (a.reference_contacts || []).entries())remember(r.name,`Reference ${alphabet(i)}`);
  for(const [i,r] of (a.emergency_contacts || []).entries())remember(r.name,`Emergency Contact ${alphabet(i)}`);
 }
 for(const [old,value] of aliases)if(!ambiguous.has(old))catalog.aliases[old]=value;
 for(const old of ambiguous)catalog.aliases[old]='Applicant (mock)';
 const globalMap=new Map(Object.entries(catalog.aliases)),contexts=new Map();
 for(const a of state.applications){const name=names.get(a.id),local=new Map(globalMap);
  for(const member of state.applications.filter(m=>(m.rental_group_id || m.id)===(a.rental_group_id || a.id))){local.set(member.name,names.get(member.id));local.set(member.email,emailFor(names.get(member.id)));}
  local.set(a.name,name);local.set(a.email,emailFor(name));
  for(const p of [...(a.roommates || []),...(a.workspace?.invitations || [])]){const label=byEmail.get(p.email);if(!label)continue;local.set(p.name || `${p.first_name} ${p.last_name}`,label);local.set(p.email,emailFor(label));p.name=label;p.first_name='Applicant';p.last_name=label.slice(10);p.email=emailFor(label);catalog.applicants[`email:${p.email}`]=label;}
  contexts.set(a.id,local);
  const next=rewrite(a,local);Object.assign(a,next,{name,first_name:'Applicant',last_name:name.slice(10),email:emailFor(name)});catalog.applicants[`email:${a.email}`]=name;
  if(a.current_employer){a.current_employer.employer='Employer A';a.current_employer.supervisor_name='Supervisor A';}
  for(const [i,e] of (a.employment_history || []).entries()){e.employer=`Previous Employer ${alphabet(i)}`;e.supervisor_name=`Previous Supervisor ${alphabet(i)}`;}
  for(const [i,r] of (a.rental_history || []).entries()){r.landlord_name=`Previous Landlord ${alphabet(i)} LLC`;r.contact=`Previous Landlord ${alphabet(i)}`;}
  for(const [i,r] of (a.reference_contacts || []).entries())r.name=`Reference ${alphabet(i)}`;
  for(const [i,r] of (a.emergency_contacts || []).entries())r.name=`Emergency Contact ${alphabet(i)}`;
  if(a.student)a.student.school_name='School A';
  if(a.listings)a.listings=structuredClone(state.listings.find(l=>l.id===a.listing_id) || a.listings);
 }
 // Refresh structured packets and frozen lease names using IDs, not ambiguous text.
 for(const a of state.applications){const members=state.applications.filter(m=>(m.rental_group_id || m.id)===(a.rental_group_id || a.id));const packet=a.workspace?.recommendation;
  if(packet){packet.tenant_name=members.map(m=>m.name).join(' & ');for(const m of packet.members || [])m.name=names.get(m.id) || m.name;const listing=state.listings.find(l=>l.id===a.listing_id);if(listing)packet.property_title=listing.property_name;}
  for(const values of [a.lease_snapshot,a.workspace?.lease_draft?.values])if(values){const clean=rewrite(values,globalMap);const listing=state.listings.find(l=>l.id===a.listing_id),settings=state.settings?.[listing?.building_id] || {};for(const key of ['landlord.entity_name','landlord.print_name','owner_rep.name','manager.name','legal_notice.name','payee.name'])if(settings[key])clean[key]=settings[key];Object.assign(values,clean,{'tenant.names':members.map(m=>m.name).join(' and '),'tenant.email':members.map(m=>m.email).join('; ')});}
 }
 for(const member of state.staff){const oldEmail=member.email;member.email=rewrite(oldEmail,globalMap);catalog.staff[member.email]=member.name;}
 for(const b of state.buildings){Object.assign(b,rewrite(b,globalMap));}
 for(const key of ['settings','onboarding','requests','account_audit'])if(state[key])state[key]=rewrite(state[key],globalMap);
 for(const email of state.emails || []){
  const root=state.applications.find(a=>JSON.stringify(email).includes(a.id));const local=new Map(root?contexts.get(root.id):globalMap);
  if(root){const packet=root.workspace?.recommendation;for(const m of packet?.members || []){const original=[...aliases].find(([,v])=>v===m.name)?.[0];if(original)local.set(original,m.name);}}
  Object.assign(email,rewrite(email,local));
 }
 const auditNames=value=>{if(!value||typeof value!=='object')return;if(value.email&&value.name&&catalog.staff[value.email])value.name=catalog.staff[value.email];for(const v of Object.values(value))auditNames(v);};
 auditNames(state.account_audit);
 return state;
}

// Repair only the old local seed's repeated, unsubmitted roommate placeholders.
// A real account may apply to more than one property; production identity rules
// must not be changed to compensate for a copied demo fixture.
export function repairDemoRoommates(state) {
 if(state.demo_roommate_seed===1)return;
 const claimed=new Map();
 const submitted=new Set(state.applications.map(a=>a.email));
 for(const root of state.applications){
  const groupId=root.rental_group_id || root.id;
  if(groupId!==root.id)continue;
  const replacements=new Map();
  for(const [index,invite] of (root.workspace?.invitations || []).entries()){
   const oldEmail=invite.email;
   if(invite.accepted || submitted.has(oldEmail) || !/^(roommate-[a-z0-9-]+|applicant-[a-z]+)@example\.test$/.test(oldEmail || ''))continue;
   const owner=claimed.get(oldEmail);
   if(!owner || owner===groupId){claimed.set(oldEmail,groupId);continue;}
   const email=replacements.get(oldEmail) || `roommate-${groupId}-${index+1}@example.test`;
   replacements.set(oldEmail,email);invite.email=email;
  }
  if(replacements.size){
   const replaceEmails=value=>{
    if(typeof value==='string'){for(const [old,email] of replacements)value=value.replaceAll(old,email);return value;}
    if(Array.isArray(value))return value.map(replaceEmails);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,replaceEmails(v)]));
    return value;
   };
   Object.assign(root,replaceEmails(root));
   for(const message of state.emails || [])if(JSON.stringify(message).includes(groupId))Object.assign(message,replaceEmails(message));
   root.workspace_version=(root.workspace_version || 0)+1;
   root.workspace.activity=[...(root.workspace.activity || []),{action:'request_info',by:'demo-repair',at:new Date().toISOString(),detail:'Separated copied mock roommate identities from unrelated application groups. Pending application requirements are unchanged.'}];
  }
 }
 state.demo_roommate_seed=1;
}
