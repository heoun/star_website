import type { RentalSigningStore, RentalSigningRecord, RentalSigningPackage } from '../../contracts/rental-signing.ts';
export function makeSigningStore(config:{url:string;key:string}) {
  async function request(path:string,body?:unknown,method=body?'POST':'GET') {
    const r=await fetch(`${config.url.replace(/\/$/,'')}/rest/v1/${path}`,{method,headers:{apikey:config.key,Authorization:`Bearer ${config.key}`,'Content-Type':'application/json',Prefer:'return=representation'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
    if(!r.ok)throw Object.assign(new Error(r.status===409?'The rental or signing request changed. Refresh and review it again.':r.status===403?'You no longer have permission to send this lease.':'Signing storage is unavailable. Apply rental-signing.sql and check configuration.'),{status:r.status===409?409:r.status===403?403:503});
    return r.status===204?null:r.json();
  }
  const rpc=(name:string,body:unknown)=>request(`rpc/${name}`,body);
  const store:RentalSigningStore={
    async get(id){const rows=await request(`rental_signing_packages?${new URLSearchParams({id:`eq.${id}`,select:'record'})}`);return rows[0]?.record || null;},
    async current(id){const rows=await request(`rental_signing_packages?${new URLSearchParams({rental_id:`eq.${id}`,reserved:'eq.true',order:'created_at.desc',limit:'1',select:'record'})}`);return rows[0]?.record || null;},
    async reserve(input){return rpc('reserve_rental_signing',{p_id:input.package.id,p_actor:input.principal.email,p_versions:input.expectedMemberVersions});},
    async save(record,version,token){await rpc('save_rental_signing',{p_id:record.package.id,p_record:record,p_version:version,p_token:token});},
    async enqueueNotice(notice,hash){await rpc('enqueue_rental_signing',{p_notice:notice,p_hash:hash});},
    async claimDue(limit){return rpc('claim_rental_signing',{p_limit:limit});},
    async release(id,token,retry){await rpc('release_rental_signing',{p_id:id,p_token:token,p_retry:retry});}
  };
  return {...store,
    async preview(pkg:RentalSigningPackage,versions:Record<string,number>) {
      const record:RentalSigningRecord={package:pkg,version:0,phase:'preparing',envelope:null,updatedAt:new Date().toISOString()};
      await request('rental_signing_packages',{id:pkg.id,rental_id:pkg.rentalId,record,member_versions:versions});return record;
    },
    async previewVersions(id:string):Promise<Record<string,number>> {
      const rows=await request(`rental_signing_packages?${new URLSearchParams({id:`eq.${id}`,select:'member_versions'})}`);return rows[0]?.member_versions || {};
    },
    async requestVoid(id:string,actor:string,reason:string){await rpc('void_rental_signing',{p_id:id,p_actor:actor,p_reason:reason});},
    async expiredPreviews():Promise<RentalSigningRecord[]> {
      const rows=await request(`rental_signing_packages?${new URLSearchParams({reserved:'eq.false',created_at:`lt.${new Date(Date.now()-86400000).toISOString()}`,select:'record',limit:'5'})}`);
      return rows.map((r:{record:RentalSigningRecord})=>r.record);
    },
    async discardPreview(id:string){await request(`rental_signing_packages?${new URLSearchParams({id:`eq.${id}`,reserved:'eq.false'})}`,undefined,'DELETE');}
  };
}
