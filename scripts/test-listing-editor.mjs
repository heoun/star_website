// Real listing HTTP handlers against isolated storage: the editor's save/reopen contract.
import assert from "node:assert/strict";
import { handleAdminRequest } from "../worker/admin.js";
import { createListingFixtures } from "./listing-fixtures.mjs";
import { toFeedListing, fetchListings } from "../worker/supabase.js";
import { propertyAddress } from "../site/shared/property-address.js";
const fixture = createListingFixtures();
const originalFetch = globalThis.fetch;
globalThis.fetch = fixture.fetch;
let count = 0;
const equal = (actual, expected) => { assert.deepEqual(actual, expected); count++; };
async function call(path, method = "GET", body) {
  const request = new Request(`http://localhost/api/admin${path}`, {method,
    ...(body ? {headers:{"Content-Type":"application/json"},body:JSON.stringify(body)} : {})});
  const response = await handleAdminRequest(request, fixture.env, {waitUntil:p => p.catch(() => {})}, new URL(request.url).pathname);
  equal(response.status, method === "POST" && !path.endsWith("/publish") ? 201 : 200);
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
  await call(`/listings/${listing.id}/publish`, "POST", {revision:reopened.draft_revision});
  await call(`/listings/${listing.id}`, "PATCH", {description:"Updated description (mock)"});
  equal(fixture.state.listings.find(row => row.id === listing.id).published, true);
  const changed = (await call('/listings')).listings.find(row => row.id === listing.id);
  equal(changed.has_unpublished_changes, true);
  equal(changed.published_snapshot.description, undefined);
  equal(toFeedListing({...changed,price_amount:9999}).price, '$3,200/mo');
  const staleRequest = new Request(`http://localhost/api/admin/listings/${listing.id}/publish`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:reopened.draft_revision})});
  equal((await handleAdminRequest(staleRequest,fixture.env,{waitUntil:p=>p.catch(()=>{})},new URL(staleRequest.url).pathname)).status,409);
  await call(`/listings/${listing.id}/publish`, 'POST', {revision:changed.draft_revision});
  equal(fixture.state.listings.find(row=>row.id===listing.id).published_snapshot.description,'Updated description (mock)');
  await call(`/listings/${listing.id}`, "PATCH", {building_id:"",location:"10 Standalone Street, Example City, NY 10001",property_name:"Standalone (mock)"});
  equal(fixture.state.listings.find(row => row.id === listing.id).location, "10 Standalone Street, Example City, NY 10001");
  equal(fixture.state.listings.find(row => row.id === listing.id).building_id, null);
  const imagePath = `${listing.id}/cover.webp`;
  const {media} = await call(`/listings/${listing.id}/media`,'POST',{path:imagePath,kind:'photo',position:0});
  let draft = (await call('/listings')).listings.find(row=>row.id===listing.id);
  await call(`/listings/${listing.id}/publish`,'POST',{revision:draft.draft_revision});
  await call(`/media/${media.id}`,'DELETE');
  draft = (await call('/listings')).listings.find(row=>row.id===listing.id);
  equal(draft.listing_media.length,0);
  equal(toFeedListing(draft).image_url,`/media/${imagePath}`);
  equal(draft.has_unpublished_changes,true);
  const publicRows=await fetchListings(fixture.env);
  equal(publicRows.find(row=>row.id===listing.id).listing_media.length,1);
  // Public visibility never grants workspace marketing access.
  const assigned=fixture.state.listings[0];assigned.building_id=property.id;
  const outsider={...assigned,id:crypto.randomUUID(),building_id:fixture.state.buildings[1].id,published:true};
  fixture.state.listings.push(outsider);
  fixture.env.DEV_ADMIN_EMAIL='agent-a@example.test';fixture.env.DEV_ADMIN_ROLE='agent';
  equal((await call('/listings')).listings.map(row=>row.id),[assigned.id]);
  await call(`/listings/${assigned.id}/publish`,'POST',{revision:assigned.draft_revision});
  async function refused(path,body,status) {
    const req=new Request(`http://localhost/api/admin${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    equal((await handleAdminRequest(req,fixture.env,{waitUntil:p=>p.catch(()=>{})},new URL(req.url).pathname)).status,status);
  }
  await refused(`/listings/${outsider.id}/publish`,{revision:outsider.draft_revision},403);
  fixture.env.DEV_ADMIN_EMAIL='landlord-a@example.test';fixture.env.DEV_ADMIN_ROLE='landlord';
  await refused(`/listings/${assigned.id}/publish`,{revision:assigned.draft_revision},403);
  fixture.env.DEV_ADMIN_EMAIL='agent-a@example.test';fixture.env.DEV_ADMIN_ROLE='agent';
  assigned.published=false;
  equal((await call('/listings')).listings.map(row=>row.id),[assigned.id]);
  fixture.state.staff.find(row=>row.email==='agent-a@example.test').property_ids=[];
  equal((await call('/listings')).listings,[]);
  fixture.env.DEV_ADMIN_EMAIL='admin@example.test';fixture.env.DEV_ADMIN_ROLE='manager';
  equal((await call('/listings')).listings.length,fixture.state.listings.length);
  console.log(`PASS ${count} listing checks: draft creation, saved list visibility, inherited address, removed fields, numeric prices, newest-first order, explicit publication and standalone address`);
} finally { globalThis.fetch = originalFetch; }
