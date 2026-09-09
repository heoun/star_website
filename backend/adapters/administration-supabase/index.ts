import type { AccountRepository, OnboardingRepository } from "../../contracts/administration.ts";
export function makeAdministrationRepositories(config: { url: string; key: string }) {
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${config.url.replace(/\/$/, "")}/rest/v1/${path}`, { ...init, headers: {
      apikey: config.key, Authorization: `Bearer ${config.key}`, "Content-Type": "application/json", Prefer: "return=representation", ...init.headers
    } });
    if (!response.ok) {
      const info = await response.json().catch(() => ({})) as { code?: string; message?: string };
      const missing = ["42703", "42P01", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(info.code || "");
      const message = missing ? "Administration setup is required. Apply supabase/administration.sql after the workspace migration."
        : info.code === "P0001" ? info.message || "The record changed. Refresh before saving."
        : info.code === "23505" ? "An account or property with these details already exists. Review it before continuing."
        : "Administration data could not be saved. Refresh and try again.";
      throw Object.assign(new Error(message), { status: missing ? 503 : /Only|cannot be changed|cannot be switched/.test(message) ? 403 : ["23505", "P0001"].includes(info.code || "") ? 409 : 500 });
    }
    return response.status === 204 ? null : response.json();
  }
  const rpc = (name: string, data: unknown) => request(`rpc/${name}`, { method: "POST", body: JSON.stringify(data) });
  async function all(table: string, params: Record<string,string>) {
    const result = []; const size = 200;
    for (let offset = 0; ; offset += size) {
      const page = await request(`${table}?${new URLSearchParams({ ...params, limit: String(size), offset: String(offset) })}`);
      result.push(...page); if (page.length < size) return result;
    }
  }
  const accountColumns = "email,name,role,active,property_ids,account_version,created_at,updated_at";
  const account = async (email: string) => (await request(`staff?${new URLSearchParams({ select: accountColumns, email: `eq.${email}` })}`))[0] || null;
  const accounts: AccountRepository = {
    list: () => all("staff", { select: accountColumns, order: "email.asc" }),
    history: email => all("account_access_audit", { select: "*", email: `eq.${email}`, order: "created_at.desc,id.asc" }),
    save: (actor, owner, c) => rpc("manage_workspace_account", { p_actor: actor, p_owner_email: owner, p_email: c.email, p_version: c.version, p_action: c.action, p_data: c, p_reason: c.reason || "" })
  };
  const onboarding: OnboardingRepository = {
    list: () => all("landlord_onboarding", { select: "*", order: "created_at.desc,id.asc" }),
    get: async id => (await request(`landlord_onboarding?${new URLSearchParams({ select: "*", id: `eq.${id}` })}`))[0] || null,
    byToken: async hash => (await request(`landlord_onboarding?${new URLSearchParams({ select: "*", token_hash: `eq.${hash}` })}`))[0] || null,
    create: async row => (await request("landlord_onboarding?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(row) })).length === 1,
    save: async (id, version, patch) => (await rpc("update_landlord_onboarding", { p_id: id, p_version: version, p_patch: patch }))[0] || null,
    delivery: async (id, hash, state) => { await request(`landlord_onboarding?${new URLSearchParams({ id: `eq.${id}`, token_hash: `eq.${hash}` })}`, { method: "PATCH", body: JSON.stringify({ email_state: state }) }); },
    approve: (id, version, actor, owner) => rpc("approve_landlord_onboarding", { p_id: id, p_version: version, p_actor: actor, p_owner_email: owner }),
    account
  };
  return { accounts, onboarding };
}
