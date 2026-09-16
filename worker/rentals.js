import { rentalsFor } from '../backend/app/rentals.ts';
import { requireConfig, fetchBuilding, fetchLeaseLayers, fetchStaff, fetchListing } from './supabase.js';
import { dealValues, resolveValues } from './lease.js';
import { parseDate } from '../site/shared/lease-dates.js';
import { documentSummary } from '../site/admin/application-view.js';
import { DOCUMENT_TYPES } from './portal.js';
export const rentalMode=env=>env.RENTAL_AUTOMATION==='on';
export function rentalWorkflow(env,request) {
  return rentalsFor(requireConfig(env),env,request,{
    missingDocuments(row) {const s=documentSummary(row,DOCUMENT_TYPES);return s ? s.rows.filter(i=>i.needed && ['missing','partial'].includes(i.state)).map(i=>i.type.label) : ['Checklist unavailable'];},
    async landlord(root) {
      const b=root.listings?.building_id ? await fetchBuilding(env,root.listings.building_id) : null;
      const people=(await fetchStaff(env)).filter(s=>s.active && s.role==='landlord' && s.property_ids?.includes(root.listings?.building_id));
      const signer=String(b?.landlord_signer_email || '').toLowerCase();
      return people.find(s=>s.email===signer)?.email || (people.length===1 ? people[0].email : null);
    },
    async lease(group,terms) {
      const application=householdApplication(group),listing=group.root.listings;
      if(!listing) throw new Error('Listing unavailable');
      const building=listing.building_id ? await fetchBuilding(env,listing.building_id) : null;
      return resolveValues({layers:await fetchLeaseLayers(env,listing.id),deal:dealValues({application,listing,building,today:parseDate(new Date().toISOString().slice(0,10))}),overrides:{...group.root.workspace?.lease_overrides,...terms}});
    }
  });
}
export function householdApplication(group) {
  return {...group.root,name:group.members.map(m=>m.name).join(' and '),email:group.members.map(m=>m.email).join('; '),
    current_address:group.members.map(m=>`${m.name}: ${m.current_address || ''}`).join('\n'),
    children_under_11:group.members.some(m=>m.children_under_11===true),wants_window_guards:group.members.some(m=>m.wants_window_guards===true)};
}
export async function runRentalAutomation(env,request,id) {
  if(!rentalMode(env)) return;
  try {await rentalWorkflow(env,request).reconcile(id);} catch(error) {console.error('Rental automation requires retry',id,error.status || 500);}
}
export async function reconcileRentals(env,request) {
  if(!rentalMode(env)) return;
  const flow=rentalWorkflow(env,request);
  for(const id of await flow.store.pending()) {
    try{const group=await flow.store.group(id);if(group?.root.workspace?.invitations?.some(i=>!i.accepted && (!i.delivery || i.delivery==='pending')))await flow.notifyInvitations(id);}catch{console.error('Invitation delivery requires retry',id);}
    await runRentalAutomation(env,request,id);
  }
}
export async function rentalApplyOptions(env,listingId) {
  const listing=await fetchListing(env,listingId,{publishedOnly:true});
  if(!listing) return [];
  return (await fetchStaff(env)).filter(s=>s.active && s.role==='agent' && s.property_ids?.includes(listing.building_id)).map(s=>({email:s.email,name:s.name || s.email}));
}
export async function submitRental(env,values,invitation) {
  const {url,key}=requireConfig(env);
  const parts=String(invitation || '').split('.');
  if(invitation && (parts.length!==2 || parts.some(p=>! /^[0-9a-f-]{36}$/i.test(p)))) throw new Error('Invalid invitation');
  const response=await fetch(`${url}/rest/v1/rpc/submit_rental_application`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({p_application:values,p_root:parts[0] || null,p_invite:parts[1] || null})});
  if(!response.ok) throw Object.assign(new Error(response.status===409 ? 'An application already exists, or the invitation changed. Contact your agent to join the existing application.' : 'Application could not be saved.'),{status:response.status===409 ? 409 : 503});
  return response.json();
}
