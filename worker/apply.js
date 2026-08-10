import { fetchListing, insertApplication } from "./supabase.js";
import { encryptionReady, encryptSsn } from "./ssn.js";

const CONTACT_EMAIL = "info@starreusa.com";
const FROM_ADDRESS = "Star Real Estate Website <no-reply@starreusa.com>";
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const TURNSTILE_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PET_TYPES = ["dog", "cat", "other"];
const MAX_ENTRIES = 10;

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

const EMPLOYMENT_SPEC = {
  employer: line(160),
  position: line(120),
  start: line(20),
  end: line(20),
  supervisor_name: line(120),
  supervisor_phone: phoneField(),
  supervisor_email: emailField()
};

const RENTAL_SPEC = {
  address: line(300),
  start: line(20),
  end: line(20),
  monthly_rent: line(30),
  landlord_name: line(120),
  landlord_phone: phoneField(),
  landlord_email: emailField()
};

const PET_SPEC = {
  type: (value) => (PET_TYPES.includes(String(value ?? "").trim().toLowerCase()) ? String(value).trim().toLowerCase() : ""),
  species: line(80),
  weight: line(20)
};

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
async function sendNotification(env, listing, name) {
  const home = [listing.building_name, listing.unit].filter(Boolean).join(" ");
  const label = home ? `${listing.title} (${home})` : listing.title;

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [CONTACT_EMAIL],
        subject: `New rental application: ${label}`,
        text: `${name} submitted an application for ${label}.\n\nReview it in the admin console: https://starreusa.com/admin/\n`
      })
    });

    if (!response.ok) {
      console.error("Application notification failed", response.status, await response.text());
    }
  } catch (error) {
    console.error("Application notification failed", error);
  }
}

export async function handleApplication(request, env, ctx) {
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

  const listingId = String(body.listing_id ?? "").trim();
  if (!UUID_PATTERN.test(listingId)) {
    return json({ error: "Unknown property." }, 400);
  }

  const errors = [];

  const firstName = cleanLine(body.first_name, 80);
  const lastName = cleanLine(body.last_name, 80);
  const email = cleanLine(body.email, 180);
  const phone = cleanLine(body.phone, 30);
  const currentAddress = cleanLine(body.current_address, 300);
  const moveIn = cleanLine(body.move_in, 10);
  const leaseTermMonths = parseIntInRange(body.lease_term_months, 1, 60);
  const dob = cleanLine(body.dob, 10);
  const ssnDigits = String(body.ssn ?? "").replace(/\D/g, "");
  const householdSize = parseIntInRange(body.household_size, 1, 20);
  const childrenUnder11 = body.children_under_11;
  const incomeNote = cleanLine(body.income_note, 300);

  if (!firstName) errors.push("first name");
  if (!lastName) errors.push("last name");
  if (!isValidEmail(email)) errors.push("email");
  if (!phone || !isValidPhone(phone)) errors.push("phone");
  if (!currentAddress) errors.push("current address");
  if (!isRealDate(moveIn)) errors.push("move-in date");
  if (leaseTermMonths === null) errors.push("lease term");
  if (!isAdultDob(dob)) errors.push("date of birth (applicants must be 18+)");
  if (!/^\d{9}$/.test(ssnDigits) || /^(\d)\1{8}$/.test(ssnDigits)) errors.push("SSN");
  if (householdSize === null) errors.push("household size");
  if (childrenUnder11 !== true && childrenUnder11 !== false) errors.push("children under 11");
  if (!incomeNote) errors.push("annual income");

  const currentEmployerRaw = typeof body.current_employer === "object" && body.current_employer !== null
    ? body.current_employer
    : {};
  const currentEmployer = {
    employer: cleanLine(currentEmployerRaw.employer, 160),
    position: cleanLine(currentEmployerRaw.position, 120),
    start: cleanLine(currentEmployerRaw.start, 20),
    supervisor_name: cleanLine(currentEmployerRaw.supervisor_name, 120),
    supervisor_phone: phoneField()(currentEmployerRaw.supervisor_phone),
    supervisor_email: emailField()(currentEmployerRaw.supervisor_email)
  };
  if (!currentEmployer.employer) errors.push("current employer");
  if (currentEmployer.supervisor_phone === null || currentEmployer.supervisor_email === null) {
    errors.push("current employer contact");
  }

  const employmentHistory = shapeEntries(
    body.employment_history, EMPLOYMENT_SPEC, ["employer"], "employment history", errors
  );
  const rentalHistory = shapeEntries(
    body.rental_history, RENTAL_SPEC, ["address"], "rental history", errors
  );
  const referenceContacts = shapeEntries(
    body.reference_contacts, PERSON_SPEC, ["name"], "references", errors
  );
  const emergencyContacts = shapeEntries(
    body.emergency_contacts, PERSON_SPEC, ["name"], "emergency contact", errors
  );
  const pets = shapeEntries(body.pets, PET_SPEC, ["type"], "pets", errors);

  if (referenceContacts.length < 3) errors.push("references (3 are required)");
  if (referenceContacts.some((ref) => !ref.phone && !ref.email)) {
    errors.push("references (each needs a phone or email)");
  }
  if (emergencyContacts.length < 1) errors.push("emergency contact");
  if (emergencyContacts.some((contact) => !contact.phone)) {
    errors.push("emergency contact phone");
  }

  if (errors.length > 0) {
    return json({ error: `Please check these fields: ${[...new Set(errors)].join(", ")}.` }, 422);
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
      ssn_encrypted: await encryptSsn(env, ssnDigits),
      ssn_last4: ssnDigits.slice(-4),
      household_size: householdSize,
      children_under_11: childrenUnder11,
      income_note: incomeNote,
      current_employer: currentEmployer,
      employment_history: employmentHistory.length > 0 ? employmentHistory : null,
      rental_history: rentalHistory.length > 0 ? rentalHistory : null,
      reference_contacts: referenceContacts,
      emergency_contacts: emergencyContacts,
      pets: pets.length > 0 ? pets : null,
      message: cleanMultiline(body.message, 2000) || null
    });
  } catch (error) {
    console.error("Application insert failed", error);
    return json({ error: "The application could not be saved. Please try again." }, 500);
  }

  ctx.waitUntil(sendNotification(env, listing, fullName));
  return json({ ok: true }, 201);
}
