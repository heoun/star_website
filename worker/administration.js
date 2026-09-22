import { inviteWorkspaceAccount } from "./workspace-auth.js";
import { administrationFor } from "../backend/app/administration.ts";
import { requireConfig } from "./supabase.js";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: {
  "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"
} });
async function bodyOf(request) {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw Object.assign(new Error("Send this form as JSON."), { status: 415 });
  const reader = request.body?.getReader(); let total = 0, text = ""; const decoder = new TextDecoder();
  if (!reader) throw Object.assign(new Error("A form is required."), { status: 400 });
  for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length;
    if (total > 128000) { await reader.cancel(); throw Object.assign(new Error("This form is too large."), { status: 413 }); }
    text += decoder.decode(value, { stream: true });
  }
  const body = JSON.parse(text + decoder.decode());
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SyntaxError();
  return body;
}
const errorResponse = error => json({ error: error instanceof SyntaxError ? "Invalid form data." : error.status ? error.message : "This request could not be completed. Please try again." }, error instanceof SyntaxError ? 400 : error.status || 500);
export async function handleAdministration(request, env, identity, resource, id, subresource) {
  if (identity.role !== "manager") return json({ error: "Only Admin can access account management and landlord onboarding." }, 403);
  try {
    const { accounts, onboarding } = administrationFor(requireConfig(env), env, request);
    if (resource === "staff") {
      if (!id && request.method === "GET") return json(await accounts.list(identity));
      if (id && subresource === "history" && request.method === "GET") return json({ history: await accounts.history(identity, decodeURIComponent(id)) });
      if (!id && request.method === "PUT") {
        const command = { ...await bodyOf(request), action: "save" };
        const member = await accounts.execute(identity, command);
        return json({ member, ...(command.version === -1 && member.active ? { invitation: await inviteWorkspaceAccount(request, env, member.email) } : {}) });
      }
      if (id && subresource === "invite" && request.method === "POST") {
        const { staff } = await accounts.list(identity);
        const member = staff.find(person => person.email === decodeURIComponent(id).toLowerCase());
        if (!member?.active || !member.allowed_actions.includes("save")) return json({ error: "You cannot invite this account." }, 403);
        return json({ invitation: await inviteWorkspaceAccount(request, env, member.email) });
      }
      if (id && subresource === "actions" && request.method === "POST") {
        const command = { ...await bodyOf(request), email: decodeURIComponent(id) };
        const member = await accounts.execute(identity, command);
        return json({ member, ...(command.action === "create_admin" ? { invitation: await inviteWorkspaceAccount(request, env, member.email) } : {}) });
      }
      if (request.method === "DELETE") return json({ error: "Suspend an account to preserve its history. Accounts are not deleted." }, 409);
    }
    if (resource === "onboarding") {
      if (!id && request.method === "GET") return json({ invitations: await onboarding.list(identity) });
      if (!id && request.method === "POST") return json({ invitation: await onboarding.invite(identity, await bodyOf(request)) }, 201);
      if (id && !subresource && request.method === "GET") return json({ invitation: await onboarding.get(identity, id) });
      if (id && subresource === "actions" && request.method === "POST") {
        const command = await bodyOf(request);
        const invitation = await onboarding.act(identity, id, command);
        return json({ invitation, ...(command.action === "approve" ? { account_invitation: await inviteWorkspaceAccount(request, env, invitation.email) } : {}) });
      }
    }
    return json({ error: "Unknown administration endpoint." }, 404);
  } catch (error) { return errorResponse(error); }
}
export async function handlePublicOnboarding(request, env) {
  try {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("Authorization") || "")?.[1] || "";
    const { onboarding } = administrationFor(requireConfig(env), env, request);
    if (request.method === "GET") return json({ invitation: await onboarding.readPublic(token) });
    if (request.method === "POST") return json({ invitation: await onboarding.submit(token, await bodyOf(request)) });
    return json({ error: "Method not allowed." }, 405);
  } catch (error) { return errorResponse(error); }
}
