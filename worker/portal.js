// The applicant portal: /portal/ in the browser, /api/portal/* here.
//
// Applying for a home starts with an account, and the accounts are Supabase
// Auth's, not ours: registration, email confirmation, password hashing,
// sign-in throttling, and password reset are the platform's job. This module
// only proxies those flows, so the browser still never talks to Supabase
// directly and never holds a token JavaScript can read — the session it gets
// is an HttpOnly cookie carrying Supabase's access and refresh tokens, which
// the Worker validates (and quietly refreshes) on every request.
//
// Registration confirms the email with a 6-digit code before the account
// works, because everything the portal shows is claimed by email: an
// unverified address would let anyone read a stranger's application by
// typing their email into a signup form. The application form itself
// (/api/apply) requires this session and takes the applicant's email from
// it, never from the form.
//
// The code arrives in Supabase Auth's own email — the project's "Confirm
// signup" and "Reset password" templates must show {{ .Token }} for that;
// see the README for the one-time dashboard setup.
//
// Documents live in their own private R2 bucket (APPLICANT_DOCS), never in
// listing-media: that bucket's objects are served to anyone at /media/, and a
// bank statement must not be one bug away from that. Every document read or
// write here checks the session email against the application's email first.

import { isLocalRequest } from "./env.js";
import { sendEmail } from "./email.js";
import {
  deleteApplicationDocument,
  fetchApplicationDocument,
  fetchApplicationsByEmail,
  fetchDocumentsForApplication,
  fetchPortalApplication,
  insertApplicationDocument
} from "./supabase.js";

const CONTACT_EMAIL = "info@starreusa.com";
const FROM_ADDRESS = "Star Real Estate Website <no-reply@starreusa.com>";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The document checklist, in the order the portal shows it. `required` is the
// minimum number of files that satisfies the type — 0 means optional — and
// `max` is where uploads stop. The counts are on files, not on months proven:
// the agent reviews content either way, and the checklist only has to say
// when it is worth their while to look.
export const DOCUMENT_TYPES = [
  { id: "government_id_front", label: "Government ID — front", required: 1, max: 2,
    hint: "Driver's license, state ID, or passport photo page." },
  { id: "government_id_back", label: "Government ID — back", required: 1, max: 2,
    hint: "The back of the same ID. For a passport, the signature page." },
  { id: "job_offer_letter", label: "Job offer letter", required: 1, max: 3,
    hint: "On company letterhead, stating your position and salary." },
  { id: "paystub", label: "Last two paystubs", required: 2, max: 6,
    hint: "Your two most recent paystubs, one file each." },
  { id: "bank_statement", label: "Last two months' bank statements", required: 2, max: 6,
    hint: "The last two monthly statements, one file each." },
  { id: "tax_return", label: "Tax returns — last two years", required: 0, max: 4,
    hint: "Optional. The first two pages of each year's return are enough." },
  { id: "landlord_reference", label: "Landlord's reference letter", required: 0, max: 2,
    hint: "Optional. A short letter from a previous landlord." }
];

const DOCUMENT_FILE_TYPES = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif"
};

// Some browsers upload a HEIC — or anything they do not recognize — with no
// content type at all, so when the browser stays silent the extension speaks.
const EXTENSION_TYPES = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif"
};

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const SESSION_COOKIE = "star_portal";
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
// Supabase is replacing the legacy `anon` JWT key with a publishable key
// (`sb_publishable_…`), and retires the legacy one at the end of 2026. Both
// are accepted here so that migrating is a change of configuration rather
// than of code. Either only ever travels in the `apikey` header — the
// `Authorization` header carries the applicant's own access token, which is
// what the new keys, not being JWTs, may not be used for.
function authConfig(env) {
  const url = (env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "";
  return url && key ? { url, key } : null;
}

async function authRequest(env, path, { method = "POST", token, body } = {}) {
  const config = authConfig(env);
  const response = await fetch(`${config.url}/auth/v1/${path}`, {
    method,
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
function authErrorMessage(payload, fallback) {
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

function signedIn(request, session) {
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
  if (user.ok && user.payload?.email) {
    return { email: String(user.payload.email).trim().toLowerCase(), token: stored.at };
  }

  if (!stored.rt) return null;
  const refreshed = await authRequest(env, "token?grant_type=refresh_token", {
    body: { refresh_token: stored.rt }
  });
  const session = refreshed.payload;
  if (!refreshed.ok || !session?.access_token || !session.user?.email) return null;

  return {
    email: String(session.user.email).trim().toLowerCase(),
    token: session.access_token,
    setCookie: sessionCookie(request, encodeSessionCookie(session), SESSION_SECONDS)
  };
}

// -------------------------------------------------------------------- account

function cleanEmail(value) {
  return String(value ?? "").trim().toLowerCase().slice(0, 180);
}

function validPassword(password) {
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

// ----------------------------------------------------------------- documents

export function requireDocsBucket(env) {
  if (!env.APPLICANT_DOCS) {
    throw new Error("The APPLICANT_DOCS R2 bucket binding is not configured.");
  }
  return env.APPLICANT_DOCS;
}

// Whether every required type has enough files. This is the one signal the
// office is notified on, so it lives here rather than being re-derived in
// two frontends from two copies of the registry.
export function checklistComplete(documents) {
  return DOCUMENT_TYPES.every((type) => type.required === 0
    || documents.filter((doc) => doc.doc_type === type.id).length >= type.required);
}

function documentContentType(file) {
  const declared = String(file.type || "").toLowerCase();
  if (DOCUMENT_FILE_TYPES[declared]) return declared;
  if (declared && declared !== "application/octet-stream") return "";
  const match = /\.([a-z0-9]+)$/i.exec(file.name || "");
  return (match && EXTENSION_TYPES[match[1].toLowerCase()]) || "";
}

// The declared type is whatever the browser felt like sending, so the first
// bytes are checked against it before anything is stored. HEIC keeps its
// signature at offset 4 ("ftyp"); everything else starts at 0.
function bytesLookLike(contentType, bytes) {
  const ascii = (offset, text) => {
    if (bytes.length < offset + text.length) return false;
    for (let i = 0; i < text.length; i += 1) {
      if (bytes[offset + i] !== text.charCodeAt(i)) return false;
    }
    return true;
  };

  switch (contentType) {
    case "application/pdf": return ascii(0, "%PDF");
    case "image/jpeg": return bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png": return bytes.length > 3 && bytes[0] === 0x89 && ascii(1, "PNG");
    case "image/webp": return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "image/heic":
    case "image/heif": return ascii(4, "ftyp");
    default: return false;
  }
}

function cleanFileName(name) {
  const cleaned = String(name ?? "").replace(/[\u0000-\u001f\u007f"\\]/g, "").trim().slice(0, 160);
  return cleaned || "document";
}

// Content-Disposition is an HTTP header, so the name it carries has to be
// plain printable ASCII whatever the applicant called the file.
function asciiFileName(name) {
  const ascii = String(name || "").replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").trim();
  return ascii || "document";
}

// Streams one stored document back, for the applicant's own session or for
// staff — the caller has already decided which. Private by definition: no
// cache anywhere may keep a copy.
export async function serveDocumentFile(env, row) {
  const object = await requireDocsBucket(env).get(row.path);
  if (!object) return new Response("Not found.", { status: 404 });

  const headers = new Headers();
  headers.set("Content-Type", row.content_type || object.httpMetadata?.contentType || "application/octet-stream");
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Disposition", `inline; filename="${asciiFileName(row.file_name)}"`);
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { status: 200, headers });
}

// Deleting an application must take its files with it; the database cascade
// only reaches the rows.
export async function deleteDocumentsByPrefix(env, prefix) {
  if (!env.APPLICANT_DOCS) return;
  const bucket = env.APPLICANT_DOCS;
  let cursor;

  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

function toPortalDocument(row) {
  return {
    id: row.id,
    doc_type: row.doc_type,
    file_name: row.file_name,
    size_bytes: row.size_bytes,
    created_at: row.created_at
  };
}

// ------------------------------------------------------------------- routes

// Everything the portal shows an applicant, and nothing it must not: no
// screening notes, no SSN digits, no income detail. The office's own
// vocabulary for statuses is translated by the page.
async function handleList(env, session) {
  const rows = await fetchApplicationsByEmail(env, session.email);

  const applications = rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    created_at: row.created_at,
    move_in: row.move_in,
    lease_term_months: row.lease_term_months,
    listing: row.listings ? {
      title: row.listings.title,
      building_name: row.listings.building_name,
      unit: row.listings.unit,
      location: row.listings.location
    } : null,
    documents: (row.application_documents || []).map(toPortalDocument)
  }));

  return json({ email: session.email, document_types: DOCUMENT_TYPES, applications });
}

async function handleUpload(request, env, ctx, session, applicationId) {
  if (!UUID_PATTERN.test(applicationId)) {
    return json({ error: "Application not found." }, 404);
  }

  const application = await fetchPortalApplication(env, applicationId);
  if (!application || String(application.email || "").trim().toLowerCase() !== session.email) {
    return json({ error: "Application not found." }, 404);
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const docType = DOCUMENT_TYPES.find((type) => type.id === String(form?.get("doc_type") ?? ""));

  if (!docType) return json({ error: "Unknown document type." }, 422);
  if (!file || typeof file === "string") return json({ error: "No file was uploaded." }, 400);
  if (file.size === 0) return json({ error: "That file is empty." }, 400);
  if (file.size > MAX_DOCUMENT_BYTES) return json({ error: "Files must be 10 MB or smaller." }, 413);

  const contentType = documentContentType(file);
  if (!contentType) {
    return json({ error: "Unsupported file type. Use a PDF or a photo (JPEG, PNG, WebP, HEIC)." }, 415);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytesLookLike(contentType, bytes)) {
    return json({ error: "That file does not look like a PDF or a photo. Please export it again and retry." }, 415);
  }

  const existing = await fetchDocumentsForApplication(env, applicationId);
  if (existing.filter((doc) => doc.doc_type === docType.id).length >= docType.max) {
    return json({
      error: `"${docType.label}" already has ${docType.max} files. Remove one to replace it.`
    }, 409);
  }

  const key = `${applicationId.toLowerCase()}/${docType.id}/${crypto.randomUUID()}.${DOCUMENT_FILE_TYPES[contentType]}`;
  await requireDocsBucket(env).put(key, bytes, { httpMetadata: { contentType } });

  let row;
  try {
    row = await insertApplicationDocument(env, {
      application_id: applicationId,
      doc_type: docType.id,
      path: key,
      file_name: cleanFileName(file.name),
      content_type: contentType,
      size_bytes: file.size
    });
  } catch (error) {
    // The row is what makes an object reachable; an insert that failed must
    // not leave orphaned bytes behind.
    ctx.waitUntil(requireDocsBucket(env).delete(key));
    throw error;
  }

  // Tell the office once, when the checklist crosses from incomplete to
  // complete — not on every one of the eight uploads.
  if (!checklistComplete(existing) && checklistComplete(existing.concat(row))) {
    ctx.waitUntil(sendCompletionNotice(request, env, application));
  }

  return json({ document: toPortalDocument(row) }, 201);
}

async function fetchOwnedDocument(env, session, id) {
  if (!UUID_PATTERN.test(id)) return null;
  const row = await fetchApplicationDocument(env, id);
  if (!row) return null;
  const owner = String(row.applications?.email || "").trim().toLowerCase();
  return owner === session.email ? row : null;
}

async function handleDownload(env, session, id) {
  const row = await fetchOwnedDocument(env, session, id);
  if (!row) return json({ error: "Document not found." }, 404);
  return serveDocumentFile(env, row);
}

async function handleDelete(env, ctx, session, id) {
  const row = await fetchOwnedDocument(env, session, id);
  if (!row) return json({ error: "Document not found." }, 404);

  await deleteApplicationDocument(env, row.id);
  ctx.waitUntil(requireDocsBucket(env).delete(row.path));
  return json({ deleted: true });
}

async function sendCompletionNotice(request, env, application) {
  const listing = application.listings || {};
  const home = [listing.building_name, listing.unit].filter(Boolean).join(" ");
  const label = home ? `${listing.title} (${home})` : (listing.title || "a property");

  const sent = await sendEmail(request, env, {
    from: FROM_ADDRESS,
    to: [CONTACT_EMAIL],
    subject: `Documents complete: ${application.name} — ${label}`,
    text: `${application.name} has uploaded every required document for their application for ${label}.\n\n`
      + "Review them in the admin console: https://starreusa.com/admin/\n"
  });
  if (!sent) {
    console.error("Document completion notice failed for", application.id);
  }
}

export async function handlePortalRequest(request, env, ctx, pathname) {
  if (!authConfig(env)) {
    console.error("SUPABASE_URL or SUPABASE_ANON_KEY is not configured; the applicant portal is unavailable.");
    return json({ error: "The portal is temporarily unavailable. Please try again shortly." }, 503);
  }

  const segments = pathname.replace(/^\/api\/portal\/?/, "").split("/").filter(Boolean);
  const [resource, id, subresource] = segments;

  try {
    if (request.method === "POST" && !id) {
      if (resource === "register") return await handleRegister(request, env);
      if (resource === "resend") return await handleResend(request, env);
      if (resource === "verify-register") return await handleVerifyRegister(request, env);
      if (resource === "login") return await handleLogin(request, env);
      if (resource === "request-reset") return await handleRequestReset(request, env);
      if (resource === "verify-reset") return await handleVerifyReset(request, env);
      if (resource === "sign-out") {
        // Revoking the refresh token is a courtesy; the cookie leaving is
        // what signs the browser out.
        const stored = decodeSessionCookie(cookieValue(request, SESSION_COOKIE));
        if (stored?.at) {
          ctx.waitUntil(authRequest(env, "logout", { token: stored.at }).catch(() => {}));
        }
        return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(request, "", 0) });
      }
    }

    // Everything below is somebody's private data, so it needs a session.
    const session = await readSession(request, env);
    if (!session) {
      return json({ error: "Please sign in." }, 401);
    }

    let response;
    if (resource === "me" && !id && request.method === "GET") {
      response = json({ email: session.email });
    } else if (resource === "applications" && !id && request.method === "GET") {
      response = await handleList(env, session);
    } else if (resource === "applications" && id && subresource === "documents" && request.method === "POST") {
      response = await handleUpload(request, env, ctx, session, id);
    } else if (resource === "documents" && id && !subresource && request.method === "GET") {
      response = await handleDownload(env, session, id);
    } else if (resource === "documents" && id && !subresource && request.method === "DELETE") {
      response = await handleDelete(env, ctx, session, id);
    } else {
      response = json({ error: "Unknown endpoint." }, 404);
    }

    if (session.setCookie) {
      response.headers.append("Set-Cookie", session.setCookie);
    }
    return response;
  } catch (error) {
    console.error("Portal request failed", error);
    return json({ error: "The request could not be completed." }, 500);
  }
}
