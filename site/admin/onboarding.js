import { esc, day, heading, empty, send, generation, intakeLabels, intakeFacts } from "./admin-ui.js";
const mailLabel = row => row.email_state === "failed" ? "Email failed · resend needed" : row.email_state === "preview" ? "Saved to demo inbox" : row.email_state === "sent" ? "Email accepted by sender" : "Email pending";
export async function renderOnboarding(host, { api, session, id = "" }) {
  const current = generation(host);
  host.innerHTML = heading("Landlord onboarding", "Invite a partner. Review their information. Add approved properties.")+'<p role="status">Loading onboarding…</p>';
  try {
    if (id && id !== "new") {
      const { invitation: row } = await api(`/onboarding/${encodeURIComponent(id)}`); if (!current()) return;
      const open = !["approved","rejected","cancelled"].includes(row.status);
      host.innerHTML = '<a class="link" href="#/onboarding">← All landlord onboarding</a>'+heading(row.contact_name, row.email)+`
        <div class="case-stage"><span class="pill">${intakeLabels[row.status]}</span><span>${mailLabel(row)} · expires ${day(row.expires_at)}</span></div>
        <div class="onboarding-review-layout"><section class="desk-panel"><div class="desk-panel-head"><h2>${["invited","changes_requested"].includes(row.status) ? "Information in progress" : "Submitted information"}</h2><span>${row.data.properties?.length || 0} properties</span></div>${row.data.properties?.length ? intakeFacts(row.data) : empty("Waiting for the landlord", "Their contact and property details will appear here when they save or submit the form.")}</section>
        <aside><section class="desk-panel desk-panel-body"><span class="k">Your next step</span><h2>${row.status==="submitted" ? "Review & approve" : row.status==="approved" ? "Properties are ready to manage" : "Invitation status"}</h2>
          ${row.status==="submitted" ? '<p>Approval creates the properties, imports the supplied landlord and utility defaults, and links this landlord account in one step. Existing properties are never overwritten.</p><form class="desk-form" data-onboarding-action="approve"><button class="primary">Approve & add properties</button><p role="status"></p></form><details class="case-disclosure"><summary>Request corrections</summary><form class="desk-form" data-onboarding-action="request_changes"><label>What should the landlord update?<textarea name="reason" required minlength="5" maxlength="2000"></textarea></label><button>Send update request</button><p role="status"></p></form></details><details class="case-disclosure"><summary>Decline this submission</summary><form class="desk-form" data-onboarding-action="reject"><label>Reason<textarea name="reason" required minlength="5" maxlength="2000"></textarea></label><button>Decline submission</button><p role="status"></p></form></details>' : ""}
          ${["invited","changes_requested"].includes(row.status) ? '<p>The landlord can save a draft and return before the link expires. A new invitation replaces the previous link.</p><form class="desk-form" data-onboarding-action="resend"><button>Send a new invitation link</button><p role="status"></p></form>' : ""}
          ${row.status==="approved" ? `<p>The landlord account and property assignments were created together. Complete any remaining lease defaults before preparing a lease.</p>${row.building_ids.map((p,i)=>`<a class="admin-shortcut" href="#/properties/${esc(p)}"><b>Open ${esc(row.data.properties?.[i]?.name || "property")}</b><span>→</span></a>`).join("")}<a href="#/staff">Open Accounts & access →</a>` : ""}
          ${open ? '<details class="case-disclosure"><summary>Cancel invitation</summary><form class="desk-form" data-onboarding-action="cancel"><p>This closes the invitation and stops the form from accepting changes.</p><button>Cancel invitation</button><p role="status"></p></form></details>' : ""}
          ${row.review_note ? `<div class="desk-response"><b>Review feedback</b><p class="desk-prewrap">${esc(row.review_note)}</p></div>` : ""}
          ${session.demo ? '<a class="admin-shortcut" href="/__demo/inbox" target="_blank" rel="noopener">Open local demo inbox ↗</a>' : ""}
        </section><details class="case-disclosure"><summary>Onboarding history</summary><ol class="case-history">${row.activity.slice().reverse().map(a=>`<li><b>${esc(a.action.replaceAll("_"," "))}</b><small>${esc(a.by)} · ${day(a.at)}</small><p>${esc(a.note)}</p></li>`).join("")}</ol></details></aside></div>`;
      host.onsubmit = async event => {
        const form=event.target.closest("[data-onboarding-action]");if(!form)return;event.preventDefault();
        const button=form.querySelector("button"), feedback=form.querySelector('[role="status"]');button.disabled=true;feedback.textContent="Saving…";
        try { const result = await send(api, `/onboarding/${id}/actions`, {action:form.dataset.onboardingAction,version:row.version,reason:new FormData(form).get("reason") || ""}); if(current()) { await renderOnboarding(host,{api,session,id}); if (result.account_invitation) host.insertAdjacentHTML("afterbegin", `<p class="case-saved" role="status">${result.account_invitation.status === "sent" ? "Properties approved. The landlord has been emailed an account activation code." : result.account_invitation.status === "preview" ? "Properties approved in the local demo. No activation email was sent." : "Properties approved, but the activation email failed. Retry from Accounts & access."}</p>`); } }
        catch(error){feedback.textContent=error.message;button.disabled=false;}
      };
      return;
    }
    const { invitations }=await api("/onboarding");if(!current())return;
    let filter="active";
    host.innerHTML=heading("Landlord onboarding", "Bring new landlords and properties into your portfolio without re-entering their details.")+`
      <div class="onboarding-steps"><span><b>1</b> Invite landlord</span><span><b>2</b> Landlord fills form</span><span><b>3</b> Admin reviews</span><span><b>4</b> Properties added</span></div>
      <div class="onboarding-review-layout"><section class="desk-panel"><div class="desk-panel-head"><h2>Invitations & submissions</h2><label>Status<select id="onboarding-filter"><option value="active">Active onboarding</option><option value="submitted">Ready for review</option><option value="approved">Approved</option><option value="all">All invitations</option></select></label></div><div id="onboarding-rows"></div></section>
      <aside class="desk-panel desk-panel-body"><span class="k">New partnership</span><h2>Invite a landlord</h2><p>The email opens a private form for their contact information and up to ten properties.</p><form id="landlord-invite" class="desk-form"><label>Contact name<input name="contact_name" maxlength="120" required autocomplete="name"></label><label>Landlord email<input name="email" type="email" maxlength="180" required autocomplete="email"></label><button class="primary">Send invitation</button><p role="status"></p></form><p class="soft">The landlord does not need an account to complete the form. Their account and property access are created only after approval.</p>${session.demo ? '<a href="/__demo/inbox" target="_blank" rel="noopener">Open local demo inbox ↗</a>' : ""}</aside></div>`;
    const draw=()=>{const rows=invitations.filter(i=>filter==="all" || filter==="active" && !["approved","cancelled","rejected"].includes(i.status) || i.status===filter);host.querySelector("#onboarding-rows").innerHTML=rows.length ? rows.map(i=>`<a class="admin-task" href="#/onboarding/${esc(i.id)}"><span><b>${esc(i.contact_name)}</b><small>${esc(i.email)}</small><span>${intakeLabels[i.status]} · ${mailLabel(i)}</span></span><span>→</span></a>`).join("") : empty("No invitations in this view","Start with the landlord's name and email. They can add their new properties in the form.");};draw();
    host.querySelector("#onboarding-filter").onchange=e=>{filter=e.target.value;draw();};
    const invitationId=crypto.randomUUID();
    host.querySelector("#landlord-invite").onsubmit=async event=>{
      event.preventDefault();const form=event.currentTarget,button=form.querySelector("button"),feedback=form.querySelector('[role="status"]');button.disabled=true;feedback.textContent="Creating invitation…";
      try{const {invitation}=await send(api,"/onboarding",{...Object.fromEntries(new FormData(form)),id:invitationId}); if(current()) location.hash=`#/onboarding/${invitation.id}`;}
      catch(error){feedback.textContent=error.message;button.disabled=false;}
    };
    if(id==="new")host.querySelector('[name="contact_name"]').focus();
  }catch(error){if(current())host.innerHTML=heading("Landlord onboarding","")+empty("Onboarding unavailable",error.message);}
}
