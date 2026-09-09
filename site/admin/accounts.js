import { esc, day, heading as pageHeading, empty, send, generation } from "./admin-ui.js";
const titles = { manager: "Admins", agent: "Agents", landlord: "Landlords" };
const nameOf = role => ({ manager: "Admin", agent: "Agent", landlord: "Landlord" }[role]);
export async function renderAccounts(host, { api, session, tab = "manager", selected = "" }) {
  const heading = (title, note, actions = "") => pageHeading(title, note, actions, session.owner ? "Access management" : "Admin workspace");
  const current = generation(host);
  host.innerHTML = heading("Accounts & access", "People, responsibilities and access — organized by account type.") + '<p role="status">Loading accounts…</p>';
  try {
    const [{ staff, owner, you }, { buildings }] = await Promise.all([api("/staff"), api("/buildings")]);
    if (!current()) return;
    const ownerAccess = you.owner;
    host.innerHTML = heading("Accounts & access", ownerAccess ? "Manage account permissions and Admin appointments. Business operations belong to the Admin team." : "Admins run the operation. Agents handle assigned rentals. Landlords keep their registered properties.", ownerAccess ? '' : '<a class="desk-button" href="#/onboarding/new">Invite a landlord</a>') + `
      <div class="account-tabs" role="tablist" aria-label="Account types">${Object.entries(titles).map(([role,title]) => `<button type="button" role="tab" data-account-tab="${role}" aria-selected="${role===tab}">${title} <b>${staff.filter(s=>s.role===role).length+(role==="manager" && owner ? 1 : 0)}</b></button>`).join("")}</div>
      <p class="account-policy">${tab === "manager" ? (ownerAccess ? "You are the platform owner. Grant or revoke Admin access through a recorded authorization." : "Admin accounts are managed by the platform owner. You can view this directory.") : tab === "agent" ? "Add internal team members and assign marketing access. Rental applications are assigned within each case." : "Landlords join with their properties through onboarding approved by Admin. Removing an account disables access and preserves registered properties."}</p>
      ${!owner ? '<p class="admin-warning">A platform owner has not been configured. Admin appointments remain locked until the operator configures the owner account.</p>' : ""}
      <div class="account-layout"><section class="desk-panel"><div class="desk-panel-head"><input type="search" id="account-search" aria-label="Search accounts" placeholder="Search name or email…">${tab==="manager" && ownerAccess ? '<button type="button" class="primary" data-new-account="manager">Add Admin</button>' : tab==="agent" ? '<button type="button" class="primary" data-new-account="agent">Add Agent</button>' : tab==="landlord" && !ownerAccess ? '<a class="desk-button primary" href="#/onboarding/new">Add Landlord</a>' : ""}</div><div id="account-directory"></div></section><aside id="account-detail" class="desk-panel desk-panel-body"></aside></div>`;
    const draw = () => {
      const query = host.querySelector("#account-search").value.toLowerCase();
      const members = staff.filter(s => s.role===tab && `${s.name} ${s.email}`.toLowerCase().includes(query));
      host.querySelector("#account-directory").innerHTML = `${tab === "manager" && owner && owner.includes(query) ? `<div class="desk-account account-owner"><span><b>Platform owner</b><small>${esc(owner)}</small></span><span class="pill">Protected</span></div>` : ""}` + members.map(s => `<button class="desk-account ${selected===s.email ? "is-selected" : ""}" data-account-email="${esc(s.email)}"><span><b>${esc(s.name || s.email)}</b><small>${esc(s.email)}</small></span><span class="pill ${s.active ? "is-good" : ""}">${s.active ? "Active" : "Suspended"}</span></button>`).join("") + (!members.length && !(tab==="manager" && owner) ? empty(`No ${titles[tab].toLowerCase()} found`, tab==="landlord" ? "Invite a landlord to collect and review their properties." : "Accounts will appear in this directory.") : "");
    };
    let detailGeneration = 0;
    async function detail(member) {
      const ticket = ++detailGeneration, panel = host.querySelector("#account-detail");
      if (!member) { panel.innerHTML = `<span class="k">Account details</span><h2>Select ${tab === "landlord" ? "a" : "an"} ${nameOf(tab).toLowerCase()}</h2><p class="soft">${tab==="manager" ? "Owner manages Admin access. Ordinary Admins cannot change other Admin accounts." : tab==="landlord" ? "Landlords keep a separate external account type. They cannot be switched to Agent or Admin." : "Account type stays fixed during ordinary edits. Only the Owner may grant Admin access to an Agent."}</p>`; return; }
      const isNew = member.account_version === -1, editable = isNew || member.allowed_actions?.includes("save");
      panel.innerHTML = `<span class="k">${nameOf(member.role)} account</span><h2>${isNew ? `Add ${nameOf(member.role).toLowerCase()}` : esc(member.name || member.email)}</h2><p class="soft">${editable ? (member.role === "landlord" ? "Update contact details and account status. Registered properties stay bound." : "Update this person's details and access.") : "This account is read only for you."}</p>
        <form id="account-form" class="desk-form"><label>Email<input type="email" name="email" maxlength="180" required value="${esc(member.email)}" ${isNew ? "" : "readonly"}></label><label>Name<input name="name" maxlength="120" value="${esc(member.name)}" ${editable ? "" : "readonly"}></label><p>Account type: <b>${nameOf(member.role)}</b></p>
        ${member.role === "agent" ? `<fieldset ${editable ? "" : "disabled"}><legend>${member.role==="agent" ? "Marketing properties" : "Property access"}</legend>${buildings.map(b => `<label class="desk-check"><input type="checkbox" name="property_ids" value="${esc(b.id)}" ${member.property_ids?.includes(b.id) ? "checked" : ""}>${esc(b.name)}</label>`).join("") || '<p>No properties registered yet.</p>'}</fieldset>` : ""}
        ${member.role === "landlord" ? `<section aria-label="Registered properties"><h3>Registered properties</h3><p class="soft">Bound through approved landlord onboarding. Property access cannot be changed here.</p><ul>${(member.property_ids || []).map(id => `<li>${esc(buildings.find(b => b.id === id)?.name || id)}</li>`).join("") || "<li>No registered properties</li>"}</ul></section>` : ""}
        <label class="desk-check"><input type="checkbox" name="active" ${member.active ? "checked" : ""} ${editable && !(isNew && member.role === "manager") ? "" : "disabled"}>Account active</label>${editable && member.role==="manager" ? `<label>${isNew ? 'Authorization reason' : 'Reason for any suspension or reactivation'}<textarea name="reason" maxlength="1000" ${isNew ? 'required minlength="5"' : ''}></textarea></label>` : ""}
        ${editable ? `<button type="submit" class="primary">${isNew && member.role === "manager" ? "Add Admin" : "Save account"}</button>` : ""}<p role="status"></p></form>
        ${member.allowed_actions?.some(a=>a==="grant_admin" || a==="revoke_admin") ? `<details class="case-disclosure account-authorization"><summary>${member.role==="manager" ? "Revoke Admin access" : "Grant Admin access"}</summary><p>${member.role==="manager" ? "The person will return to Agent access and see only assigned or collaborating rentals." : "Admin access includes all applications, private notes, property settings and team account management."}</p><form class="desk-form" id="account-authorize"><label>Authorization reason<textarea name="reason" required minlength="5" maxlength="1000"></textarea></label><button class="primary">${member.role==="manager" ? "Revoke Admin access" : "Grant Admin access"}</button><p role="status"></p></form></details>` : ""}
        ${member.allowed_actions?.some(action => ["remove_admin", "remove_account"].includes(action)) ? `<details class="case-disclosure account-authorization"><summary>Remove ${nameOf(member.role)}</summary><p>Removes this person's platform access. Historical rentals, property bindings and audit records are preserved. ${member.role === "agent" ? "Review their open rentals and reassign work to an active Agent." : member.role === "landlord" ? "Property ownership and lease records remain unchanged; this only removes account access." : "They will not retain Agent access."}</p><form id="account-remove" class="desk-form"><label>Removal reason<textarea name="reason" required minlength="5" maxlength="1000"></textarea></label><button type="submit">Remove ${nameOf(member.role)}</button><p role="status"></p></form></details>` : ""}
        ${isNew ? '<p class="soft">Use this person’s work identity. The platform login policy must allow this email.</p>' : '<details class="case-disclosure"><summary>Access history</summary><div id="account-history">Loading history…</div></details>'}`;
      panel.querySelector("#account-form").onsubmit = async event => {
        event.preventDefault(); if (!editable) return;
        const form = event.currentTarget, button = form.querySelector("button"), values = new FormData(form); button.disabled = true;
        try {
          await send(api, isNew && member.role === "manager" ? `/staff/${encodeURIComponent(values.get("email"))}/actions` : "/staff", { ...(isNew && member.role === "manager" ? {action:"create_admin"} : {}), email: values.get("email"), name: values.get("name"), role: member.role, active: values.has("active"), version: member.account_version || (isNew ? -1 : 0), ...(member.role === "agent" ? {property_ids: values.getAll("property_ids")} : {}), reason: values.get("reason") || "" }, isNew && member.role === "manager" ? "POST" : "PUT");
          if (!current() || ticket !== detailGeneration) return;
          await renderAccounts(host, { api, session, tab, selected: values.get("email") });
          host.querySelector("#account-detail")?.insertAdjacentHTML("afterbegin", '<p class="case-saved" role="status">Account saved.</p>');
        } catch(error) { form.querySelector('[role="status"]').textContent = error.message; button.disabled = false; }
      };
      const removal = panel.querySelector("#account-remove");
      if (removal) removal.onsubmit = async event => {
        event.preventDefault(); const button = removal.querySelector("button"); button.disabled = true;
        try {
          await send(api, `/staff/${encodeURIComponent(member.email)}/actions`, {action:member.role === "manager" ? "remove_admin" : "remove_account", version:member.account_version || 0, reason:new FormData(removal).get("reason")});
          if (!current() || ticket !== detailGeneration) return;
          await renderAccounts(host, {api,session,tab,selected:member.email});
          host.querySelector("#account-detail")?.insertAdjacentHTML("afterbegin", `<p role="status" class="case-saved">${nameOf(member.role)} removed. Platform access has been disabled; historical records are preserved.</p>`);
        } catch(error) { removal.querySelector('[role="status"]').textContent=error.message; button.disabled=false; }
      };
      const authorization = panel.querySelector("#account-authorize");
      if (authorization) authorization.onsubmit = async event => {
        event.preventDefault(); const button = authorization.querySelector("button"); button.disabled = true;
        try {
          const { member: saved } = await send(api, `/staff/${encodeURIComponent(member.email)}/actions`, { action: member.role==="manager" ? "revoke_admin" : "grant_admin", version: member.account_version || 0, reason: new FormData(authorization).get("reason") });
          if (!current() || ticket !== detailGeneration) return;
          await renderAccounts(host, { api, session, tab: saved.role, selected: saved.email });
          host.querySelector("#account-detail")?.insertAdjacentHTML("afterbegin", '<p class="case-saved" role="status">Authorization recorded.</p>');
        } catch(error) { authorization.querySelector('[role="status"]').textContent=error.message; button.disabled=false; }
      };
      if (!isNew) {
        try { const { history } = await api(`/staff/${encodeURIComponent(member.email)}/history`); if (current() && ticket===detailGeneration) panel.querySelector("#account-history").innerHTML = history.length ? `<ol class="case-history">${history.map(h=>`<li><b>${esc(h.action.replaceAll("_"," "))}</b><small>${esc(h.actor)} · ${esc(day(h.created_at))}</small><p>${esc(h.reason || "Account details updated")}</p></li>`).join("")}</ol>` : '<p>No recorded changes yet.</p>'; }
        catch(error) { if(current() && ticket===detailGeneration) panel.querySelector("#account-history").textContent=error.message; }
      }
    }
    draw(); await detail(staff.find(s=>s.email===selected));
    if (!current()) return;
    host.querySelector("#account-search").oninput = draw;
    host.onclick = event => {
      const button = event.target.closest("[data-account-tab],[data-account-email],[data-new-account]"); if (!button) return;
      if (button.dataset.accountTab) return renderAccounts(host, { api, session, tab: button.dataset.accountTab });
      if (button.dataset.newAccount) { selected=""; draw(); return detail({ email:"",name:"",role:button.dataset.newAccount,active:true,property_ids:[],account_version:-1 }); }
      selected=button.dataset.accountEmail;draw();detail(staff.find(s=>s.email===selected));
    };
  } catch(error) { if(current()) host.innerHTML=heading("Accounts & access", "")+empty("Accounts unavailable",error.message); }
}
