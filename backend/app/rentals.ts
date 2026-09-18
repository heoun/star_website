import { makeRentals } from '../core/rentals.ts';
import { makeRentalStore } from '../adapters/rentals-supabase/index.ts';
import { makeRentalMail } from '../adapters/rental-mail/index.ts';
import { makeRentalScreening } from '../adapters/rental-screening/index.ts';
import type { RentalDependencies } from '../contracts/rentals.ts';
import { internalTesting } from './internal-testing.ts';
import { makeScreeningSimulator } from '../adapters/screening-simulator/index.ts';
export { screeningIssue } from '../core/screening.ts';
export { rentalMembers } from '../core/rentals.ts';
export function rentalsFor(config:{url:string;key:string}, env:Record<string,any>, request:Request,
  policy:Pick<RentalDependencies,'missingDocuments'|'lease'|'landlord'>) {
  const store=makeRentalStore(config);
  const legacyMock=env.RENTAL_SCREENING==='mock' && ['localhost','127.0.0.1','[::1]'].includes(new URL(request.url).hostname);
  const testing=internalTesting(env,request),allowMockScreening=legacyMock || testing;
  const simulator=testing ? makeScreeningSimulator(env.SCREENING_SIMULATOR_URL,env.SCREENING_SIMULATOR_TOKEN) : undefined;
  return {...makeRentals({...policy,store,allowMockScreening,mail:makeRentalMail(env,request),screening:makeRentalScreening(legacyMock,simulator)}),store};
}
