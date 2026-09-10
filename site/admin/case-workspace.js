import { PIPELINE, selectQueueCases } from "./case-queue-state.js";
// The case workspace, from the agent's chair.
//
// An agent's day is a list of people waiting on them, and then one case at a
// time. The queue answers "who needs me, and for how long"; the case page
// answers "what do I do next", and puts that one thing first, with its form on
// the page rather than behind a menu. Everything an agent looks up while doing
// it (who the applicant is, what has arrived, what the landlord said) is
// visible without a click. Only editing is folded away.
//
// Nothing here decides permissions. The server sends allowed_actions with every
// case and refuses what it did not list; this file only chooses where to draw
// the actions it was given, and the server's next_step is the one line both
// the queue row and the case page lead with.

import { documentSummary, money, requestedItems, shortDay } from "./application-view.js";

// Styled by case-workspace.css, linked from the console page beside this module.

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ROLE_NAMES = { manager: "Admin", agent: "Agent", landlord: "Landlord" };
const STAGE_LABELS = {
  new: "New application", contacted: "In review", fee_pending: "Fee pending", screening: "Screening pending",
  review: "In review", needs_info: "Information requested", approved: "Staff approved",
  sent_to_landlord: "With the landlord", landlord_approved: "Landlord confirmed", lease_sent: "Signing",
  lease_signed: "Completed", declined: "Closed"
};
const STAGE_TONES = {
  new: "warn", contacted: "busy", fee_pending: "warn", screening: "busy", review: "busy", needs_info: "warn",
  approved: "good", sent_to_landlord: "busy", landlord_approved: "good", lease_sent: "busy", lease_signed: "good", declined: "off"
};
const ACTION_LABELS = {
  assign: "Assignment changed", checks: "Verification recorded", approve: "Application approved",
  request_info: "Information requested", decline: "Application declined", terms: "Terms updated",
  review_and_recommend: "Reviewed and recommended to the landlord", recommend: "Recommendation sent to the landlord", landlord_accept: "Landlord agreed to the terms",
  landlord_changes: "Landlord requested changes", landlord_decline: "Landlord declined",
  note: "Team note saved", admin_note: "Admin note updated", prepare_lease: "Final lease prepared",
  record_tenant_signature: "Tenant signatures recorded", record_landlord_signature: "Landlord signature recorded",
  archive_lease: "Signed lease archived"
};
const TERM_LABELS = {
  "lease.effective_date": "Agreement Date", "lease.commencement_date": "Lease Start", "lease.end_date": "Lease End",
  "rent.monthly": "Monthly Rent", "rent.due_day": "Rent Due Day", "deposit.amount": "Security Deposit",
  "concession.terms": "Concessions"
};
const TERM_IDS = Object.keys(TERM_LABELS);
const OWNER_TEXT = {
  you: "With you", applicant: "With the applicant", landlord: "With the landlord", provider: "With the provider",
  admin: "Needs an admin", team: "With the leasing team", nobody: "Closed"
};

// The pipeline an agent glances at before opening anything: how many cases
// sit at each stage, each chip a filter.
const STEPS = ["Review", "Landlord", "Lease & signing", "Done"];

// ------------------------------------------------------------- reading a row

const home = row => row.listings?.property_name
  ? [row.listings.property_name, row.listings.unit && `Unit ${row.listings.unit}`].filter(Boolean).join(" · ")
  : row.listings?.title || "Property unavailable";
// The same place, for an email, where a middle dot reads oddly.
const place = row => row.listings?.property_name
  ? [row.listings.property_name, row.listings.unit && `Unit ${row.listings.unit}`].filter(Boolean).join(", ")
  : row.listings?.title || "the apartment";
const firstName = row => String(row.first_name || row.name || "").trim().split(/\s+/)[0] || "there";
const checksDone = w => w.checks?.documents === "verified" && w.checks.screening === "received" && ["paid", "waived"].includes(w.checks.fee);
const stagePill = status => `<span class="pill is-${STAGE_TONES[status] || "off"}">${esc(STAGE_LABELS[status] || status)}</span>`;

// "3 days", and a tone that turns as it ages. A case nobody has touched for a
// week is the one the queue exists to surface.
function age(iso) {
  const stamp = Date.parse(iso || "");
  if (!Number.isFinite(stamp)) return { text: "", days: 0, tone: "" };
  const days = Math.max(0, Math.floor((Date.now() - stamp) / 86400000));
  const text = days === 0 ? "Today" : days === 1 ? "1 day" : days < 14 ? `${days} days` : `${Math.floor(days / 7)} weeks`;
  return { text, days, tone: days >= 10 ? "is-bad" : days >= 5 ? "is-warn" : "" };
}

function isoDate(value) {
  const s = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
}
function endOfTerm(startIso, months) {
  if (!startIso || !Number.isInteger(months) || months <= 0) return "";
  const date = new Date(`${startIso}T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
// The terms a lease starts from: what the applicant asked for and what the
// listing asks, until the agent saves something else.
function initialTerms(row) {
  const start = isoDate(row.move_in);
  const months = Number(row.lease_term_months);
  return {
    "lease.commencement_date": start,
    "lease.end_date": endOfTerm(start, months),
    "rent.monthly": row.listings?.price_amount == null ? "" : String(row.listings.price_amount),
    ...row.workspace?.terms
  };
}
const termText = (key, value) => {
  if (value === undefined || value === null || value === "") return "";
  if (key === "rent.monthly" || key === "deposit.amount") return money(value) || String(value);
  if (key.startsWith("lease.")) return shortDay(`${value}T12:00:00Z`);
  return String(value);
};

// "monthly rent $2,900, lease start 10/15/2026": a counter-offer in one breath.
const proposedText = proposed => Object.entries(proposed || {})
  .map(([key, value]) => `${(TERM_LABELS[key] || key).toLowerCase()} ${termText(key, value)}`).join(", ");

// Flags a queue row carries so the agent knows what is short without opening
// the case. At most three, the ones that decide what to do first.
function rowFlags(row, docs, manager) {
  const w = row.workspace || {}, flags = [];
  if (manager && !row.responsible_email) flags.push("Unassigned");
  if (row.next_step?.label === "Review New Documents") flags.push("New documents");
  if (w.landlord_decision?.outcome === "changes" && row.status === "review") flags.push("Landlord asked for changes");
  if (["new", "contacted", "fee_pending", "screening", "review", "needs_info"].includes(row.status)) {
    if (docs && docs.missing > 0) flags.push(`${docs.missing} document${docs.missing === 1 ? "" : "s"} missing`);
    if (w.checks) {
      if (!["paid", "waived"].includes(w.checks.fee)) flags.push("Fee not verified");
      if (w.checks.screening !== "received") flags.push("Report pending");
      if (w.checks.documents !== "verified") flags.push("Documents not verified");
    }
  }
  return flags.slice(0, 3);
}

// Emails the agent sends at the moments the workflow needs one, drafted so the
// click is the whole job. Nothing is sent from here; the agent's own mail
// client opens with the draft.
function mailto(to, subject, body) {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
function drafts(row, session) {
  const signer = session.name || session.email;
  const where = place(row);
  const portal = `${location.origin}/portal/`;
  const workspace = `${location.origin}/admin/#/applications/${row.id}`;
  return {
    request: message => mailto(row.email, `Your application for ${where}`,
      `Hi ${firstName(row)},\n\nThank you for applying for ${where}. To keep your application moving, we need the following.\n\n${message}\n\nYou can upload documents any time in your applicant portal.\n${portal}\n\nThank you,\n${signer}\nStar Realty`),
    landlord: to => mailto(to, `Rental recommendation for ${where}`,
      `Hello,\n\nA rental recommendation for ${where} is waiting for your decision. Please review and confirm it in your workspace.\n${workspace}\n\nThank you,\n${signer}\nStar Realty`),
    lease: () => mailto(row.email, `Your lease for ${where}`,
      `Hi ${firstName(row)},\n\nGood news. The landlord has approved your application for ${where}. Your lease is attached for review, and the signing request will follow.\n\nThank you,\n${signer}\nStar Realty`),
    landlordSigns: to => mailto(to, `Lease ready for your signature for ${where}`,
      `Hello,\n\nAll tenants have signed the lease for ${where}. The signing request for your signature will follow.\n\nThank you,\n${signer}\nStar Realty`)
  };
}
// The request an agent is about to send, written out from what is actually
// short so nobody types "please upload the documents" for the third time.
function requestDraft(row, types) {
  const items = requestedItems(row, types);
  if (!items.length) return "";
  return `Please provide the following.\n${items.map(item => `• ${item.label}${item.detail ? ` (${item.detail})` : ""}`).join("\n")}`;
}

// ---------------------------------------------------------------- markup

const empty = (title, note) => `<div class="desk-empty"><h3>${esc(title)}</h3><p>${esc(note)}</p></div>`;
const heading = (role, title, note, tools = "") => `<div class="pagehead"><div><span class="k">${esc(ROLE_NAMES[role] || "Account")} workspace</span><h1>${esc(title)}</h1><p>${esc(note)}</p></div><div class="actions">${tools}<button type="button" data-case-refresh>Refresh</button></div></div>`;
const panel = (title, note, body, tools = "", extra = "") => `<article class="panel cw-panel ${extra}"><div class="phead"><div><h2>${esc(title)}</h2>${note ? `<p>${esc(note)}</p>` : ""}</div>${tools ? `<div class="phead-tools">${tools}</div>` : ""}</div><div class="pbody">${body}</div></article>`;
const line = (label, value, tail = "") => `<div class="line"><span class="lbl">${esc(label)}</span><div>${value}</div>${tail}</div>`;
const actionForm = (action, fields, label) => `<form class="cw-form case-action-form" data-action="${action}">${fields}<button class="primary" type="submit">${esc(label)}</button><p role="status"></p></form>`;
const reasonField = (label, value = "", { required = true, rows = 3 } = {}) => `<label>${esc(label)}<textarea name="reason" rows="${rows}" maxlength="2000" ${required ? "required" : ""}>${esc(value)}</textarea></label>`;
const edit = (summary, body) => `<details class="cw-edit"><summary>${esc(summary)}</summary>${body}</details>`;

// Each render owns a generation; a slow response cannot replace a later route.
const generations = new WeakMap();
function generation(host) { const id = (generations.get(host) || 0) + 1; generations.set(host, id); return () => generations.get(host) === id; }

// ------------------------------------------------------------------ queue

export async function renderCaseQueue(host, { api, session, overview = false, files = false }) {
  const current = generation(host);
  host.onchange = host.oninput = host.onkeydown = host.onsubmit = null;
  const landlord = session.role === "landlord", manager = session.role === "manager";
  const title = files ? "Lease Documents"
    : overview ? (landlord ? "Your Next Decision" : manager ? "What Needs Attention" : "My Tasks")
      : manager ? "All Rentals" : "My Rentals";
  const note = files ? "Completed leases shared with your account."
    : landlord ? "Review the team's rental recommendation and confirm the terms."
      : session.role === "agent" ? "The cases assigned to you or shared with you, the longest waiting first."
        : "Resolve exceptions, assign work, and keep the leasing team moving.";
  const again = () => renderCaseQueue(host, { api, session, overview, files });
  host.innerHTML = heading(session.role, title, note) + '<p role="status">Loading your workspace…</p>';
  host.onclick = event => { if (event.target.closest("[data-case-refresh]")) again(); };
  try {
    const { cases, document_types: types = [] } = await api("/cases");
    if (!current()) return;
    if (!landlord && !files) return renderStaffQueue(host, { cases, types, session, overview, title, note, again });
    let bucket = overview ? "attention" : "all", stage = "", query = "";
    const count = key => cases.filter(row => row.next_step?.bucket === key).length;
    const inStage = (row, key) => PIPELINE.find(group => group.key === key)?.statuses.includes(row.status);
    const tabs = [["all", "All Rentals"], ["attention", manager ? "Needs Attention" : "Needs Me"], ["waiting", "Waiting on Others"]];

    host.innerHTML = heading(session.role, title, note) + `
      ${files ? "" : `<div class="cw-bar">
        <div class="cw-tabs" role="group" aria-label="Work queue">${tabs.map(([key, label]) => `<button type="button" data-bucket="${key}" aria-pressed="${bucket === key}">${esc(label)} <b>${key === "all" ? cases.length : count(key)}</b></button>`).join("")}</div>
        <input type="search" aria-label="Search rentals" placeholder="Search tenant or property…">
      </div>
      ${landlord ? "" : `<div class="cw-pipeline" role="group" aria-label="Pipeline">${PIPELINE.map(group => {
        const n = cases.filter(row => inStage(row, group.key)).length;
        return `<button type="button" data-stage="${group.key}" aria-pressed="false" class="${n ? "" : "is-zero"}">${esc(group.label)} <b>${n}</b></button>`;
      }).join("")}</div>`}`}
      <article class="panel cw-list cw-rows"></article>
      <p class="cw-foot">${landlord ? "Your leasing team handles application review." : "Payment, screening and signing happen outside this system. Record each receipt in the case."}
        <a href="#/requests">${manager ? "Property change requests" : "My change requests"} →</a></p>
      ${manager ? '<p class="cw-foot"><a href="#/staff">Accounts and access →</a> <a href="#/listings">Marketing listings →</a> <a href="#/permissions">Permission guide →</a></p>' : ""}`;

    const draw = () => {
      const rows = cases.filter(row => (files ? row.signed_lease
        : (bucket === "all" || row.next_step?.bucket === bucket) && (!stage || inStage(row, stage)))
        && `${row.name} ${home(row)}`.toLowerCase().includes(query));
      const since = row => Date.parse(row.next_step?.since || row.updated_at || 0) || 0;
      rows.sort((a, b) => bucket === "all" && !stage ? since(b) - since(a) : since(a) - since(b));
      const list = host.querySelector(".cw-rows");
      if (files) {
        list.innerHTML = rows.map(row => `<a class="cw-row cw-row-file" href="/api/admin/cases/${esc(row.id)}/signed-lease"><span class="cw-who"><span class="desk-initial">${esc((row.name || "A").slice(0, 1))}</span><span class="cw-who-text"><b>${esc(row.name)}</b><small>${esc(home(row))}</small></span></span><span class="cw-next"><b>Download signed PDF ↓</b><small>${esc(shortDay(row.signed_lease?.uploaded_at))}</small></span></a>`).join("")
          || empty("No completed leases yet", "The signed PDF appears here after all signatures are recorded and the leasing team archives it.");
        return;
      }
      list.innerHTML = rows.length ? rows.map(row => queueRow(row, types, session.role)).join("")
        : empty(query ? "No matching rentals" : bucket === "attention" ? "You're up to date" : "Nothing in this view",
          query ? "Try another tenant or property."
            : session.role === "agent" && !cases.length ? "An admin can assign a case to you or add you as a collaborator."
              : "New work appears here when it needs your attention.");
    };
    draw();
    host.querySelector('input[type="search"]')?.addEventListener("input", event => { query = event.target.value.trim().toLowerCase(); draw(); });
    host.onclick = event => {
      if (event.target.closest("[data-case-refresh]")) return again();
      const tab = event.target.closest("[data-bucket]");
      if (tab) {
        bucket = tab.dataset.bucket;
        host.querySelectorAll("[data-bucket]").forEach(el => el.setAttribute("aria-pressed", String(el === tab)));
        draw();
      }
      const chip = event.target.closest("[data-stage]");
      if (chip) {
        stage = stage === chip.dataset.stage ? "" : chip.dataset.stage;
        host.querySelectorAll("[data-stage]").forEach(el => el.setAttribute("aria-pressed", String(el.dataset.stage === stage)));
        if (stage && bucket !== "all") {
          bucket = "all";
          host.querySelectorAll("[data-bucket]").forEach(el => el.setAttribute("aria-pressed", String(el.dataset.bucket === "all")));
        }
        draw();
      }
    };
  } catch (error) {
    if (current()) host.innerHTML = heading(session.role, title, note) + `<div class="status" role="alert">${esc(error.message)}</div>`;
  }
}

// Remember navigation choices for this identity only, in memory, never in shared storage.
const queueViews = new Map();
const detailViews = new Map();
function renderStaffQueue(host, { cases, types, session, overview, title, note, again }) {
  const manager = session.role === "manager";
  const key = JSON.stringify([session.role, session.email, overview]);
  if (!queueViews.has(key)) queueViews.set(key, { bucket: overview ? "attention" : "all", stage: "", person: "", query: "" });
  const view = queueViews.get(key);
  const people = [...new Set(cases.map(row => row.responsible_email).filter(Boolean))].sort();
  const tabs = [["all", "All Rentals"], ["attention", "Needs Attention"], ["waiting", "Waiting on Others"]];
  const count = bucket => bucket === "all" ? cases.length : cases.filter(row => row.next_step?.bucket === bucket).length;
  host.innerHTML = heading(session.role, title, manager
    ? "See who owns each rental and where the team needs to act."
    : "Your assigned and shared rentals, with the next action ready to open.") + `
    <section class="cw-queue-tools" aria-label="Rental filters">
      <div class="cw-tabs" role="group" aria-label="Work queue">${tabs.map(([bucket,label]) => `<button type="button" data-bucket="${bucket}" aria-pressed="${view.bucket === bucket}">${esc(label)} <b>${count(bucket)}</b></button>`).join("")}</div>
      <div class="cw-filters">
        <label class="cw-search">Search rentals<input type="search" value="${esc(view.query)}" placeholder="Applicant, property or unit…"></label>
        <label>Stage<select data-queue-stage><option value="">All stages</option>${PIPELINE.map(p => `<option value="${p.key}"${view.stage === p.key ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</select></label>
        <label>${manager ? "Assigned to" : "My involvement"}<select data-queue-person>
          <option value="">${manager ? "Everyone" : "All my rentals"}</option>
          ${manager ? '<option value="unassigned">Unassigned</option>' + people.map(email => `<option value="${esc(email)}">${esc(email === session.email ? "Me" : email)}</option>`).join("")
            : '<option value="lead">I am responsible</option><option value="collaborating">I am collaborating</option>'}
        </select></label>
      </div>
    </section>
    <div class="cw-results"><p data-queue-result role="status"></p><button type="button" data-clear-filters>Clear filters</button></div>
    <article class="panel cw-queue-table">
      <div class="cw-table-head" aria-hidden="true"><span>Applicant / property</span><span>Next step</span><span>${manager ? "Responsible" : "Your involvement"}</span><span>Waiting</span></div>
      <div class="cw-rows"></div>
    </article>`;
  host.querySelector('[data-queue-person]').value = view.person;
  if (!host.querySelector('[data-queue-person]').value) view.person = "";
  const draw = () => {
    const rows = selectQueueCases(cases, view, session);
    host.querySelector('.cw-rows').innerHTML = rows.length ? rows.map(row => staffQueueRow(row,types,session)).join("")
      : empty("No rentals in this view", cases.length ? "Change or clear the filters to see more rentals." : manager ? "Submitted applications will appear here." : "An admin can assign an application to you or add you as a collaborator.");
    host.querySelector('[data-queue-result]').textContent = `${rows.length} of ${cases.length} rentals · ${view.bucket === "all" ? "Action needed first, then longest waiting" : "Longest waiting first"}`;
    host.querySelector('[data-clear-filters]').hidden = !(view.stage || view.person || view.query || view.bucket !== "all");
    host.querySelectorAll('[data-bucket]').forEach(el => el.setAttribute('aria-pressed',String(el.dataset.bucket === view.bucket)));
  };
  draw();
  host.querySelector('input[type="search"]').addEventListener('input',event => {view.query=event.target.value;draw();});
  host.onchange = event => {
    if (event.target.matches('[data-queue-stage]')) view.stage=event.target.value;
    if (event.target.matches('[data-queue-person]')) view.person=event.target.value;
    draw();
  };
  host.onclick = event => {
    if (event.target.closest('[data-case-refresh]')) return again();
    const tab=event.target.closest('[data-bucket]');
    if (tab) {view.bucket=tab.dataset.bucket;draw();}
    if (event.target.closest('[data-clear-filters]')) {
      Object.assign(view,{bucket:'all',stage:'',person:'',query:''});
      host.querySelector('input[type="search"]').value='';
      host.querySelector('[data-queue-stage]').value='';
      host.querySelector('[data-queue-person]').value='';
      draw();
    }
  };
}
function staffQueueRow(row,types,session) {
  const manager=session.role === "manager", step=row.next_step || {};
  const closed=["lease_signed","declined"].includes(row.status);
  const when=age(step.since || row.updated_at || row.created_at);
  const flag=rowFlags(row,row.application_documents ? documentSummary(row,types) : null,false)[0];
  const responsible=row.responsible_email || "Unassigned";
  const involvement=manager ? responsible : responsible === session.email ? "Responsible" : "Collaborator";
  return `<a class="cw-row cw-staff-row" href="#/applications/${esc(row.id)}">
    <span class="cw-who"><span class="desk-initial">${esc((row.name || "A").slice(0,1))}</span><span class="cw-who-text"><b>${esc(row.name || "Application")}</b><small>${esc(home(row))}</small>${stagePill(row.status)}</span></span>
    <span class="cw-next"><b>${esc(step.label || "Open rental")}</b>${flag ? `<small class="cw-flags">${esc(flag)}</small>` : ""}</span>
    <span class="cw-responsible"><small class="cw-mobile-label">${manager ? "Responsible" : "Your involvement"}</small><b>${esc(involvement)}</b>${manager && !row.responsible_email && !closed ? '<small class="cw-flags">Assign a team member →</small>' : ""}</span>
    <span class="cw-age ${closed ? "" : when.tone}"><b>${esc(closed ? "—" : when.text)}</b><small>${closed ? "Closed" : "in this step"}</small></span>
  </a>`;
}

function queueRow(row, types, viewer) {
  const step = row.next_step || {};
  const when = age(step.since);
  const docs = row.application_documents ? documentSummary(row, types) : null;
  const flags = rowFlags(row, docs, viewer === "manager");
  // A landlord reading "with the landlord" is reading about themselves.
  const holder = viewer === "landlord" && step.owner === "landlord" ? "With you" : OWNER_TEXT[step.owner] || "";
  const stage = viewer === "landlord" && row.status === "sent_to_landlord" ? "Awaiting your decision" : STAGE_LABELS[row.status] || row.status;
  // A landlord's row is about the offer in front of them; a staff row about
  // what the applicant asked for.
  const offer = row.recommendation;
  const asks = (offer
    ? [offer.terms?.["rent.monthly"] && `${termText("rent.monthly", offer.terms["rent.monthly"])} a month`, offer.summary?.move_in && `Move in ${offer.summary.move_in}`]
    : [row.move_in && `Move in ${row.move_in}`, row.lease_term_months && `${row.lease_term_months} months`]).filter(Boolean).join(" · ");
  return `<a class="cw-row" href="#/applications/${esc(row.id)}">
    <span class="cw-who"><span class="desk-initial">${esc((row.name || "A").slice(0, 1))}</span>
      <span class="cw-who-text"><b>${esc(row.name || "Application")}</b><small>${esc(home(row))}</small>${asks ? `<small>${esc(asks)}</small>` : ""}</span></span>
    <span class="cw-next"><b>${esc(step.label)}</b><small>${esc(stage)}</small>${flags.length ? `<small class="cw-flags">${flags.map(esc).join(" · ")}</small>` : ""}</span>
    <span class="cw-age ${when.tone}"><b>${esc(when.text)}</b><small>${esc(holder)}</small></span>
  </a>`;
}

// ----------------------------------------------------------------- detail

export async function renderCaseDetail(host, { api, session, id }) {
  const current = generation(host);
  host.onchange = host.oninput = host.onkeydown = host.onsubmit = null;
  host.innerHTML = '<p role="status">Loading this rental…</p>';
  try {
    const { case: row, document_types: types = [] } = await api(`/cases/${encodeURIComponent(id)}`);
    if (!current()) return;
    if (session.role === "landlord") return renderLandlordCase(host, { api, session, id, row });

    const allowed = row.allowed_actions || [], w = row.workspace || {};
    let people = { team: [], landlords: [] };
    if (allowed.includes("assign") || allowed.includes("recommend") || allowed.includes("review_and_recommend")) {
      people = await api(`/cases/${encodeURIComponent(id)}/participants`);
      if (!current()) return;
    }
    // Whether the final lease could be produced right now, asked only when
    // that is the next thing to do. The answer names what is still short.
    let readiness = null;
    if (allowed.includes("prepare_lease") || allowed.includes("review_and_recommend")) {
      try {
        readiness = await api(`/lease/document/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "values" }) });
      } catch (error) { readiness = { error: error.message }; }
      if (!current()) return;
    }

    const ctx = { row, w, allowed, people, session, types, readiness, id, api,
      docs: documentSummary(row, types), terms: { ...Object.fromEntries(TERM_IDS.filter(key => key !== "lease.effective_date" && readiness?.values?.[key] != null).map(key => [key, String(readiness.values[key])])), ...initialTerms(row) }, mail: drafts(row, session) };
    ctx.reviewing = allowed.includes("review_and_recommend");
    ctx.viewKey = JSON.stringify([session.role, session.email, id]);
    const activeSection = detailViews.get(ctx.viewKey) || "application";
    const step = row.next_step || {};
    const sections = [
      ["application", ctx.reviewing ? "Review & decide" : "Application", ctx.reviewing ? reviewDesk(ctx) : `<div class="cw-grid"><div>${applicantPanel(ctx)}${verificationPanel(ctx)}</div><aside>${session.role === "manager" ? caseOwnerSummary(ctx) : teamPanel(ctx)}${propertyPanel(ctx)}</aside></div>`],
      ["documents", ctx.docs ? `Documents · ${ctx.docs.requiredMet}/${ctx.docs.required}` : "Documents", documentsPanel(ctx)],
      ["lease", "Lease & landlord", `<div class="cw-grid"><div>${termsPanel(ctx)}</div><aside>${landlordPanel(ctx)}${leasePanel(ctx)}</aside></div>`],
      ["activity", "Notes & activity", `<div class="cw-grid"><div>${notesPanel(ctx)}</div><aside>${activityPanel(ctx)}</aside></div>`],
      ...(session.role === "manager" ? [["team", "Team & admin", `<div class="cw-grid"><div>${teamPanel(ctx)}</div><aside>${privateNotePanel(ctx)}</aside></div>`]] : [])
    ];
    host.innerHTML = `
      <a class="link" href="#/applications">← Rentals</a>
      ${heading(session.role, row.name || "Rental", home(row), `<a class="desk-button" href="#/dossier/${esc(id)}">Open Full Application</a>`)}
      ${stepper(row)}
      ${ctx.reviewing ? "" : applicantStrip(ctx)}
      ${ctx.reviewing ? "" : panel(step.label || "Next step", nextNote(ctx), primaryFor(ctx) + (allowed.includes("checks") ? '<div class="cw-actions"><button type="button" data-case-tab-target="documents">Review documents →</button></div>' : ""), stagePill(row.status), "cw-next-panel")}
      <nav class="cw-detail-tabs" role="tablist" aria-label="Rental information">${sections.map(([key,label],index) => `<button type="button" role="tab" id="cw-tab-${key}" data-case-tab="${key}" aria-controls="cw-section-${key}" aria-selected="${key === activeSection}" tabindex="${key === activeSection ? 0 : -1}">${esc(label)}</button>`).join("")}</nav>
      ${sections.map(([key,label,body],index) => `<section class="cw-detail-section" role="tabpanel" id="cw-section-${key}" aria-labelledby="cw-tab-${key}" ${key === activeSection ? "" : "hidden"}>${body}</section>`).join("")}`;
    bindCase(host, ctx, () => renderCaseDetail(host, { api, session, id }));
  } catch (error) {
    if (current()) host.innerHTML = `<a class="link" href="#/overview">← My workspace</a><p role="alert" class="status">${esc(error.message)}</p>`;
  }
}

// Review is a decision surface: evidence on the left, one recommendation on the right.
function reviewDesk(ctx) {
  const {row, w, docs, types, people, terms, allowed} = ctx;
  const missing = requestedItems(row, types);
  const annual = String(row.income_note || "").trim();
  const annualNumber = annual && /^\$?[\d,]+(?:\.\d+)?$/.test(annual) ? Number(annual.replace(/[$,]/g,"")) : null;
  const roommates = Array.isArray(row.roommates) ? row.roommates : [];
  const names = roommates.map(m => [m.first_name,m.last_name].filter(Boolean).join(" ")).filter(Boolean);
  const employment = row.employment_status === "student" ? `Student${row.student?.school_name ? ` · ${row.student.school_name}` : ""}`
    : ({employed:"Employed",self_employed:"Self-employed",unemployed:"Not employed",retired:"Retired"}[row.employment_status] || row.employment_status || "Not stated");
  const issueList = missing.map(item => item.label);
  if (!people.landlords.length) issueList.push("No active landlord is bound to this property — ask Admin to update Properties");
  const fact = (label,value,source) => `<div class="cw-review-fact"><span class="k">${esc(label)}</span><b>${esc(value || "Not given")}</b><small>${esc(source)}</small></div>`;
  const proof = (label,value,done) => `<div class="cw-proof"><span>${esc(label)}</span><b class="${done ? 'is-good' : ''}">${esc(value)}</b></div>`;
  const proposed = w.landlord_decision?.proposed_terms;
  const offerCtx = { ...ctx, terms: {...terms, ...(proposed || {})} };
  const issues = issueList.length ? `<details class="cw-review-alert"><summary>${issueList.length} item${issueList.length === 1 ? '' : 's'} to follow up</summary><ul>${issueList.map(item=>`<li>${esc(item)}</li>`).join('')}</ul><p>Required uploads must be present before recommending. Check the other unanswered items with the applicant.</p></details>`
    : '<p class="cw-review-ready">Required uploads and key application answers are present. Review the evidence before deciding.</p>';
  const request = actionForm("request_info", reasonField("What the Applicant Needs to Provide",requestDraft(row,types),{rows:5}),"Save request & open email");
  const decision = `<p class="cw-note">Review the applicant, then confirm the terms and send one recommendation.</p>
    <details class="cw-decision is-primary"><summary>Recommend to landlord <span>→</span></summary>
      ${!docs || docs.missing ? '<p class="cw-review-alert">Required uploads are missing. Use Request information below; you can still review the proposed terms here.</p>' : ''}
      ${recommendationForm(offerCtx)}
    </details>
    ${allowed.includes("request_info") ? `<details class="cw-decision"><summary>Request information <span>+</span></summary>${request}<p class="cw-note">The request is saved. Send the prepared email from your mail app.</p></details>` : ''}
    ${allowed.includes("decline") ? `<details class="cw-decision"><summary>Decline application <span>+</span></summary>${actionForm("decline",reasonField("Internal Reason"),"Decline Application")}</details>` : ''}`;
  return `<div class="cw-review-jump"><span><b>${esc(termText('rent.monthly', offerCtx.terms['rent.monthly']) || 'Rent not set')}</b> / month · ${esc(row.lease_term_months || '—')} months</span><button type="button" data-review-jump>Your decision ↓</button></div><div class="cw-review-layout"><div class="cw-review-evidence">
    ${issues}
    ${w.info_request && row.status === 'needs_info' ? `<div class="cw-quote"><b>Requested from the applicant</b>\n${esc(w.info_request.message)}</div>` : ''}
    ${w.landlord_decision?.outcome === 'changes' ? `<div class="cw-quote"><b>Landlord requested changes</b>\n${esc(w.landlord_decision.comment)}${proposed ? `\n${esc(proposedText(proposed))}` : ''}</div>` : ''}
    ${panel("Applicant at a glance","From the application · supporting evidence is below.",`<div class="cw-review-facts">
      ${fact("Annual income",annualNumber !== null ? money(annualNumber) : annual,"Applicant reported")}
      ${fact("Employment / school",employment,"Applicant reported")}
      ${fact("People on the application",[row.name,...names].filter(Boolean).join(' · '),`${roommates.length} roommate${roommates.length===1?'':'s'} listed · confirm lease signers`)}
      ${fact("Requested move-in",row.move_in,row.lease_term_months ? `${row.lease_term_months} month term · applicant requested` : "Term not given")}
      ${fact("Pets",Array.isArray(row.pets) ? (row.pets.map(p=>p.type).filter(Boolean).join(', ') || "None listed") : "Not stated","Applicant reported")}
      ${fact("Current address",row.current_address,"Applicant reported")}
    </div><div class="cw-review-contact">${row.email ? `<a href="mailto:${esc(row.email)}">${esc(row.email)}</a>` : ''}${row.phone ? `<a href="tel:${esc(String(row.phone).replace(/[^\d+]/g,''))}">${esc(row.phone)}</a>` : ''}<a href="#/dossier/${esc(row.id)}">Full application →</a></div>`)}
    ${panel("Evidence & verification","Uploaded files are not automatically verified.",`
      ${proof("Application fee",w.checks?.fee === 'paid' ? 'Payment verified' : w.checks?.fee === 'waived' ? 'Waiver verified' : 'Needs verification',['paid','waived'].includes(w.checks?.fee))}
      ${proof("Screening report",w.checks?.screening === 'received' ? 'Reviewed by staff' : 'Needs review',w.checks?.screening === 'received')}
      ${proof("Credit score",w.checks?.credit_score ? `${w.checks.credit_score} · recorded from report` : 'Not recorded',false)}
      ${proof("Supporting documents",w.checks?.documents === 'verified' ? 'Verified by staff' : docs ? `${docs.requiredMet}/${docs.required} required uploads present · not verified` : 'Checklist unavailable',w.checks?.documents === 'verified')}
      ${w.checks?.reference ? `<p class="cw-note">${esc(w.checks.reference)}<br>Recorded by ${esc(w.checks.by)} · ${esc(shortDay(w.checks.at))}</p>` : ''}
      <details class="cw-evidence-files"><summary>Open supporting files & checklist</summary>${documentsPanel(ctx)}</details>
      <details class="cw-evidence-files"><summary>Save verification progress</summary>${checksForm(w)}</details>`)}
  </div><aside class="cw-review-decision">
    ${panel("Proposed lease","From the application, listing and property defaults, or saved terms. Confirm before sending.",`<div class="lines">${['rent.monthly','lease.commencement_date','lease.end_date','deposit.amount','concession.terms'].map(key=>line(TERM_LABELS[key],`<b>${esc(termText(key,offerCtx.terms[key]) || 'Not set')}</b>`)).join('')}</div><p class="cw-note">${people.landlords.length === 1 ? `Landlord: ${esc(people.landlords[0].name || people.landlords[0].email)} · linked to this property` : people.landlords.length ? 'Select a linked landlord when recommending.' : 'A linked landlord is required.'}</p>`)}
    ${panel("Your decision","",decision,stagePill(row.status),"cw-decision-panel")}
  </aside></div>`;
}
function recommendationForm(ctx) {
  const {people,w,docs} = ctx;
  const recipient = people.landlords.length === 1
    ? `<input type="hidden" name="landlord_email" value="${esc(people.landlords[0].email)}"><p><b>To ${esc(people.landlords[0].name || people.landlords[0].email)}</b><br>${esc(people.landlords[0].email)}</p>`
    : `<label>Landlord<select name="landlord_email" required><option value="">Choose a linked landlord</option>${people.landlords.map(p=>`<option value="${esc(p.email)}">${esc(p.name || p.email)}</option>`).join('')}</select></label>`;
  return `<form class="cw-form case-action-form" data-action="review_and_recommend">
    ${recipient}
    <h3>Confirm the lease terms</h3>${termsFields(ctx, TERM_IDS.filter(key => key !== "lease.effective_date"))}
    <h3>Confirm your review</h3>${checksFields(w)}
    <p class="cw-note">The landlord receives the applicant summary, recorded credit score and these terms. Original documents, contact details and internal notes stay with staff.</p>
    <label class="cw-check"><input type="checkbox" name="confirmed" required><span>I have reviewed the application and evidence and approve this recommendation on the terms above.</span></label>
    <button type="submit" class="primary" ${!docs || docs.missing || !people.landlords.length ? 'disabled' : ''}>Confirm & send recommendation</button><p role="status"></p>
  </form>`;
}

function stepper(row) {
  const w = row.workspace || {};
  const at = row.status === "declined" ? -1 : row.status === "lease_signed" ? 3
    : ["landlord_approved", "lease_sent"].includes(row.status) ? 2 : row.status === "sent_to_landlord" ? 1 : 0;
  return `<ol class="cw-steps" aria-label="Progress">${STEPS.map((label, index) => `<li class="${index < at ? "is-done" : index === at ? "is-now" : ""}${at === -1 ? " is-closed" : ""}">${esc(label)}</li>`).join("")}</ol>`;
}

// Who the applicant is and what they asked for, in one strip: the things an
// agent looks up mid-call.
function applicantStrip({ row }) {
  const offer = row.workspace?.recommendation?.terms || row.workspace?.terms;
  const rent = offer?.["rent.monthly"] ?? row.listings?.price_amount;
  const agreed = ["landlord_approved", "lease_sent", "lease_signed"].includes(row.status);
  return `<section class="cw-strip cw-brief" aria-label="Applicant">
    <div class="stat"><span class="k">Move in</span><b>${esc(row.move_in || "Not given")}</b><small>${esc(row.lease_term_months ? `${row.lease_term_months} months` : "Term not given")}</small></div>
    <div class="stat"><span class="k">${offer?.["rent.monthly"] ? agreed ? "Agreed rent" : "Proposed rent" : "Asking rent"}</span><b>${esc(rent == null ? "Not set" : money(rent))}</b><small>per month</small></div>
    <div class="stat"><span class="k">Contact applicant</span>${row.email ? `<a href="mailto:${esc(row.email)}">${esc(row.email)}</a>` : '<span class="soft">Email not given</span>'}${row.phone ? `<a href="tel:${esc(String(row.phone).replace(/[^\d+]/g,""))}">${esc(row.phone)}</a>` : ""}</div>
  </section>`;
}
function applicantPanel({ row, docs }) {
  const income=row.income_note ? money(String(row.income_note).replace(/[$,\s]/g,"")) || String(row.income_note) : "Not given";
  const employment={employed:"Employed",self_employed:"Self-employed",student:"Student",unemployed:"Not employed",retired:"Retired"}[row.employment_status] || row.employment_status || "Not given";
  const household=[Array.isArray(row.roommates) ? `${row.roommates.length} roommate${row.roommates.length === 1 ? "" : "s"}` : "Roommates not stated",Array.isArray(row.pets) ? `${row.pets.length} pet${row.pets.length === 1 ? "" : "s"}` : "Pets not stated"].join(" · ");
  return panel("Applicant summary", "As submitted by the applicant. Open the full application for detailed review.", `<div class="lines">
    ${line("Annual income",`<b>${esc(income)}</b>`)}${line("Employment",`<b>${esc(employment)}</b>`)}
    ${line("Household",esc(household))}${line("Current address",esc(row.current_address || "Not given"))}
    ${line("Submitted",esc(shortDay(row.created_at)))}
    ${line("Documents",`<button type="button" class="cw-inline-link" data-case-tab-target="documents">${docs ? `${docs.requiredMet} of ${docs.required} required documents` : "Open document checklist"} →</button>`)}
  </div>`);
}
function caseOwnerSummary({ row }) {
  return panel("Responsible team", "", `<div class="lines">${line("Responsible",`<b>${esc(row.responsible_email || "Unassigned")}</b>`)}</div><button type="button" class="cw-inline-link" data-case-tab-target="team">Manage assignment →</button>`);
}
function privateNotePanel({ w, allowed }) {
  return panel("Admin Private Note", "Visible only to Admins. Never shared with Agents or Landlords.", allowed.includes("admin_note") ? actionForm("admin_note",reasonField("Only Admins Can Read This",w.admin_note || "",{required:false}),"Save Private Note") : `<p>${esc(w.admin_note || "No private note.")}</p>`);
}

function nextNote({ row, w, allowed }) {
  const step = row.next_step || {};
  if (row.status === "declined") return "This application is closed.";
  if (row.status === "lease_signed") return "Everything is signed and archived.";
  if (step.owner === "landlord") return `Sent to ${w.recommendation?.landlord_email || "the landlord"} on ${shortDay(w.recommendation?.sent_at)}.`;
  if (step.owner === "applicant") return w.info_request ? `Requested on ${shortDay(w.info_request.at)}.` : "The applicant has to act before this moves.";
  if (step.owner === "admin") return "An admin assigns the case before anyone works it.";
  if (!allowed.length) return "You can read this case. Actions belong to its assigned team.";
  return "";
}

// The one thing to do now, with its form. Mirrors the server's next_step, so
// the title above and the form below cannot disagree.
function primaryFor(ctx) {
  const { row, w, allowed, people, session, types, readiness, mail, terms, docs } = ctx;
  const status = row.status;
  const parts = [];

  if (status === "declined") return `<p>${esc(lastDetail(w, "decline") || w.landlord_decision?.comment || "Declined.")}</p>`;
  if (status === "lease_signed") return `<a class="desk-button" href="/api/admin/cases/${esc(row.id)}/signed-lease">Download Signed PDF ↓</a>`;

  if (allowed.includes("assign") && !row.responsible_email) {
    return `<p>Choose who works this case. Collaborators see it too.</p>${assignForm(row, people)}`;
  }
  if (status === "sent_to_landlord") {
    return `<p>The landlord confirms the terms in their workspace. Nothing to do until they answer.</p>
      <div class="cw-actions"><a class="desk-button" href="${mail.landlord(w.recommendation?.landlord_email || "")}">Email the Landlord</a></div>`;
  }
  if (status === "landlord_approved" && !w.lease_preparation) return prepareLease(ctx);
  if (status === "landlord_approved") {
    return `<p>The final values are saved. Download the lease, send it to the tenant through your signing service, then record the receipt here.</p>
      <div class="cw-actions"><button type="button" data-download-lease>Download Saved Lease</button><a class="desk-button" href="${mail.lease()}">Email the Tenant</a><a class="desk-button" href="#/leases/${esc(row.id)}">Review Lease Fields</a></div>
      ${allowed.includes("record_tenant_signature") ? edit("Record Tenant Signatures", actionForm("record_tenant_signature", reasonField("Signing Provider and Receipt Reference for All Tenants"), "Record Tenant Signatures")) : ""}`;
  }
  if (status === "lease_sent" && !w.landlord_signature) {
    return `<p>All tenant signatures are recorded. The landlord signs next, through your signing service.</p>
      <div class="cw-actions"><a class="desk-button" href="${mail.landlordSigns(w.recommendation?.landlord_email || "")}">Email the Landlord</a></div>
      ${allowed.includes("record_landlord_signature") ? edit("Record the Landlord Signature", actionForm("record_landlord_signature", reasonField("Signing Provider and Landlord Receipt Reference"), "Record Landlord Signature")) : ""}`;
  }
  if (status === "lease_sent") {
    return allowed.includes("archive_lease")
      ? `<form id="archive-lease" class="cw-form"><label>Fully Signed Lease PDF<input type="file" name="file" accept="application/pdf" required></label><button class="primary" type="submit">Archive Completed Lease</button><p role="status"></p></form>`
      : "<p>The signed lease is archived by the case team.</p>";
  }
  if (status === "approved") {
    if (!w.review) return `<p>This application was approved before verification was recorded. Record what was checked, then approve it again.</p>${allowed.includes("checks") ? edit("Record verification",checksForm(w)) : ""}`;
    if (!allowed.includes("recommend")) return "<p>The assigned team sends the recommendation.</p>";
    return `<p>The landlord receives the tenant summary and proposed terms. The full application and internal notes stay with the leasing team.</p>
      ${actionForm("recommend", `<label>Landlord<select name="landlord_email" required><option value="">Choose a landlord</option>${people.landlords.map(p => `<option value="${esc(p.email)}">${esc(p.name || p.email)}</option>`).join("")}</select></label>
        ${people.landlords.length ? "" : `<p class="cw-note">No active landlord is assigned to this property. ${session.role === "manager" ? '<a href="#/properties">Review the property’s landlord binding.</a>' : "Ask an admin to assign one."}</p>`}`, "Send to the Landlord")}`;
  }
  if (status === "needs_info") {
    const fresh = row.next_step?.label === "Review New Documents";
    parts.push(w.info_request ? `<div class="cw-quote"><b>Requested on ${esc(shortDay(w.info_request.at))}</b>\n${esc(w.info_request.message)}</div>` : "");
    parts.push(fresh ? `<p>The applicant uploaded documents after the request. Review them below, then record what you verified.</p>`
      : `<p>Waiting for the applicant. Send the request from your mail client if you have not yet.</p>`);
    parts.push(`<div class="cw-actions"><a class="desk-button" href="${mail.request(w.info_request?.message || requestDraft(row, types))}">Email the Applicant</a></div>`);
    if (allowed.includes("checks")) parts.push(edit("Record Verification", checksForm(w)));
    if (allowed.includes("approve")) parts.push(approveForm());
    return parts.join("");
  }
  if (status === "fee_pending" || status === "screening") {
    parts.push(`<p>${status === "fee_pending" ? "The application fee is paid to the screening provider directly." : "The screening report comes from the provider."} Record it here when it arrives.</p>`);
    if (allowed.includes("checks")) parts.push(edit("Record verification", checksForm(w)));
    return parts.join("");
  }

  // Reviewing.
  if (w.landlord_decision?.outcome === "changes") {
    const proposed = w.landlord_decision.proposed_terms || null;
    parts.push(`<div class="cw-quote"><b>The landlord asked for changes on ${esc(shortDay(w.landlord_decision.at))}</b>\n${esc(w.landlord_decision.comment)}</div>`);
    parts.push(proposed
      ? `<p>The landlord proposed ${esc(proposedText(proposed))}. The form starts from those figures. Saving them asks for a fresh approval and a new recommendation.</p>`
      : "<p>Adjust the terms below, or keep them and reply to the landlord. Saving asks for a fresh approval and a new recommendation.</p>");
    if (allowed.includes("terms")) parts.push(termsForm({ ...ctx, terms: { ...terms, ...(proposed || {}) } }));
    if (allowed.includes("approve")) parts.push(approveForm("Approve Again"));
    return parts.join("");
  }
  if (checksDone(w)) {
    parts.push(allowed.includes("approve") ? approveForm() : "<p>Verified. The assigned team approves it.</p>");
  } else {
    const short = [!["paid", "waived"].includes(w.checks?.fee) && "the fee", w.checks?.screening !== "received" && "the screening report", w.checks?.documents !== "verified" && "the documents"].filter(Boolean);
    parts.push(`<p>Verify ${esc(short.join(", ").replace(/, ([^,]*)$/, " and $1"))} outside this system, then record it here.${docs && docs.missing ? ` ${docs.missing} required document${docs.missing === 1 ? " has" : "s have"} not arrived yet.` : ""}</p>`);
    if (allowed.includes("checks")) parts.push(edit("Record verification", checksForm(w)));
  }
  if (allowed.includes("request_info")) parts.push(edit("Request Information", actionForm("request_info", reasonField("What the Applicant Needs to Provide", requestDraft(row, types), { rows: 5 }), "Request Information") + '<p class="cw-note">Saving records the request. Your mail client opens with the same text afterwards.</p>'));
  if (allowed.includes("decline")) parts.push(edit("Decline the Application", actionForm("decline", reasonField("Internal Reason"), "Decline Application")));
  return parts.join("");
}

function prepareLease({ row, readiness, allowed }) {
  if (!readiness || readiness.error) return `<p>${esc(readiness?.error || "The lease values could not be read.")}</p>`;
  const missing = readiness.missing || [], labels = readiness.missing_labels || missing;
  const mine = missing.filter(id => TERM_IDS.includes(id)), theirs = missing.filter(id => !TERM_IDS.includes(id));
  if (!missing.length) {
    return `<p>Every value the lease needs is answered. The download saves the final values and the signatures attach to that version.</p>
      <div class="cw-actions"><button type="button" class="primary" data-download-lease>Prepare and Download the Final Lease</button><a class="desk-button" href="#/leases/${esc(row.id)}">Review Lease Fields</a></div>`;
  }
  return `<p>${missing.length} required value${missing.length === 1 ? " is" : "s are"} still unanswered, so the final lease cannot be produced yet.</p>
    <ul class="cw-list">${labels.map(label => `<li>${esc(label)}</li>`).join("")}</ul>
    <div class="cw-actions">${mine.length ? `<a class="desk-button" href="#/leases/${esc(row.id)}">Fill In on the Lease</a>` : ""}${theirs.length ? `<a class="desk-button" href="#/requests/${esc(row.listing_id || "")}">Ask the Admin for the Property Values</a>` : ""}</div>
    ${theirs.length ? '<p class="cw-note">Property values are maintained by the admin on the property page. The request reaches them with this case named.</p>' : ""}`;
}

function checksFields(w) {
  const option = (value, text, selected) => `<option value="${value}"${selected ? " selected" : ""}>${text}</option>`;
  return `
    <div class="cw-form-grid">
      <label>Application Fee<select name="fee">${option("pending", "Not verified", !w.checks || w.checks.fee === "pending")}${option("paid", "Payment verified", w.checks?.fee === "paid")}${option("waived", "Waiver verified", w.checks?.fee === "waived")}</select></label>
      <label>Credit Check<select name="screening">${option("pending", "Report pending", w.checks?.screening !== "received")}${option("received", "Report received and reviewed", w.checks?.screening === "received")}</select></label>
      <label>Supporting Documents<select name="documents">${option("pending", "Not yet verified", w.checks?.documents !== "verified")}${option("verified", "Reviewed and verified", w.checks?.documents === "verified")}</select></label>
      <label>Credit Score<input name="credit_score" type="number" min="300" max="850" step="1" value="${esc(w.checks?.credit_score ?? "")}" placeholder="From the report, if any"></label>
    </div>
    ${reasonField("Provider Reference and Note", w.checks?.reference || "", { rows: 2 })}`;
}
const checksForm = (w, label = "Save Verification") => actionForm("checks", checksFields(w), label);
const approveForm = (label = "Approve Application") => actionForm("approve", "<p>Payment, the screening report and the documents are verified. Approving prepares the landlord recommendation.</p>", label);
function assignForm(row, people) {
  return actionForm("assign", `<label>Responsible Team Member<select name="responsible_email"><option value="">Unassigned</option>${people.team.map(p => `<option value="${esc(p.email)}" ${p.email === row.responsible_email ? "selected" : ""}>${esc(p.name || p.email)}</option>`).join("")}</select></label>
    <fieldset><legend>Collaborators</legend>${people.team.map(p => `<label class="desk-check"><input type="checkbox" name="collaborator_emails" value="${esc(p.email)}" ${(row.collaborator_emails || []).includes(p.email) ? "checked" : ""}>${esc(p.name || p.email)}</label>`).join("")}</fieldset>`, "Save Assignment");
}
function termsFields({ terms, row }, fields = TERM_IDS) {
  const field = key => key === "concession.terms"
    ? `<label class="cw-span">${esc(TERM_LABELS[key])}<textarea name="${key}" rows="2" maxlength="2000">${esc(terms[key] || "")}</textarea></label>`
    : `<label>${esc(TERM_LABELS[key])}<input name="${key}" type="${key.startsWith("lease.") ? "date" : "number"}" ${key.startsWith("lease.") ? "" : `min="${key === "rent.due_day" ? 1 : 0}" step="${key === "rent.due_day" ? 1 : "0.01"}"`} value="${esc(terms[key] || "")}"${key === "lease.end_date" && !row.workspace?.terms?.["lease.end_date"] ? ' data-auto="1"' : ""}></label>`;
  return `<div class="cw-form-grid">${fields.map(field).join("")}</div>`;
}
function termsForm(ctx) {
  const {row} = ctx;
  return actionForm("terms", `${termsFields(ctx)}<p class="cw-note">The end date follows the start date and the ${esc(String(row.lease_term_months || ""))} month term until you change it. Saving asks for a fresh approval and a new landlord recommendation.</p>`, "Save Terms");
}

// ------------------------------------------------------------- panels

function verificationPanel({ w, allowed, row }) {
  const state = (ok, yes, no) => ok ? `<span class="pill is-good">${yes}</span>` : `<span class="pill is-warn">${no}</span>`;
  const body = w.checks ? `<div class="lines">
      ${line("Application Fee", `<b>${esc(w.checks.fee === "paid" ? "Payment verified" : w.checks.fee === "waived" ? "Waiver verified" : "Not verified")}</b>`, state(["paid", "waived"].includes(w.checks.fee), "Done", "Open"))}
      ${line("Credit Check", `<b>${esc(w.checks.screening === "received" ? "Report received and reviewed" : "Report pending")}</b>`, state(w.checks.screening === "received", "Done", "Open"))}
      ${line("Supporting Documents", `<b>${esc(w.checks.documents === "verified" ? "Reviewed and verified" : "Not yet verified")}</b>`, state(w.checks.documents === "verified", "Done", "Open"))}
      ${line("Credit Score", w.checks.credit_score ? `<b>${esc(String(w.checks.credit_score))}</b><span class="panel-hint">Shared with the landlord in the recommendation</span>` : '<span class="soft">Not recorded</span>')}
      ${line("Reference", `<span class="desk-prewrap">${esc(w.checks.reference || "")}</span><span class="panel-hint">${esc(w.checks.by || "")} · ${esc(shortDay(w.checks.at))}</span>`)}
    </div>` : '<p class="cw-note">Nothing recorded yet. Payment, the screening report and the documents are verified outside this system and recorded here.</p>';
  const inPrimary = !["approved", "sent_to_landlord", "landlord_approved", "lease_sent", "lease_signed", "declined"].includes(row.status);
  return panel("Verification", "What the team confirmed outside this system.", body + (allowed.includes("checks") && !inPrimary ? edit("Update Verification", checksForm(w)) : ""),
    w.checks ? (checksDone(w) ? '<span class="pill is-good">Complete</span>' : '<span class="pill is-warn">In progress</span>') : '<span class="pill is-off">Not started</span>');
}

function documentsPanel({ row, docs, mail, types }) {
  if (!docs) return panel("Documents", "", '<p class="cw-note">This database has no document checklist yet.</p>');
  const tone = { received: ["good", "Received"], covered: ["good", "Covered"], partial: ["warn", ""], missing: ["bad", "Missing"], optional: ["off", "Optional"] };
  const rows = docs.rows.map(({ type, files, state }) => {
    const [pill, text] = tone[state] || ["off", state];
    const label = state === "partial" ? `${files.length} of ${type.required}` : text;
    return line(type.label, files.length ? `<span class="cw-files">${files.map(file => `<a href="/api/admin/documents/${esc(file.id)}" target="_blank" rel="noopener">${esc(file.file_name)}</a>`).join("")}</span>` : '<span class="soft">Nothing uploaded</span>', `<span class="pill is-${pill}">${esc(label)}</span>`);
  }).join("");
  const draft = requestDraft(row, types);
  return panel("Documents", "The checklist the applicant sees in their portal.", `<div class="lines">${rows}</div>
    <div class="cw-actions"><a class="desk-button" href="#/dossier/${esc(row.id)}">Open Full Application</a>${docs.missing && draft ? `<a class="desk-button" href="${mail.request(draft)}">Ask for Missing Documents</a>` : ""}</div>`,
    docs.complete ? '<span class="pill is-good">Complete</span>' : `<span class="pill is-warn">${docs.requiredMet} of ${docs.required}</span>`);
}

function termsPanel(ctx) {
  const { row, terms, w, allowed } = ctx;
  const saved = Boolean(w.terms);
  const rows = TERM_IDS.map(key => line(TERM_LABELS[key], terms[key] ? `<b>${esc(termText(key, terms[key]))}</b>` : '<span class="soft">Not set</span>')).join("");
  const asked = [row.move_in && `move in ${row.move_in}`, row.lease_term_months && `${row.lease_term_months} months`].filter(Boolean).join(", ");
  const inPrimary = row.status === "review" && w.landlord_decision?.outcome === "changes";
  return panel("Terms for This Lease", saved ? "Saved for this rental. Property defaults are not changed." : `Suggested from the application${asked ? ` (${asked})` : ""} and the listing. Not saved yet.`,
    `<div class="lines">${rows}</div>${allowed.includes("terms") && !inPrimary ? edit("Edit Terms", termsForm(ctx)) : ""}`,
    saved ? '<span class="pill is-good">Saved</span>' : '<span class="pill is-off">Suggested</span>');
}

function notesPanel({ row, w, session, allowed }) {
  const team = allowed.includes("note")
    ? actionForm("note", reasonField("Team Note", row.notes || "", { required: false }), "Save Team Note")
    : `<p class="desk-prewrap">${esc(row.notes || "No team note.")}</p>`;
  return panel("Team note", "Seen by the assigned team and admins.", team);
}

function activityPanel({ w }) {
  const items = (w.activity || []).slice().reverse();
  const item = entry => `<li><b>${esc(ACTION_LABELS[entry.action] || entry.action.replaceAll("_", " "))}</b><small>${esc(entry.by)} · ${esc(shortDay(entry.at))}</small>${entry.detail ? `<p>${esc(entry.detail)}</p>` : ""}</li>`;
  const body = items.length ? `<ol class="cw-activity">${items.slice(0, 5).map(item).join("")}</ol>${items.length > 5 ? edit(`Show All ${items.length}`, `<ol class="cw-activity">${items.slice(5).map(item).join("")}</ol>`) : ""}` : '<p class="cw-note">No recorded actions yet.</p>';
  return panel("Activity", "", body);
}

function landlordPanel({ row, w, people, mail }) {
  const r = w.recommendation, d = w.landlord_decision;
  const outcome = { accepted: ["good", "Agreed to the terms"], changes: ["warn", "Asked for changes"], declined: ["bad", "Declined"] };
  let body = "";
  if (r) body += `<div class="lines">${line("Sent To", `<b>${esc(r.landlord_email)}</b><span class="panel-hint">${esc(shortDay(r.sent_at))} · revision ${esc(r.revision)}</span>`)}${line("Rent Offered", `<b>${esc(termText("rent.monthly", r.terms?.["rent.monthly"]))}</b>`)}</div>`;
  else if (people.landlords.length) body += `<p class="cw-note">${people.landlords.map(p => esc(p.name || p.email)).join(", ")} can receive the recommendation.</p>`;
  else body += '<p class="cw-note">No recommendation has been sent.</p>';
  if (d) body += `<div class="cw-quote${d.outcome === "accepted" ? " is-good" : ""}"><b>${esc(outcome[d.outcome]?.[1] || d.outcome)} · ${esc(shortDay(d.at))}</b>${d.proposed_terms ? `\nProposed ${esc(proposedText(d.proposed_terms))}` : ""}${d.comment ? `\n${esc(d.comment)}` : ""}</div>`;
  if (row.status === "sent_to_landlord") body += `<div class="cw-actions"><a class="desk-button" href="${mail.landlord(r?.landlord_email || "")}">Email the Landlord</a></div>`;
  const pill = d ? `<span class="pill is-${outcome[d.outcome]?.[0] || "off"}">${esc(outcome[d.outcome]?.[1] || d.outcome)}</span>` : r ? '<span class="pill is-busy">Waiting</span>' : '<span class="pill is-off">Not sent</span>';
  return panel("Landlord", "", body, pill);
}

function leasePanel({ row, w, readiness }) {
  const lines = [];
  if (readiness && !readiness.error) lines.push(line("Values", readiness.missing?.length ? `<b class="is-bad">${readiness.missing.length} still needed</b>` : '<b class="is-good">All answered</b>'));
  lines.push(line("Final Lease", w.lease_preparation ? `<b>Prepared</b><span class="panel-hint">${esc(w.lease_preparation.by)} · ${esc(shortDay(w.lease_preparation.at))}</span>` : '<span class="soft">Not prepared</span>'));
  lines.push(line("Tenant Signatures", w.tenant_signature ? `<b>Recorded</b><span class="panel-hint">${esc(w.tenant_signature.reference)}</span>` : '<span class="soft">Not recorded</span>'));
  lines.push(line("Landlord Signature", w.landlord_signature ? `<b>Recorded</b><span class="panel-hint">${esc(w.landlord_signature.reference)}</span>` : '<span class="soft">Not recorded</span>'));
  lines.push(line("Archived PDF", row.signed_lease ? `<a href="/api/admin/cases/${esc(row.id)}/signed-lease">${esc(row.signed_lease.name)}</a>` : '<span class="soft">Not archived</span>'));
  const tools = row.status === "lease_signed" ? '<span class="pill is-good">Complete</span>' : w.lease_preparation ? '<span class="pill is-busy">Signing</span>' : '<span class="pill is-off">Not started</span>';
  return panel("Lease", "", `<div class="lines">${lines.join("")}</div><div class="cw-actions"><a class="desk-button" href="#/leases/${esc(row.id)}">Review Lease Fields</a>${w.lease_preparation && row.status !== "lease_signed" ? '<button type="button" data-download-lease>Download Saved Lease</button>' : ""}</div>`, tools);
}

function teamPanel({ row, people, allowed }) {
  const body = `<div class="lines">${line("Responsible", row.responsible_email ? `<b>${esc(row.responsible_email)}</b>` : '<span class="soft">Unassigned</span>')}${line("Collaborators", (row.collaborator_emails || []).length ? `<b>${esc(row.collaborator_emails.join(", "))}</b>` : '<span class="soft">None</span>')}</div>`;
  return panel("Case Team", "", body + (allowed.includes("assign") && row.responsible_email ? edit("Change Assignment", assignForm(row, people)) : ""));
}

function propertyPanel({ row, session }) {
  return panel("Property", "", `<p class="cw-note">Property defaults and landlord details are maintained by the admin and printed on every lease for ${esc(row.listings?.property_name || "this property")}.</p><div class="cw-actions">${session?.role === "manager" && row.listings?.building_id ? `<a class="desk-button" href="#/properties/${esc(row.listings.building_id)}">Manage property settings</a>` : `<a class="desk-button" href="#/requests/${esc(row.listing_id || "")}">Request a Change</a>`}</div>`);
}

function lastDetail(w, action) {
  return (w.activity || []).slice().reverse().find(item => item.action === action)?.detail || "";
}

// ---------------------------------------------------------------- landlord
//
// A landlord reads one thing: an offer to rent their unit to a named tenant on
// stated terms, backed by what Star checked. They say yes, counter, or no.
// Afterwards they watch the lease move, sign when the signing service asks,
// and collect the signed copy. Nothing from the application itself is here.

const LANDLORD_STEPS = ["Decide", "Lease", "Tenants Sign", "You Sign", "Done"];

function landlordStepper(row) {
  const progress = row.progress || {};
  const at = row.status === "lease_signed" ? LANDLORD_STEPS.length
    : row.status === "lease_sent" ? (progress.landlord_signed ? 4 : 3)
      : row.status === "landlord_approved" ? 1 : 0;
  return `<ol class="cw-steps" aria-label="Progress">${LANDLORD_STEPS.map((label, index) => `<li class="${index < at ? "is-done" : index === at ? "is-now" : ""}">${esc(label)}</li>`).join("")}</ol>`;
}

function landlordDecision(row, decision) {
  if (!decision) return "";
  const said = { accepted: "agreed to these terms", changes: "asked for changes", declined: "declined this recommendation" }[decision.outcome] || decision.outcome;
  return `<div class="cw-quote${decision.outcome === "accepted" ? " is-good" : ""}"><b>You ${esc(said)} on ${esc(shortDay(decision.at))}</b>${decision.proposed_terms ? `\nYou proposed ${esc(proposedText(decision.proposed_terms))}` : ""}${decision.comment ? `\n${esc(decision.comment)}` : ""}</div>`;
}

function landlordPrimary(row, id, terms, decision, allowed) {
  const progress = row.progress || {};
  if (row.status === "sent_to_landlord" && allowed.includes("landlord_accept")) {
    return `<p>Star has completed its review and recommends ${esc(row.name)} for ${esc(home(row))}. Agreeing lets the leasing team prepare the lease on the terms above.</p>
      ${actionForm("landlord_accept", "", "Agree to These Terms")}
      ${edit("Request a Change", actionForm("landlord_changes", `<p class="cw-note">Propose different figures, or leave them blank and say what should change. The leasing team reviews it and sends the recommendation again.</p>
        <div class="cw-form-grid">
          <label>Monthly Rent<input name="rent.monthly" type="number" min="1" step="0.01" placeholder="${esc(terms["rent.monthly"] || "")}"></label>
          <label>Security Deposit<input name="deposit.amount" type="number" min="0" step="0.01" placeholder="${esc(terms["deposit.amount"] || "")}"></label>
          <label>Lease Start<input name="lease.commencement_date" type="date"></label>
          <label>Lease End<input name="lease.end_date" type="date"></label>
        </div>
        ${reasonField("What Should Change")}`, "Request Changes"))}
      ${edit("Decline This Recommendation", actionForm("landlord_decline", reasonField("Reason for Declining"), "Decline"))}`;
  }
  if (row.status === "landlord_approved") return `<p>You agreed on ${esc(shortDay(decision?.at))}. The leasing team is preparing the lease on these terms and sending it to the tenant to sign. Nothing to do until the tenants have signed.</p>`;
  if (row.status === "lease_sent" && !progress.landlord_signed) return "<p>All tenants have signed. The request for your signature comes by email from the signing service. Once you have signed, the leasing team files the lease and it appears here.</p>";
  if (row.status === "lease_sent") return "<p>Your signature is recorded. The leasing team is filing the fully signed lease, which will appear here to download.</p>";
  if (row.status === "lease_signed") return `<p>The lease is fully signed and filed.</p><div class="cw-actions"><a class="desk-button" href="/api/admin/cases/${esc(id)}/signed-lease">Download Signed PDF ↓</a></div>`;
  return "<p>Your decision is saved. The leasing team takes it from here.</p>";
}

// What Star shares from the application, and nothing more: who will live
// there, how the rent is paid for, and the one figure from the screening.
function tenantPanel(row, summary) {
  if (!summary) return panel("About the Tenant", "", `<div class="lines">${line("Tenant", `<b>${esc(row.name)}</b>`)}</div><p class="cw-note">The leasing team can tell you more about this tenant.</p>`);
  const household = [row.name, ...(summary.roommates || [])].filter(Boolean);
  const pets = (summary.pets || []).map(pet => [pet.type, pet.breed, pet.weight && `${pet.weight} lb`].filter(Boolean).join(", "));
  const income = summary.annual_income ? money(String(summary.annual_income).replace(/[$,\s]/g, "")) || summary.annual_income : "";
  return panel("About the Tenant", "What Star shares from the application. The application itself stays with the leasing team.", `<div class="lines">
    ${line("Tenants on the Lease", `<b>${esc(household.join(", "))}</b><span class="panel-hint">${household.length === 1 ? "1 adult" : `${household.length} adults`}</span>`)}
    ${line("Pets", pets.length ? `<b>${esc(pets.join("; "))}</b>` : '<span class="soft">None declared</span>')}
    ${line("Requested Move In", summary.move_in ? `<b>${esc(summary.move_in)}</b>${summary.lease_term_months ? `<span class="panel-hint">${esc(String(summary.lease_term_months))} month term</span>` : ""}` : '<span class="soft">Not stated</span>')}
    ${line("Employment", `<b>${summary.employment_status === "student" ? "Student" : "Employed"}</b>`)}
    ${line("Annual Income", income ? `<b>${esc(income)}</b><span class="panel-hint">As stated on the application</span>` : '<span class="soft">Not stated</span>')}
    ${line("Credit Score", summary.credit_score ? `<b>${esc(String(summary.credit_score))}</b><span class="panel-hint">From the screening report, recorded by Star</span>` : '<span class="soft">Not recorded</span>')}
  </div>`);
}

function verifiedPanel(summary) {
  const done = summary?.verified;
  const mark = ok => ok ? '<span class="pill is-good">Done</span>' : '<span class="pill is-warn">Open</span>';
  if (!done) return panel("What Star Verified", "", '<p class="cw-note">Star completed its internal review before sending this recommendation.</p>');
  const complete = done.fee && done.screening && done.documents;
  return panel("What Star Verified", `Recorded by the leasing team on ${shortDay(done.at)}.`, `<div class="lines">
    ${line("Application Fee", `<b>${done.fee ? "Paid to the screening provider" : "Not yet verified"}</b>`, mark(done.fee))}
    ${line("Credit Check", `<b>${done.screening ? "Report received and reviewed" : "Report pending"}</b>`, mark(done.screening))}
    ${line("Supporting Documents", `<b>${done.documents ? "Reviewed and verified" : "Not yet verified"}</b>`, mark(done.documents))}
  </div>`, complete ? '<span class="pill is-good">Complete</span>' : '<span class="pill is-warn">In progress</span>');
}

function landlordLeasePanel(row, id) {
  const progress = row.progress || {};
  const state = (ok, yes, no) => ok ? `<b>${yes}</b>` : `<span class="soft">${no}</span>`;
  return panel("Lease", "", `<div class="lines">
    ${line("Lease Prepared", state(progress.lease_prepared, "Prepared by the leasing team", "Not yet"))}
    ${line("Tenant Signatures", state(progress.tenants_signed, "All tenants have signed", "Not yet"))}
    ${line("Your Signature", state(progress.landlord_signed, "Recorded", progress.tenants_signed ? "Next, through the signing service" : "After the tenants"))}
    ${line("Signed Copy", row.signed_lease ? `<a href="/api/admin/cases/${esc(id)}/signed-lease">${esc(row.signed_lease.name)}</a>` : '<span class="soft">Not filed yet</span>')}
  </div>`, row.status === "lease_signed" ? '<span class="pill is-good">Complete</span>' : progress.lease_prepared ? '<span class="pill is-busy">Signing</span>' : '<span class="pill is-off">Not started</span>');
}

function renderLandlordCase(host, { api, session, id, row }) {
  const allowed = row.allowed_actions || [], offer = row.recommendation || {}, terms = offer.terms || {}, decision = row.landlord_decision;
  const step = row.next_step || {};
  const where = place(row);
  const askAgent = offer.sent_by ? mailto(offer.sent_by, `Question about the recommendation for ${where}`, `Hello,\n\nI have a question about the rental recommendation for ${where} (${row.name}).\n\n`) : "";
  const strip = `<section class="cw-strip" aria-label="Proposed terms">${[
    ["Monthly Rent", termText("rent.monthly", terms["rent.monthly"])],
    ["Lease Start", termText("lease.commencement_date", terms["lease.commencement_date"])],
    ["Lease End", termText("lease.end_date", terms["lease.end_date"])],
    ["Security Deposit", termText("deposit.amount", terms["deposit.amount"])],
    ["Rent Due Day", terms["rent.due_day"] ? `Day ${terms["rent.due_day"]}` : ""]
  ].map(([label, value]) => `<div class="stat"><span class="k">${esc(label)}</span><b>${value ? esc(value) : '<span class="soft">Not set</span>'}</b></div>`).join("")}</section>`;

  host.innerHTML = `<a class="link" href="#/overview">← My workspace</a>
    ${heading(session.role, row.name || "Rental", home(row))}
    ${landlordStepper(row)}
    ${strip}
    ${panel(step.label || "Next step", offer.sent_at ? `Recommended by Star on ${shortDay(offer.sent_at)}${offer.revision > 1 ? `, revision ${offer.revision}` : ""}.` : "", landlordDecision(row, decision) + landlordPrimary(row, id, terms, decision, allowed), stagePill(row.status), "cw-next-panel")}
    <div class="cw-grid">
      <div>
        ${tenantPanel(row, offer.summary)}
        ${verifiedPanel(offer.summary)}
        ${terms["concession.terms"] ? panel("Concessions", "Agreed incentives written into the lease.", `<p class="desk-prewrap">${esc(terms["concession.terms"])}</p>`) : ""}
      </div>
      <aside>
        ${landlordLeasePanel(row, id)}
        ${panel("Questions", "", `<p class="cw-note">${offer.sent_by ? `${esc(offer.sent_by)} sent this recommendation and handles the rental.` : "Your leasing team handles the rental."}</p><div class="cw-actions">${askAgent ? `<a class="desk-button" href="${askAgent}">Email the Agent</a>` : ""}<a class="desk-button" href="#/requests/${esc(row.listing_id || "")}">Request a Property Change</a></div>`)}
      </aside>
    </div>`;
  bindCase(host, { row, id, api, session }, () => renderCaseDetail(host, { api, session, id }));
}

// ------------------------------------------------------------ behaviour

function bindCase(host, ctx, reload) {
  const { row, id, api, session } = ctx;
  const selectTab = key => {
    if (!host.querySelector(`[data-case-tab="${key}"]`)) return;
    if (ctx.viewKey) detailViews.set(ctx.viewKey, key);
    host.querySelectorAll('[data-case-tab]').forEach(tab => { const active=tab.dataset.caseTab === key; tab.setAttribute('aria-selected',String(active)); tab.tabIndex=active ? 0 : -1; });
    host.querySelectorAll('.cw-detail-section').forEach(section => {section.hidden=section.id !== `cw-section-${key}`;});
  };
  host.onkeydown = event => {
    const tab=event.target.closest('[data-case-tab]');
    if (!tab || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const tabs=[...host.querySelectorAll('[data-case-tab]')], at=tabs.indexOf(tab);
    const next=event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : (at+(event.key === 'ArrowRight' ? 1 : -1)+tabs.length)%tabs.length;
    selectTab(tabs[next].dataset.caseTab);tabs[next].focus();
  };
  host.onclick = async event => {
    const tab=event.target.closest('[data-case-tab], [data-case-tab-target]');
    if (tab) {
      const key=tab.dataset.caseTab || tab.dataset.caseTabTarget;
      selectTab(key);
      if (tab.dataset.caseTabTarget) { const target=host.querySelector(`[data-case-tab="${key}"]`); target?.focus(); target?.scrollIntoView({block:'nearest'}); }
      return;
    }
    if (event.target.closest("[data-review-jump]")) {
      const decision = host.querySelector('.cw-decision-panel');
      decision?.scrollIntoView({block:'start',behavior:'smooth'});
      decision?.querySelector('summary')?.focus({preventScroll:true});
      return;
    }
    if (event.target.closest("[data-case-refresh]")) return reload();
    const button = event.target.closest("[data-download-lease]");
    if (!button) return;
    button.disabled = true;
    try {
      const response = await fetch(`/api/admin/lease/document/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "final" }), credentials: "same-origin" });
      if (!response.ok) throw new Error((await response.json()).error || "Could not generate the lease.");
      const url = URL.createObjectURL(await response.blob()), a = document.createElement("a");
      a.href = url; a.download = `lease-${String(row.name || "tenant").replace(/[^\w]+/g, "-").toLowerCase()}.docx`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      await reload();
    } catch (error) {
      const p = document.createElement("p"); p.setAttribute("role", "alert"); p.textContent = error.message; button.after(p);
      button.disabled = false;
    }
  };
  // The end date follows the start date and the applied-for term until the
  // agent types an end date of their own.
  host.oninput = event => {
    const form = event.target.closest('form[data-action="terms"], form[data-action="review_and_recommend"]');
    if (!form) return;
    const end = form.elements["lease.end_date"];
    if (event.target === end) { end.dataset.auto = "0"; return; }
    if (event.target.name === "lease.commencement_date" && end && end.dataset.auto === "1") {
      end.value = endOfTerm(event.target.value, Number(row.lease_term_months)) || end.value;
    }
  };
  host.onsubmit = async event => {
    const form = event.target;
    if (!form.matches(".case-action-form, #archive-lease")) return;
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]'), feedback = form.querySelector('[role="status"]');
    button.disabled = true; feedback.textContent = "Saving…";
    try {
      const data = new FormData(form);
      let result;
      if (form.id === "archive-lease") {
        data.set("version", String(row.workspace_version));
        result = await api(`/cases/${encodeURIComponent(id)}/signed-lease`, { method: "POST", body: data });
      } else {
        const command = { ...Object.fromEntries(data), action: form.dataset.action, version: row.workspace_version };
        if (command.action === "terms") { command.terms = Object.fromEntries(data); TERM_IDS.forEach(key => delete command[key]); }
        if (command.action === "review_and_recommend") {
          command.terms = Object.fromEntries(TERM_IDS.map(key => [key, data.get(key)]).filter(([,value])=>value !== null));
          TERM_IDS.forEach(key => delete command[key]);
          command.confirmed = data.get("confirmed") === "on";
        }
        if (command.action === "assign") command.collaborator_emails = data.getAll("collaborator_emails");
        if (command.action === "landlord_changes") {
          // Blank figures mean "no proposal on this one", not a proposal of nothing.
          const offered = {};
          for (const key of ["rent.monthly", "deposit.amount", "lease.commencement_date", "lease.end_date"]) {
            if (String(command[key] ?? "").trim()) offered[key] = command[key];
            delete command[key];
          }
          if (Object.keys(offered).length) command.terms = offered;
        }
        result = await api(`/cases/${encodeURIComponent(id)}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
        // The request is recorded; now it has to reach the applicant. Open the
        // draft in the same gesture, so the two cannot drift apart.
        if (command.action === "request_info" && session.role !== "landlord" && row.email) {
          location.href = drafts(row, session).request(String(command.reason || ""));
        }
      }
      if (result.case?.recorded) {
        host.innerHTML = heading(session.role, "Decision Recorded", "Your leasing team will take it from here.") + '<a class="desk-button" href="#/overview">Back to My Workspace</a>';
        return;
      }
      await reload();
      const notice = document.createElement("p");
      notice.className = "cw-saved"; notice.setAttribute("role", "status");
      notice.textContent = result.notified === true ? `Saved. The landlord was emailed at ${result.case?.workspace?.recommendation?.landlord_email || "their address"}.`
        : result.notified === false ? "Saved. The email to the landlord could not be sent. Use Email the Landlord to reach them."
          : "Saved. The next step is up to date.";
      host.querySelector(".pagehead")?.after(notice);
    } catch (error) {
      feedback.textContent = error.message; button.disabled = false;
    }
  };
}
