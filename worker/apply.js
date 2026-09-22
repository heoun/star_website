import { fetchListing, insertApplication } from "./supabase.js";
import { encryptionReady, encryptSsn } from "./ssn.js";
import { sendEmail } from "./email.js";
import { readSession } from "./portal.js";
import { renderPage } from "./contact.js";
import { rentalMode, rentalApplyOptions, submitRental, rentalWorkflow, runRentalAutomation, findOpenInvitation, groupHasRoom } from "./rentals.js";
import { householdCapacity, capacityMessage } from "../backend/app/rentals.ts";
import { submitTestApplication, markTestMembers, internalTestParticipant, internalTestListing, internalTestInboxes, invitedTestRun } from './internal-testing.js';
import { rentalDraft, saveRentalDraft, submitDraftApplication, recordDraftDelivery } from './rental-drafts.js';
import { MAIL_FROM, mailPlace, invitationMail } from "./mail-layout.js";

const CONTACT_EMAIL = "info@starreusa.com";
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
  const label = mailPlace(listing, listing.title);

  const sent = await sendEmail(request, env, {
    from: MAIL_FROM,
    to: [CONTACT_EMAIL],
    subject: `New rental application: ${label}`,
    text: `${name} submitted an application for ${label}.\n\nReview it in the admin console: https://starreusa.com/admin/\n`
  });

  if (!sent) {
    console.error("Application notification failed for", label);
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

  // One lease signer per bedroom: the applicant and one roommate in a
  // two-bedroom home, nobody else in a studio.
  const cap = householdCapacity(listing) - 1;

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

  // The same card the lead's landlord will get later, addressed to the
  // roommate; the greeting uses the typed name only when it looks like one,
  // since this mail goes to an address its owner never gave us directly.
  const place = mailPlace(listing, listing.title);
  const label = place;
  // The link names the invited address, so the form can tell an invitee
  // from whoever else is signed in on that browser.
  const linkFor = (mate) => {
    const link = new URL("/apply/", env.SITE_ORIGIN || request.url);
    link.searchParams.set("id", listingId);
    link.searchParams.set("invited", mate.email);
    if (draft) {
      link.searchParams.set("group", draft.id);
      link.searchParams.set("invite", `${draft.id}.${draft.invitations.find(i=>i.email===mate.email.toLowerCase()).id}`);
    }
    return link.toString();
  };
  const runId = String(body.test_run_id ?? "").trim();
  const test = UUID_PATTERN.test(runId) && internalTestParticipant(env, request, session)
    && internalTestListing(env, listingId) ? runId : "";
  let draft=null;
  if(rentalMode(env)) {
    try {draft=await saveRentalDraft(env,request,session,listingId,test || body.draft_group_id || crypto.randomUUID(),roommates,test);}
    catch(error){return withSession(json({error:error.message},error.status || 503));}
  }
  const greetName = (value) => (/^[\p{L}][\p{L}' .-]{0,39}$/u.test(value) ? value : "");

  const outcomes = await Promise.all(roommates.map(async (mate) => ({
    email: mate.email,
    delivered: await sendEmail(request, env, {
      from: MAIL_FROM,
      to: [mate.email],
      ...invitationMail(env, {
        place, inviter: session.email, link: linkFor(mate), test,
        invitee: { name: greetName(mate.first_name), email: mate.email }
      })
    })
  })));

  // Per address, not all or nothing: the ones that went out stay sent, and
  // the answer says which are which, so nobody is mailed twice on a retry.
  const sent = outcomes.filter((outcome) => outcome.delivered).map((outcome) => outcome.email);
  const failedInvites = outcomes.filter((outcome) => !outcome.delivered).map((outcome) => outcome.email);

  if(draft && sent.length) {try{await recordDraftDelivery(env,draft.id,sent);}catch{console.error('Invitation delivery status requires retry');}}

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

  const response = await processApplication(request, env, ctx, body, session.email, session);

  // Supabase rotates refresh tokens: a session that was refreshed while this
  // submit was validated has to reach the browser, or the applicant is
  // quietly signed out a request later.
  if (session.setCookie) {
    response.headers.append("Set-Cookie", session.setCookie);
  }
  return response;
}

async function processApplication(request, env, ctx, body, email, session) {
  // A second tab can replace the shared browser cookie while this form is
  // open. Never file one person's completed answers under the new account.
  for (const expected of [body.account_email, body.invited_email]) {
    if (expected && String(expected).trim().toLowerCase() !== email) {
      return json({ code: "APPLICANT_ACCOUNT_CHANGED", error: "This application belongs to a different applicant account. Open it using its own account. Your answers have not been submitted." }, 409);
    }
  }
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
  let saved;
  try {
    const automatic=rentalMode(env),capacity=householdCapacity(listing);
    if(automatic && (new Set(roommates.map(m=>m.email.toLowerCase())).size!==roommates.length || roommates.some(m=>m.email.toLowerCase()===email))) return json({error:'List each roommate once, using their own email.'},422);
    if(automatic && roommates.length+1>capacity) return json({error:capacityMessage(listing)},422);
    // A roommate answering an invitation joins the lead's group: by the link
    // they were sent, or by the address the lead named if they came without it.
    let joining=automatic ? String(body.group_invite || '') : '';
    const groupRoot=String(body.group_root || '');
    if(groupRoot && (!automatic || !UUID_PATTERN.test(groupRoot) || (joining && joining.split('.')[0]!==groupRoot))) return json({error:'This invitation link is invalid. Reopen the invitation email.'},422);
    const draftId=String(body.draft_group_id || body.test_run_id || groupRoot || joining.split('.')[0] || '');
    if((groupRoot && draftId!==groupRoot) || (body.test_run_id && draftId!==body.test_run_id))return json({error:'This invitation link does not match the application group.'},422);
    let draft=automatic ? await rentalDraft(env,draftId) : null;
    if(automatic && !draft && !joining && !body.test_run_id) joining=await findOpenInvitation(env,request,listingId,email,groupRoot);
    if(automatic && !draft && joining)draft=await rentalDraft(env,joining.split('.')[0]);
    if(body.test_run_id && (!internalTestParticipant(env,request,session) || !internalTestListing(env,listingId)))return json({error:'Internal testing is unavailable for this account or listing.'},403);
    if(body.test_run_id && roommates.some(m=>!internalTestInboxes(env).includes(m.email.toLowerCase())))return json({error:'Internal test roommates are limited to the configured test inboxes.'},422);
    const ownsDraft=!!draft && draft.owner_id===session.subject && draft.owner_email===email;
    if(draft && body.draft_group_id===draft.id && !ownsDraft)return json({error:'This application group belongs to another account.'},403);
    if(draft && ownsDraft && roommates.length && !draft.invitations.some(i=>i.role==='inviter' && i.accepted)) draft=await saveRentalDraft(env,request,session,listingId,draft.id,roommates,body.test_run_id || (draft.test_run?.id ?? ''));
    if(groupRoot && !joining && !draft) return json({error:'This invitation has not been saved. Ask the inviter to resend it from their application form.'},409);
    if(automatic && joining && !ownsDraft && roommates.length) return json({error:'Join this group first. Your agent can invite additional roommates.'},422);
    if(automatic && !draft && joining && !(await groupHasRoom(env,request,joining,capacity,email))) return json({error:capacityMessage(listing)},422);
    const agent=String(body.sales_person || '').trim().toLowerCase();
    if(automatic && agent && !(await rentalApplyOptions(env,listingId)).some(a=>a.email===agent)) return json({error:'Choose an active agent for this property.'},422);
    const parts=moveIn.split('/');
    const start=parts.length===3 ? `${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}` : moveIn;
    const end=new Date(`${start}T12:00:00Z`);end.setUTCMonth(end.getUTCMonth()+leaseTermMonths);end.setUTCDate(end.getUTCDate()-1);
    // Roommates the form already emailed from its first step arrive marked
    // sent; the rest wait for the lead applicant's fee.
    const invited=new Set((Array.isArray(body.invited_emails) ? body.invited_emails : []).map(e=>String(e).toLowerCase()));
    const invitations=automatic && !joining ? roommates.map(m=>({id:crypto.randomUUID(),email:m.email.toLowerCase(),name:`${m.first_name} ${m.last_name}`,expires:new Date(Date.now()+14*86400000).toISOString(),delivery:invited.has(m.email.toLowerCase()) ? 'sent' : 'pending'})) : [];
    const values={
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
      message: cleanMultiline(body.message, 2000) || null,
      // ready_notice enrols this application for the ready-for-review
      // confirmation, stored with the row so a retry or a roommate-first
      // join cannot lose it. Applications without it are never mailed.
      ...(automatic ? {responsible_email:agent || null,workspace:{rental_flow:'automatic',invitations,ready_notice:{status:'queued',at:new Date().toISOString()},terms:{'lease.commencement_date':start,'lease.end_date':end.toISOString().slice(0,10),'rent.monthly':String(listing.price_amount || ''),'deposit.amount':String(listing.price_amount || '')}}} : {})
    };
    if(draft) {
      if(!ownsDraft && roommates.length)return json({error:'Join this group first. Your agent can invite additional roommates.'},422);
      const result=await submitDraftApplication(env,session,values,draft,joining);saved=result.application;
      if(result.replayed)return json({ok:true,application_id:saved.id,...(saved.workspace?.test_run?{test_run_id:saved.id}:{})},200);
    } else if(body.test_run_id) {
      if(!automatic || joining)return json({error:'Test runs require an independent application.'},422);
      const result=await submitTestApplication(request,env,session,values,body.test_run_id);saved=result.application;
      if(result.replayed)return json({ok:true,application_id:saved.id,test_run_id:saved.id},200);
    } else {
      const run=joining ? await invitedTestRun(env,request,session,listingId,joining) : null;
      if(run)values.workspace.test_run=run;
      saved=automatic ? await submitRental(env,values,joining) : await insertApplication(env,values);
    }
  } catch (error) {
    console.error("Application insert failed:", withoutRowValues(error?.message));
    return json({ error: error.status ? error.message : "The application could not be saved. Please try again." }, error.status || 500);
  }

  if(rentalMode(env)) {
    const rootId=saved.rental_group_id || saved.id;
    ctx.waitUntil((async()=>{
      // A lead adopts roommates who applied before them; a roommate joining
      // an internal run inherits it. Invitations that still wait go out with
      // the reconciliation once the lead's fee is paid.
      try {if(rootId===saved.id && !saved.workspace?.invitations?.some(i=>i.role==='inviter' && !i.accepted)) await rentalWorkflow(env,request).adoptInvited(rootId);await markTestMembers(env,request,rootId);}catch{console.error('Roommate group update requires retry');}
      await runRentalAutomation(env,request,rootId);
    })());
  }
  if(!saved.workspace?.test_run)ctx.waitUntil(sendNotification(request, env, listing, fullName));
  // The applicant is not mailed on submission. The rental workflow confirms
  // them once their own fee, documents and screening are complete (enrolled
  // above as workspace.ready_notice); without that workflow there is no
  // completed-readiness step yet, so no applicant confirmation exists to send.
  return json({ ok: true, application_id:saved.id, ...(saved.workspace?.test_run?{test_run_id:saved.id}:{}) }, 201);
}
