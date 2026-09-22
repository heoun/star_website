// The end-to-end flow: listing -> application -> screening -> review ->
// landlord decision -> lease -> signatures -> executed. Pure orchestration;
// every effect goes through a port.

import type { Deps } from "./deps.ts";
import type { Application, Case, Id, Principal } from "../contracts/domain.ts";

function uuid(): Id {
  return crypto.randomUUID();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export class FlowError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------------------ apply

export interface ApplyInput {
  listingId: Id;
  name: string;
  email: string;
  answers?: Record<string, string>;
}

export async function submitApplication(deps: Deps, input: ApplyInput) {
  const listing = await deps.repos.listings.get(input.listingId);
  if (!listing || listing.status !== "published") {
    throw new FlowError(404, "Listing not found or not open for applications.");
  }

  const personId = uuid();
  const kase: Case = {
    id: uuid(),
    rentableId: listing.rentableId,
    listingId: listing.id,
    status: "open",
    members: [],
    moveInDate: input.answers?.["move_in"] || null,
    declineReason: null,
  };
  const application: Application = {
    id: uuid(),
    caseId: kase.id,
    applicant: { id: personId, name: input.name, email: input.email },
    status: "submitted",
    answers: input.answers || {},
  };
  kase.members.push({ personId, role: "primary", applicationId: application.id });

  await deps.repos.cases.create(kase);
  await deps.repos.applications.create(application);

  const started = await deps.screening.start({
    applicationId: application.id,
    caseId: kase.id,
    applicant: application.applicant,
  });
  await deps.repos.screenings.save({
    screeningId: started.screeningId,
    applicationId: application.id,
    status: "pending",
    creditScore: null,
    reportRef: null,
  });

  await deps.email.send({
    to: [input.email],
    template: "application_received",
    data: { name: input.name, caseId: kase.id },
  });
  await deps.events.emit({ type: "application.submitted", applicationId: application.id, caseId: kase.id });

  return { caseId: kase.id, applicationId: application.id, screeningUrl: started.applicantUrl };
}

// ------------------------------------------------------------ screening result

export async function handleScreeningWebhook(deps: Deps, body: unknown, headers: Record<string, string>) {
  const result = await deps.screening.parseWebhook(body, headers);
  if (!result) return { handled: false };

  await deps.repos.screenings.save(result);
  if (result.status === "complete") {
    await deps.repos.applications.setStatus(result.applicationId, "complete");
    await deps.events.emit({ type: "screening.completed", applicationId: result.applicationId });

    // When every member's application has a completed screening, the case is
    // ready for staff eyes.
    const app = await deps.repos.applications.get(result.applicationId);
    if (app) {
      const siblings = await deps.repos.applications.listByCase(app.caseId);
      const allDone = siblings.every((a) => a.status === "complete" || a.status === "withdrawn");
      const kase = await deps.repos.cases.get(app.caseId);
      if (allDone && kase && kase.status === "open") {
        await deps.repos.cases.setStatus(kase.id, "in_review");
      }
    }
  }
  return { handled: true };
}

// ------------------------------------------------------------ staff review

export async function sendToLandlord(deps: Deps, principal: Principal, caseId: Id, recipients: string[]) {
  requireCan(deps, principal, "case.send_to_landlord", caseId);
  const kase = await mustGetCase(deps, caseId);
  if (kase.status !== "in_review") {
    throw new FlowError(409, `Case is ${kase.status}; only a case in review can go to the landlord.`);
  }
  if (recipients.length === 0) {
    throw new FlowError(422, "Pick at least one recipient.");
  }

  // Ring 1: one placeholder landlord per listing. The landlord entity and its
  // contacts arrive with the real database ring.
  const url = await deps.auth.mintLandlordLink("landlord-dev", "contact-dev", "decision", 14);
  const link = `${url}${url.includes("?") ? "&" : "?"}case=${kase.id}`;

  await deps.email.send({
    to: recipients,
    template: "decision_package",
    data: { caseId: kase.id, decisionUrl: link },
  });
  await deps.repos.cases.setStatus(kase.id, "sent_to_landlord");
  await deps.events.emit({ type: "case.sent_to_landlord", caseId: kase.id });
  return { decisionUrl: link };
}

export async function declineCase(deps: Deps, principal: Principal, caseId: Id, reason: string) {
  requireCan(deps, principal, "case.decline", caseId);
  const kase = await mustGetCase(deps, caseId);
  if (kase.status === "executed" || kase.status === "closed") {
    throw new FlowError(409, `Case is already ${kase.status}.`);
  }
  await deps.repos.cases.setStatus(caseId, "declined", reason);
  return { ok: true };
}

// ------------------------------------------------------------ landlord decision

export async function recordDecision(deps: Deps, principal: Principal, caseId: Id, approved: boolean, note: string | null) {
  if (principal.kind !== "landlord_link" || principal.purpose !== "decision") {
    throw new FlowError(403, "Decisions arrive through the emailed link.");
  }
  const kase = await mustGetCase(deps, caseId);
  if (kase.status !== "sent_to_landlord") {
    throw new FlowError(409, `Case is ${kase.status}; there is nothing to decide.`);
  }

  await deps.repos.decisions.save({
    caseId,
    approved,
    decidedAt: new Date().toISOString(),
    contactId: principal.contactId,
    note,
  });
  await deps.repos.cases.setStatus(caseId, approved ? "approved" : "declined", approved ? undefined : "Landlord declined");
  await deps.email.send({
    to: ["office@starreusa.com"],
    template: "decision_recorded",
    data: { caseId, approved: String(approved) },
  });
  await deps.events.emit({ type: "landlord.decided", caseId, approved });
  return { ok: true };
}

// ------------------------------------------------------------ lease out

export async function sendLease(deps: Deps, principal: Principal, caseId: Id) {
  requireCan(deps, principal, "lease.send", caseId);
  const kase = await mustGetCase(deps, caseId);
  if (kase.status !== "approved") {
    throw new FlowError(409, `Case is ${kase.status}; only an approved case gets a lease.`);
  }

  // Ring 1 sends the draft build: property settings are all fake-empty, so a
  // final build would refuse on missing values. The final-only guard lands
  // with the real database ring.
  const generated = await deps.leasegen.build(caseId, "draft");

  const applications = await deps.repos.applications.listByCase(caseId);
  const tenants = applications
    .filter((a) => a.status !== "withdrawn")
    .map((a, index) => ({
      name: a.applicant.name,
      email: a.applicant.email,
      order: index + 1,
      role: "tenant" as const,
    }));
  const signers = [
    ...tenants,
    { name: "Landlord", email: "landlord@example.com", order: tenants.length + 1, role: "landlord" as const },
  ];

  const versionId = uuid();
  const envelope = await deps.esign.createEnvelope(
    versionId,
    generated.documents.map((d) => ({ name: d.name, docx: d.docx })),
    signers,
  );

  await deps.repos.leaseVersions.create({
    id: versionId,
    caseId,
    status: "sent",
    values: generated.values,
    envelopeRef: envelope.envelopeId,
    executedFileKey: null,
  });
  await deps.repos.cases.setStatus(caseId, "lease_sent");
  await deps.email.send({
    to: signers.map((s) => s.email),
    template: "lease_sent",
    data: { caseId, envelopeId: envelope.envelopeId },
  });
  await deps.events.emit({ type: "lease.sent", leaseVersionId: versionId });

  return { leaseVersionId: versionId, envelopeId: envelope.envelopeId, signerLinks: envelope.signerLinks, missing: generated.missing };
}

// ------------------------------------------------------------ signatures

export async function handleEsignWebhook(deps: Deps, body: unknown, headers: Record<string, string>) {
  const event = await deps.esign.parseWebhook(body, headers);
  if (!event) return { handled: false };

  const version = await findVersionByEnvelope(deps, event.envelopeId);
  if (!version) throw new FlowError(404, "No lease version matches that envelope.");

  if (event.type === "signed") {
    if (version.status === "sent") {
      version.status = "partially_signed";
      await deps.repos.leaseVersions.update(version);
    }
    return { handled: true, status: version.status };
  }

  if (event.type === "declined") {
    version.status = "voided";
    await deps.repos.leaseVersions.update(version);
    await deps.repos.cases.setStatus(version.caseId, "declined", "A signer declined the lease.");
    return { handled: true, status: version.status };
  }

  // completed: pull the signed set, file it, close the loop.
  const signed = await deps.esign.downloadCompleted(event.envelopeId);
  const key = `leases/${version.caseId}/${version.id}.docx`;
  await deps.storage.put("applicant-docs", key, signed, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  version.status = "executed";
  version.executedFileKey = key;
  await deps.repos.leaseVersions.update(version);
  await deps.repos.cases.setStatus(version.caseId, "executed");
  await deps.events.emit({ type: "lease.executed", leaseVersionId: version.id, caseId: version.caseId });

  const kase = await mustGetCase(deps, version.caseId);
  await deps.repos.listings.setStatus(kase.listingId, "rented");
  await deps.events.emit({ type: "listing.rented", listingId: kase.listingId, rentableId: kase.rentableId });

  // Competing open cases on the same rentable close with a reason staff can
  // reverse — the rule confirmed on 9/4: it fires only on full execution.
  const competitors = await deps.repos.cases.listOpenByRentable(kase.rentableId);
  for (const other of competitors) {
    if (other.id !== kase.id) {
      await deps.repos.cases.setStatus(other.id, "closed", "Unit no longer available");
    }
  }

  const applications = await deps.repos.applications.listByCase(version.caseId);
  await deps.email.send({
    to: applications.map((a) => a.applicant.email),
    template: "lease_executed",
    data: { caseId: version.caseId },
  });

  return { handled: true, status: version.status };
}

// ------------------------------------------------------------ helpers

function requireCan(deps: Deps, principal: Principal, action: Parameters<Deps["policy"]["can"]>[1], id: Id) {
  if (!deps.policy.can(principal, action, { type: "case", id })) {
    throw new FlowError(403, `Not allowed: ${action}.`);
  }
}

async function mustGetCase(deps: Deps, caseId: Id) {
  const kase = await deps.repos.cases.get(caseId);
  if (!kase) throw new FlowError(404, "Case not found.");
  return kase;
}

async function findVersionByEnvelope(deps: Deps, envelopeId: string) {
  // Repos stay minimal; the memory adapter scans, the SQL adapter will index.
  const version = await deps.repos.leaseVersions.getByEnvelope(envelopeId);
  return version;
}

export function todayIso(): string {
  return today();
}
