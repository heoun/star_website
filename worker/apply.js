import { fetchListing, insertApplication } from "./supabase.js";

const CONTACT_EMAIL = "info@starreusa.com";
const FROM_ADDRESS = "Star Real Estate Website <no-reply@starreusa.com>";
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const TURNSTILE_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function parseHouseholdSize(value) {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) return null;
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

function isValidPhone(value) {
  const digits = value.replace(/\D/g, "");
  return digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
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

  const listingId = String(body.listing_id ?? "").trim();
  if (!UUID_PATTERN.test(listingId)) {
    return json({ error: "Unknown property." }, 400);
  }

  const name = cleanLine(body.name, 120);
  const email = cleanLine(body.email, 180);
  const phone = cleanLine(body.phone, 60);
  const moveIn = cleanLine(body.move_in, 10);
  const householdSize = parseHouseholdSize(body.household_size);
  const incomeNote = cleanLine(body.income_note, 300);

  const errors = [];
  if (!name) errors.push("name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("email");
  if (phone && !isValidPhone(phone)) errors.push("phone");
  if (!isRealDate(moveIn)) errors.push("move-in date");
  if (householdSize === null) errors.push("household size");
  if (!incomeNote) errors.push("annual income");
  if (errors.length > 0) {
    return json({ error: `Please check these fields: ${errors.join(", ")}.` }, 422);
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

  try {
    await insertApplication(env, {
      listing_id: listingId,
      name,
      email,
      phone: phone || null,
      move_in: moveIn,
      household_size: householdSize,
      income_note: incomeNote,
      message: cleanMultiline(body.message, 2000) || null
    });
  } catch (error) {
    console.error("Application insert failed", error);
    return json({ error: "The application could not be saved. Please try again." }, 500);
  }

  ctx.waitUntil(sendNotification(env, listing, name));
  return json({ ok: true }, 201);
}
