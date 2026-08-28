import { fetchListing, insertApplication } from "./supabase.js";
import { encryptionReady, encryptSsn } from "./ssn.js";
import { sendEmail } from "./email.js";
import { readSession } from "./portal.js";
import { renderPage } from "./contact.js";

const CONTACT_EMAIL = "info@starreusa.com";
const FROM_ADDRESS = "Star Real Estate Website <no-reply@starreusa.com>";
const TURNSTILE_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PET_TYPES = ["dog", "cat", "other"];
const EMPLOYMENT_STATUSES = ["employed", "student"];
const ID_TYPES = ["ssn", "passport"];
const MAX_ENTRIES = 10;
const REFERENCES_REQUIRED = 2;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function cleanLine(value, maxLength) {
  return String(value ?? "").replace(/<[^>]*>/g, "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maxLength);
}

function cleanMultiline(value, maxLength) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function parseIntInRange(value, min, max) {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function isRealDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function isAdultDob(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match || !isRealDate(value)) return false;
  const year = Number(match[3]);
  if (year < 1900) return false;

  const dob = new Date(year, Number(match[1]) - 1, Number(match[2]));
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 18);
  return dob <= cutoff;
}

function isValidPhone(value) {
  const digits = value.replace(/\D/g, "");
  return digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Rebuilds each repeated section from the raw payload so only whitelisted
// keys, cleaned values, and a bounded number of entries can reach the
// database. `spec` maps output keys to cleaners; `required` lists keys that
// make an entry valid. Entries that are entirely empty are dropped silently;
// entries that are partially filled but miss a required key are an error.
function shapeEntries(raw, spec, required, label, errors) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push(label);
    return [];
  }

  const entries = [];
  for (const item of raw.slice(0, MAX_ENTRIES)) {
    if (typeof item !== "object" || item === null) continue;

    const entry = {};
    let hasValue = false;
    let invalid = false;
    for (const [key, clean] of Object.entries(spec)) {
      const value = clean(item[key]);
      entry[key] = value;
      if (value === null) invalid = true;
      else if (value !== "") hasValue = true;
    }
    if (!hasValue && !invalid) continue;

    if (invalid || required.some((key) => entry[key] === "")) {
      errors.push(label);
      return [];
    }
    entries.push(entry);
  }
  return entries;
}

const line = (max) => (value) => cleanLine(value, max);
const phoneField = () => (value) => {
  const cleaned = cleanLine(value, 30);
  return cleaned === "" || isValidPhone(cleaned) ? cleaned : null;
};
const emailField = () => (value) => {
  const cleaned = cleanLine(value, 180);
  return cleaned === "" || isValidEmail(cleaned) ? cleaned : null;
};

const PERSON_SPEC = {
  name: line(120),
  relationship: line(80),
  phone: phoneField(),
  email: emailField()
};

// Somebody who will rent and sign alongside the applicant. Their details are
// what lets the leasing team reach them and, later, invite them to a portal
// account of their own.
const ROOMMATE_SPEC = {
  first_name: line(80),
  last_name: line(80),
  phone: phoneField(),
  email: emailField()
};

// A previous job: where, what, since when, what it paid. The form asks only
// these four — supervisor contact is asked about the current employer alone —
// but `end` and the supervisor keys stay in the spec because older
// applications carry them, and an admin correction rebuilds every entry from
// this whitelist: a key missing here is a key erased on save.
const EMPLOYMENT_SPEC = {
  employer: line(160),
  position: line(120),
  start: line(20),
  end: line(20),
  income: line(30),
  supervisor_name: line(120),
  supervisor_phone: phoneField(),
  supervisor_email: emailField()
};

// The identity number is a nine-digit SSN or a passport number. Both are
// encrypted the same way and stored in the same column; `id_type` records
// which one it is.
function isValidIdNumber(idType, value) {
  if (idType === "passport") return /^[A-Z0-9]{5,20}$/.test(value);
  return /^\d{9}$/.test(value) && !/^(\d)\1{8}$/.test(value);
}

// What a student fills in instead of an employer.
function shapeStudent(raw, errors) {
  const source = typeof raw === "object" && raw !== null ? raw : {};
  const student = {
    school_name: cleanLine(source.school_name, 200),
    major: cleanLine(source.major, 120),
    entry_year: cleanLine(source.entry_year, 10),
    graduation_year: cleanLine(source.graduation_year, 10),
    country: cleanLine(source.country, 80)
  };
  if (!student.school_name) errors.push("school name");
  if (!student.major) errors.push("major");
  if (!/^\d{4}$/.test(student.entry_year)) errors.push("school entry year");
  if (!/^\d{4}$/.test(student.graduation_year)) errors.push("graduation year");
  if (!student.country) errors.push("country");
  return student;
}

const RENTAL_SPEC = {
  address: line(300),
  start: line(20),
  end: line(20),
  monthly_rent: line(30),
  landlord_name: line(120),
  contact: line(120),
  landlord_phone: phoneField(),
  landlord_email: emailField()
};

const PET_SPEC = {
  type: (value) => (PET_TYPES.includes(String(value ?? "").trim().toLowerCase()) ? String(value).trim().toLowerCase() : ""),
  species: line(80),
  weight: line(20)
};

// ------------------------------------------------ correcting an application
//
// An agent can correct a submitted application from the admin console — an
// applicant mistypes an email, a move-in date slips, a name is spelled the way
// nobody spells it. The rules are the ones above, applied to whichever fields
// were sent, so a corrected application cannot end up shaped differently from a
// submitted one. What may NOT be corrected here is the SSN: it is stored
// encrypted and never leaves the server in full, so there is nothing to edit
// against.
//
// `name` is derived rather than accepted: it is first and last together on the
// way in, and it stays that way, because the lease prints `name` and a screen
// that lets those two disagree prints the wrong tenant.

const SCALAR_EDITS = {
  name: { clean: (v) => cleanLine(v, 240), required: true, label: "tenant name(s)" },
  concession_terms: { clean: (v) => cleanMultiline(v, 4000) || null, blank: true, label: "rent concession" },
  first_name: { clean: (v) => cleanLine(v, 80), required: true, label: "first name" },
  last_name: { clean: (v) => cleanLine(v, 80), required: true, label: "last name" },
  email: { clean: (v) => cleanLine(v, 180), check: isValidEmail, label: "email" },
  phone: { clean: (v) => cleanLine(v, 30), check: isValidPhone, label: "phone" },
  current_address: { clean: (v) => cleanLine(v, 300), required: true, label: "current address" },
  move_in: { clean: (v) => cleanLine(v, 10), check: isRealDate, label: "lease start date" },
  dob: { clean: (v) => cleanLine(v, 10), check: isAdultDob, label: "date of birth" },
  // Blank on purpose is a student with no salary to note, so empty maps to
  // null rather than being refused.
  income_note: { clean: (v) => cleanLine(v, 300) || null, blank: true, label: "annual income" },
  message: { clean: (v) => cleanMultiline(v, 2000) || null, blank: true, label: "message" }
};

const LIST_EDITS = {
  employment_history: { spec: EMPLOYMENT_SPEC, required: ["employer"], label: "previous employment", least: 0 },
  rental_history: { spec: RENTAL_SPEC, required: ["address"], label: "rental history", least: 0 },
  reference_contacts: { spec: PERSON_SPEC, required: ["name"], label: "references", least: REFERENCES_REQUIRED },
  // The form requires an emergency contact again, but applications from the
  // years it did not ask may hold none — so a correction is allowed to leave
  // the list empty, and only insists on a name and a phone per entry kept.
  emergency_contacts: { spec: PERSON_SPEC, required: ["name"], label: "emergency contact", least: 0 },
  roommates: { spec: ROOMMATE_SPEC, required: ["first_name", "last_name"], label: "roommates", least: 0 },
  pets: { spec: PET_SPEC, required: ["type"], label: "pets", least: 0 }
};

export function normalizeApplicationEdit(body, current = {}) {
  const values = {};
  const errors = [];

  for (const [key, rule] of Object.entries(SCALAR_EDITS)) {
    if (body[key] === undefined) continue;
    const cleaned = rule.clean(body[key]);
    // A rule marked `blank` maps empty to null on purpose: there is no message,
    // there is no concession. For every other scalar a null came out of a value
    // that would not clean, which is a correction to reject rather than store.
    if (cleaned === null && !rule.blank) { errors.push(rule.label); continue; }
    if (rule.required && !cleaned) errors.push(rule.label);
    else if (rule.check && !rule.check(cleaned)) errors.push(rule.label);
    values[key] = cleaned;
  }

  if (body.lease_term_months !== undefined) {
    const months = parseIntInRange(body.lease_term_months, 1, 60);
    if (months === null) errors.push("lease term");
    else values.lease_term_months = months;
  }

  if (body.employment_status !== undefined) {
    if (!EMPLOYMENT_STATUSES.includes(body.employment_status)) errors.push("working or student");
    else values.employment_status = body.employment_status;
  }

  if (body.student !== undefined) {
    const raw = typeof body.student === "object" && body.student !== null ? body.student : {};
    const student = {
      school_name: cleanLine(raw.school_name, 200),
      major: cleanLine(raw.major, 120),
      entry_year: cleanLine(raw.entry_year, 10),
      graduation_year: cleanLine(raw.graduation_year, 10),
      country: cleanLine(raw.country, 80)
    };
    // A correction only insists on the school itself; the rest is the
    // applicant's to fill and the agent's to tidy.
    if (!student.school_name) errors.push("school name");
    values.student = student;
  }

  if (body.children_under_11 !== undefined) {
    if (body.children_under_11 !== true && body.children_under_11 !== false) {
      errors.push("children 10 or younger");
    } else {
      values.children_under_11 = body.children_under_11;
    }
  }

  if (body.wants_window_guards !== undefined) {
    // Null is a real state here: every application from before the checkbox
    // existed never answered it, and saving such a row must not invent an
    // answer or refuse the save.
    if (body.wants_window_guards !== true && body.wants_window_guards !== false
        && body.wants_window_guards !== null) {
      errors.push("window guards");
    } else {
      values.wants_window_guards = body.wants_window_guards;
    }
  }

  if (body.current_employer !== undefined) {
    const raw = typeof body.current_employer === "object" && body.current_employer !== null
      ? body.current_employer : {};
    const employer = {
      employer: cleanLine(raw.employer, 160),
      position: cleanLine(raw.position, 120),
      start: cleanLine(raw.start, 20),
      supervisor_name: cleanLine(raw.supervisor_name, 120),
      supervisor_phone: phoneField()(raw.supervisor_phone),
      supervisor_email: emailField()(raw.supervisor_email)
    };
    if (!employer.employer) errors.push("current employer");
    if (employer.supervisor_phone === null || employer.supervisor_email === null) {
      errors.push("current employer contact");
    }
    values.current_employer = employer;
  }

  for (const [key, rule] of Object.entries(LIST_EDITS)) {
    if (body[key] === undefined) continue;
    const entries = shapeEntries(body[key], rule.spec, rule.required, rule.label, errors);
    if (entries.length < rule.least) errors.push(`${rule.label} (${rule.least} required)`);
    if (key === "reference_contacts" && entries.some((ref) => !ref.phone && !ref.email)) {
      errors.push("references (each needs a phone or email)");
    }
    if (key === "emergency_contacts" && entries.some((contact) => !contact.phone)) {
      errors.push("emergency contact phone");
    }
    // The submit path stores an empty optional list as null, not as [].
    values[key] = entries.length > 0 || rule.least > 0 ? entries : null;
  }

  // Kept in step with the two halves it is made of, whichever of them moved —
  // unless the name itself was sent, which is how a lease adds a second tenant
  // the application was never going to name.
  if (values.name === undefined
      && (values.first_name !== undefined || values.last_name !== undefined)) {
    const first = values.first_name ?? current.first_name ?? "";
    const last = values.last_name ?? current.last_name ?? "";
    values.name = `${first} ${last}`.trim();
    if (!values.name) errors.push("name");
  }

  return { values, errors: [...new Set(errors)] };
}


async function verifyTurnstile(env, token, remoteIp) {
  if (!token) return false;

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  if (remoteIp) body.append("remoteip", remoteIp);

  try {
    const response = await fetch(TURNSTILE_ENDPOINT, { method: "POST", body });
    if (!response.ok) return false;
    const outcome = await response.json();
    return outcome.success === true;
  } catch (error) {
    console.error("Turnstile verification failed", error);
    return false;
  }
}

// The notification deliberately carries no applicant details beyond the name:
// inboxes are the most common place private data leaks from, so the full
// application stays in the admin console only.
async function sendNotification(request, env, listing, name) {
  const home = [listing.property_name, listing.unit].filter(Boolean).join(" ");
  const label = home ? `${listing.title} (${home})` : listing.title;

  const sent = await sendEmail(request, env, {
    from: FROM_ADDRESS,
    to: [CONTACT_EMAIL],
    subject: `New rental application: ${label}`,
    text: `${name} submitted an application for ${label}.\n\nReview it in the admin console: https://starreusa.com/admin/\n`
  });

  if (!sent) {
    console.error("Application notification failed for", label);
  }
}

// The applicant's receipt. It names the property and points at the portal
// where the supporting documents go — deliberately nothing else, because
// inboxes are where private data leaks from, and the application's contents
// stay in the admin console.
async function sendReceipt(request, env, listing, email, employmentStatus) {
  const home = [listing.property_name, listing.unit].filter(Boolean).join(" ");
  const label = home ? `${listing.title} (${home})` : listing.title;
  const portal = new URL("/portal/", request.url).toString();

  // The checklist the portal will show them, in one sentence: it depends on
  // whether they work or study, and the email should ask for the same things
  // the page does.
  const proofOfMeans = employmentStatus === "student"
    ? "your school offer letter, your student visa or I-20"
    : "your job offer letter or your last two paystubs";

  const sent = await sendEmail(request, env, {
    from: FROM_ADDRESS,
    to: [email],
    subject: `We received your application for ${label}`,
    text: `Thank you for applying for ${label}.\n\n`
      + `The next step is to upload your supporting documents in your applicant portal.\n\n    ${portal}\n\n`
      + `We need your government ID (front and back), ${proofOfMeans}, and your last two `
      + "months' bank statements. Tax returns for the last two years and a rental payment "
      + "record are optional but help.\n\n"
      + "The Star Real Estate team will review your application and follow up shortly.\n"
  });

  if (!sent) {
    console.error("Application receipt failed for", label);
  }
}

// A PostgREST failure quotes the row it could not write, and that row carries
// the applicant's details. The SSN itself is already ciphertext by the time it
// reaches Supabase, but the last four digits are not, and neither is anything
// else -- so the row never reaches a log line.
function withoutRowValues(message) {
  return String(message ?? "").replace(/Failing row contains[\s\S]*/i, "[row redacted]");
}

// ------------------------------------------------------ roommate invitations
//
// Sent from the roommate step of the form, before the application itself is
// submitted, so a roommate can create their account and start their own
// application while the inviter is still filling theirs in. The route needs a
// signed-in applicant, a real published listing, and valid addresses; the
// inviter is named by their account email, because at this point in the form
// their name has not been asked yet.

export async function handleRoommateInvites(request, env) {
  const contentType = (request.headers.get("Content-Type") || "").trim();
  if (!/^application\/json\b/i.test(contentType)) {
    return json({ error: "Invitations could not be read. Please try again." }, 415);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invitations could not be read. Please try again." }, 400);
  }

  const session = await readSession(request, env);
  if (!session) {
    return json({ error: "Please sign in to your applicant account first." }, 401);
  }

  // Supabase rotates refresh tokens, so the rolled cookie has to ride every
  // response from here on — an error that dropped it would quietly sign the
  // applicant out mid-form.
  const withSession = (response) => {
    if (session.setCookie) response.headers.append("Set-Cookie", session.setCookie);
    return response;
  };

  const listingId = String(body.listing_id ?? "").trim();
  if (!UUID_PATTERN.test(listingId)) {
    return withSession(json({ error: "Unknown property." }, 400));
  }

  let listing;
  try {
    listing = await fetchListing(env, listingId, { publishedOnly: true });
  } catch (error) {
    console.error("Invite listing lookup failed", error);
    return withSession(json({ error: "The invitations could not be sent. Please try again shortly." }, 502));
  }
  if (!listing) {
    return withSession(json({ error: "Unknown property." }, 404));
  }

  // The form caps roommates at one per bedroom beyond the applicant, and a
  // studio takes nobody. A listing whose bedroom count cannot be read gets
  // the form's own fallback of one.
  const bedrooms = parseInt(String(listing.bedrooms ?? "").trim(), 10);
  const cap = Number.isFinite(bedrooms) ? Math.max(0, Math.min(4, bedrooms - 1)) : 1;

  const rawRoommates = Array.isArray(body.roommates) ? body.roommates : [];
  const roommates = [];
  const seenAddresses = new Set();
  for (const item of rawRoommates) {
    if (typeof item !== "object" || item === null) continue;
    const invitee = {
      first_name: cleanLine(item.first_name, 80),
      last_name: cleanLine(item.last_name, 80),
      email: emailField()(item.email)
    };
    if (!invitee.email) {
      return withSession(json({ error: "Please check the roommate email addresses." }, 422));
    }
    const address = invitee.email.toLowerCase();
    if (seenAddresses.has(address)) continue;
    seenAddresses.add(address);
    roommates.push(invitee);
  }
  if (roommates.length === 0) {
    return withSession(json({ error: "There is nobody to invite yet." }, 422));
  }
  if (roommates.length > cap) {
    return withSession(json({ error: "This home does not have room for that many roommates." }, 422));
  }

  const home = [listing.property_name, listing.unit].filter(Boolean).join(" ");
  const label = home ? `${listing.title} (${home})` : listing.title;
  const applyUrl = new URL(`/apply/?id=${encodeURIComponent(listingId)}`, request.url).toString();

  // The greeting uses the typed first name only when it looks like a name:
  // this mail goes to an address its owner never gave us directly, so free
  // text has no business riding in it.
  const greetName = (value) => (/^[\p{L}][\p{L}' .-]{0,39}$/u.test(value) ? value : "");

  const outcomes = await Promise.all(roommates.map(async (mate) => ({
    email: mate.email,
    delivered: await sendEmail(request, env, {
      from: FROM_ADDRESS,
      to: [mate.email],
      subject: `You are invited to apply for ${label}`,
      text: `${greetName(mate.first_name) ? `Hi ${greetName(mate.first_name)},\n\n` : ""}`
        + `${session.email} is applying to rent ${label} with Star Real Estate and named you `
        + "as a roommate. Everyone who signs the lease completes an application of their own.\n\n"
        + `Start yours here\n\n    ${applyUrl}\n\n`
        + "Sign in with this email address to create your applicant account, and your "
        + "application will be filed alongside theirs.\n\n"
        + "The Star Real Estate team\n"
    })
  })));

  // Per address, not all or nothing: the ones that went out stay sent, and
  // the answer says which are which, so nobody is mailed twice on a retry.
  const sent = outcomes.filter((outcome) => outcome.delivered).map((outcome) => outcome.email);
  const failedInvites = outcomes.filter((outcome) => !outcome.delivered).map((outcome) => outcome.email);

  if (sent.length === 0) {
    console.error("Roommate invitation delivery failed for", label);
    return withSession(json({
      error: "The invitations could not be sent. Please try again shortly.",
      sent, failed: failedInvites
    }, 502));
  }
  if (failedInvites.length > 0) {
    console.error("Some roommate invitations failed for", label);
  }
  return withSession(json({ ok: failedInvites.length === 0, sent, failed: failedInvites }));
}

export async function handleApplication(request, env, ctx) {
  // JSON and nothing else. A form-encoded body means the browser submitted the
  // HTML form itself, which only happens when this page's JavaScript did not
  // run -- and this step collects a Social Security Number, so it is answered
  // with an explanation rather than parsed. It is also what keeps a cross-site
  // form off this route: no HTML form can set this header, whatever it does
  // with enctype, and the session cookie is SameSite=Lax besides.
  const contentType = (request.headers.get("Content-Type") || "").trim();
  if (!/^application\/json\b/i.test(contentType)) {
    return renderPage(
      "JavaScript is required",
      "This application form needs JavaScript to submit securely. Please turn it on, "
      + "go back to the property, and open the application again. Nothing you typed was read "
      + "or saved.",
      415
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "The application could not be read. Please try again." }, 400);
  }

  // Honeypot: bots that fill the hidden field get a fake success.
  if (String(body.website ?? "").trim() !== "") {
    return json({ ok: true });
  }

  // Fail closed: without the encryption key an SSN cannot be stored safely,
  // so no application is accepted at all.
  if (!encryptionReady(env)) {
    console.error("APP_ENCRYPTION_KEY is not configured; rejecting application.");
    return json({ error: "Applications are temporarily unavailable. Please try again shortly." }, 503);
  }

  // Applying requires a portal account, and the application's email IS the
  // account's — taken from the verified session, never from the form. It is
  // what ties the application to the portal where the documents arrive, so a
  // typed address (one typo, or someone else's) must not be able to detach
  // the two.
  const session = await readSession(request, env);
  if (!session) {
    return json({ error: "Please sign in to your applicant account to apply." }, 401);
  }

  const response = await processApplication(request, env, ctx, body, session.email);

  // Supabase rotates refresh tokens: a session that was refreshed while this
  // submit was validated has to reach the browser, or the applicant is
  // quietly signed out a request later.
  if (session.setCookie) {
    response.headers.append("Set-Cookie", session.setCookie);
  }
  return response;
}

async function processApplication(request, env, ctx, body, email) {
  const listingId = String(body.listing_id ?? "").trim();
  if (!UUID_PATTERN.test(listingId)) {
    return json({ error: "Unknown property." }, 400);
  }

  const errors = [];

  const firstName = cleanLine(body.first_name, 80);
  const lastName = cleanLine(body.last_name, 80);
  const phone = cleanLine(body.phone, 30);
  const currentAddress = cleanLine(body.current_address, 300);
  const moveIn = cleanLine(body.move_in, 10);
  const leaseTermMonths = parseIntInRange(body.lease_term_months, 1, 60);
  const dob = cleanLine(body.dob, 10);
  const childrenUnder11 = body.children_under_11;
  // The third window guard answer, offered to applicants without young
  // children. Anything but an explicit true is false.
  const wantsWindowGuards = body.wants_window_guards === true;

  // A payload with no id_type is an SSN: that is what every application was
  // before the passport option existed.
  const idType = body.id_type === undefined || ID_TYPES.includes(body.id_type)
    ? (body.id_type ?? "ssn")
    : null;
  // No truncation on the way in: an over-length passport number fails the
  // 5–20 character test below and is refused, the same way eleven digits of
  // SSN are — never silently shortened into a plausible-looking wrong one.
  const rawIdNumber = String(body.id_number ?? body.ssn ?? "");
  const idNumber = idType === "passport"
    ? rawIdNumber.replace(/\s+/g, "").toUpperCase()
    : rawIdNumber.replace(/\D/g, "");

  const employmentStatus = EMPLOYMENT_STATUSES.includes(body.employment_status)
    ? body.employment_status
    : null;

  if (!firstName) errors.push("first name");
  if (!lastName) errors.push("last name");
  if (!phone || !isValidPhone(phone)) errors.push("phone");
  if (!currentAddress) errors.push("current address");
  if (!isRealDate(moveIn)) errors.push("lease start date");
  if (leaseTermMonths === null) errors.push("lease term");
  if (!isAdultDob(dob)) errors.push("date of birth (applicants must be 18+)");
  if (idType === null || !isValidIdNumber(idType, idNumber)) errors.push("SSN or passport number");
  if (childrenUnder11 !== true && childrenUnder11 !== false) errors.push("children 10 or younger");
  if (employmentStatus === null) errors.push("working or student");

  // The work-or-school branch: an employer and an income for one answer, a
  // school record for the other. Only the branch that was chosen is required,
  // stored, or even read.
  const incomeNote = cleanLine(body.income_note, 300);
  let currentEmployer = null;
  let employmentHistory = [];
  let student = null;

  if (employmentStatus === "employed") {
    const currentEmployerRaw = typeof body.current_employer === "object" && body.current_employer !== null
      ? body.current_employer
      : {};
    currentEmployer = {
      employer: cleanLine(currentEmployerRaw.employer, 160),
      position: cleanLine(currentEmployerRaw.position, 120),
      start: cleanLine(currentEmployerRaw.start, 20),
      supervisor_name: cleanLine(currentEmployerRaw.supervisor_name, 120),
      supervisor_phone: phoneField()(currentEmployerRaw.supervisor_phone),
      supervisor_email: emailField()(currentEmployerRaw.supervisor_email)
    };
    if (!currentEmployer.employer) errors.push("current employer");
    if (!currentEmployer.position) errors.push("position");
    if (!currentEmployer.start) errors.push("employed since");
    if (!incomeNote) errors.push("annual income");
    if (!currentEmployer.supervisor_name) errors.push("supervisor name");
    if (!currentEmployer.supervisor_phone) errors.push("supervisor phone");
    if (!currentEmployer.supervisor_email) errors.push("supervisor email");

    employmentHistory = shapeEntries(
      body.employment_history, EMPLOYMENT_SPEC,
      ["employer", "position", "start", "income"], "previous employment", errors
    );
  } else if (employmentStatus === "student") {
    student = shapeStudent(body.student, errors);
  }

  // A landlord record needs a way to be reached, but one way is enough:
  // a phone or an email, whichever the applicant has.
  const rentalHistory = shapeEntries(
    body.rental_history, RENTAL_SPEC,
    ["landlord_name", "contact", "address", "start", "monthly_rent"],
    "rental history", errors
  );
  if (rentalHistory.some((entry) => !entry.landlord_phone && !entry.landlord_email)) {
    errors.push("rental history (a phone or an email for each landlord)");
  }
  const referenceContacts = shapeEntries(
    body.reference_contacts, PERSON_SPEC,
    ["name", "relationship", "phone", "email"], "references", errors
  );
  const emergencyContacts = shapeEntries(
    body.emergency_contacts, PERSON_SPEC,
    ["name", "relationship", "phone", "email"], "emergency contacts", errors
  );
  const roommates = shapeEntries(
    body.roommates, ROOMMATE_SPEC,
    ["first_name", "last_name", "phone", "email"], "roommates", errors
  );
  const pets = shapeEntries(body.pets, PET_SPEC, ["type", "species", "weight"], "pets", errors);

  if (rentalHistory.length < 1) errors.push("rental history (your current home)");
  if (referenceContacts.length < REFERENCES_REQUIRED) {
    errors.push(`references (${REFERENCES_REQUIRED} are required)`);
  }
  if (emergencyContacts.length < 1) errors.push("emergency contacts (one is required)");

  if (errors.length > 0) {
    return json({ error: `Please check ${[...new Set(errors)].join(", ")}.` }, 422);
  }

  // Human verification is enforced whenever the secret is configured; a
  // missing or bad token is rejected rather than let through.
  if (env.TURNSTILE_SECRET_KEY) {
    const passed = await verifyTurnstile(
      env,
      String(body.turnstile_token ?? ""),
      request.headers.get("CF-Connecting-IP")
    );
    if (!passed) {
      return json({ error: "Human verification failed. Please refresh the page and try again." }, 403);
    }
  }

  let listing;
  try {
    listing = await fetchListing(env, listingId, { publishedOnly: true });
  } catch (error) {
    console.error("Application listing lookup failed", error);
    return json({ error: "Applications are temporarily unavailable. Please try again shortly." }, 503);
  }

  if (!listing) {
    return json({ error: "This property is no longer listed." }, 404);
  }

  const fullName = `${firstName} ${lastName}`.trim();

  try {
    await insertApplication(env, {
      listing_id: listingId,
      name: fullName,
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      current_address: currentAddress,
      move_in: moveIn,
      lease_term_months: leaseTermMonths,
      dob,
      id_type: idType,
      ssn_encrypted: await encryptSsn(env, idNumber),
      ssn_last4: idNumber.slice(-4),
      children_under_11: childrenUnder11,
      wants_window_guards: wantsWindowGuards,
      employment_status: employmentStatus,
      income_note: incomeNote || null,
      current_employer: currentEmployer,
      student,
      employment_history: employmentHistory.length > 0 ? employmentHistory : null,
      rental_history: rentalHistory.length > 0 ? rentalHistory : null,
      reference_contacts: referenceContacts,
      emergency_contacts: emergencyContacts.length > 0 ? emergencyContacts : null,
      roommates: roommates.length > 0 ? roommates : null,
      pets: pets.length > 0 ? pets : null,
      message: cleanMultiline(body.message, 2000) || null
    });
  } catch (error) {
    console.error("Application insert failed:", withoutRowValues(error?.message));
    return json({ error: "The application could not be saved. Please try again." }, 500);
  }

  ctx.waitUntil(sendNotification(request, env, listing, fullName));
  ctx.waitUntil(sendReceipt(request, env, listing, email, employmentStatus));
  return json({ ok: true }, 201);
}
