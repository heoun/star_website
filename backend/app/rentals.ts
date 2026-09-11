import { makeRentals } from '../core/rentals.ts';
import { makeRentalStore } from '../adapters/rentals-supabase/index.ts';
import { makeRentalMail } from '../adapters/rental-mail/index.ts';
import { makeRentalScreening } from '../adapters/rental-screening/index.ts';
import type { RentalDependencies } from '../contracts/rentals.ts';
export { rentalMembers } from '../core/rentals.ts';
export function rentalsFor(config:{url:string;key:string}, env:Record<string,any>, request:Request,
  policy:Pick<RentalDependencies,'missingDocuments'|'lease'|'landlord'>) {
  const store=makeRentalStore(config);
  return {...makeRentals({...policy,store,mail:makeRentalMail(env,request),screening:makeRentalScreening(env.RENTAL_SCREENING==='mock' && ['localhost','127.0.0.1','[::1]'].includes(new URL(request.url).hostname))}),store};
}
