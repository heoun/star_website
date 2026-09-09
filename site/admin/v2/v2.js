// The Leasing Desk: the staff view over /api/v2. Plain JS, no build step.
// Every action is a fetch to the flow routes; links the fakes hand back are
// shown so a person can click through screening and signatures.

const $ = (id) => document.getElementById(id);

const state = {
  cases: [],
  selected: null,
  detail: null,
  // Links returned by actions this session, keyed by case id. The fakes hand
  // them back on the API response; real vendors email them to real people.
  links: {},
};

async function api(path, options = {}) {
  const response = await fetch(`/api/v2${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    throw new Error(body && body.error ? body.error : `Request failed (${response.status}).`);
  }
  return body;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
  ));
}

function shortId(id) {
  return String(id || "").slice(0, 8);
}

function statusChip(status) {
  return `<span class="status ${esc(status)}">${esc(status.replace(/_/g, " "))}</span>`;
}

// ------------------------------------------------------------ header

async function loadHealth() {
  try {
    const health = await api("/health");
    $("env-chips").innerHTML = ["ring " + health.ring, health.db, health.auth + " auth", health.email + " mail", health.storage]
      .map((c) => `<span class="chip">${esc(c)}</span>`).join("");
  } catch (error) {
    $("env-chips").innerHTML = `<span class="chip">${esc(error.message)}</span>`;
  }
}

// ------------------------------------------------------------ cases

async function loadCases() {
  const { cases } = await api("/cases");
  state.cases = cases;
  $("case-count").textContent = cases.length ? `(${cases.length})` : "";
  if (!cases.length) {
    $("case-list").innerHTML = '<p class="muted">No cases yet. Start one with New Application.</p>';
    return;
  }
  $("case-list").innerHTML = `<table>
    <tr><th>Case</th><th>Unit</th><th>Applicants</th><th>Status</th></tr>
    ${cases.map((c) => `
      <tr class="row ${c.id === state.selected ? "selected" : ""}" data-id="${esc(c.id)}">
        <td>${esc(shortId(c.id))}</td>
        <td>${esc(c.listing ? c.listing.unitLabel : "?")}</td>
        <td>${esc(c.applicants.join(", ") || "-")}</td>
        <td>${statusChip(c.status)}</td>
      </tr>`).join("")}
  </table>`;
  for (const row of document.querySelectorAll("tr.row")) {
    row.addEventListener("click", () => selectCase(row.dataset.id));
  }
}

async function selectCase(id) {
  state.selected = id;
  await Promise.all([loadCases(), loadDetail()]);
}

async function loadDetail() {
  if (!state.selected) return;
  state.detail = await api(`/cases/${state.selected}`);
  renderDetail();
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  const kase = d.case;
  const links = state.links[kase.id] || {};

  const applicants = d.applications.map((a, i) => {
    const screening = d.screenings[i];
    const score = screening && screening.status === "complete"
      ? `credit ${screening.creditScore}` : (screening ? screening.status : "no screening");
    return `<tr><td>${esc(a.applicant.name)}</td><td>${esc(a.applicant.email)}</td>
      <td>${statusChip(a.status)}</td><td>${esc(score)}</td></tr>`;
  }).join("");

  const parts = [];
  parts.push(`<p>${statusChip(kase.status)}
    <span class="muted">Unit ${esc(d.listing ? d.listing.unitLabel : "?")},
    $${esc(d.listing ? d.listing.rent : "?")} monthly,
    move in ${esc(kase.moveInDate || "not set")}.</span></p>`);
  if (kase.declineReason) parts.push(`<p class="muted">Reason. ${esc(kase.declineReason)}</p>`);
  parts.push(`<table><tr><th>Applicant</th><th>Email</th><th>Application</th><th>Screening</th></tr>${applicants}</table>`);

  if (links.screeningUrl && d.applications.some((a) => a.status !== "complete")) {
    parts.push(`<div class="note">Screening invite for the applicant.
      <div class="links"><a href="${esc(links.screeningUrl)}" target="_blank">${esc(links.screeningUrl)}</a></div>
      The fake vendor completes it on open. Refresh after.</div>`);
  }

  const actions = [];
  if (kase.status === "in_review") {
    actions.push(`<div class="field"><label>Decision Email Recipients</label>
      <input id="recipients" value="owner@example.com"></div>`);
    actions.push(`<button id="act-send-landlord">Send To Landlord</button>`);
  }
  if (links.decisionUrl && (kase.status === "sent_to_landlord")) {
    parts.push(`<div class="note">Decision link, as emailed to the landlord.
      <div class="links"><a href="${esc(links.decisionUrl)}" target="_blank">${esc(links.decisionUrl)}</a></div>
      Open it, decide, then refresh.</div>`);
  }
  if (kase.status === "approved") {
    actions.push(`<button id="act-send-lease">Send Lease For Signature</button>`);
  }
  if (links.signerLinks && (kase.status === "lease_sent" || (d.lease && d.lease.status === "partially_signed"))) {
    parts.push(`<div class="note">Signing links, in order. Tenants first, landlord last.
      <div class="links">${links.signerLinks.map((l) =>
        `<a href="${esc(l.url)}" target="_blank">${esc(l.email)}</a>`).join("")}</div>
      Each opens the fake signing endpoint. Refresh after each signature.</div>`);
  }
  if (d.lease && d.lease.status === "executed" && d.lease.executedFileKey) {
    parts.push(`<div class="note">Executed lease on file.
      <div class="links"><a href="/api/v2/files/applicant-docs/${esc(d.lease.executedFileKey)}" target="_blank">
      Download the signed document</a></div></div>`);
  }
  if (!["executed", "closed", "declined"].includes(kase.status)) {
    actions.push(`<button class="warn" id="act-decline">Decline</button>`);
  }
  if (actions.length) parts.push(`<div class="actions">${actions.join("")}</div>`);

  $("detail").innerHTML = parts.join("");

  const sendLandlord = $("act-send-landlord");
  if (sendLandlord) sendLandlord.addEventListener("click", async () => {
    const recipients = $("recipients").value.split(",").map((r) => r.trim()).filter(Boolean);
    const result = await act(`/cases/${kase.id}/send-to-landlord`, { recipients });
    if (result) state.links[kase.id] = { ...links, decisionUrl: result.decisionUrl };
    await refreshAll();
  });
  const sendLease = $("act-send-lease");
  if (sendLease) sendLease.addEventListener("click", async () => {
    const result = await act(`/cases/${kase.id}/lease/send`, {});
    if (result) state.links[kase.id] = { ...links, signerLinks: result.signerLinks };
    await refreshAll();
  });
  const decline = $("act-decline");
  if (decline) decline.addEventListener("click", async () => {
    const reason = prompt("Reason for declining");
    if (reason === null) return;
    await act(`/cases/${kase.id}/decline`, { reason: reason || "Declined by staff" });
    await refreshAll();
  });
}

async function act(path, body) {
  try {
    return await api(path, { method: "POST", body: JSON.stringify(body) });
  } catch (error) {
    alert(error.message);
    return null;
  }
}

// ------------------------------------------------------------ outbox

async function loadOutbox() {
  try {
    const { emails } = await api("/dev/emails");
    if (!emails.length) { $("outbox").innerHTML = '<p class="muted">Nothing yet.</p>'; return; }
    $("outbox").innerHTML = emails.slice().reverse().map((m) => {
      const link = m.data && (m.data.decisionUrl || m.data.screeningUrl);
      return `<div class="mailrow"><b>${esc(m.template)}</b> to ${esc(m.to.join(", "))}
        <span class="muted">${esc(m.at)}</span>
        ${link ? `<div class="links"><a href="${esc(link)}" target="_blank">${esc(link)}</a></div>` : ""}</div>`;
    }).join("");
  } catch {
    $("outbox").innerHTML = '<p class="muted">Outbox unavailable.</p>';
  }
}

// ------------------------------------------------------------ new application

async function openDialog() {
  const { listings } = await api("/listings");
  const select = $("app-listing");
  select.innerHTML = listings.length
    ? listings.map((l) => `<option value="${esc(l.id)}">${esc(l.unitLabel)}, $${esc(l.rent)} monthly</option>`).join("")
    : '<option value="">No published listing. Reset demo data first.</option>';
  $("app-result").innerHTML = "";
  $("app-dialog").showModal();
}

async function submitApplication() {
  const listingId = $("app-listing").value;
  if (!listingId) return;
  try {
    const result = await api("/applications", {
      method: "POST",
      body: JSON.stringify({
        listingId,
        name: $("app-name").value,
        email: $("app-email").value,
        answers: {
          move_in: $("app-movein").value,
          lease_term_months: $("app-term").value,
          listing_location: "41-15 Main St, Flushing, NY",
        },
      }),
    });
    state.links[result.caseId] = { screeningUrl: result.screeningUrl };
    $("app-dialog").close();
    await refreshAll();
    await selectCase(result.caseId);
  } catch (error) {
    $("app-result").innerHTML = `<div class="note">${esc(error.message)}</div>`;
  }
}

// ------------------------------------------------------------ shell

async function refreshAll() {
  await Promise.all([loadCases(), loadOutbox(), state.selected ? loadDetail() : Promise.resolve()]);
}

$("refresh").addEventListener("click", refreshAll);
$("new-app").addEventListener("click", openDialog);
$("app-cancel").addEventListener("click", () => $("app-dialog").close());
$("app-submit").addEventListener("click", submitApplication);
$("reset").addEventListener("click", async () => {
  await act("/dev/reset", {});
  state.links = {};
  state.selected = null;
  $("detail").innerHTML = '<p class="muted">Pick a case on the left.</p>';
  await refreshAll();
});

const today = new Date();
today.setDate(today.getDate() + 21);
$("app-movein").value = today.toISOString().slice(0, 10);

loadHealth();
refreshAll();
setInterval(refreshAll, 5000);

// ------------------------------------------------------------ tabs

let activeTab = "cases";

function switchTab(name) {
  activeTab = name;
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === name);
  document.getElementById("tab-cases").hidden = name !== "cases";
  document.getElementById("tab-cases-outbox").hidden = name !== "cases";
  document.getElementById("tab-listings").hidden = name !== "listings";
  document.getElementById("tab-properties").hidden = name !== "properties";
  if (name === "listings") loadListings();
  if (name === "properties") loadProperties();
}
for (const b of document.querySelectorAll(".tab")) {
  b.addEventListener("click", () => switchTab(b.dataset.tab));
}

// ------------------------------------------------------------ listings tab

async function loadListings() {
  try {
    const { listings } = await api("/listings?scope=all");
    if (!listings.length) {
      $("listing-list").innerHTML = '<p class="muted">No residential rentals in the inventory.</p>';
      return;
    }
    $("listing-list").innerHTML = `<table>
      <tr><th>Unit</th><th>Property</th><th>Monthly</th><th>Status</th><th></th></tr>
      ${listings.map((l) => `
        <tr>
          <td>${esc(l.unitLabel)}</td>
          <td class="muted">${esc(l.propertyId ? "linked" : "no property")}</td>
          <td>$${esc(l.rent)}</td>
          <td>${statusChip(l.status)}</td>
          <td class="actions" style="margin:0">
            ${l.status === "published"
              ? `<button class="quiet" data-act="unpublish" data-id="${esc(l.id)}">Unpublish</button>
                 <button data-act="apply" data-id="${esc(l.id)}">Start Application</button>`
              : `<button class="quiet" data-act="publish" data-id="${esc(l.id)}">Publish</button>`}
          </td>
        </tr>`).join("")}
    </table>
    <p class="muted">Rented and archived are set by the flow. Editing price, photos and copy stays in
      <a href="/admin" target="_blank">the classic admin</a> until listings move over.</p>`;
    for (const button of $("listing-list").querySelectorAll("button")) {
      button.addEventListener("click", async () => {
        const id = button.dataset.id;
        if (button.dataset.act === "apply") {
          switchTab("cases");
          await openDialog();
          $("app-listing").value = id;
          return;
        }
        await act(`/listings/${id}/status`, { status: button.dataset.act === "publish" ? "published" : "draft" });
        await loadListings();
      });
    }
  } catch (error) {
    $("listing-list").innerHTML = `<p class="muted">${esc(error.message)}</p>`;
  }
}

// ------------------------------------------------------------ properties tab

async function loadProperties() {
  try {
    const response = await fetch("/api/admin/buildings", { headers: { "Content-Type": "application/json" } });
    if (!response.ok) throw new Error(`The classic admin API answered ${response.status}.`);
    const { buildings } = await response.json();
    if (!buildings || !buildings.length) {
      $("property-list").innerHTML = '<p class="muted">No properties yet. Create one in the classic admin.</p>';
      return;
    }
    const rows = [];
    for (const b of buildings) {
      let answered = "?";
      try {
        const settings = await fetch(`/api/admin/lease/settings?building_id=${encodeURIComponent(b.id)}`);
        if (settings.ok) {
          const body = await settings.json();
          answered = String(Object.keys(body.field_values || {}).length);
        }
      } catch { /* leave the count unknown */ }
      rows.push(`<tr>
        <td>${esc(b.name)}</td>
        <td class="muted">${esc([b.street, b.city, b.zip].filter(Boolean).join(", ") || "no address")}</td>
        <td>${esc(answered)} answered</td>
        <td><a href="/admin" target="_blank">Open Lease Settings</a></td>
      </tr>`);
    }
    $("property-list").innerHTML = `<table>
      <tr><th>Property</th><th>Address</th><th>Building Settings</th><th></th></tr>
      ${rows.join("")}
    </table>
    <p class="muted">Settings editing stays in the classic admin for now. The new per-field
      trust model replaces it in a later ring without changing this tab.</p>`;
  } catch (error) {
    $("property-list").innerHTML = `<p class="muted">${esc(error.message)}</p>`;
  }
}
