import {workspaceInvitationStates} from './workspace-invitation-state.js';
import {accountSecurityEnabled,recentMfa,identityRequest} from "./account-security.js";
import {readSession,sameOriginMutation} from "./auth.js";
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
    if(accountSecurityEnabled(env) && !['GET','HEAD'].includes(request.method) && !recentMfa(identity))return json({error:'Verify your authenticator again before changing account access.',code:'mfa_required'},403);
    const { accounts, onboarding } = administrationFor(requireConfig(env), env, request, identity);
    if (resource === "staff") {
      if (!id && request.method === "GET") {
        const directory = await accounts.list(identity);
        if (accountSecurityEnabled(env)) {
          const states = await workspaceInvitationStates(env, directory.staff.map(member => member.email));
          directory.staff = directory.staff.map(member => ({...member, invitation_state: states.get(member.email)}));
        }
        return json(directory);
      }
      if (id && subresource === "history" && request.method === "GET") return json({ history: await accounts.history(identity, decodeURIComponent(id)) });
      if (!id && request.method === "PUT") {
        const command = { ...await bodyOf(request), action: "save" };
        const member = await accounts.execute(identity, command);
        return json({ member, ...(command.version === -1 && member.active ? { invitation: await inviteWorkspaceAccount(request, env, member.email) } : {}) });
      }
      if(accountSecurityEnabled(env) && id && subresource==='revoke-invitation' && request.method==='POST') {
        const {staff}=await accounts.list(identity);
        const member=staff.find(person=>person.email===decodeURIComponent(id).toLowerCase());
        if(!member?.allowed_actions.includes('save'))return json({error:'You cannot revoke this invitation.'},403);
        const state = (await workspaceInvitationStates(env, [member.email])).get(member.email);
        if(state.activated || !state.pending)return json({error:'There is no pending invitation to revoke.'},409);
        await identityRequest(env,`workspace_invitations?email=eq.${encodeURIComponent(member.email)}&accepted_at=is.null`,{method:'PATCH',body:{revoked_at:new Date().toISOString()}});
        return json({ok:true});
      }
      if (id && subresource === "invite" && request.method === "POST") {
        const { staff } = await accounts.list(identity);
        const member = staff.find(person => person.email === decodeURIComponent(id).toLowerCase());
        if (!member?.active || !member.allowed_actions.includes("save")) return json({ error: "You cannot invite this account." }, 403);
        if(accountSecurityEnabled(env) && (await workspaceInvitationStates(env,[member.email])).get(member.email).activated)
          return json({error:'This account is already activated. Use password recovery if needed.'},409);
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
        return json({ invitation, ...(!accountSecurityEnabled(env) && command.action === "approve" ? { account_invitation: await inviteWorkspaceAccount(request, env, invitation.email) } : {}) });
      }
    }
    return json({ error: "Unknown administration endpoint." }, 404);
  } catch (error) { return errorResponse(error); }
}
export async function handlePublicOnboarding(request, env) {
  try {
    if(!sameOriginMutation(request))return json({error:"Use this website to submit the form."},403);
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("Authorization") || "")?.[1] || "";
    const { onboarding } = administrationFor(requireConfig(env), env, request);
    if(accountSecurityEnabled(env)) {
      const session=await readSession(request,env,'workspace');
      if(!session)return json({error:'Sign in or register with the invited email before completing this form.',code:'sign_in_required'},401);
      const invitation=await onboarding.readPublic(token);
      if(session.email!==invitation.email)return json({error:'This invitation belongs to another account.'},403);
      const [member]=await identityRequest(env,`staff?email=eq.${encodeURIComponent(session.email)}&select=active,user_id,role,access_state`);
      if(!member?.active||member.role!=='landlord'||member.user_id!==session.user_id||member.access_state!=='active')return json({error:'Accept your landlord invitation before continuing.',code:'invitation_required'},403);
      const response=request.method==='GET'?json({invitation}):request.method==='POST'?json({invitation:await onboarding.submit(token,await bodyOf(request))}):json({error:'Method not allowed.'},405);
      if(session.setCookie)response.headers.append('Set-Cookie',session.setCookie);
      return response;
    }
    if (request.method === "GET") return json({ invitation: await onboarding.readPublic(token) });
    if (request.method === "POST") return json({ invitation: await onboarding.submit(token, await bodyOf(request)) });
    return json({ error: "Method not allowed." }, 405);
  } catch (error) { return errorResponse(error); }
}
