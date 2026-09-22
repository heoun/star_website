// Local test/demo storage only. Production uses the SQL functions tested separately.
export function administrationFixture(state, table, method, q, body, response) {
  state.onboarding ||= []; state.account_audit ||= []; state.emails ||= [];
  const version = row => row.account_version || 0;
  const match = (row,key) => !q.has(key) || String(row[key]) === q.get(key).replace(/^eq\./,"");
  const paged = rows => rows.slice(Number(q.get("offset")||0),Number(q.get("offset")||0)+Number(q.get("limit")||1000));
  const denied = message => response({code:"P0001",message},400);
  if(table === "account_access_audit") return response(paged(state.account_audit.filter(r=>match(r,"email"))));
  if(table === "manage_workspace_account") {
    const old = state.staff.find(s=>s.email===body.p_email),data=body.p_data,isOwner=body.p_owner_email && body.p_actor===body.p_owner_email;
    if(!isOwner && !state.staff.some(s=>s.email===body.p_actor&&s.role==="manager"&&s.active))return denied("Only Admin can manage accounts");
    if(body.p_email===body.p_owner_email||body.p_email===body.p_actor)return denied("Your account and the platform owner cannot be changed here");
    if((old?version(old):-1)!==body.p_version)return denied("Account changed. Refresh before saving");
    if((old?.role==="manager"||!["save","remove_account"].includes(body.p_action))&&!isOwner)return denied("Only the platform owner can manage Admin accounts");
    if(body.p_action==="save" && ((old&&data.role!==old.role)||(!old&&!["agent","landlord"].includes(data.role))))return denied("Account type is fixed. Use the separate authorization action");
    if(body.p_action!=="save" && body.p_action!=="create_admin" && body.p_action!=="remove_account" && (!old || !["agent","manager"].includes(old.role) || !body.p_reason))return denied("Choose an internal account and record the reason");
    if(data.property_ids?.some(id=>!state.buildings.some(b=>b.id===id)))return denied("A selected property no longer exists");
    const before=old?structuredClone(old):null;
    const row=old||{email:body.p_email};
    if(body.p_action==="save") Object.assign(row,{role:data.role,name:data.name,active:data.active??old?.active??true,property_ids:data.property_ids??old?.property_ids??[]});
    else if(body.p_action === "create_admin") { row.role="manager"; row.name=data.name; row.active=true; row.property_ids=[]; }
    else if(["remove_admin","remove_account"].includes(body.p_action)) row.active=false;
    else row.role=body.p_action==="grant_admin"?"manager":"agent";
    row.account_version=old?version(old)+1:0;
    if(!old)state.staff.push(row);
    state.account_audit.unshift({id:crypto.randomUUID(),email:row.email,actor:body.p_actor,action:body.p_action,reason:body.p_reason,before_record:before,after_record:structuredClone(row),created_at:new Date().toISOString()});
    return response(row);
  }
  if(table === "landlord_onboarding") {
    if(method==="POST") {if(state.onboarding.some(r=>r.id===body.id))return response([]);state.onboarding.unshift(body);return response([body]);}
    const rows=state.onboarding.filter(r=>match(r,"id")&&match(r,"token_hash"));
    if(method==="PATCH")rows.forEach(r=>Object.assign(r,body));
    return response(paged(rows));
  }
  if(table === "update_landlord_onboarding") {
    const row=state.onboarding.find(r=>r.id===body.p_id&&r.version===body.p_version);
    if(!row||["approved","rejected","cancelled"].includes(row.status))return response([]);
    Object.assign(row,body.p_patch);row.version++;return response([row]);
  }
  if(table === "approve_landlord_onboarding") {
    const row=state.onboarding.find(r=>r.id===body.p_id&&r.version===body.p_version&&r.status==="submitted");
    if(!row)return denied("Submission changed or already reviewed");
    const old=state.staff.find(s=>s.email===row.email);
    if(old&&(old.role!=="landlord"||!old.active))return denied("This address belongs to an internal or inactive account");
    if(row.data.properties.some(p=>state.buildings.some(b=>b.name.toLowerCase()===p.name.toLowerCase()||(b.street.toLowerCase()===p.street.toLowerCase()&&b.city.toLowerCase()===p.city.toLowerCase()&&b.zip===p.zip))))return denied("A property with this name or address already exists. Review the duplicate before approving");
    const before=old?structuredClone(old):null;
    row.building_ids=row.data.properties.map(p=>{const id=crypto.randomUUID();state.buildings.push({id,...p,landlord_signer_email:row.email,landlord_email:row.email,declared_units:Number(p.unit_count)||null,onboarding_id:row.id});state.settings[id]={"landlord.entity_name":row.data.legal_name,"landlord.print_name":row.data.contact_name,"landlord.address":row.data.mailing_address,...Object.fromEntries(Object.entries(p.utilities||{}).map(([k,v])=>[`utility.${k}`,v]))};return id;});
    const member=old||{email:row.email,name:row.data.contact_name,role:"landlord",active:true,property_ids:[],account_version:0};
    member.property_ids=[...new Set([...member.property_ids,...row.building_ids])];if(old)member.account_version=version(old)+1;else state.staff.push(member);
    state.account_audit.unshift({id:crypto.randomUUID(),email:row.email,actor:body.p_actor,action:"onboarding_approved",reason:row.id,before_record:before,after_record:structuredClone(member),created_at:new Date().toISOString()});
    row.status="approved";row.version++;row.activity.push({action:"approved",by:body.p_actor,at:new Date().toISOString()});return response(row);
  }
}
