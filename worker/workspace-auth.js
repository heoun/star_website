// Invitation and activation adapter. The directory is the allowlist; email
// verification alone never grants a role, and user metadata is never trusted.
import { authRequest, signedIn, cleanEmail, validPassword, sameOriginMutation } from "./auth.js";
import { fetchStaffMember } from "./supabase.js";
import { resolveStaff } from "./staff.js";
import { isLocalRequest } from "./env.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
async function eligible(env, email) {
  if (email === String(env.OWNER_EMAIL || "").trim().toLowerCase()) return !!env.OWNER_AUTH_USER_ID;
  return (await fetchStaffMember(env, email))?.active === true;
}

export async function inviteWorkspaceAccount(request, env, email) {
  // Local role demos never trigger Supabase's real email service.
  if (isLocalRequest(request) && env.DEV_REAL_EMAIL !== "true") return { status: "preview" };
  try {
    if (!await eligible(env, email)) return { status: "failed" };
    const result = await authRequest(env, "otp", { body: { email, create_user: true } });
    return { status: result.ok ? "sent" : "failed" };
  } catch { return { status: "failed" }; }
}

export async function handleWorkspaceAuth(request, env, resource) {
  if (!sameOriginMutation(request)) return json({ error: "Use this website to submit the form." }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "Send this form as JSON." }, 415);
  try {
    const reader = request.body?.getReader(); let size = 0; const parts = [];
    if (reader) for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 16384) { await reader.cancel(); return json({ error: "This form is too large." }, 413); }
      parts.push(value);
    }
    let body;
    try { body = JSON.parse(await new Blob(parts).text()); } catch { return json({ error: "Invalid form data." }, 400); }
    const email = cleanEmail(body?.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter your email address." }, 422);
    if (resource === "workspace-code") {
      if (await eligible(env, email)) {
        const delivery = await inviteWorkspaceAccount(request, env, email);
        if (delivery.status === "failed") return json({ error: "A code could not be sent. Please try again shortly." }, 503);
        if (delivery.status === "preview") return json({ error: "Email activation is disabled in the local role demo. Use Demo roles to preview accounts." }, 409);
      }
      return json({ ok: true, message: "If this email has workspace access, a code is on its way." });
    }
    const code = String(body?.code || "");
    if (!/^\d{6,8}$/.test(code) || !validPassword(body?.password)) return json({ error: "Enter the email code and a password of at least 8 characters." }, 422);
    if (!await eligible(env, email)) return json({ error: "The invitation is unavailable. Contact your account administrator." }, 403);
    const result = await authRequest(env, "verify", { body: { type: "email", email, token: code } });
    const session = result.payload;
    if (!result.ok || !session?.access_token || !session.user?.email_confirmed_at || cleanEmail(session.user.email) !== email) {
      return json({ error: "This code is invalid or expired. Request a new one." }, 401);
    }
    const resolved = await resolveStaff(env, { email, subject: session.user.id });
    if (!resolved.identity) return json({ error: resolved.error }, resolved.status || 403);
    const updated = await authRequest(env, "user", { method: "PUT", token: session.access_token, body: { password: body.password } });
    if (!updated.ok) return json({ error: "The password could not be saved. Request a new code and try again." }, 400);
    return signedIn(request, session);
  } catch { return json({ error: "Account activation is temporarily unavailable." }, 503); }
}
