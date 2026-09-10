// Shared Supabase identity adapter. Business roles are resolved separately.
import { isLocalRequest } from "./env.js";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SESSION_COOKIE = "star_portal"; // One HttpOnly session shared by both portals.
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

function cookieValue(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

// `Secure` would make the browser drop the cookie on a plain-HTTP loopback,
// which is exactly where development runs.
function sessionCookie(request, value, maxAge) {
  const attributes = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (!isLocalRequest(request)) attributes.push("Secure");
  return attributes.join("; ");
}

export function signedIn(request, session) {
  if (!verifiedUser(session.user)) return json({ error: "Confirm your email before signing in." }, 403);
  return json({ ok: true, email: String(session.user?.email || "").toLowerCase() }, 200, {
    "Set-Cookie": sessionCookie(request, encodeSessionCookie(session), SESSION_SECONDS)
  });
}

// The session /api/apply and every portal route trust. The access token is
// validated against Supabase on each request; when it has expired, the
// refresh token buys its successor, and `setCookie` carries the rolled
// cookie the response must set — Supabase rotates refresh tokens, so
// dropping it would sign the applicant out a request later.
export async function readSession(request, env) {
  if (!authConfig(env)) return null;

  const stored = decodeSessionCookie(cookieValue(request, SESSION_COOKIE));
  if (!stored) return null;

  const user = await authRequest(env, "user", { method: "GET", token: stored.at });
  if (user.ok && verifiedUser(user.payload)) {
    return { email: String(user.payload.email).trim().toLowerCase(), subject: user.payload.id, token: stored.at };
  }

  if (user.ok || ![401, 403].includes(user.status) || !stored.rt) return null;
  const refreshed = await authRequest(env, "token?grant_type=refresh_token", {
    body: { refresh_token: stored.rt }
  });
  const session = refreshed.payload;
  if (!refreshed.ok || !session?.access_token || !verifiedUser(session.user)) return null;

  return {
    email: String(session.user.email).trim().toLowerCase(),
    subject: session.user.id,
    token: session.access_token,
    setCookie: sessionCookie(request, encodeSessionCookie(session), SESSION_SECONDS)
  };
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
    return signedIn(request, result.payload);
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
  if (!EMAIL_PATTERN.test(email) || code.length !== 6) {
    return json({ error: "Please enter the 6-digit code from the email." }, 422);
  }

  const result = await authRequest(env, "verify", { body: { type: "signup", email, token: code } });
  if (!result.ok || !result.payload?.access_token) {
    return json({
      error: authErrorMessage(result.payload, "That code has expired or is not right. Request a new one.")
    }, 401);
  }

  return signedIn(request, result.payload);
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

  return signedIn(request, result.payload);
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
  if (!EMAIL_PATTERN.test(email) || code.length !== 6) {
    return json({ error: "Please enter the 6-digit code from the email." }, 422);
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

  return signedIn(request, verified.payload);
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
  if (!sameOriginMutation(request)) return json({ error: "Use this website to submit the form." }, 403);
  try {
    if (request.method === "GET" && resource === "me") {
      const session = await readSession(request, env);
      return session ? json({ email: session.email }, 200, session.setCookie ? { "Set-Cookie": session.setCookie } : {}) : json({ error: "Please sign in." }, 401);
    }
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
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
    if (resource === "sign-out") {
      const stored = decodeSessionCookie(cookieValue(request, SESSION_COOKIE));
      if (stored?.at) {
        // Clear this browser even if upstream revocation is temporarily unavailable.
        ctx.waitUntil(authRequest(env, "logout?scope=local", { token: stored.at }).catch(() => {}));
      }
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(request, "", 0) });
    }
    return json({ error: "Unknown account endpoint." }, 404);
  } catch { return json({ error: "Sign-in could not be completed. Please try again." }, 503); }
}
