import type { RentalScreening } from '../../contracts/rentals.ts';
import type { ApplicantChecksProvider } from '../../contracts/applicant-checks.ts';
// Production never receives a made-up score. Automatic screening remains
// unavailable until a vendor is connected; the applicant view is read-only.
export function makeRentalScreening(mock: boolean,simulator?:ApplicantChecksProvider): RentalScreening {
  return {async check(row) {
    if (!['paid','waived'].includes(row.workspace?.checks?.fee || '')) return {status:'pending'};
    if(row.workspace?.test_run) {
      if(!simulator)return {status:'not_connected'};
      if(!row.workspace.test_screening)return {status:'pending'};
      const result=await simulator.result(row.id);
      if(!result || result.status==='pending')return {status:'pending'};
      if(result.id!==row.workspace.test_screening.order_id)throw new Error('Screening order mismatch.');
      if(result.status==='failed')return {status:'failed',mock:true};
      return {status:'complete',application_id:row.id,provider:'Screening API Simulator',source:'mock',mock:true,outcome:result.outcome,credit_score:result.score ?? null,no_score_reason:result.reason,model:'Simulated score (not a bureau report)',reference:`mock/${result.id}`,date:result.completed_at};
    }
    if (!mock) return {status:'not_connected'};
    if(row.workspace?.demo_screening_status==='pending') return {status:'pending'};
    if(row.workspace?.demo_screening_status==='no_score') return {status:'complete',application_id:row.id,provider:'Mock screening provider',source:'mock',outcome:'no_score',credit_score:null,no_score_reason:'Synthetic insufficient credit history outcome',reference:`mock/${row.id}`,date:new Date().toISOString(),mock:true};
    return {status:'complete',application_id:row.id,provider:'Mock screening provider',source:'mock',outcome:'scored',credit_score:700 + parseInt(row.id.replace(/-/g,'').slice(-2),16)%61,
      reference:`mock/${row.id}`,model:'Mock score',date:new Date().toISOString(),mock:true};
  }};
}
