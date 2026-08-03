// Verifies the JSON Web Token that Cloudflare Access attaches to every request
// it lets through. Access already blocks unauthenticated traffic at the edge;
// verifying the signature here means a leaked or forged header cannot reach the
// admin API even if the Access application is ever misconfigured or removed.

const JWKS_TTL_MS = 60 * 60 * 1000;

let jwksCache = { teamDomain: "", fetchedAt: 0, keys: null };

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJson(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

async function getSigningKeys(teamDomain, now) {
  if (jwksCache.keys && jwksCache.teamDomain === teamDomain && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }

  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) {
    throw new Error(`Unable to load Access signing keys: ${response.status}`);
  }

  const { keys } = await response.json();
  jwksCache = { teamDomain, fetchedAt: now, keys };
  return keys;
}

function readToken(request) {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;

  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? match[1] : "";
}

// Returns the verified identity, or null when the request must be rejected.
export async function verifyAccessRequest(request, env) {
  const teamDomain = (env.CF_ACCESS_TEAM_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const audience = (env.CF_ACCESS_AUD || "").trim();

  // Fail closed: without configuration there is nothing to verify against.
  if (!teamDomain || !audience) return null;

  const token = readToken(request);
  if (!token) return null;

  const [headerSegment, payloadSegment, signatureSegment] = token.split(".");
  if (!headerSegment || !payloadSegment || !signatureSegment) return null;

  let header;
  let payload;
  try {
    header = decodeJson(headerSegment);
    payload = decodeJson(payloadSegment);
  } catch {
    return null;
  }

  if (header.alg !== "RS256") return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
  if (typeof payload.nbf === "number" && payload.nbf > nowSeconds + 60) return null;
  if (payload.iss !== `https://${teamDomain}`) return null;

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(audience)) return null;

  let keys;
  try {
    keys = await getSigningKeys(teamDomain, Date.now());
  } catch {
    return null;
  }

  const jwk = keys.find((candidate) => candidate.kid === header.kid);
  if (!jwk) return null;

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    base64UrlToBytes(signatureSegment),
    new TextEncoder().encode(`${headerSegment}.${payloadSegment}`)
  );

  if (!verified) return null;

  return { email: payload.email || "", subject: payload.sub || "" };
}
