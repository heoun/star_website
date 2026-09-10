// Real listing HTTP handlers against isolated storage: the editor's save/reopen contract.
import assert from "node:assert/strict";
import { handleAdminRequest } from "../worker/admin.js";
import { createWorkspaceFixtures } from "../backend/tools/workspace-fixtures.mjs";
import { toFeedListing, fetchListings } from "../worker/supabase.js";
import { propertyAddress } from "../site/shared/property-address.js";
const fixture = createWorkspaceFixtures();
const originalFetch = globalThis.fetch;
globalThis.fetch = fixture.fetch;
let count = 0;
const equal = (actual, expected) => { assert.deepEqual(actual, expected); count++; };
async function call(path, method = "GET", body) {
  const request = new Request(`http://localhost/api/admin${path}`, {method,
    ...(body ? {headers:{"Content-Type":"application/json"},body:JSON.stringify(body)} : {})});
  const response = await handleAdminRequest(request, fixture.env, {waitUntil:p => p.catch(() => {})}, new URL(request.url).pathname);
  equal(response.status, method === "POST" ? 201 : 200);
  return response.json();
}
try {
  const property = fixture.state.buildings[0];
  const before = fixture.state.listings.length;
  const {listing} = await call("/listings", "POST", {
    category:"residential",transaction_type:"rental",title:"Editor round trip (mock)",building_id:property.id,
    unit:"TEST",price_amount:3200,term_label:"12 months",location:"Do not trust this address",property_name:"Wrong name",
    price_display:"$1 (obsolete)",kind_label:"Obsolete badge",neighborhood:"Obsolete neighborhood",position:-100,details_url:"https://example.test/listing"
  });
  equal(fixture.state.listings.length, before + 1);
  equal(listing.published, false);
  equal(listing.location, propertyAddress(property));
  equal(listing.property_name, property.name);
  equal((await call("/listings")).listings.find(row => row.id === listing.id).title, "Editor round trip (mock)");
  property.street = "200 Updated Example Avenue";
  await call(`/listings/${listing.id}`, "PATCH", {title:"Edited draft (mock)",location:"Stale value"});
  const reopened = (await call("/listings")).listings.find(row => row.id === listing.id);
  equal(reopened.location, propertyAddress(property));
  equal([reopened.term_label,reopened.published,reopened.details_url], ["12 months",false,"https://example.test/listing"]);
  for (const field of ["price_display", "neighborhood", "kind_label", "position"]) equal(field in reopened, false);
  equal(toFeedListing({...reopened,price_display:"$1 (obsolete)"}).price, "$3,200/mo");
  equal(toFeedListing({...reopened,transaction_type:"sale"}).price, "$3,200");
  const ordered = await fetchListings(fixture.env, {publishedOnly:false});
  equal(ordered[0].id, listing.id);
  await call(`/listings/${listing.id}`, "PATCH", {published:true});
  await call(`/listings/${listing.id}`, "PATCH", {description:"Updated description (mock)"});
  equal(fixture.state.listings.find(row => row.id === listing.id).published, true);
  await call(`/listings/${listing.id}`, "PATCH", {building_id:"",location:"10 Standalone Street, Example City, NY 10001",property_name:"Standalone (mock)"});
  equal(fixture.state.listings.find(row => row.id === listing.id).location, "10 Standalone Street, Example City, NY 10001");
  equal(fixture.state.listings.find(row => row.id === listing.id).building_id, null);
  console.log(`PASS ${count} listing checks: draft creation, saved list visibility, inherited address, removed fields, numeric prices, newest-first order, explicit publication and standalone address`);
} finally { globalThis.fetch = originalFetch; }
