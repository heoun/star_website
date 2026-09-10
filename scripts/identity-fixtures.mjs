// Isolated identity transport for HTTP and browser regression tests.
// No credentials, real email, or live Supabase requests.
import { createWorkspaceFixtures } from "../backend/tools/workspace-fixtures.mjs";
export function createIdentityFixture() {
const fixture = createWorkspaceFixtures();
const owner = "platform-owner@example.test";
const env = { ...fixture.env, DEV_ADMIN_EMAIL: "", SUPABASE_PUBLISHABLE_KEY: "public-test-key", OWNER_EMAIL: owner, OWNER_AUTH_USER_ID: "owner-id" };
const users = new Map(), tokens = new Map(), codes = new Map(), requests = [], revokedRefresh = new Set();
const user = (email, id = crypto.randomUUID()) => {
  const row = { id, email, email_confirmed_at: "2026-09-01T00:00:00Z", password: "testing-password", user_metadata: {role: "manager", owner: true} };
  users.set(email, row); return row;
};
for (const row of fixture.state.staff) user(row.email);
user(owner, "owner-id"); user("applicant@example.test");
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const issue = row => {
  const token = crypto.randomUUID(); tokens.set(token, row); revokedRefresh.delete(`refresh:${row.email}`);
  return { user: row, access_token: token, refresh_token: `refresh:${row.email}` };
};
const controls = { failMail: false };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input), body = init.body ? JSON.parse(init.body) : {}, token = new Headers(init.headers).get("Authorization")?.replace("Bearer ", "");
  requests.push(url.pathname);
  if (url.pathname === "/auth/v1/token") {
    const row = url.searchParams.get("grant_type") === "refresh_token" ? users.get(body.refresh_token?.replace("refresh:", "")) : users.get(body.email);
    return row && !revokedRefresh.has(body.refresh_token) && (body.refresh_token || row.password === body.password) ? reply(issue(row)) : reply({message:"Invalid login credentials"},401);
  }
  if (url.pathname === "/auth/v1/user") {
    const row = tokens.get(token); if (!row) return reply({},401);
    if (init.method === "PUT") row.password = body.password;
    return reply(row);
  }
  if (url.pathname === "/auth/v1/otp" || url.pathname === "/auth/v1/recover") {
    if (controls.failMail) return reply({},429);
    if (!users.has(body.email)) user(body.email);
    codes.set(body.email,"123456"); return reply({});
  }
  if (url.pathname === "/auth/v1/verify") {
    if (!codes.has(body.email) || codes.get(body.email) !== body.token) return reply({},401);
    codes.delete(body.email); return reply(issue(users.get(body.email)));
  }
  if (url.pathname === "/auth/v1/logout") { const row = tokens.get(token); if (row) revokedRefresh.add(`refresh:${row.email}`); tokens.delete(token); return reply({}); }
  if (url.pathname === "/rest/v1/rpc/bind_staff_identity") {
    const row = fixture.state.staff.find(s=>s.email===body.p_email), account = users.get(body.p_email);
    if (!row?.active || !account?.email_confirmed_at || account.id !== body.p_user_id || row.auth_user_id && row.auth_user_id !== body.p_user_id) return reply(false);
    row.auth_user_id = body.p_user_id; return reply(true);
  }
  return fixture.fetch(input, init);
};
return { fixture, env, users, tokens, codes, requests, controls, user, restore: () => { globalThis.fetch = originalFetch; } };
}
