import { shortDay, money } from "./application-view.js";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const roleName = role => ({ manager: "Admin", agent: "Agent", landlord: "Landlord" }[role] || "Account");
const requestLabels = { open: "Open", in_progress: "In progress", resolved: "Resolved", declined: "Declined" };
const empty = (title, note) => `<div class="desk-empty"><h3>${esc(title)}</h3><p>${esc(note)}</p></div>`;
const pill = (label, tone = "") => `<span class="pill ${tone ? `is-${tone}` : ""}">${esc(label)}</span>`;
const heading = (eyebrow, title, note, actions = "") => `<div class="pagehead"><div><span class="k">${esc(eyebrow)}</span><h1>${esc(title)}</h1><p>${esc(note)}</p></div><div class="actions">${actions}</div></div>`;

export function renderPermissions(host) {
  const rows = [
    ["View listings", "All", "All", "Assigned properties"],
    ["Create & edit listings", "Yes", "Assigned marketing properties", "Request a change"],
    ["Delete listings", "Yes", "No", "No"],
    ["Create properties & edit defaults", "Yes", "View only", "No"],
    ["Review application information & documents", "All cases", "Responsible / collaborating cases", "No raw applications or documents"],
    ["Correct applicant identity", "Yes", "No", "No"],
    ["Reveal full identity number", "Yes, on demand", "Last four on assigned cases", "No"],
    ["Internal approval", "Yes", "Assigned cases", "No — confirms rental recommendation"],
    ["Set lease dates, rent, deposit & concession", "Yes", "Yes", "No"],
    ["Edit landlord defaults on a lease", "In property settings", "No", "No"],
    ["Manage Agent / Landlord accounts and property access", "Yes", "No", "No"],
    ["Change Admin access", "Platform owner only", "No", "No"],
    ["Admin private notes", "Read and edit", "No", "No"],
    ["Confirm rental terms", "Submit to landlord", "Submit assigned cases", "Own recommendation only"]
  ];
  host.innerHTML = heading("Workspace guide", "Who can do what", "Property defaults belong to the property. Transaction terms belong to each lease.") +
    `<div class="desk-panel desk-table-wrap"><table class="desk-table"><thead><tr><th>Action</th><th>Admin</th><th>Agent</th><th>Landlord</th></tr></thead><tbody>${rows.map(row => `<tr>${row.map(v => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function renderListingDetail(host, listing, landlord) {
  const fields = [["Property", listing.property_name], ["Unit", listing.unit], ["Category", listing.category],
    ["Transaction", listing.transaction_type === "sale" ? "For sale" : "For rent"], ["Address", listing.location],
    ["Property type", listing.property_type], ["Bedrooms", listing.bedrooms], ["Bathrooms", listing.bathrooms],
    ["Size", listing.size], ["Term", listing.term_label]];
  host.innerHTML = `<a class="link" href="#/listings">← All listings</a>` + heading("Listing details", listing.title || "Untitled listing",
    landlord ? "View only. Your team can update this listing from a change request." : "Marketing information for this unit.",
    landlord ? `<a class="desk-button" href="#/requests/${esc(listing.id)}">Request a change</a>` : '<button type="button" data-desk-edit-listing>Edit listing</button>') +
    `<div class="desk-grid"><article class="desk-panel"><div class="desk-gallery">${(listing.listing_media || []).map(m => `<figure><img src="${esc(m.url)}" alt="${esc(m.caption || m.kind)}" loading="lazy"><figcaption>${esc(m.caption || m.kind.replace("_", " "))}</figcaption></figure>`).join("") || empty("No photos uploaded", "Photos and floor plans will appear here.")}</div><div class="desk-panel-body"><h2>Description</h2><p class="desk-prewrap">${esc(listing.description || "No description added.")}</p>${safeLink(listing.video_url, "Watch video")}${safeLink(listing.details_url, "External details")}</div></article>
    <aside class="desk-panel desk-panel-body"><span class="k">Asking price</span><h2>${listing.price_amount == null ? "Not set" : money(listing.price_amount)}</h2>${pill(listing.published ? "Published on website" : "Unpublished", listing.published ? "good" : "warn")}<dl class="desk-facts">${fields.map(([key, val]) => `<div><dt>${esc(key)}</dt><dd>${esc(val ?? "—") || "—"}</dd></div>`).join("")}</dl></aside></div>`;
}
function safeLink(url, label) {
  if (!url || !/^(https?:\/\/|\/media\/)/i.test(url)) return "";
  return `<p><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a></p>`;
}

export async function renderRequests(host, { api, session, listings, selectedListing }) {
  const landlord = session.role !== "manager";
  host.innerHTML = heading("Team collaboration", "Change requests", landlord ? "Tell your team what should change. Track the response here." : "Review listing corrections from landlords and record how each request was handled.") + '<p role="status">Loading requests…</p>';
  let requests, fields;
  try { const result = await Promise.all([api("/requests"), api("/requests/options")]); requests = result[0].requests; fields = result[1].fields; }
  catch (error) { host.innerHTML = heading("Team collaboration", "Change requests", "") + empty("Requests unavailable", error.message); return; }
  host.innerHTML = heading("Team collaboration", "Change requests", landlord ? "Tell your team what should change. Track the response here." : "Approve structured changes to publish property defaults. General requests still need a team response.") + `
    <div class="desk-grid"><article class="desk-panel"><div class="desk-panel-head"><h2>${landlord ? "Your requests" : "Request inbox"}</h2><label>Status <select id="request-filter"><option value="all">All requests</option>${Object.entries(requestLabels).map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select></label></div><div id="request-rows"></div></article>
    <aside class="desk-panel desk-panel-body"><span class="k">Listing correction</span><h2>New change request</h2><form id="request-form" class="desk-form"><label for="request-listing">Listing</label><select id="request-listing" name="listing_id" required><option value="">Choose a listing</option>${listings.map(l => `<option value="${esc(l.id)}"${selectedListing === l.id ? " selected" : ""}>${esc(l.title)}</option>`).join("")}</select><label for="request-field">Change type</label><select id="request-field" name="field_id"><option value="">General request</option>${fields.map(f => `<option value="${esc(f.id)}">Property default: ${esc(f.label)}</option>`).join("")}</select><label id="request-value-label" hidden>Proposed value<input name="proposed_value" maxlength="400"></label><p class="soft">A property default applies to future leases across this property. Existing signed leases are preserved.</p><label for="request-message">What needs to change?</label><textarea id="request-message" name="message" minlength="10" maxlength="4000" required rows="5" placeholder="For example: please update the monthly rent to $2,800 starting October 1."></textarea><button class="primary" ${listings.length ? "" : "disabled"}>Submit request</button><p class="soft">Your request is saved here for the team to review.</p><p id="request-feedback" role="status"></p></form></aside></div>`;
  const renderRows = () => {
    const filter = host.querySelector("#request-filter").value;
    const visible = requests.filter(row => filter === "all" || row.status === filter);
    host.querySelector("#request-rows").innerHTML = visible.length ? visible.map(row => `<article class="desk-request"><div class="desk-request-head"><b>${esc(row.listing_title)}</b>${pill(requestLabels[row.status], row.status === "resolved" ? "good" : "warn")}</div><small>${esc(shortDay(row.created_at))}${landlord ? "" : ` · ${esc(row.created_by)}`}</small><p class="desk-prewrap">${esc(row.message)}</p>${row.proposal ? `<div class="desk-response"><b>${esc(row.proposal.label)} · Property default</b><p>${esc(row.proposal.previous_value ?? "Not set")} → ${esc(row.proposal.value)}</p>${!landlord && ["open", "in_progress"].includes(row.status) ? `<button type="button" data-publish-request="${esc(row.id)}">Approve & publish default</button><p role="status"></p>` : ""}</div>` : ""}${row.response ? `<div class="desk-response"><b>Team response</b><p class="desk-prewrap">${esc(row.response)}</p></div>` : ""}${!landlord ? `<form class="desk-form request-update" data-id="${esc(row.id)}">${row.listing_id ? `<a href="#/listings/${esc(row.listing_id)}">Open listing →</a>` : '<span class="soft">Listing removed</span>'}<label>Status<select name="status">${Object.entries(requestLabels).map(([key, label]) => `<option value="${key}"${row.status === key ? " selected" : ""}>${label}</option>`).join("")}</select></label><label>Response<textarea name="response" maxlength="4000" rows="2">${esc(row.response)}</textarea></label><button>Save response</button><p role="status"></p></form>` : ""}</article>`).join("") : empty("No requests in this view", "Submitted requests and team responses will appear here.");
  };
  renderRows();
  host.querySelector("#request-field").addEventListener("change", event => {
    const field = fields.find(f => f.id === event.target.value), label = host.querySelector("#request-value-label");
    label.hidden = !field;
    label.innerHTML = `Proposed value${field?.options ? `<select name="proposed_value" required>${field.options.map(value => `<option>${esc(value)}</option>`).join("")}</select>` : `<input name="proposed_value" maxlength="400" ${field ? "required" : ""}>`}`;
  });
  host.querySelector("#request-rows").addEventListener("click", async event => {
    const button = event.target.closest("[data-publish-request]"); if (!button) return;
    button.disabled = true;
    try { const { request } = await api(`/requests/${button.dataset.publishRequest}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publish: true }) }); requests = requests.map(row => row.id === request.id ? request : row); renderRows(); }
    catch(error) { button.nextElementSibling.textContent = error.message; button.disabled = false; }
  });
  host.querySelector("#request-filter").addEventListener("change", renderRows);
  host.querySelector("#request-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector("button"), feedback = host.querySelector("#request-feedback");
    button.disabled = true;
    try {
      const { request } = await api("/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      requests.unshift(request); form.reset(); host.querySelector("#request-value-label").hidden = true; host.querySelector("#request-value-label input, #request-value-label select").required = false; renderRows(); feedback.textContent = "Request submitted. Your team can now review it.";
    } catch (error) { feedback.textContent = error.message; }
    finally { button.disabled = false; }
  });
  host.querySelector("#request-rows").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.target, button = form.querySelector("button");
    button.disabled = true;
    try {
      const { request } = await api(`/requests/${form.dataset.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      requests = requests.map(row => row.id === request.id ? request : row); renderRows();
    } catch (error) { form.querySelector('[role="status"]').textContent = error.message; button.disabled = false; }
  });
}

export { renderAccounts as renderStaff } from "./accounts.js";
