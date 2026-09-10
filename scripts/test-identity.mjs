// Real Worker routes, synthetic Supabase transport. Never reads credentials.
import assert from "node:assert/strict";
import worker from "../worker/index.js";
import { ids } from "../backend/tools/workspace-fixtures.mjs";
import { makeRealAuth } from "../backend/adapters/auth-real/index.ts";
import { createIdentityFixture } from "./identity-fixtures.mjs";
const {fixture,env,users,tokens,codes,requests,controls,user,restore} = createIdentityFixture();
const owner = env.OWNER_EMAIL;
let checks = 0;
const eq = (a,b,message) => { assert.deepEqual(a,b,message); checks++; };
const pending = [];
async function call(path, {cookie,body,method = body ? "POST" : "GET",origin = "https://workspace.example.test",extra = {},headers = {}} = {}) {
  const response = await worker.fetch(new Request(`https://workspace.example.test${path}`, {method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{"Content-Type":"application/json",Origin:origin}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})}),{...env,...extra},{waitUntil:p=>pending.push(p)});
  const result = {status:response.status,cookie:response.headers.get("Set-Cookie"),headers:response.headers,body:await response.json().catch(()=>null)};
  return result;
}
async function login(email) {
  const result = await call("/api/auth/login",{body:{email,password:users.get(email).password}});
  eq(result.status,200); assert(result.cookie.includes("HttpOnly") && result.cookie.includes("Secure")); checks++;
  eq(Object.keys(result.body).sort(),["email","ok"]); return result.cookie.split(";")[0];
}
try {
  eq((await call("/api/admin/me")).status,401);
  eq((await call("/api/admin/me",{headers:{"Cf-Access-Jwt-Assertion":"forged"}})).status,401);
  const redirect = await call("/admin/"); eq(redirect.status,302); eq(redirect.headers.get("Location"),"/login/?next=admin");
  eq((await call("/api/auth/login",{body:{email:owner,password:"wrong"}})).status,401);
  eq((await call("/api/auth/login",{body:{email:owner,password:"testing-password"},origin:"https://attacker.test"})).status,403);
  eq((await call("/api/auth/login",{body:{email:owner,password:"a".repeat(17000)}})).status,413);
  const applicant = await login("applicant@example.test");
  eq((await call("/api/admin/me",{cookie:applicant})).status,403,"User metadata cannot grant workspace access");
  eq((await call("/api/portal/me",{cookie:applicant})).status,200);
  eq((await call(`/api/portal/documents/${ids.doc}`,{cookie:applicant})).status,404,"Applicant cannot read someone else's document");
  const ownerCookie = await login(owner), admin = await login("admin@example.test"), agent = await login("agent-a@example.test"), landlord = await login("owner@example.test");
  for (const [cookie,role] of [[ownerCookie,"manager"],[admin,"manager"],[agent,"agent"],[landlord,"landlord"]]) eq((await call("/api/admin/me",{cookie})).body.role,role);
  eq((await call("/api/admin/me",{cookie:ownerCookie})).body.owner,true);
  eq((await call("/api/admin/cases",{cookie:ownerCookie})).status,403);
  eq((await call("/api/admin/staff",{cookie:agent})).status,403);
  eq((await call(`/api/admin/cases/${ids.b}`,{cookie:agent})).status,404);
  eq((await call(`/api/admin/documents/${ids.doc}`,{cookie:landlord})).status,404);
  eq((await call("/api/admin/staff",{cookie:landlord})).status,403);
  eq((await call("/api/admin/staff",{cookie:admin,body:{},method:"PUT",origin:"https://attacker.test"})).status,403);
  const deniedInvite = await call(`/api/admin/staff/admin%40example.test/invite`,{cookie:admin,body:{}});eq(deniedInvite.status,403);
  eq((await call(`/api/admin/staff/admin%40example.test/invite`,{cookie:ownerCookie,body:{}})).body.invitation.status,"sent");
  const fresh = "new-agent@example.test";
  eq((await call("/api/admin/staff",{cookie:admin,method:"PUT",body:{email:fresh,name:"New agent",role:"agent",active:true,version:-1}})).body.invitation.status,"sent");
  const activation = await call("/api/auth/workspace-activate",{body:{email:fresh,code:"123456",password:"new-password"}});
  eq(activation.status,200); eq((await call("/api/admin/me",{cookie:activation.cookie.split(";")[0]})).body.role,"agent");
  eq((await call("/api/auth/workspace-activate",{body:{email:fresh,code:"123456",password:"new-password"}})).status,401,"Codes cannot be reused");
  eq((await call("/api/auth/workspace-activate",{body:{email:"applicant@example.test",code:"123456",password:"new-password"}})).status,403);
  const mailCount = requests.filter(p=>p==="/auth/v1/otp").length;
  eq((await call("/api/auth/workspace-code",{body:{email:"unknown@example.test"}})).status,200);
  eq(requests.filter(p=>p==="/auth/v1/otp").length,mailCount,"Public activation cannot create uninvited accounts");
  controls.failMail = true;
  const failed = await call("/api/admin/staff",{cookie:admin,method:"PUT",body:{email:"retry-agent@example.test",role:"agent",active:true,version:-1}});
  eq(failed.status,200); eq(failed.body.invitation.status,"failed"); controls.failMail=false;
  eq((await call("/api/admin/staff/retry-agent%40example.test/invite",{cookie:admin,body:{}})).body.invitation.status,"sent");
  const agentRow = fixture.state.staff.find(s=>s.email==="agent-a@example.test");
  agentRow.active=false; eq((await call("/api/admin/me",{cookie:agent})).status,403,"Suspension takes effect within the current session"); agentRow.active=true;
  const oldId=users.get(agentRow.email).id; users.get(agentRow.email).id="different-id";
  eq((await call("/api/admin/me",{cookie:agent})).status,403,"Reused email cannot take over a pinned account"); users.get(agentRow.email).id=oldId;
  eq((await call("/api/admin/me",{cookie:ownerCookie,extra:{OWNER_AUTH_USER_ID:"different-id"}})).status,403);
  eq((await call("/api/admin/me",{cookie:ownerCookie,extra:{OWNER_AUTH_USER_ID:""}})).status,503);
  const unconfirmed = user("unconfirmed@example.test"); unconfirmed.email_confirmed_at=null;
  eq((await call("/api/auth/login",{body:{email:unconfirmed.email,password:unconfirmed.password}})).status,403);
  // Approval creates the external account and invites it only after its properties exist.
  const intakeId = crypto.randomUUID(), partner = "approved-partner@example.test";
  fixture.state.onboarding.push({id:intakeId,email:partner,contact_name:"Partner",created_by:"admin@example.test",created_at:new Date().toISOString(),token_hash:"test-hash",expires_at:"2027-01-01T00:00:00Z",version:0,status:"submitted",email_state:"sent",review_note:"",building_ids:[],activity:[],data:{legal_name:"Partner Holdings",contact_name:"Partner",phone:"2125550100",mailing_address:"10 Example Street",properties:[{name:"Auth Test Property",street:"10 Example Street",city:"New York",state_abbr:"NY",zip:"10001",unit_count:"2",notes:"",utilities:{water:"Landlord"}}]}});
  const approved = await call(`/api/admin/onboarding/${intakeId}/actions`,{cookie:admin,body:{action:"approve",version:0}});
  eq(approved.status,200);eq(approved.body.account_invitation.status,"sent");
  const partnerActivation=await call("/api/auth/workspace-activate",{body:{email:partner,code:"123456",password:"partner-password"}});
  eq(partnerActivation.status,200);
  const partnerMe=await call("/api/admin/me",{cookie:partnerActivation.cookie.split(";")[0]});eq(partnerMe.body.role,"landlord");eq(partnerMe.body.property_ids,approved.body.invitation.building_ids);
  const expiredCookie = `star_portal=${Buffer.from(JSON.stringify({at:"expired",rt:"refresh:admin@example.test"})).toString("base64url")}`;
  const refreshed = await call("/api/admin/me",{cookie:expiredCookie});eq(refreshed.status,200);assert(refreshed.cookie);checks++;
  const refreshedDenied = await call("/api/admin/me",{cookie:`star_portal=${Buffer.from(JSON.stringify({at:"expired",rt:"refresh:applicant@example.test"})).toString("base64url")}`});eq(refreshedDenied.status,403);assert(refreshedDenied.cookie);checks++;
  const real = makeRealAuth(env); eq((await real.resolve(new Request("https://workspace.example.test/api/v2/admin/cases",{headers:{Cookie:admin}}))).kind,"staff");
  eq((await real.resolve(new Request("https://workspace.example.test/api/v2/me",{headers:{Cookie:applicant}}))).kind,"applicant");
  const reset = await call("/api/auth/request-reset",{body:{email:fresh}});eq(reset.status,200);
  eq((await call("/api/auth/verify-reset",{body:{email:fresh,code:"123456",password:"reset-password"}})).status,200);
  const logout = await call("/api/auth/sign-out",{cookie:admin,body:{}});eq(logout.status,200); assert(logout.cookie.includes("Max-Age=0"));checks++;
  await Promise.all(pending);eq((await call("/api/admin/me")).status,401);
  eq((await call("/api/admin/me",{cookie:admin})).status,401,"Revoked session cannot be refreshed after logout");
  console.log(`PASS ${checks} unified identity checks: five roles, invitation, recovery, refresh, isolation, revocation and forged identities`);
} finally { restore(); }
