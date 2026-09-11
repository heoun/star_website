import type { RentalScreening } from '../../contracts/rentals.ts';
// Production never receives a made-up score. Until a vendor is selected, staff
// can record its completed report through the audited per-person checks form.
export function makeRentalScreening(mock: boolean): RentalScreening {
  return {async check(row) {
    if (!mock) return {status:'not_connected'};
    return {status:'complete',credit_score:700 + parseInt(row.id.replace(/-/g,'').slice(-2),16)%61,
      reference:`mock/${row.id}`,model:'Mock score',date:new Date().toISOString(),mock:true};
  }};
}
