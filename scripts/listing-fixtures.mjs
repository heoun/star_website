import { createWorkspaceFixtures } from '../backend/tools/workspace-fixtures.mjs';
export function createListingFixtures() {
  const fixture = createWorkspaceFixtures();
  const snapshot = row => { const {published_snapshot, ...draft} = row; return structuredClone(draft); };
  for (const row of fixture.state.listings) {
    row.draft_revision = 1; row.published_revision = 1;
    row.published_snapshot = snapshot(row);
  }
  const original = fixture.fetch;
  fixture.fetch = async (input, init = {}) => {
    const u = new URL(input), table = u.pathname.split('/').at(-1), method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : {};
    const row = fixture.state.listings.find(l => l.id === (body.p_id || u.searchParams.get('id')?.slice(3)));
    if (table === 'publish_listing') {
      if (!row || row.draft_revision !== body.p_revision) return Response.json(null);
      row.published_snapshot = {...snapshot(row),published:true}; row.published = true; row.published_revision = row.draft_revision;
      return Response.json(row.published_snapshot);
    }
    if (table === 'listings' && method === 'PATCH' && row) {
      if (Object.keys(body).some(key => key !== 'published' && row[key] !== body[key])) row.draft_revision++;
    }
    if (table === 'listing_media') {
      const owner = fixture.state.listings.find(l => l.id === body.listing_id || l.listing_media.some(m => m.id === u.searchParams.get('id')?.slice(3)));
      if (!owner) return Response.json([]);
      if (method === 'POST') {
        const media = {id:crypto.randomUUID(),...body}; owner.listing_media.push(media); owner.draft_revision++;
        return Response.json([media]);
      }
      const media = owner.listing_media.find(m => m.id === u.searchParams.get('id')?.slice(3));
      if (method === 'PATCH') { Object.assign(media, body); owner.draft_revision++; }
      if (method === 'DELETE') { owner.listing_media = owner.listing_media.filter(m => m !== media); owner.draft_revision++; }
      return Response.json(media ? [media] : []);
    }
    const response = await original(input, init);
    if (table === 'listings' && method === 'POST') {
      const [created] = await response.json();
      const saved = fixture.state.listings.find(l => l.id === created.id);
      Object.assign(saved, {draft_revision:1,published_revision:null,published_snapshot:null});
      return Response.json([saved]);
    }
    return response;
  };
  return fixture;
}
