import type { RentalStore, RentalGroup } from '../../contracts/rentals.ts';
import type { WorkspaceApplication } from '../../contracts/workspace.ts';
export function makeRentalStore(config: {url: string; key: string}): RentalStore {
  async function request(path: string, body?: unknown) {
    const r = await fetch(`${config.url.replace(/\/$/, '')}/rest/v1/${path}`, {method: body ? 'POST' : 'GET', headers: {apikey: config.key, Authorization: `Bearer ${config.key}`, 'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
    if (!r.ok) throw Object.assign(new Error(r.status === 409 ? 'This rental changed. Refresh before saving.' : 'Rental workflow is unavailable. Apply supabase/rental-flow.sql and retry.'), {status:r.status === 409 ? 409 : 503});
    // commit_rental_group returns void; PostgREST answers with no JSON body.
    if (r.status === 204) return null;
    return r.json();
  }
  const select = '*,listings(*),application_documents(id,doc_type,file_name,content_type,size_bytes,created_at)';
  return {
    async list(p) {
      const q=new URLSearchParams({select,order:'created_at.asc,id.asc'});
      const quoted=`"${p.email.toLowerCase().replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;
      if(p.role==='agent') q.set('or',`(responsible_email.eq.${quoted},collaborator_emails.cs.{${quoted}})`);
      if(p.role==='landlord') q.set('workspace->recommendation->>landlord_email',`eq.${p.email.toLowerCase()}`);
      const rows:WorkspaceApplication[]=[];
      for(let offset=0;;offset+=200) {q.set('offset',String(offset));q.set('limit','200');const page=await request(`applications?${q}`);rows.push(...page);if(page.length<200)break;}
      return rows.filter(r=>(r.rental_group_id || r.id)===r.id).map(root=>({root,members:rows.filter(m=>(m.rental_group_id || m.id)===root.id)}));
    },
    async listing(listingId) {
      const q=new URLSearchParams({select,listing_id:`eq.${listingId}`,'workspace->>rental_flow':'eq.automatic',order:'created_at.asc,id.asc'});
      const rows:WorkspaceApplication[]=[];
      for(let offset=0;;offset+=200) {q.set('offset',String(offset));q.set('limit','200');const page=await request(`applications?${q}`);rows.push(...page);if(page.length<200)break;}
      return rows.filter(r=>(r.rental_group_id || r.id)===r.id).map(root=>({root,members:rows.filter(m=>(m.rental_group_id || m.id)===root.id)}));
    },
    async group(id) {
      const [row] = await request(`applications?${new URLSearchParams({id:`eq.${id}`,select})}`);
      if (!row) return null;
      const rootId = row.rental_group_id || row.id;
      const members = await request(`applications?${new URLSearchParams({rental_group_id:`eq.${rootId}`,select,order:'created_at.asc,id.asc'})}`) as WorkspaceApplication[];
      if (!members.length) members.push(row);
      const root = members.find(m => m.id === rootId);
      return root ? {root,members} : null;
    },
    async save(group,patches,actor,join) {
      await request('rpc/commit_rental_group', {p_root:group.root.id,p_versions:Object.fromEntries([...group.members,...(join ? [join] : [])].map(m=>[m.id,m.workspace_version || 0])),p_patches:patches,p_actor:actor,p_join:join?.id || null});
    },
    async separate(group,memberId,remainingRoot,remove,patches,actor) {
      await request('rpc/separate_rental_member',{p_root:group.root.id,p_versions:Object.fromEntries(group.members.map(m=>[m.id,m.workspace_version || 0])),p_member:memberId,p_remaining_root:remainingRoot,p_delete:remove,p_patches:patches,p_actor:actor});
    },
    async staff() { return request('staff?select=email,name,role,active,property_ids'); },
    async pending() {
      const ids:string[]=[];
      for(let offset=0;;offset+=200) {
        const rows=await request(`applications?select=id,rental_group_id&workspace->>rental_flow=eq.automatic&status=in.(new,contacted,fee_pending,screening,review,needs_info,approved,sent_to_landlord)&limit=200&offset=${offset}&order=created_at.asc,id.asc`);
        ids.push(...rows.filter((r:WorkspaceApplication)=>(r.rental_group_id || r.id)===r.id).map((r:WorkspaceApplication)=>r.id));
        if(rows.length<200)break;
      }
      return ids;
    },
    async notices() {
      const ids=new Set<string>();
      for(let offset=0;;offset+=200) {
        const rows=await request(`applications?select=id,rental_group_id&workspace->>rental_flow=eq.automatic&workspace->ready_notice->>status=in.(queued,failed)&limit=200&offset=${offset}&order=created_at.asc,id.asc`) as WorkspaceApplication[];
        for(const r of rows) ids.add(r.rental_group_id || r.id);
        if(rows.length<200)break;
      }
      return [...ids];
    }
  };
}
