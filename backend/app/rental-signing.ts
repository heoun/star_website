import { makeDocusign } from '../adapters/esign-docusign/index.ts';
import { makeSigningStore } from '../adapters/rental-signing-supabase/index.ts';
import { makeRentalSigning } from '../core/rental-signing.ts';
import type { RentalSigningFiles } from '../contracts/rental-signing.ts';
export { boundedBytes } from '../adapters/esign-docusign/index.ts';
export function signingFor(config:{url:string;key:string},env:Record<string,string>,files:RentalSigningFiles) {
  const store=makeSigningStore(config);
  const provider=makeDocusign({environment:env.DOCUSIGN_ENVIRONMENT==='production'?'production':'demo',integrationKey:env.DOCUSIGN_INTEGRATION_KEY,
    userId:env.DOCUSIGN_USER_ID,accountId:env.DOCUSIGN_ACCOUNT_ID,privateKey:env.DOCUSIGN_PRIVATE_KEY,
    hmacSecret:env.DOCUSIGN_CONNECT_HMAC_SECRET,webhookUrl:env.DOCUSIGN_WEBHOOK_URL});
  return {store,provider,...makeRentalSigning(store,provider,files)};
}
