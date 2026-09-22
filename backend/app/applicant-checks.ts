import { makeApplicantChecks } from '../core/applicant-checks.ts';
import { makeRentalStore } from '../adapters/rentals-supabase/index.ts';
import { makeScreeningSimulator } from '../adapters/screening-simulator/index.ts';
export function applicantChecksFor(config:{url:string;key:string},env:Record<string,any>,missing:(row:any)=>string[]) {
  return makeApplicantChecks(makeRentalStore(config),makeScreeningSimulator(env.SCREENING_SIMULATOR_URL,env.SCREENING_SIMULATOR_TOKEN),missing);
}
