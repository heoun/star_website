import type { WorkspacePrincipal, WorkspaceProperty, WorkspaceApplication, WorkspaceCommand, WorkspaceRepository,
  WorkspaceAction, WorkspaceState, WorkspaceTerms, RecommendationSummary, WorkspaceReviewPolicy } from "../contracts/workspace.ts";

export class WorkspaceError extends Error {
  status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}
const email = (value: unknown) => String(value ?? "").trim().toLowerCase();
const text = (value: unknown, max = 4000) => String(value ?? "").trim().slice(0, max);
const same = (a: unknown, b: unknown) => email(a) !== "" && email(a) === email(b);
export const TERM_FIELDS = ["lease.effective_date", "lease.commencement_date", "lease.end_date",
  "rent.monthly", "rent.due_day", "deposit.amount", "concession.terms"] as const;
// What a landlord may counter on. The due day and the agreement date are the
// team's to set; a landlord who wants them changed says so in the comment.
const LANDLORD_TERMS = ["rent.monthly", "lease.commencement_date", "lease.end_date", "deposit.amount", "concession.terms"];
const CLOSED = ["declined", "lease_signed"];
const SHARED = ["sent_to_landlord", "landlord_approved", "lease_sent", "lease_signed"];

export function projectLandlordProperty(p: WorkspacePrincipal, row: WorkspaceProperty) {
  if (p.role !== "landlord" || !p.property_ids?.includes(row.id)) return null;
  const { id, name, street, city, state_abbr, zip, declared_units } = row;
  return { id, name, street, city, state_abbr, zip, declared_units };
}

// Every external fact the team records before an application can be approved:
// the fee, the screening report, the documents.
export function checksComplete(w: WorkspaceState): boolean {
  return w.checks?.documents === "verified" && w.checks.screening === "received" && ["paid", "waived"].includes(w.checks.fee);
}

type DocumentRow = { created_at?: string };
function documentsOf(row: WorkspaceApplication): DocumentRow[] {
  return Array.isArray(row.application_documents) ? row.application_documents as DocumentRow[] : [];
}

// Whether anything arrived after a given moment. An applicant answering a
// request by uploading a file changes nothing in the workspace itself, so the
// upload is the only evidence the request was answered.
function uploadedAfter(row: WorkspaceApplication, at: string | undefined): boolean {
  const since = at ? Date.parse(at) : NaN;
  return Number.isFinite(since) && documentsOf(row).some(doc => Date.parse(doc.created_at || "") > since);
}

// When the case last moved, from the case's own point of view: the last thing
// anybody did to it, or the last file that arrived, whichever is later. Not
// updated_at, which every housekeeping write touches.
function lastChange(row: WorkspaceApplication): string {
  const times = [row.created_at as string, ...(row.workspace?.activity || []).map(item => item.at),
    ...documentsOf(row).map(doc => doc.created_at || "")].filter(Boolean).map(value => Date.parse(value)).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : String(row.created_at || "");
}

export function canAccessCase(p: WorkspacePrincipal, row: WorkspaceApplication): boolean {
  if (p.role === "manager") return true;
  if (p.role === "agent") return same(p.email, row.responsible_email)
    || (row.collaborator_emails || []).some(value => same(p.email, value));
  const recommendation = row.workspace?.recommendation;
  return p.role === "landlord" && !!recommendation && SHARED.includes(row.status)
    && same(p.email, recommendation.landlord_email)
    && !!row.listings?.building_id && (p.property_ids || []).includes(row.listings.building_id);
}

export function allowedCaseActions(p: WorkspacePrincipal, row: WorkspaceApplication): WorkspaceAction[] {
  if (!canAccessCase(p, row)) return [];
  const w = row.workspace || {};
  if (p.role === "landlord") return row.status === "sent_to_landlord"
    ? ["landlord_accept", "landlord_changes", "landlord_decline"] : [];
  const actions: WorkspaceAction[] = p.role === "manager" ? ["assign", "note", "admin_note"] : ["note"];
  if (CLOSED.includes(row.status)) return actions;
  if (!["lease_sent", "landlord_approved"].includes(row.status)) {
    actions.push("terms", "checks", "request_info", "decline");
    if (row.status !== "sent_to_landlord" && checksComplete(w)) actions.push("approve");
  }
  if (![...SHARED, ...CLOSED].includes(row.status)) actions.push("review_and_recommend");
  if (row.status === "approved" && w.review) actions.push("recommend");
  if (row.status === "landlord_approved") actions.push(w.lease_preparation ? "record_tenant_signature" : "prepare_lease");
  if (row.status === "lease_sent" && w.tenant_signature && !w.landlord_signature) actions.push("record_landlord_signature");
  if (w.landlord_signature && !w.signed_lease) actions.push("archive_lease");
  return actions;
}

const STAFF_FIELDS = (`id listing_id name first_name last_name email phone current_address move_in lease_term_months
  dob ssn_last4 id_type children_under_11 wants_window_guards income_note current_employer employment_history rental_history
  reference_contacts emergency_contacts pets message status created_at updated_at employment_status student roommates
  notes concession_terms decision responsible_email collaborator_emails workspace_version`).split(/\s+/).filter(Boolean);
const DOCUMENT_FIELDS = ["id", "doc_type", "file_name", "content_type", "size_bytes", "created_at"];
const pick = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(key => key in row).map(key => [key, row[key]]));

export function projectCase(p: WorkspacePrincipal, row: WorkspaceApplication, detail = false) {
  if (!canAccessCase(p, row)) throw new WorkspaceError("Application not found.", 404);
  const actions = allowedCaseActions(p, row);
  const base = { id: row.id, status: row.status, workspace_version: row.workspace_version || 0,
    allowed_actions: actions, editable_fields: actions.includes("terms") ? [...TERM_FIELDS] : [],
    next_step: nextStep(p, row) };
  const w = row.workspace || {};
  if (p.role === "landlord") {
    // A separately-shaped response. Never attach the original row, raw uploads,
    // staff notes, report evidence, identities or arbitrary nested JSON here.
    const recommendation = w.recommendation!;
    return { ...base, name: recommendation.tenant_name, listing_id: row.listing_id,
      listings: { id: row.listing_id, title: recommendation.property_title, unit: recommendation.unit },
      recommendation: { revision: recommendation.revision, sent_at: recommendation.sent_at, sent_by: recommendation.sent_by,
        tenant_name: recommendation.tenant_name, terms: recommendation.terms, summary: recommendation.summary || null },
      landlord_decision: w.landlord_decision && { outcome: w.landlord_decision.outcome,
        comment: w.landlord_decision.comment, at: w.landlord_decision.at, proposed_terms: w.landlord_decision.proposed_terms || null },
      // Where the lease stands, as facts a landlord can act on: whether it is
      // waiting on their signature, and whether the signed copy is filed.
      progress: { lease_prepared: !!w.lease_preparation, tenants_signed: !!w.tenant_signature,
        landlord_signed: !!w.landlord_signature, archived: !!w.signed_lease },
      signed_lease: w.signed_lease ? { name: w.signed_lease.name, uploaded_at: w.signed_lease.uploaded_at } : null };
  }
  const { admin_note, signed_lease, ...teamState } = w;
  const common = { ...base, name: row.name, listing_id: row.listing_id, listings: row.listings,
    responsible_email: row.responsible_email, collaborator_emails: row.collaborator_emails || [],
    created_at: row.created_at, updated_at: row.updated_at,
    // What a queue row needs to be read without opening it: how to reach the
    // applicant, when they want to move in, and which documents have arrived.
    email: row.email, phone: row.phone, move_in: row.move_in, lease_term_months: row.lease_term_months,
    employment_status: row.employment_status,
    application_documents: documentsOf(row).map(doc => pick(doc as Record<string, unknown>, DOCUMENT_FIELDS)),
    workspace: { ...teamState,
      activity: (teamState.activity || []).filter(item => p.role === "manager" || item.action !== "admin_note"),
      ...(p.role === "manager" ? { admin_note: admin_note || "" } : {}),
      signed_lease: signed_lease ? { name: signed_lease.name, uploaded_at: signed_lease.uploaded_at } : null },
    signed_lease: signed_lease ? { name: signed_lease.name, uploaded_at: signed_lease.uploaded_at } : null };
  if (!detail) return common;
  return { ...pick(row, STAFF_FIELDS), ...common,
    ...(p.role === "manager" ? { submitted: row.submitted } : {}) };
}

// The one line a queue row shows and a case page leads with: what happens
// next, who it is waiting on, and since when. Written for the person reading
// it — an agent reads "Verify Payment, Screening and Documents", a landlord
// reads "Confirm Rental Terms" — so the label is the instruction, not the
// status.
//
//   bucket   attention (this reader acts) · waiting (somebody else does) ·
//            complete (nothing left)
//   owner    who the case is waiting on: you, applicant, landlord, team, admin
//   since    when the case last moved, for "waiting 3 days"
export interface NextStep { label: string; bucket: "attention" | "waiting" | "complete"; owner: string; since: string }

export function nextStep(p: WorkspacePrincipal, row: WorkspaceApplication): NextStep {
  const w = row.workspace || {};
  const since = lastChange(row);
  const step = (label: string, bucket: NextStep["bucket"], owner: string): NextStep => ({ label, bucket, owner, since });
  if (row.status === "lease_signed") return step("Lease Complete", "complete", "nobody");
  if (row.status === "declined") return step("Closed", "complete", "nobody");
  if (p.role === "manager" && !row.responsible_email) return step("Assign a Responsible Agent", "attention", "admin");
  if (p.role === "landlord") {
    if (row.status === "sent_to_landlord") return step("Confirm Rental Terms", "attention", "landlord");
    if (row.status === "landlord_approved") return step("Leasing Team Is Preparing Your Lease", "waiting", "team");
    if (w.landlord_signature) return step("Leasing Team Is Archiving the Lease", "waiting", "team");
    return step("Your Signature Is Next", "attention", "landlord");
  }
  switch (row.status) {
    case "sent_to_landlord": return step("Waiting for the Landlord", "waiting", "landlord");
    case "landlord_approved": return w.lease_preparation
      ? step("Send the Lease for Tenant Signatures", "attention", "you")
      : step("Prepare the Final Lease", "attention", "you");
    case "lease_sent": return w.landlord_signature
      ? step("Archive the Signed Lease", "attention", "you")
      : step("Get the Landlord's Signature", "attention", "you");
    case "approved": return w.review
      ? step("Send the Recommendation to the Landlord", "attention", "you")
      : step("Verify the Earlier Approval", "attention", "you");
    case "needs_info": return uploadedAfter(row, w.info_request?.at)
      ? step("Review New Documents", "attention", "you")
      : step("Waiting for the Applicant", "waiting", "applicant");
    case "fee_pending": return step("Waiting for the Application Fee", "waiting", "applicant");
    case "screening": return step("Waiting for the Screening Report", "waiting", "provider");
  }
  if (w.landlord_decision?.outcome === "changes") return step("Review the Landlord's Requested Changes", "attention", "you");
  return checksComplete(w)
    ? step("Approve or Request Information", "attention", "you")
    : step("Verify Payment, Screening and Documents", "attention", "you");
}

// The tenant as the landlord gets to know them: who will live there, how the
// rent is paid for, and what Star checked. Taken from the application once,
// when the recommendation goes out, so a later correction cannot change what
// the landlord agreed to.
function recommendationSummary(row: WorkspaceApplication, w: WorkspaceState, now: string): RecommendationSummary {
  const roommates = Array.isArray(row.roommates) ? row.roommates as Record<string, unknown>[] : [];
  const pets = Array.isArray(row.pets) ? row.pets as Record<string, unknown>[] : [];
  const months = Number(row.lease_term_months);
  return {
    move_in: text(row.move_in, 20),
    lease_term_months: Number.isInteger(months) && months > 0 ? months : null,
    employment_status: row.employment_status === "student" ? "student" : "employed",
    annual_income: text(row.income_note, 60),
    credit_score: w.checks?.credit_score ?? null,
    roommates: roommates.map(mate => text(`${mate?.first_name ?? ""} ${mate?.last_name ?? ""}`, 120)).filter(Boolean),
    pets: pets.map(pet => ({ type: text(pet?.type, 40), breed: text(pet?.species ?? pet?.breed, 60), weight: text(pet?.weight, 20) })).filter(pet => pet.type),
    verified: { fee: ["paid", "waived"].includes(w.checks?.fee || ""), screening: w.checks?.screening === "received",
      documents: w.checks?.documents === "verified", at: w.checks?.at || now }
  };
}

function normalizedTerms(raw: unknown): WorkspaceTerms {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WorkspaceError("Enter the terms for this lease.");
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(TERM_FIELDS as readonly string[]).includes(key)) throw new WorkspaceError("That field is maintained in property settings.", 403);
    const val = text(value, key === "concession.terms" ? 2000 : 100);
    if (["rent.monthly", "deposit.amount", "rent.due_day"].includes(key) && val) {
      const amount = Number(val);
      if (!Number.isFinite(amount) || amount < 0 || (key === "rent.monthly" && amount === 0)
        || (key === "rent.due_day" && (!Number.isInteger(amount) || amount < 1 || amount > 31))) throw new WorkspaceError("Check the rent, deposit and due day.");
    }
    if (key.startsWith("lease.") && val && (!/^\d{4}-\d{2}-\d{2}$/.test(val)
      || Number.isNaN(Date.parse(val)) || new Date(val).toISOString().slice(0, 10) !== val)) throw new WorkspaceError("Use a valid date for lease terms.");
    result[key] = val;
  }
  const start = result["lease.commencement_date"], end = result["lease.end_date"];
  if (start && end && end < start) throw new WorkspaceError("The lease end must follow the start date.");
  return result;
}

function normalizedChecks(command: WorkspaceCommand, actor: string, now: string): NonNullable<WorkspaceState["checks"]> {
  const reason = text(command.reason, 2000);
  const fee = text(command.fee), screening = text(command.screening), documents = text(command.documents);
  if (!["pending", "paid", "waived"].includes(fee) || !["pending", "received"].includes(screening) || !["pending", "verified"].includes(documents)) throw new WorkspaceError("Choose a valid verification status.");
  if (!reason) throw new WorkspaceError("Record the external provider/report reference and verification note.");
  // The score off the report, typed by the person who read it. It is
  // the one figure a landlord sees of the screening, so it is optional
  // and bounded rather than free text.
  const scoreText = text(command.credit_score, 10);
  const creditScore = scoreText ? Number(scoreText) : null;
  if (scoreText && (!Number.isInteger(creditScore) || creditScore! < 300 || creditScore! > 850)) throw new WorkspaceError("Enter a credit score between 300 and 850, or leave it blank.");
  return { fee, screening, documents, reference: reason, by: actor, at: now, credit_score: creditScore };
}

export function makeWorkspace(repo: WorkspaceRepository, reviewPolicy?: WorkspaceReviewPolicy) {
  const load = async (p: WorkspacePrincipal, id: string) => {
    const row = await repo.get(id);
    if (!row || !canAccessCase(p, row)) throw new WorkspaceError("Application not found.", 404);
    return row;
  };
  return {
    load,
    async list(p: WorkspacePrincipal) {
      const rows = await repo.list(p);
      return rows.filter(row => canAccessCase(p, row)).map(row => projectCase(p, row));
    },
    async get(p: WorkspacePrincipal, id: string) { return projectCase(p, await load(p, id), true); },
    async execute(p: WorkspacePrincipal, id: string, command: WorkspaceCommand) {
      const row = await load(p, id);
      if (!Number.isInteger(command.version) || command.version !== (row.workspace_version || 0)) throw new WorkspaceError("This case changed. Refresh it before saving.", 409);
      if (!allowedCaseActions(p, row).includes(command.action)) throw new WorkspaceError("This action is not available in the current stage or for this account.", 403);
      const w: WorkspaceState = structuredClone(row.workspace || {});
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = {};
      const reason = text(command.reason, 2000);
      switch (command.action) {
        case "assign": {
          const owner = email(command.responsible_email);
          if (!Array.isArray(command.collaborator_emails)) throw new WorkspaceError("Choose the case collaborators.");
          const collaborators = [...new Set(command.collaborator_emails.map(email))].filter(value => value && value !== owner);
          const roster = await repo.staff();
          if ([owner, ...collaborators].filter(Boolean).some(value => !roster.some(member => same(value, member.email) && member.active && ["manager", "agent"].includes(member.role)))) throw new WorkspaceError("Assign active team members only.");
          patch.responsible_email = owner || null; patch.collaborator_emails = collaborators;
          break;
        }
        case "checks": {
          w.checks = normalizedChecks(command, p.email, now);
          delete w.review; delete w.recommendation; delete w.landlord_decision;
          patch.status = w.checks.fee === "pending" ? "fee_pending" : w.checks.screening === "pending" ? "screening" : "review";
          break;
        }
        case "terms": {
          w.terms = { ...w.terms, ...normalizedTerms(command.terms) };
          normalizedTerms(w.terms);
          delete w.review; delete w.recommendation; delete w.landlord_decision;
          patch.status = "review";
          break;
        }
        case "approve": w.review = { by: p.email, at: now }; patch.status = "approved"; break;
        case "request_info":
        case "decline":
          if (!reason) throw new WorkspaceError("Add the reason or requested information.");
          patch.status = command.action === "decline" ? "declined" : "needs_info";
          if (command.action === "request_info") w.info_request = { message: reason, by: p.email, at: now };
          delete w.review; delete w.recommendation; delete w.landlord_decision;
          break;
        case "review_and_recommend":
        case "recommend": {
          if (command.action === "review_and_recommend") {
            if (command.confirmed !== true) throw new WorkspaceError("Confirm that you reviewed this application and its proposed terms.");
            if (!reviewPolicy) throw new WorkspaceError("The document checklist is unavailable. Try again later.", 503);
            const missing = reviewPolicy.missingDocuments(row);
            if (missing.length) throw new WorkspaceError(`Required documents are missing: ${missing.join(", ")}.`);
            if (!text(row.name)) throw new WorkspaceError("Complete the applicant's legal name before recommending.");
            w.checks = normalizedChecks(command, p.email, now);
            if (!checksComplete(w)) throw new WorkspaceError("Verify payment or waiver, review the screening report and supporting documents before recommending.");
            w.terms = normalizedTerms({ ...w.terms, ...normalizedTerms(command.terms) });
            // The agreement date is resolved when the lease is prepared. An
            // empty optional input must not erase that generated default.
            if (!w.terms["lease.effective_date"]) delete w.terms["lease.effective_date"];
            if (!w.terms["rent.due_day"]) delete w.terms["rent.due_day"];
            w.review = { by: p.email, at: now };
            if (!row.responsible_email) patch.responsible_email = p.email;
          }
          const roster = await repo.staff();
          const landlords = roster.filter(member => member.role === "landlord" && member.active && (member.property_ids || []).includes(row.listings?.building_id || ""));
          const recipient = email(command.landlord_email) || (command.action === "review_and_recommend" && landlords.length === 1 ? email(landlords[0].email) : "");
          if (!row.listings?.building_id || !roster.some(member => same(member.email, recipient) && member.role === "landlord" && member.active && (member.property_ids || []).includes(row.listings!.building_id!))) throw new WorkspaceError("Choose an active landlord assigned to this property.");
          const terms = w.terms || {};
          if (!terms["lease.commencement_date"] || !terms["lease.end_date"] || !terms["rent.monthly"] || !terms["deposit.amount"]) throw new WorkspaceError("Save the lease dates, monthly rent and deposit before sending.");
          w.recommendation = { revision: command.version + 1, sent_at: now, sent_by: p.email,
            landlord_email: recipient, tenant_name: text(row.name, 200), property_title: row.listings.title || "", unit: row.listings.unit || "", terms: { ...terms },
            summary: recommendationSummary(row, w, now) };
          delete w.landlord_decision;
          if (command.action === "review_and_recommend") {
            w.activity = [...(w.activity || []),
              { action: "checks", by: p.email, at: now, detail: "Verification confirmed during recommendation" },
              { action: "terms", by: p.email, at: now, detail: "Proposed terms confirmed during recommendation" },
              { action: "approve", by: p.email, at: now, detail: "Approved during recommendation" }];
          }
          patch.status = "sent_to_landlord"; break;
        }
        case "landlord_accept":
        case "landlord_changes":
        case "landlord_decline": {
          if (command.action !== "landlord_accept" && !reason) throw new WorkspaceError("Tell the leasing team what needs to change.");
          const outcome = command.action === "landlord_accept" ? "accepted" : command.action === "landlord_changes" ? "changes" : "declined";
          w.landlord_decision = { outcome, comment: reason, by: p.email, at: now, revision: w.recommendation!.revision };
          if (command.action === "landlord_changes" && command.terms !== undefined) {
            const proposed = normalizedTerms(command.terms);
            if (Object.keys(proposed).some(key => !LANDLORD_TERMS.includes(key))) throw new WorkspaceError("Propose the rent, the lease dates, the deposit or the concessions. Anything else goes in the comment.");
            const offered = Object.fromEntries(Object.entries(proposed).filter(([, value]) => value !== ""));
            if (Object.keys(offered).length) w.landlord_decision.proposed_terms = offered;
          }
          patch.status = outcome === "accepted" ? "landlord_approved" : outcome === "changes" ? "review" : "declined";
          if (outcome !== "accepted") delete w.review;
          break;
        }
        case "prepare_lease": {
          if (!command.lease_snapshot || typeof command.lease_snapshot !== "object") throw new WorkspaceError("A complete saved lease is required before signing.");
          w.lease_preparation = { by: p.email, at: now };
          patch.lease_snapshot = command.lease_snapshot;
          break;
        }
        case "record_tenant_signature":
        case "record_landlord_signature": {
          if (!reason) throw new WorkspaceError("Record the signing provider and signature receipt reference.");
          if (command.action === "record_tenant_signature") {
            if (!w.lease_preparation || !row.lease_snapshot) throw new WorkspaceError("Prepare the final lease before recording signatures.", 409);
            w.tenant_signature = { reference: reason, by: p.email, at: now }; patch.status = "lease_sent";
          }
          else w.landlord_signature = { reference: reason, by: p.email, at: now };
          break;
        }
        case "archive_lease": {
          // Only the server's verified upload handler supplies this command.
          const file = command.file as WorkspaceState["signed_lease"];
          if (!file?.path?.startsWith(`${id}/executed/`)) throw new WorkspaceError("Upload the fully signed lease PDF.");
          w.signed_lease = file; patch.status = "lease_signed"; break;
        }
        case "note": patch.notes = reason; break;
        case "admin_note": w.admin_note = reason; break;
      }
      w.activity = [...(w.activity || []), { action: command.action, by: p.email, at: now,
        detail: command.action === "admin_note" ? "Admin note updated" : reason }];
      patch.workspace = w;
      const saved = await repo.save(id, command.version, patch, p.email);
      if (!saved) throw new WorkspaceError("This case changed. Refresh it before saving.", 409);
      // A landlord requesting changes immediately loses intake access. Return
      // an acknowledgement instead of attempting to serialize that intake row.
      return canAccessCase(p, saved) ? projectCase(p, saved, true) : { id, recorded: true };
    }
  };
}
