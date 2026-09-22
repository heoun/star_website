import type { WorkspaceApplication, WorkspacePrincipal, WorkspaceRepository } from "../../contracts/workspace.ts";

// A strict adapter: missing authorization columns are an unavailable workspace,
// never a reason to retry an unscoped legacy query. No request state is cached.
const columns = `id,listing_id,name,first_name,last_name,email,phone,current_address,move_in,lease_term_months,dob,ssn_last4,children_under_11,income_note,current_employer,employment_history,rental_history,reference_contacts,emergency_contacts,pets,message,status,notes,created_at,updated_at,employment_status,id_type,student,wants_window_guards,roommates,submitted,concession_terms,decision,lease_snapshot,responsible_email,collaborator_emails,workspace_version,workspace,listings(id,building_id,title,property_name,unit,price_amount),application_documents(id,doc_type,file_name,content_type,size_bytes,created_at)`;
const quoted = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
export function makeWorkspaceRepository(config: { url: string; key: string }): WorkspaceRepository {
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${config.url.replace(/\/$/, "")}/rest/v1/${path}`, {
      ...init, headers: { apikey: config.key, Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json", ...init.headers }
    });
    if (!response.ok) {
      const raw = await response.text();
      const missing = /42703|PGRST20[024]|42883|42P01/.test(raw);
      const error = new Error(missing
        ? "Workspace setup is required. Apply supabase/workspace.sql after schema.sql and backoffice.sql."
        : "Workspace data could not be saved. Refresh and try again.");
      Object.assign(error, { status: missing ? 503 : response.status === 409 ? 409 : 500 });
      throw error;
    }
    return response.json();
  }
  async function get(id: string): Promise<WorkspaceApplication | null> {
    const query = new URLSearchParams({ select: columns, id: `eq.${id}` });
    return (await request(`applications?${query}`))[0] || null;
  }
  return {
    get,
    async list(p: WorkspacePrincipal) {
      const query = new URLSearchParams({ select: columns, order: "created_at.desc,id.asc" });
      if (p.role === "agent") {
        const person = quoted(p.email.toLowerCase());
        query.set("or", `(responsible_email.eq.${person},collaborator_emails.cs.{${person}})`);
      } else if (p.role === "landlord") {
        if (!p.property_ids?.length) return [];
        query.set("select", columns.replace("listings(", "listings!inner("));
        query.set("listings.building_id", `in.(${p.property_ids.join(",")})`);
        query.set("workspace->recommendation->>landlord_email", `eq.${quoted(p.email.toLowerCase())}`);
        query.set("status", "in.(sent_to_landlord,landlord_approved,lease_sent,lease_signed)");
      }
      // PostgREST caps responses. Explicit paging avoids silently losing older
      // assigned cases; details and all mutations re-check the current row.
      const rows: WorkspaceApplication[] = [];
      const size = 200;
      for (let offset = 0; ; offset += size) {
        query.set("limit", String(size)); query.set("offset", String(offset));
        const page = await request(`applications?${query}`) as WorkspaceApplication[];
        rows.push(...page);
        if (page.length < size) break;
      }
      return rows;
    },
    async save(id, expectedVersion, patch, actor) {
      const rows = await request("rpc/update_application_workspace", { method: "POST",
        body: JSON.stringify({ p_id: id, p_version: expectedVersion, p_patch: patch, p_actor: actor }) });
      return rows?.length ? get(id) : null;
    },
    async staff() { return request("staff?select=email,role,active,property_ids&order=email.asc"); }
  };
}
