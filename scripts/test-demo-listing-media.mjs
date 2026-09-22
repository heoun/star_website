import assert from 'node:assert/strict';
import {seedListingMedia, demoListingAsset, mockFloorPlan} from './demo-listing-media.mjs';
const state={listings:[{id:'a',property_name:'Property A',unit:'2A',bedrooms:2,bathrooms:1,size:'900 sq ft',published:true},{id:'b',property_name:'Property B',unit:'1A',bedrooms:1,bathrooms:1,size:'650 sq ft',published:false}]};
seedListingMedia(state);
for(const listing of state.listings){
  assert.equal(listing.listing_media.filter(m=>m.kind==='photo').length,2);
  assert.equal(listing.listing_media.filter(m=>m.kind==='floor_plan').length,1);
  for(const media of listing.listing_media){
    assert.equal(media.listing_id,listing.id);
    assert(media.caption.includes('mock'));
    const result=await demoListingAsset(`/media/${media.path}`,state);
    assert.equal(result.status,200);
    assert((await result.arrayBuffer()).byteLength>100);
  }
  const video=await demoListingAsset(listing.video_url,state);
  assert.equal(video.headers.get('Content-Type'),'video/mp4');
  assert.equal(Buffer.from(await video.arrayBuffer()).subarray(4,8).toString(),'ftyp');
  const floor=mockFloorPlan(listing);
  assert(floor.includes(listing.property_name));
  assert.equal((floor.match(/Bedroom \d/g)||[]).length,listing.bedrooms);
}
assert.equal(state.listings[1].published,false,'Media must not publish a draft');
const before=JSON.stringify(state);seedListingMedia(state);assert.equal(JSON.stringify(state),before,'No duplicate media on restart');
const removed=state.listings[0].listing_media.pop();seedListingMedia(state);
assert(!state.listings[0].listing_media.includes(removed),'Do not restore media a user removed');
assert.equal((await demoListingAsset(`/media/${removed.path}`,state)).status,404);
assert.equal((await demoListingAsset('/media/unknown/mock/photo-1.jpg',state)).status,404);
assert.equal(await demoListingAsset('/media/../../secrets',state),null);
console.log('PASS demo listing media: photos, per-unit floor plans, playable video bytes, draft state, scoped URLs and non-destructive reseeding');
