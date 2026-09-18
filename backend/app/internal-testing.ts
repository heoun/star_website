// These are deployment-owned allowlists, never browser claims or user metadata.
export function internalTesting(env:Record<string,any>, request:Request) {
  const loopback=['127.0.0.1','localhost','[::1]'].includes(new URL(request.url).hostname);
  const database=(()=>{try{return new URL(env.SUPABASE_URL).hostname;}catch{return '';}})();
  return loopback && env.INTERNAL_TESTING==='on' && !!env.INTERNAL_TEST_DATABASE_HOST
    && database===env.INTERNAL_TEST_DATABASE_HOST && env.DOCUSIGN_ENVIRONMENT==='demo';
}
export function internalTestAccount(env:Record<string,any>,request:Request,session:{email:string;subject:string}|null) {
  return internalTesting(env,request) && !!session?.subject && session.subject===env.INTERNAL_TEST_USER_ID
    && session.email.toLowerCase()===String(env.INTERNAL_TEST_EMAIL || '').toLowerCase();
}
export function internalTestListing(env:Record<string,any>,listingId:string) {
  return String(env.INTERNAL_TEST_LISTING_IDS || '').split(',').map(s=>s.trim()).includes(listingId);
}
