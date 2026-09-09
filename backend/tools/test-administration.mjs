import assert from "node:assert/strict";
import worker from "../../worker/index.js";
import { makeRealAuth } from "../adapters/auth-real/index.ts";
import { resolveStaff } from "../../worker/staff.js";
import { createWorkspaceFixtures, ids } from "./workspace-fixtures.mjs";
const fixture=createWorkspaceFixtures();
fixture.state.staff.push({email:"peer-admin@example.test",name:"Other Admin",role:"manager",active:true,property_ids:[],account_version:0});
const owner="platform-owner@example.test",admin="admin@example.test",agent="agent-a@example.test",landlord="owner@example.test";
const actualFetch=globalThis.fetch;globalThis.fetch=fixture.fetch;
const inbox=[];let failMail=false,checks=0;
const env={...fixture.env,OWNER_EMAIL:owner,LOCAL_EMAIL_SINK:{send:async m=>{if(failMail)throw new Error("Simulated sender failure");inbox.push(m);}}};
const equal=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
async function call(person,path,method="GET",body,token){
  const role=person===agent?"agent":person===landlord?"landlord":"manager";
  const request=new Request(`http://localhost${path}`,{method,headers:{...(body?{"Content-Type":"application/json"}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const response=await worker.fetch(request,{...env,DEV_ADMIN_EMAIL:person||"",DEV_ADMIN_ROLE:role},{waitUntil:promise=>promise.catch(()=>{})});
  return {status:response.status,body:await response.json()};
}
const staff=(person,email,action,extra={})=>call(person,`/api/admin/staff/${encodeURIComponent(email)}/actions`,"POST",{action,version:fixture.state.staff.find(s=>s.email===email)?.account_version??-1,...extra});
const invite=async(email="new-partner@example.test")=>{const response=await call(admin,"/api/admin/onboarding","POST",{id:crypto.randomUUID(),email,contact_name:"Morgan Owner"});equal(response.status,201);return response.body.invitation;};
const tokenOf=()=>/\/landlord-onboarding\/#([a-f0-9]{64})/.exec(inbox.at(-1).text)[1];
const getRow=id=>fixture.state.onboarding.find(r=>r.id===id);
const act=(id,action,extra={})=>call(admin,`/api/admin/onboarding/${id}/actions`,"POST",{action,version:getRow(id).version,...extra});
const data={legal_name:"Morgan Holdings LLC",contact_name:"Morgan Owner",phone:"212-555-0101",mailing_address:"12 Example Lane, New York, NY 10001",properties:[{name:"Maple House",street:"40 Example Street",city:"New York",state_abbr:"NY",zip:"10001",unit_count:"6",notes:"Synthetic property intake",utilities:{water:"Landlord",electricity:"Tenant"}}]};
try{
  equal((await call(owner,"/api/admin/me")).body.owner,true);
  equal((await call(admin,"/api/admin/me")).body.owner,false);
  equal(await makeRealAuth({...env,DEV_ADMIN_EMAIL:owner,DEV_ADMIN_ROLE:"manager"}).resolve(new Request("http://localhost/api/v2/admin/cases")),null,"Owner is not a v2 business principal");
  const directory=(await call(admin,"/api/admin/staff")).body;
  equal(directory.staff.find(s=>s.email==="peer-admin@example.test").allowed_actions,[]);
  equal(directory.staff.find(s=>s.email===agent).allowed_actions,["save","remove_account"]);
  for(const who of [agent,landlord]) for(const path of ["/api/admin/staff","/api/admin/onboarding"]) equal((await call(who,path)).status,403);
  equal((await staff(admin,"peer-admin@example.test","save",{role:"manager",name:"Intrusion",active:false})).status,403);
  equal((await staff(admin,agent,"grant_admin",{reason:"I want access"})).status,403);
  equal((await call(admin,"/api/admin/staff","PUT",{email:"new-admin@example.test",role:"manager",version:-1})).status,403);
  equal((await staff(owner,landlord,"grant_admin",{reason:"External to internal"})).status,409);
  equal((await call(owner,"/api/admin/staff","PUT",{email:landlord,role:"agent",version:0})).status,409);
  const version=fixture.state.staff.find(s=>s.email===agent).account_version;
  equal((await staff(owner,agent,"grant_admin",{reason:"Leads day-to-day operations"})).status,200);
  equal((await call(admin,"/api/admin/staff","PUT",{email:agent,role:"agent",name:"Stale admin edit",version})).status,403);
  const principal=await resolveStaff(env,{email:agent});equal(principal.identity.role,"manager");
  equal((await staff(owner,agent,"revoke_admin",{reason:"Returns to leasing responsibilities"})).status,200);
  equal((await call(owner,`/api/admin/staff/${agent}/history`)).body.history.length,2);
  equal((await call(admin,`/api/admin/staff/${agent}`,"DELETE")).status,409);
  equal((await call(admin,"/api/admin/staff","PUT",{email:"fresh-agent@example.test",role:"agent",name:"Fresh Agent",version:-1,property_ids:[ids.property],active:true})).status,200);
  equal((await call(admin,"/api/admin/staff","PUT",{email:"fresh-agent@example.test",role:"agent",name:"Duplicate",version:-1})).status,409);

  equal((await call(admin,"/api/admin/staff","PUT",{email:admin,role:"manager",version:0,active:false})).status,403);
  equal((await call(admin,"/api/admin/staff","PUT",{email:"fresh-agent@example.test",role:"agent"})).status,422);
  equal((await call(admin,"/api/admin/staff","PUT",{email:"not-an-email",role:"agent",version:-1})).status,422);
  equal((await call(admin,"/api/admin/staff","PUT",{email:"Fresh.Agent2@Example.test ",role:"agent",version:-1})).body.member.email,"fresh.agent2@example.test");
  const inactive=fixture.state.staff.find(s=>s.email==="fresh-agent@example.test");inactive.active=false;
  equal((await call(admin,"/api/admin/staff","PUT",{email:inactive.email,role:"agent",version:inactive.account_version})).body.member.active,false);
  equal(fixture.state.staff.find(s=>s.email===inactive.email).name,"Fresh Agent","Omitting a name preserves the account name");
  equal((await call(admin,"/api/admin/staff","PUT",{email:inactive.email,role:"agent",version:inactive.account_version,active:"false"})).status,422);
  equal((await staff(owner,agent,"grant_admin",{reason:""})).status,422);
  equal((await call(owner,"/api/admin/staff","PUT",{email:agent,role:"agent",version:fixture.state.staff.find(s=>s.email===agent).account_version,property_ids:[crypto.randomUUID()]})).status,409);

  // The Owner is an access governor, not a business administrator.
  for (const path of ["/api/admin/listings", "/api/admin/applications", `/api/admin/applications/${ids.a}/ssn`, "/api/admin/cases", `/api/admin/cases/${ids.a}`, "/api/admin/requests", "/api/admin/onboarding", "/api/admin/lease/fields", `/api/admin/buildings/${ids.property}`, `/api/admin/documents/${ids.doc}`]) {
    equal((await call(owner,path)).status,403,`Owner must not read business data: ${path}`);
  }
  for (const [path,method,body] of [["/api/admin/buildings","POST",{}],["/api/admin/onboarding","POST",{}],[`/api/admin/cases/${ids.a}/actions`,"POST",{action:"approve"}],["/api/admin/lease/document","POST",{listing_id:ids.listing}]]) {
    equal((await call(owner,path,method,body)).status,403,"Owner cannot mutate business data");
  }
  equal((await call(owner,"/api/admin/staff")).status,200);
  const propertyDirectory=(await call(owner,"/api/admin/buildings")).body.buildings;
  equal(propertyDirectory.every(b=>Object.keys(b).sort().join(",")==="id,name"),true,"Permission selectors receive names and IDs only");
  for(const person of [admin,owner]) {
    const bound=fixture.state.staff.find(s=>s.email===landlord);
    equal((await call(person,"/api/admin/staff","PUT",{email:landlord,role:"landlord",version:bound.account_version||0,property_ids:[]})).status,403,"Cannot unbind landlord properties");
    equal((await call(person,"/api/admin/staff","PUT",{email:landlord,role:"landlord",version:bound.account_version||0,property_ids:[ids.property,ids.otherProperty]})).status,403,"Cannot expand landlord properties");
    equal((await call(person,"/api/admin/staff","PUT",{email:"manual-landlord@example.test",role:"landlord",version:-1,property_ids:[ids.property]})).status,403,"Landlords enter through onboarding only");
  }
  const bound=fixture.state.staff.find(s=>s.email===landlord), originalProperties=[...bound.property_ids];
  equal((await call(admin,"/api/admin/staff","PUT",{email:landlord,role:"landlord",version:bound.account_version||0,name:bound.name,active:bound.active})).status,200);
  equal(fixture.state.staff.find(s=>s.email===landlord).property_ids,originalProperties,"Saving account details preserves property bindings");

  const freshAdmin="direct-admin@example.test";
  equal((await staff(admin,freshAdmin,"create_admin",{name:"Direct Admin",reason:"Manage leasing operations"})).status,403);
  equal((await staff(owner,freshAdmin,"create_admin",{name:"Direct Admin",reason:""})).status,422);
  equal((await staff(owner,freshAdmin,"create_admin",{name:"Direct Admin",reason:"Manage leasing operations"})).status,200);
  equal((await call(freshAdmin,"/api/admin/me")).body.role,"manager");
  equal((await staff(owner,freshAdmin,"create_admin",{name:"Duplicate",reason:"Must not replace account"})).status,409);
  equal((await staff(owner,landlord,"create_admin",{name:"Collision",reason:"Must not convert landlord"})).status,409);
  equal((await staff(admin,freshAdmin,"remove_admin",{reason:"Unauthorized removal"})).status,403);
  equal((await staff(owner,freshAdmin,"remove_admin",{reason:""})).status,422);
  equal((await staff(owner,owner,"remove_admin",{reason:"Must protect owner"})).status,403);
  equal((await staff(owner,freshAdmin,"remove_admin",{reason:"No longer on the operations team"})).status,200);
  equal((await resolveStaff(env,{email:freshAdmin})).status,403,"Removed Admin loses authenticated platform access, not merely Admin privileges");
  equal(fixture.state.staff.find(s=>s.email===freshAdmin).active,false);
  equal((await call(owner,`/api/admin/staff/${freshAdmin}/history`)).body.history.map(h=>h.action),["remove_admin","create_admin"]);
  equal((await staff(owner,freshAdmin,"remove_admin",{reason:"Already removed"})).status,403);
  const record=await invite();const token=tokenOf();
  equal(record.status,"invited");equal(record.email_state,"preview");equal("token_hash" in record,false);
  equal(getRow(record.id).token_hash===token,false,"Only the token digest is stored");
  equal(inbox.at(-1).html.includes("Complete property information"),true);
  equal((await call(admin,"/api/admin/onboarding","POST",{id:record.id,email:record.email,contact_name:"Retry"})).status,201);equal(inbox.length,1,"Retrying the same invitation does not resend");
  for(const bad of [undefined,"a".repeat(64),"invalid"])equal((await call(null,"/api/landlord-onboarding","GET",undefined,bad)).status,410);
  equal((await act(record.id,"approve")).status,409);
  const read=await call(null,"/api/landlord-onboarding","GET",undefined,token);equal(read.status,200);
  equal((await call(null,"/api/landlord-onboarding","POST",{version:0,data,submit:"true",attested:true},token)).status,422);
  equal((await call(null,"/api/landlord-onboarding","POST",{data,submit:false},token)).status,422);
  for(const key of ["created_by","activity","token_hash","building_ids","email_state"])equal(key in read.body.invitation,false);
  equal((await call(null,"/api/landlord-onboarding","POST",{version:0,data:{...data,legal_name:""},submit:false},token)).status,200);
  equal((await call(null,"/api/landlord-onboarding","GET",undefined,token)).body.invitation.data.phone,data.phone,"Draft survives reload");
  equal((await call(null,"/api/landlord-onboarding","POST",{version:0,data,submit:false},token)).status,409);
  equal((await call(null,"/api/landlord-onboarding","POST",{version:1,data,submit:true,attested:false},token)).status,422);
  equal((await call(null,"/api/landlord-onboarding","POST",{version:1,data:{...data,properties:[{...data.properties[0],zip:"bad"}]},submit:true,attested:true},token)).status,422);
  equal((await call(null,"/api/landlord-onboarding","POST",{version:1,data,submit:true,attested:true},token)).status,200);
  equal((await call(null,"/api/landlord-onboarding","POST",{version:2,data,submit:false},token)).status,409);
  equal((await act(record.id,"request_changes",{reason:"Please confirm the street number."})).status,200);
  const revisedToken=tokenOf();equal(revisedToken!==token,true);
  equal((await call(null,"/api/landlord-onboarding","GET",undefined,token)).status,410);
  const corrections=(await call(null,"/api/landlord-onboarding","GET",undefined,revisedToken)).body.invitation;
  equal(corrections.status,"changes_requested");equal(corrections.review_note,"Please confirm the street number.");
  equal((await call(null,"/api/landlord-onboarding","POST",{version:corrections.version,data:{...data,properties:[{...data.properties[0],street:"42 Example Street"}]},submit:true,attested:true},revisedToken)).status,200);
  const submittedVersion=getRow(record.id).version;
  const approvals=await Promise.all([1,2].map(()=>call(admin,`/api/admin/onboarding/${record.id}/actions`,"POST",{action:"approve",version:submittedVersion})));
  equal(approvals.map(r=>r.status).sort(),[200,409],"Concurrent approval creates only one set of properties");
  equal(fixture.state.buildings.filter(b=>b.name===data.properties[0].name).length,1);
  const buildingId=getRow(record.id).building_ids[0];
  const partner=fixture.state.staff.find(s=>s.email===record.email);equal(partner.role,"landlord");equal(partner.property_ids,[buildingId]);
  equal(fixture.state.settings[buildingId]["utility.electricity"],"Tenant");
  const resolved=await resolveStaff(env,{email:record.email});equal(resolved.identity.role,"landlord");equal(resolved.identity.property_ids,[buildingId]);
  equal((await call(null,"/api/landlord-onboarding","GET",undefined,revisedToken)).body.invitation.status,"approved");
  equal((await call(null,"/api/landlord-onboarding","POST",{version:getRow(record.id).version,data,submit:false},revisedToken)).status,409);
  equal((await call(admin,"/api/admin/onboarding","POST",{id:crypto.randomUUID(),email:agent,contact_name:"Internal account"})).status,409);
  failMail=true;const failed=await invite("retry-partner@example.test");equal(failed.email_state,"failed");failMail=false;
  equal((await act(failed.id,"resend")).status,200);equal(getRow(failed.id).email_state,"preview");
  const expires=tokenOf();getRow(failed.id).expires_at="2020-01-01T00:00:00Z";
  equal((await call(null,"/api/landlord-onboarding","GET",undefined,expires)).status,410);
  equal((await act(failed.id,"resend")).status,200);
  const cancelled=tokenOf();equal((await act(failed.id,"cancel")).status,200);
  equal((await call(null,"/api/landlord-onboarding","GET",undefined,cancelled)).status,410);
  equal((await act(failed.id,"resend")).status,409);
  for (const actor of [admin, owner]) {
    const email = `removal-${actor.split("@")[0]}@example.test`;
    equal((await call(actor,"/api/admin/staff","PUT",{email,role:"agent",name:"Removal test",version:-1,active:true,property_ids:[ids.property]})).status,200);
    equal((await staff(actor,email,"remove_account",{reason:""})).status,422);
    for (const unauthorized of [agent,landlord]) equal((await staff(unauthorized,email,"remove_account",{reason:"Unauthorized removal"})).status,403);
    equal((await staff(actor,email,"remove_account",{version:99,reason:"Stale removal"})).status,409);
    equal((await staff(actor,email,"remove_account",{reason:"No longer on the team",role:"manager",property_ids:[]})).status,200);
    equal((await resolveStaff(env,{email})).status,403);
    const retained=fixture.state.staff.find(s=>s.email===email);
    equal(retained.role,"agent"); equal(retained.property_ids,[ids.property]);
    equal((await staff(actor,email,"remove_account",{reason:"Already removed"})).status,403);
    equal((await staff(actor,"peer-admin@example.test","remove_account",{reason:"Must not bypass Admin protection"})).status,403);
  }
  const keptBuildings=structuredClone(fixture.state.buildings);
  for (const [actor,email] of [[admin,record.email],[owner,landlord]]) {
    const before=structuredClone(fixture.state.staff.find(s=>s.email===email));
    equal((await staff(actor,email,"remove_account",{reason:"Partnership account closed",property_ids:[],role:"agent"})).status,200);
    equal((await resolveStaff(env,{email})).status,403);
    equal(fixture.state.staff.find(s=>s.email===email).property_ids,before.property_ids);
    equal(fixture.state.staff.find(s=>s.email===email).role,"landlord");
    equal((await call(actor,`/api/admin/staff/${email}/history`)).body.history[0].action,"remove_account");
  }
  equal(fixture.state.buildings,keptBuildings,"Removing landlords must preserve property records");
  console.log(`PASS ${checks} HTTP checks: Owner governance, account scope, invitation mail, draft, correction, approval, binding, CAS, expiration and cancellation`);
}finally{globalThis.fetch=actualFetch;}
