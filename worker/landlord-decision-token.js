// A scoped email capability, never a workspace session. Keep it in the URL
// fragment and Authorization header, not query strings, logs or cookies.
const purpose = 'star/landlord-decision/v1';
const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const error = (message, status = 401) => Object.assign(new Error(message), {status});
async function signingKey(env, usage) {
  let bytes;
  try { bytes = decode(String(env.LANDLORD_DECISION_SECRET || '').trim()); } catch {}
  if (bytes?.length !== 32) throw error('Email decision links are unavailable. Contact the leasing team.', 503);
  return crypto.subtle.importKey('raw', bytes, {name:'HMAC', hash:'SHA-256'}, false, [usage]);
}
function audience(env, origin) { return `${new URL(origin).origin}|${new URL(env.SUPABASE_URL).hostname}`; }
export async function createLandlordDecisionToken(env, origin, id, recommendation) {
  if (!env.LANDLORD_DECISION_SECRET) return null; // Existing account-based deployments keep working.
  const issued = Math.floor(Date.parse(recommendation.sent_at) / 1000);
  if (!Number.isSafeInteger(issued)) throw error('Refresh this application recommendation before emailing it.', 409);
  // Recommendation time is stable across transport retries; do not mint a new
  // payload on each attempt with the same provider idempotency key.
  const claims = {purpose, id, revision:recommendation.revision, email:recommendation.landlord_email.toLowerCase(),
    audience:audience(env,origin), expires:issued + 14 * 86400};
  if (claims.expires <= Date.now()/1000) throw error('This decision request expired. Prepare a new recommendation.', 409);
  const payload = encode(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env,'sign'), new TextEncoder().encode(`${purpose}.${payload}`));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}
export async function verifyLandlordDecisionToken(env, origin, token) {
  const key = await signingKey(env,'verify');
  try {
    if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const [payload,signature] = token.split('.');
    if (!await crypto.subtle.verify('HMAC',key,decode(signature),new TextEncoder().encode(`${purpose}.${payload}`))) throw new Error();
    const claims = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (claims.purpose !== purpose || claims.audience !== audience(env,origin) || !/^[0-9a-f-]{36}$/i.test(claims.id) ||
      !Number.isSafeInteger(claims.revision) || claims.revision < 1 || typeof claims.email !== 'string' || !claims.email.includes('@') ||
      !Number.isSafeInteger(claims.expires)) throw new Error();
    if (claims.expires <= Date.now()/1000) throw error('This email link has expired. Ask the leasing team for a new decision request.',410);
    return claims;
  } catch (e) {
    if (e.status === 410) throw e;
    throw error('This email link is invalid. Open the latest email from the leasing team.');
  }
}
