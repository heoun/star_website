// In-memory persistence for the tracer bullet. Module-level state so it
// survives across requests within one dev isolate. Seeds one published
// listing so the flow has somewhere to start.

import type {
  Application, Case, CaseStatus, Id, LandlordDecision, LeaseVersion, Listing, ScreeningResult,
} from "../../contracts/domain.ts";
import type { Repos } from "../../contracts/repos.ts";

const listings = new Map<Id, Listing>();
const cases = new Map<Id, Case>();
const applications = new Map<Id, Application>();
const screenings = new Map<Id, ScreeningResult>(); // by applicationId
const leaseVersions = new Map<Id, LeaseVersion>();
const decisions = new Map<Id, LandlordDecision>(); // by caseId

function seed() {
  if (listings.size > 0) return;
  const listing: Listing = {
    id: "listing-dev-1",
    propertyId: null,
    unitLabel: "3C",
    rentableId: "rentable-dev-1",
    rent: 2450,
    availableOn: null,
    status: "published",
    agentUserId: null,
  };
  listings.set(listing.id, listing);
}

export function makeMemoryRepos(): Repos {
  seed();
  return {
    listings: {
      async get(id) { return listings.get(id) ?? null; },
      async listPublished() {
        return [...listings.values()].filter((l) => l.status === "published");
      },
      async listAll(limit) {
        return [...listings.values()].slice(0, limit);
      },
      async setStatus(id, status) {
        const row = listings.get(id);
        if (row) row.status = status;
      },
    },
    cases: {
      async create(c) { cases.set(c.id, structuredClone(c)); },
      async get(id) { return cases.get(id) ? structuredClone(cases.get(id)!) : null; },
      async listOpenByRentable(rentableId) {
        const OPEN: CaseStatus[] = ["open", "in_review", "sent_to_landlord", "approved", "lease_sent"];
        return [...cases.values()]
          .filter((c) => c.rentableId === rentableId && OPEN.includes(c.status))
          .map((c) => structuredClone(c));
      },
      async listRecent(limit) {
        return [...cases.values()].slice(-limit).reverse().map((c) => structuredClone(c));
      },
      async setStatus(id, status, declineReason) {
        const row = cases.get(id);
        if (!row) return;
        row.status = status;
        if (declineReason !== undefined) row.declineReason = declineReason;
      },
      async addMember(caseId, member) {
        cases.get(caseId)?.members.push(member);
      },
    },
    applications: {
      async create(a) { applications.set(a.id, structuredClone(a)); },
      async get(id) { return applications.get(id) ? structuredClone(applications.get(id)!) : null; },
      async listByCase(caseId) {
        return [...applications.values()].filter((a) => a.caseId === caseId).map((a) => structuredClone(a));
      },
      async setStatus(id, status) {
        const row = applications.get(id);
        if (row) row.status = status;
      },
      async saveAnswers(id, answers) {
        const row = applications.get(id);
        if (row) row.answers = { ...row.answers, ...answers };
      },
    },
    screenings: {
      async save(r) { screenings.set(r.applicationId, structuredClone(r)); },
      async getByApplication(applicationId) {
        return screenings.get(applicationId) ? structuredClone(screenings.get(applicationId)!) : null;
      },
    },
    leaseVersions: {
      async create(v) { leaseVersions.set(v.id, structuredClone(v)); },
      async get(id) { return leaseVersions.get(id) ? structuredClone(leaseVersions.get(id)!) : null; },
      async getCurrentByCase(caseId) {
        const rows = [...leaseVersions.values()].filter((v) => v.caseId === caseId);
        return rows.length ? structuredClone(rows[rows.length - 1]) : null;
      },
      async getByEnvelope(envelopeRef) {
        const row = [...leaseVersions.values()].find((v) => v.envelopeRef === envelopeRef);
        return row ? structuredClone(row) : null;
      },
      async update(v) { leaseVersions.set(v.id, structuredClone(v)); },
    },
    decisions: {
      async save(d) { decisions.set(d.caseId, structuredClone(d)); },
      async getByCase(caseId) {
        return decisions.get(caseId) ? structuredClone(decisions.get(caseId)!) : null;
      },
    },
  };
}
