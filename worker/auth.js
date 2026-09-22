// Shared Supabase provider, separate applicant and workspace browser sessions.
import { isLocalRequest } from "./env.js";
import { resolveStaff } from "./staff.js";
import { accountSecurityEnabled, businessIdentity, verifiedSessionClaims } from "./account-security.js";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SESSION_COOKIES = { applicant: "star_portal", workspace: "star_workspace" };
function authScope(request) {
  const path = new URL(request.url).pathname;
  return path.startsWith('/api/auth/workspace/') || ['/api/auth/workspace-code','/api/auth/workspace-activate'].includes(path) ? 'workspace' : 'applicant';
}
// A selector identifies an HttpOnly cookie, never a user or a bearer token.
// Missing selectors support old clients; a supplied invalid/missing slot must
// never fall back to another applicant's legacy session.
const APPLICANT_CONTEXT=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function sessionCookieName(request,scope=authScope(request)) {
  if(scope==='workspace')return SESSION_COOKIES.workspace;
  const header=request.headers.get('X-Applicant-Session');
  const query=new URL(request.url).searchParams.get('applicant_session');
  if(header!==null && query!==null && header!==query)return null;
  const context=header ?? query;
  return context===null ? SESSION_COOKIES.applicant : APPLICANT_CONTEXT.test(context) ? `star_portal_${context.toLowerCase()}` : null;
}
const SESSION_SECONDS = 7 * 24 * 60 * 60;

// Mirrors the minimum set in the Supabase dashboard, so the form's error and
// the platform's agree.
const PASSWORD_MIN = 8;

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
  });
}

// ------------------------------------------------------- the Supabase side

// The low-privilege key Supabase Auth expects public clients to present;
// here it never leaves the Worker. Without it there is no portal, the same
// fail-closed rule as everywhere else.
//
// Accept publishable and legacy anon keys. These only travel in apikey;
// Authorization carries the user's verified access token.
export function authConfig(env) {
  const url = (env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "";
  return url && key ? { url, key } : null;
}

export async function authRequest(env, path, { method = "POST", token, body } = {}) {
  const config = authConfig(env);
  if (!config) throw Object.assign(new Error("Sign-in is not configured."), { status: 503 });
  const response = await fetch(`${config.url}/auth/v1/${path}`, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      apikey: config.key,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, payload };
}

// Supabase Auth's error strings are written for developers; the applicant
// gets words, and anything unrecognized falls back to the caller's message
// rather than leaking internals.
export function authErrorMessage(payload, fallback) {
  const raw = String(payload?.msg || payload?.message || payload?.error_description || "");
  if (/invalid login credentials/i.test(raw)) return "Email or password is incorrect.";
  if (/email not confirmed/i.test(raw)) {
    return "This email has not been confirmed yet. Create the account again to get a new code.";
  }
  if (/already registered|already been registered|user_already_exists/i.test(raw)) {
    return "This email already has an account. Sign in instead, or reset your password.";
  }
  if (/password should be/i.test(raw)) return `Please choose a password of at least ${PASSWORD_MIN} characters.`;
  if (/rate limit|too many|429/i.test(raw)) return "Too many attempts. Please wait a minute and try again.";
  if (/expired|invalid/i.test(raw)) return "That code has expired or is not right. Request a new one.";
  return fallback;
}

// ------------------------------------------------------------------ sessions

// Both Supabase tokens ride in one HttpOnly cookie: the short-lived access
// token, and the refresh token that mints its successor.
function encodeSessionCookie(session) {
  const packed = JSON.stringify({ at: session.access_token, rt: session.refresh_token });
  return btoa(String.fromCharCode(...new TextEncoder().encode(packed)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeSessionCookie(value) {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed.at === "string" && parsed.at !== "" ? parsed : null;
  } catch {
    return null;
  }
}

export function cookieValue(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

// `Secure` would make the browser drop the cookie on a plain-HTTP loopback,
// which is exactly where development runs.
function sessionCookie(request, value, maxAge, scope = authScope(request)) {
  const attributes = [`${sessionCookieName(request,scope)}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (!isLocalRequest(request)) attributes.push("Secure");
  return attributes.join("; ");
}

export function workspaceRoleCookie(request,role) {
  return `star_workspace_role=${role}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${isLocalRequest(request)?"":"; Secure"}`;
}

export async function signedIn(request, session, env) {
  if (!sessionCookieName(request)) return json({error:"Invalid applicant session."},400);
  if (!verifiedUser(session.user)) return json({ error: "Confirm your email before signing in." }, 403);
  let access;
  if (authScope(request) === 'workspace') {
    const resolved = await resolveStaff(env, {email: session.user.email, subject: session.user.id}, {allowPending:true});
    access=resolved.identity;
    if (!resolved.identity) return json({error: resolved.error}, resolved.status || 403);
  }
  return json({ ok: true, email: String(session.user?.email || "").toLowerCase(), ...(access && accountSecurityEnabled(env) ? {setup_password:access.has_password===false,mfa_required:access.role==="manager"} : {}) }, 200, {
    "Set-Cookie": sessionCookie(request, encodeSessionCookie(session), SESSION_SECONDS)
  });
}

// The session /api/apply and every portal route trust. The access token is
// validated against Supabase on each request; when it has expired, the
// refresh token buys its successor, and `setCookie` carries the rolled
// cookie the response must set — Supabase rotates refresh tokens, so
// dropping it would sign the applicant out a request later.
export async function readSession(request, env, scope = authScope(request)) {
  if (!authConfig(env)) return null;

  const name=sessionCookieName(request,scope);
  if(!name)return null;
  const stored = decodeSessionCookie(cookieValue(request, name));
  if (!stored) return null;

  const user = await authRequest(env, "user", { method: "GET", token: stored.at });
  if (user.ok && verifiedUser(user.payload)) {
    return verifiedIdentity(request,env,user.payload,stored.at);
  }

  if (user.ok || ![401, 403].includes(user.status) || !stored.rt) return null;
  const refreshed = await authRequest(env, "token?grant_type=refresh_token", {
    body: { refresh_token: stored.rt }
  });
  const session = refreshed.payload;
  if (!refreshed.ok || !session?.access_token || !verifiedUser(session.user)) return null;

  return {
    ...await verifiedIdentity(request,env,session.user,session.access_token),
    setCookie: sessionCookie(request, encodeSessionCookie(session), SESSION_SECONDS, scope)
  };
}

async function verifiedIdentity(request,env,user,token) {
  const identity={email:String(user.email).trim().toLowerCase(),subject:user.id,token,setCookie:undefined,user_id:undefined,aal:undefined,mfaAt:0,workspaceRole:"owner",factors:[]};
  if(!accountSecurityEnabled(env))return identity;
  const claims=verifiedSessionClaims(token);
  identity.user_id=await businessIdentity(env,identity);
  identity.aal=claims.aal;
  identity.mfaAt=Math.max(0,...(Array.isArray(claims.amr)?claims.amr:[]).filter(a=>a.method==='totp'||a.method==='mfa/totp').map(a=>Number(a.timestamp)||0));
  identity.workspaceRole=cookieValue(request,'star_workspace_role')==='admin'?'admin':'owner';
  identity.factors=(user.factors||[]).filter(f=>f.factor_type==='totp').map(({id,status,friendly_name})=>({id,status,friendly_name}));
  return identity;
}

// -------------------------------------------------------------------- account

export function cleanEmail(value) {
  return String(value ?? "").trim().toLowerCase().slice(0, 180);
}

export function validPassword(password) {
  return typeof password === "string" && password.length >= PASSWORD_MIN && password.length <= 200;
}

// Step one of registration. Supabase stores the pending account and emails
// the confirmation code; nothing works until the code comes back.
async function handleRegister(request, env) {
  const body = await request.json().catch(() => ({}));

  // Honeypot, same as the application form: bots that fill the hidden field
  // get a fake success.
  if (String(body.website ?? "").trim() !== "") {
    return json({ ok: true, confirm: true });
  }

  const email = cleanEmail(body.email);
  if (!EMAIL_PATTERN.test(email)) {
    return json({ error: "Please enter a valid email address." }, 422);
  }
  if (!validPassword(body.password)) {
    return json({ error: `Please choose a password of at least ${PASSWORD_MIN} characters.` }, 422);
  }

  const result = await authRequest(env, "signup", { body: { email, password: body.password } });
  if (!result.ok) {
    return json({
      error: authErrorMessage(result.payload, "The account could not be created. Please try again.")
    }, result.status === 429 ? 429 : 400);
  }

  // An address that already has a confirmed account comes back looking like a
  // success, just with no identities on the user. Saying so beats a code
  // that never arrives.
  const identities = result.payload?.identities ?? result.payload?.user?.identities;
  if (Array.isArray(identities) && identities.length === 0) {
    return json({ error: "This email already has an account. Sign in instead, or reset your password." }, 409);
  }

  // A project with email confirmation turned off (a development convenience)
  // answers with the session itself, and there is no code step.
  if (result.payload?.access_token) {
    return signedIn(request, result.payload, env);
  }

  return json({ ok: true, confirm: true });
}

// "Send a new code", without asking for the password again.
async function handleResend(request, env) {
  const email = cleanEmail((await request.json().catch(() => ({}))).email);
  if (!EMAIL_PATTERN.test(email)) {
    return json({ error: "Please enter a valid email address." }, 422);
  }

  const result = await authRequest(env, "resend", { body: { type: "signup", email } });
  if (!result.ok && result.status === 429) {
    return json({ error: authErrorMessage(result.payload, "Too many codes requested. Please wait a minute.") }, 429);
  }
  return json({ ok: true });
}

async function handleVerifyRegister(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = cleanEmail(body.email);
  const code = String(body.code ?? "").replace(/\D/g, "");
  if (!EMAIL_PATTERN.test(email) || !/^\d{6,8}$/.test(code)) {
    return json({ error: "Please enter the complete 6–8 digit code from the email." }, 422);
  }

  const result = await authRequest(env, "verify", { body: { type: "signup", email, token: code } });
  if (!result.ok || !result.payload?.access_token) {
    return json({
      error: authErrorMessage(result.payload, "That code has expired or is not right. Request a new one.")
    }, 401);
  }

  return signedIn(request, result.payload, env);
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = cleanEmail(body.email);
  const password = String(body.password ?? "");
  if (!EMAIL_PATTERN.test(email) || password === "") {
    return json({ error: "Email or password is incorrect." }, 401);
  }

  const result = await authRequest(env, "token?grant_type=password", { body: { email, password } });
  if (!result.ok || !result.payload?.access_token) {
    return json({
      error: authErrorMessage(result.payload, "Email or password is incorrect.")
    }, result.status === 429 ? 429 : 401);
  }

  return signedIn(request, result.payload, env);
}

// Password reset: prove the inbox again, then choose the new password. The
// answer here is the same whether or not the email has an account — only the
// inbox learns which.
async function handleRequestReset(request, env) {
  const email = cleanEmail((await request.json().catch(() => ({}))).email);
  if (!EMAIL_PATTERN.test(email)) {
    return json({ error: "Please enter a valid email address." }, 422);
  }

  const result = await authRequest(env, "recover", { body: { email } });
  if (!result.ok && result.status === 429) {
    return json({ error: authErrorMessage(result.payload, "Too many codes requested. Please wait a minute.") }, 429);
  }
  return json({ ok: true });
}

async function handleVerifyReset(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = cleanEmail(body.email);
  const code = String(body.code ?? "").replace(/\D/g, "");
  if (!EMAIL_PATTERN.test(email) || !/^\d{6,8}$/.test(code)) {
    return json({ error: "Please enter the complete 6–8 digit code from the email." }, 422);
  }
  if (!validPassword(body.password)) {
    return json({ error: `Please choose a password of at least ${PASSWORD_MIN} characters.` }, 422);
  }

  const verified = await authRequest(env, "verify", { body: { type: "recovery", email, token: code } });
  if (!verified.ok || !verified.payload?.access_token) {
    return json({
      error: authErrorMessage(verified.payload, "That code has expired or is not right. Request a new one.")
    }, 401);
  }

  const updated = await authRequest(env, "user", {
    method: "PUT",
    token: verified.payload.access_token,
    body: { password: body.password }
  });
  if (!updated.ok) {
    return json({
      error: authErrorMessage(updated.payload, "The password could not be changed. Please try again.")
    }, 400);
  }

  return signedIn(request, verified.payload, env);
}


function verifiedUser(user) {
  return !!(user?.id && user?.email && user?.email_confirmed_at && !user?.is_anonymous);
}

export function sameOriginMutation(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const origin = request.headers.get("Origin");
  return (!origin || origin === new URL(request.url).origin) && request.headers.get("Sec-Fetch-Site") !== "cross-site";
}

// Called by both /api/auth and the existing applicant endpoints.
export async function handleAuthRequest(request, env, ctx, resource) {
  if (!authConfig(env)) return json({ error: "Sign-in is temporarily unavailable." }, 503);
  if (!sessionCookieName(request)) return json({error:"Invalid applicant session."},400);
  if (!sameOriginMutation(request)) return json({ error: "Use this website to submit the form." }, 403);
  if (authScope(request) === 'workspace' && !['login','me','request-reset','verify-reset','sign-out'].includes(resource)) return json({error:'Unknown workspace account endpoint.'},404);
  try {
    if (request.method === "GET" && resource === "me") {
      const session = await readSession(request, env);
      return session ? json({ email: session.email }, 200, session.setCookie ? { "Set-Cookie": session.setCookie } : {}) : json({ error: "Please sign in." }, 401);
    }
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    // Signing out has no payload. Accept the original portal's bodyless POST
    // too, while retaining the same-origin and session-scope checks above.
    if (resource === "sign-out") {
      const stored = decodeSessionCookie(cookieValue(request, sessionCookieName(request)));
      if (stored?.at) {
        // Clear this browser even if upstream revocation is temporarily unavailable.
        ctx.waitUntil(authRequest(env, "logout?scope=local", { token: stored.at }).catch(() => {}));
      }
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(request, "", 0) });
    }
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "Send this form as JSON." }, 415);
    const reader = request.body?.getReader(); let size = 0; const parts = [];
    if (reader) for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 16384) { await reader.cancel(); return json({ error: "This form is too large." }, 413); }
      parts.push(value);
    }
    const raw = await new Blob(parts).text();
    let body; try { body = JSON.parse(raw || "{}"); } catch { return json({ error: "Invalid form data." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid form data." }, 400);
    const safeRequest = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(body) });
    const handlers = { register: handleRegister, resend: handleResend, "verify-register": handleVerifyRegister, login: handleLogin, "request-reset": handleRequestReset, "verify-reset": handleVerifyReset };
    if (handlers[resource]) return await handlers[resource](safeRequest, env);
    return json({ error: "Unknown account endpoint." }, 404);
  } catch { return json({ error: "Sign-in could not be completed. Please try again." }, 503); }
}
