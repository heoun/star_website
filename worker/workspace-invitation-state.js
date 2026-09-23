import {identityRequest} from './account-security.js';

// Workspace identities only: an applicant with the same email is unrelated.
export async function workspaceInvitationStates(env, emails) {
  const states = new Map();
  for (let offset = 0; offset < emails.length; offset += 100) {
    const filter = encodeURIComponent(`in.(${emails.slice(offset, offset + 100).map(email => `"${email.replaceAll('"', '\\"')}"`).join(',')})`);
    const [users, members, invitations] = await Promise.all([
      identityRequest(env, `app_users?realm=eq.workspace&email=${filter}&select=id,email,password_setup_required`),
      identityRequest(env, `staff?email=${filter}&select=email,user_id,access_state`),
      identityRequest(env, `workspace_invitations?email=${filter}&select=email,accepted_at,revoked_at,expires_at`)
    ]);
    for (const email of emails.slice(offset, offset + 100)) {
      const user = users.find(row => row.email === email), member = members.find(row => row.email === email);
      const activated = !!user && member?.user_id === user.id && member?.access_state === 'active' && user.password_setup_required === false;
      const pending = !activated && invitations.some(row => row.email === email && !row.accepted_at && !row.revoked_at && Date.parse(row.expires_at) > Date.now());
      states.set(email, {activated, pending});
    }
  }
  return states;
}
