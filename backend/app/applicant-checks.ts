import { makeApplicantChecks } from '../core/applicant-checks.ts';
import { makeRentalStore } from '../adapters/rentals-supabase/index.ts';
import { testingProvider } from './testing-provider.ts';
export function applicantChecksFor(config:{url:string;key:string},env:Record<string,any>,missing:(row:any)=>string[]) {
  return makeApplicantChecks(makeRentalStore(config),testingProvider(env),missing);
}
