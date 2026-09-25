import {makeScreeningSimulator} from '../adapters/screening-simulator/index.ts';
// Cloud service bindings never expose the simulator publicly. Local development
// retains its separately supervised HTTP provider.
export function testingProvider(env:Record<string,any>) {
  if(env.APP_ENV==='staging') {
    if(env.SITE_ORIGIN!=='https://dev.starreusa.com' || env.INTERNAL_TESTING!=='on'
      || env.DOCUSIGN_ENVIRONMENT!=='demo' || !env.SCREENING_SIMULATOR?.fetch
      || new URL(env.SUPABASE_URL).hostname!==env.INTERNAL_TEST_DATABASE_HOST)throw new Error('Staging simulator configuration is invalid.');
    return makeScreeningSimulator('https://screening.internal','service-binding',env.SCREENING_SIMULATOR.fetch.bind(env.SCREENING_SIMULATOR),true);
  }
  if(env.APP_ENV==='production')throw new Error('Simulation is unavailable in production.');
  return makeScreeningSimulator(env.SCREENING_SIMULATOR_URL,env.SCREENING_SIMULATOR_TOKEN);
}
