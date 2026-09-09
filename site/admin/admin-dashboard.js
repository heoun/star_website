import { esc, heading, empty, generation, intakeLabels } from "./admin-ui.js";
export async function renderAdminDashboard(host, { api, session }) {
  const current = generation(host);
  host.innerHTML = heading("Dashboard", "A clear view of your team, properties and decisions.") + '<p role="status">Loading your business overview…</p>';
  const endpoints = ["/cases", "/onboarding", "/requests", "/buildings", "/staff", "/listings"];
  const results = await Promise.allSettled(endpoints.map(path => api(path)));
  if (!current()) return;
  const data = results.map(r => r.status === "fulfilled" ? r.value : null);
  const cases = data[0]?.cases || [], invites = data[1]?.invitations || [], requests = data[2]?.requests || [], properties = data[3]?.buildings || [], team = data[4]?.staff || [], listings = data[5]?.listings || [];
  const active = cases.filter(c => !["declined", "lease_signed"].includes(c.status));
  const unassigned = active.filter(c => !c.responsible_email);
  const review = invites.filter(i => i.status === "submitted");
  const followup = invites.filter(i => ["invited", "changes_requested"].includes(i.status) && (i.email_state === "failed" || Date.parse(i.expires_at) < Date.now()));
  const changes = requests.filter(r => ["open", "in_progress"].includes(r.status));
  const cards = [
    ["Active rentals", data[0] ? active.length : "—", `${unassigned.length} need an assignment`, "applications"],
    ["Landlord submissions", data[1] ? review.length : "—", "Ready for your review", "onboarding"],
    ["Properties", data[3] ? properties.length : "—", `${listings.filter(l => l.published).length} published listings`, "properties"],
    ["Active team", data[4] ? team.filter(t => t.active && t.role !== "landlord").length + (data[4].owner ? 1 : 0) : "—", "Owner, Admins and Agents", "staff"]
  ];
  const tasks = [
    ...review.map(i => ({ label: `Review ${i.contact_name}'s property submission`, note: `${i.data.properties?.length || 0} properties · ${i.email}`, url: `#/onboarding/${i.id}`, tag: "Landlord onboarding" })),
    ...followup.map(i => ({ label: `Follow up with ${i.contact_name}`, note: i.email_state === "failed" ? "Invitation email could not be sent" : "Invitation expired", url: `#/onboarding/${i.id}`, tag: "Invitation" })),
    ...unassigned.map(c => ({ label: `Assign ${c.name}'s application`, note: c.listings?.title || "Rental application", url: `#/applications/${c.id}`, tag: "Case assignment" })),
    ...changes.map(r => ({ label: r.listing_title, note: r.message, url: "#/requests", tag: "Change request" }))
  ];
  host.innerHTML = heading("Dashboard", `Your business at a glance${session.owner ? " · Platform owner" : ""}. Review decisions and give your team what they need.`, '<a class="desk-button primary" href="#/onboarding/new">Invite a landlord</a>') +
    results.map((r,i) => r.status === "rejected" ? `<p class="admin-warning" role="alert">${esc(["Rentals", "Landlord onboarding", "Change requests", "Properties", "Accounts", "Listings"][i])}: ${esc(r.reason.message)}</p>` : "").join("") + `
    <div class="admin-metrics">${cards.map(([label,value,note,route]) => `<a href="#/${route}" class="admin-metric"><span>${label}</span><strong>${value}</strong><small>${esc(note)}</small></a>`).join("")}</div>
    <div class="admin-dashboard-grid"><section class="desk-panel"><div class="desk-panel-head"><div><span class="k">Decision desk</span><h2>Needs your attention</h2></div><span>${tasks.length} ${tasks.length === 1 ? "item" : "items"}</span></div>${tasks.length ? tasks.slice(0,12).map(t => `<a class="admin-task" href="${esc(t.url)}"><span><small>${esc(t.tag)}</small><b>${esc(t.label)}</b><span>${esc(t.note)}</span></span><span aria-hidden="true">→</span></a>`).join("") : empty("No decisions waiting", "Your team can continue working. Check rentals to see their progress.")}</section>
    <aside><section class="desk-panel desk-panel-body"><span class="k">Start here</span><h2>Manage your business</h2>${[["onboarding/new","Bring on a new landlord","Invite → review → add properties"],["staff","Accounts & access","Manage people and property assignments"],["listings","Listings","Create and maintain property marketing"],["properties","Properties & settings","Maintain lease defaults once per property"]].map(([url,title,note]) => `<a href="#/${url}" class="admin-shortcut"><b>${title}</b><small>${note}</small><span aria-hidden="true">↗</span></a>`).join("")}</section></aside></div>
    <section class="desk-panel"><div class="desk-panel-head"><div><span class="k">Leasing progress</span><h2>Where rentals stand</h2></div><a href="#/applications">Open all rentals →</a></div><div class="admin-pipeline">${[["Intake & review",active.filter(c=>!["approved","sent_to_landlord","landlord_approved","lease_sent"].includes(c.status)).length],["Staff approved",active.filter(c=>c.status==="approved").length],["With landlord",active.filter(c=>c.status==="sent_to_landlord").length],["Lease & signatures",active.filter(c=>["landlord_approved","lease_sent"].includes(c.status)).length],["Completed",cases.filter(c=>c.status==="lease_signed").length]].map(([label,count]) => `<div><strong>${data[0] ? count : "—"}</strong><span>${label}</span></div>`).join("")}</div></section>`;
}
