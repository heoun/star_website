// Local demo assets only; these records never enter a production seed or build.
import {readFile} from 'node:fs/promises';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function seedListingMedia(state) {
  const seeded = state.demo_listing_media ||= {};
  for (const listing of state.listings) {
    if (seeded[listing.id]) continue;
    listing.listing_media ||= [];
    const prefix = `${listing.id}/mock/`;
    if (!listing.listing_media.some(m => m.kind === 'photo')) {
      for (const [i, caption] of ['Living area (mock)', 'Dining area (mock)'].entries()) {
        listing.listing_media.push({id:crypto.randomUUID(),listing_id:listing.id,kind:'photo',path:`${prefix}photo-${i+1}.jpg`,caption,position:i});
      }
    }
    if (!listing.listing_media.some(m => m.kind === 'floor_plan')) listing.listing_media.push({
      id:crypto.randomUUID(),listing_id:listing.id,kind:'floor_plan',path:`${prefix}floor-plan.svg`,caption:'Floor plan (mock · not to scale)',position:0
    });
    if (!listing.video_url) listing.video_url = `/media/${prefix}preview.mp4`;
    seeded[listing.id] = true;
  }
}

export function mockFloorPlan(listing) {
  const beds = Math.max(0, Math.min(6, Number(listing.bedrooms) || 0));
  const baths = Number(listing.bathrooms) || 1;
  const room = (x,y,w,h,name) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#f1f6f7" stroke="#264d61" stroke-width="5"/><text x="${x+w/2}" y="${y+h/2}" text-anchor="middle">${name}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="760" viewBox="0 0 1000 760" role="img" aria-label="Mock floor plan">
    <rect width="1000" height="760" fill="#fff"/>
    <g font-family="Arial,sans-serif" fill="#264d61">
      <text x="60" y="60" font-size="28" font-weight="bold">${esc(listing.property_name || listing.title)} · Unit ${esc(listing.unit)} (mock)</text>
      <text x="60" y="100" font-size="18">${beds || 'Studio'}${beds ? ' bedrooms' : ''} · ${baths} bath${baths === 1 ? '' : 's'} · ${esc(listing.size)}</text>
      <g font-size="20">${room(60,145,555,285,beds ? 'Living / dining' : 'Living / sleeping')}
      ${room(615,145,325,150,'Kitchen')}${room(615,295,325,135,`${baths} bath${baths === 1 ? '' : 's'}`)}
      ${beds ? Array.from({length:beds},(_,i)=>room(60+i*880/beds,430,880/beds,200,`Bedroom ${i+1}`)).join('') : room(60,430,880,200,'Entry / storage')}
      <rect x="80" y="422" width="70" height="16" fill="#fff"/><text x="95" y="470" font-size="14">Entry</text>
      </g><text x="60" y="700" font-size="20" font-weight="bold">MOCK · Layout illustration only · Not to scale</text>
      <text x="60" y="730" font-size="16">Sample photographs and video do not depict this unit.</text>
    </g></svg>`;
}

export async function demoListingAsset(pathname, state) {
  const match = /^\/media\/([^/]+)\/mock\/(photo-[12]\.jpg|floor-plan\.svg|preview\.mp4)$/.exec(pathname);
  if (!match) return null;
  const listing = state.listings.find(l => l.id === match[1]);
  if (!listing) return new Response('Not found',{status:404});
  const name = match[2];
  const linked = name === 'preview.mp4' ? listing.video_url === pathname : listing.listing_media?.some(m => `/media/${m.path}` === pathname);
  if (!linked) return new Response('Not found',{status:404});
  const files = {'photo-1.jpg':'../site/jpg/rental-bkg.jpeg','photo-2.jpg':'../site/jpg/unit-bkg.jpeg','preview.mp4':'./demo-assets/listing-preview-mock.mp4'};
  const body = name === 'floor-plan.svg' ? mockFloorPlan(listing) : await readFile(new URL(files[name],import.meta.url));
  return new Response(body,{headers:{'Content-Type':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.mp4')?'video/mp4':'image/jpeg','Cache-Control':'no-store'}});
}
