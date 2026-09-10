import { storageBucket } from "./storage.js";
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

import { authConfig, readSession, handleAuthRequest, sameOriginMutation } from "./auth.js";
export { readSession } from "./auth.js";
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
//
// `when` limits a type to applications with that employment_status; a type
// without it is asked of everyone. Types sharing an `either` value are
// alternatives: satisfying any one of them satisfies them all — a job offer
// letter proves income the same way two paystubs do.
//
// The id `landlord_reference` predates the "Rental payment record" label and
// stays as it is: uploaded files carry the id in their rows and their R2 keys,
// and renaming it would orphan every one already received.
export const DOCUMENT_TYPES = [
  { id: "government_id_front", label: "Government ID (Front)", required: 1, max: 2,
    hint: "Driver's license, state ID, or passport photo page." },
  { id: "government_id_back", label: "Government ID (Back)", required: 1, max: 2,
    hint: "The back of the same ID. For a passport, the signature page." },
  { id: "job_offer_letter", label: "Job Offer Letter", required: 1, max: 3,
    when: "employed", either: "income_proof",
    hint: "On company letterhead stating your position and salary. Either this or your last two paystubs is enough." },
  { id: "paystub", label: "Last Two Paystubs", required: 2, max: 6,
    when: "employed", either: "income_proof",
    hint: "Your two most recent paystubs, one file each. Either these or your job offer letter is enough." },
  { id: "school_offer_letter", label: "School Offer Letter", required: 1, max: 3,
    when: "student",
    hint: "Your school's offer or enrollment letter." },
  { id: "student_visa_i20", label: "Student Visa / I-20", required: 1, max: 4,
    when: "student",
    hint: "Your student visa or your I-20. Upload both if you have them." },
  { id: "bank_statement", label: "Last Two Bank Statements", required: 2, max: 6,
    hint: "The last two monthly statements, one file each." },
  { id: "tax_return", label: "Last Two Tax Returns", required: 0, max: 4,
    hint: "Optional. The first two pages of each year's return are enough." },
  { id: "landlord_reference", label: "Rental Payment Record", required: 0, max: 4,
    hint: "Optional. Proof of rent paid on time, such as a payment ledger or a letter from a previous landlord." }
];

// The types this application is asked for. Applications from before the
// work-or-school question — employment_status null — all had an employer on
// the form, so they read as employed rather than being asked for a visa.
export function applicableDocumentTypes(application) {
  const status = application?.employment_status === "student" ? "student" : "employed";
  return DOCUMENT_TYPES.filter((type) => !type.when || type.when === status);
}

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

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

// ----------------------------------------------------------------- documents

export function requireDocsBucket(env) {
  return storageBucket(env, "applicant-docs");
}

// Whether every required type has enough files, for the checklist this
// application is actually asked for. This is the one signal the office is
// notified on, so it lives here rather than being re-derived in two frontends
// from two copies of the registry.
export function checklistComplete(documents, application) {
  const types = applicableDocumentTypes(application);
  const satisfied = (type) =>
    documents.filter((doc) => doc.doc_type === type.id).length >= type.required;
  return types.every((type) => {
    if (type.required === 0) return true;
    if (!type.either) return satisfied(type);
    return types.some((other) => other.either === type.either && satisfied(other));
  });
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
  const bucket = requireDocsBucket(env);
  if (bucket.deletePrefix) return bucket.deletePrefix(prefix);
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
// One application as its applicant sees it: their own answers, the listing,
// their documents, and what the leasing team has asked them for. Nothing else
// on the row is theirs to read.
export function toPortalApplication(row) {
  const asked = row.workspace?.info_request;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    created_at: row.created_at,
    move_in: row.move_in,
    lease_term_months: row.lease_term_months,
    employment_status: row.employment_status || null,
    listing: row.listings ? {
      title: row.listings.title,
      property_name: row.listings.property_name,
      unit: row.listings.unit,
      location: row.listings.location
    } : null,
    documents: (row.application_documents || []).map(toPortalDocument),
    // Only while the request stands. Once the status has moved on, what was
    // asked is history, not an instruction.
    request: row.status === "needs_info" && asked && asked.message
      ? { message: String(asked.message), at: asked.at || null }
      : null
  };
}

async function handleList(env, session) {
  const rows = await fetchApplicationsByEmail(env, session.email);
  const applications = rows.map(toPortalApplication);
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
  // Only the types this application is asked for: a student's checklist has
  // no paystub slot, so no paystub can be filed onto it either.
  const docType = applicableDocumentTypes(application)
    .find((type) => type.id === String(form?.get("doc_type") ?? ""));

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
  if (!checklistComplete(existing, application) && checklistComplete(existing.concat(row), application)) {
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
  const home = [listing.property_name, listing.unit].filter(Boolean).join(" ");
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
    if (!sameOriginMutation(request)) return json({ error: "Use this website to submit the form." }, 403);
    if (!id && ["register", "resend", "verify-register", "login", "request-reset", "verify-reset", "sign-out"].includes(resource)) {
      return handleAuthRequest(request, env, ctx, resource);
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
