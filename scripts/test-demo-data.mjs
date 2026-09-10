import { toFeedListing } from "../worker/supabase.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWorkspaceFixtures, ids } from "../backend/tools/workspace-fixtures.mjs";
import { completeDemoState, annotateDemoTemplate, DEMO_ENCRYPTION_KEY, MOCK_PREVIEW_TENANCY } from "./demo-data.mjs";
import { LEASE_REGISTRY, dealValues, resolveValues, fillTemplate } from "../worker/lease.js";
import { reviewLease } from "../site/shared/lease-review.js";
import { documentSummary } from "../site/admin/application-view.js";
import { parseDate } from "../site/shared/lease-dates.js";
import { DOCUMENT_TYPES } from "../worker/portal.js";
import { handleAdminRequest } from "../worker/admin.js";
import { readEntries, readEntryText } from "../worker/zip.js";
const fixture = createWorkspaceFixtures(); let checks = 0;
const equal=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
const originalTemplate = readFileSync(new URL("../lease/template/lease-template.docx",import.meta.url));
const template = await annotateDemoTemplate(originalTemplate);
const env = {...fixture.env, APP_ENCRYPTION_KEY:DEMO_ENCRYPTION_KEY, ASSETS:{fetch:async()=>new Response(template)}};
const actualFetch=globalThis.fetch;globalThis.fetch=fixture.fetch;
const xmlOf = async bytes => readEntryText(readEntries(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),"word/document.xml");
try {
  // An approved onboarding can create a property before any listing exists.
  const addedProperty = "99999999-9999-4999-8999-999999999999";
  fixture.state.buildings.push({id:addedProperty,name:"New Example Property"});
  fixture.state.settings[addedProperty] = {"landlord.entity_name":"Onboarded Example LLC"};
  fixture.state.listings[0].price_display = "obsolete";
  fixture.state.listings[0].neighborhood = "obsolete";
  fixture.state.listings[0].kind_label = "obsolete";
  fixture.state.listings[0].position = 99;
  await completeDemoState(fixture.state);
  for (const key of ["price_display", "neighborhood", "kind_label", "position"]) equal(key in fixture.state.listings[0],false,"Removed listing fields are pruned from persisted demo data");
  equal(fixture.state.staff.some(s=>s.role==="landlord" && s.property_ids?.includes(addedProperty)),true,"Every mock property has a scoped landlord");
  equal(fixture.state.settings[addedProperty]["payee.name"],"Onboarded Example LLC","Provided landlord details stay consistent with generated contacts");
  equal(fixture.state.listings.filter(l=>l.building_id===addedProperty).length,1,"A property without listings receives one sample unit in the local demo only");
  for(const l of fixture.state.listings) equal(toFeedListing(l).price,`${new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(l.price_amount)}/mo`,"Displayed rent matches the unit's numeric rent");
  for (const b of fixture.state.buildings) {
    const values=fixture.state.settings[b.id];
    equal(Object.keys(values).sort(),LEASE_REGISTRY.fields.filter(f=>f.source==="manager").map(f=>f.id).sort(),"Every property has all 125 stored lease defaults");
    for (const f of LEASE_REGISTRY.fields.filter(f=>f.source==="manager")) {
      if(f.type==="checkbox")assert.equal(typeof values[f.id],"boolean");
      else assert(String(values[f.id]).trim(),f.id);
      if(f.type==="choice")assert(f.options.includes(values[f.id]),f.id);
      assert(!String(values[f.id]).includes("(mock)"),"Labels must not contaminate stored values");
    }
    checks++;
    const listing=fixture.state.listings.find(l=>l.building_id===b.id);
    const app=fixture.state.applications.find(a=>a.listing_id===listing.id);
    const result=resolveValues({layers:{building:values,unit:{}},deal:dealValues({building:b,listing,application:app,today:parseDate("2026-09-09")})});
    equal(result.missing,[],"Mock data resolves every required lease field");
    equal(reviewLease({registry:LEASE_REGISTRY,...result,application:app}).findings.blank,[],"Checkbox disclosures must form a consistent scenario");
    const docx=await fillTemplate(env,{url:"http://localhost/admin/"},result.values),xml=await xmlOf(docx);
    assert(!xml.includes("{{"));assert(xml.includes("MOCK LEASE - DEMONSTRATION ONLY"));checks++;
    equal((xml.match(/\(mock\)/g)||[]).length,(await xmlOf(originalTemplate)).match(/\{\{/g).length,"Every printed placeholder carries (mock)");
    const preview = await handleAdminRequest(new Request("http://localhost/api/admin/lease/document",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"values",listing_id:listing.id,overrides:MOCK_PREVIEW_TENANCY})}),env,{},"/api/admin/lease/document");
    equal(preview.status,200);
    equal((await preview.json()).missing,[],"Standalone property previews include a complete independent sample tenancy");
  }
  for(const app of fixture.state.applications){
    assert(app.current_employer.employer);assert(app.rental_history.length);assert(app.reference_contacts.length>=2);assert(app.emergency_contacts.length);checks++;
    const response=await handleAdminRequest(new Request(`http://localhost/api/admin/lease/document/${app.id}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"values"})}),env,{},`/api/admin/lease/document/${app.id}`);
    equal(response.status,200);equal((await response.json()).missing,[]);
    const docs=fixture.state.documents.filter(d=>d.application_id===app.id);
    equal(documentSummary({...app,application_documents:docs},DOCUMENT_TYPES).rows.filter(r=>r.state==="missing" || r.state==="partial"),[],"Every applicable supporting-document slot has a viewable sample");
    assert(docs.every(d=>fixture.state.files[d.path].length>1000));checks++;
  }
  const ssn=await handleAdminRequest(new Request(`http://localhost/api/admin/applications/${ids.a}/ssn`),env,{},`/api/admin/applications/${ids.a}/ssn`);
  equal(ssn.status,200);equal((await ssn.json()).ssn,"000-00-1234");
  const put = {scope:"building",building_id:ids.property,field_values:{"manager.phone":"212-555-0199"}};
  const saved=await handleAdminRequest(new Request("http://localhost/api/admin/lease/settings",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(put)}),env,{},"/api/admin/lease/settings");
  equal(saved.status,200);equal(fixture.state.settings[ids.property]["manager.phone"],"212-555-0199","Demo saves really persist");
  fixture.state.settings[ids.property]["utility.other1_label"]="";
  const count=fixture.state.documents.length;
  const listingCount=fixture.state.listings.length, applicationCount=fixture.state.applications.length;
  await completeDemoState(fixture.state);
  equal(fixture.state.documents.length,count,"Reload never duplicates sample documents");
  equal(fixture.state.listings.length,listingCount,"Reload never duplicates sample units");
  equal(fixture.state.applications.length,applicationCount,"Reload never duplicates applications");
  equal(fixture.state.settings[ids.property]["manager.phone"],"212-555-0199");
  equal(fixture.state.settings[ids.property]["utility.other1_label"],"","Intentional clearing survives the next demo seed");
  equal((await xmlOf(originalTemplate)).includes("(mock)"),false,"Production template remains untouched");
  equal((await xmlOf(template)).match(/<w:t[^>]*>(.*?)<\/w:t>/)?.[1],(await xmlOf(originalTemplate)).match(/<w:t[^>]*>(.*?)<\/w:t>/)?.[1],"Mock banner preserves the opening words used for document navigation");
  console.log(`PASS ${checks} complete mock data, lease generation, printed markers, disclosure consistency and persistence checks`);
} finally {globalThis.fetch=actualFetch;}
