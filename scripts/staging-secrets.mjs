import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
const env=Object.fromEntries(readFileSync('.dev.vars','utf8').split('\n').filter(l=>/^\w+=/.test(l)).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}));
if(env.SUPABASE_URL!=='https://shlodyxlnepxnafthvod.supabase.co' || env.DOCUSIGN_ENVIRONMENT!=='demo')throw new Error('Use the Star Dev database and DocuSign Sandbox credentials only.');
const names=['SUPABASE_SERVICE_ROLE_KEY','SUPABASE_PUBLISHABLE_KEY','APP_ENCRYPTION_KEY','RESEND_API_KEY','AUTH_LINK_SECRET','DOCUSIGN_INTEGRATION_KEY','DOCUSIGN_USER_ID','DOCUSIGN_ACCOUNT_ID','DOCUSIGN_PRIVATE_KEY','DOCUSIGN_CONNECT_HMAC_SECRET','LANDLORD_DECISION_SECRET','INTERNAL_TEST_USER_ID','INTERNAL_TEST_EMAIL','INTERNAL_TEST_LANDLORD_EMAIL','INTERNAL_TEST_ROOMMATE_EMAILS','INTERNAL_TEST_LISTING_IDS'];
const secrets=Object.fromEntries(names.map(n=>{if(!env[n])throw new Error('Missing '+n);return[n,env[n]];}));
mkdirSync('.local/staging',{recursive:true,mode:0o700});
writeFileSync('.local/staging/secrets.json',JSON.stringify(secrets),{mode:0o600});
console.log('Prepared .local/staging/secrets.json. No credentials have been uploaded. Delete this file after the one-time upload.');
