// Persistence port, one repository per aggregate. Methods exist because a use
// case needs them — grow additively, never speculatively.
// Implementations: adapters/db-memory (Ring 1), adapters/db-supabase (Ring 2).

import type {
  Application, Case, CaseStatus, Id, LandlordDecision, LeaseVersion, Listing, ScreeningResult,
} from "./domain";

export interface ListingsRepo {
  get(id: Id): Promise<Listing | null>;
  listPublished(): Promise<Listing[]>;
  // The staff inventory view: every residential rental, whatever its state.
  listAll(limit: number): Promise<Listing[]>;
  setStatus(id: Id, status: Listing["status"]): Promise<void>;
}

export interface CasesRepo {
  create(c: Case): Promise<void>;
  get(id: Id): Promise<Case | null>;
  // The auto-decline rule and the one-active-lease rule both key on rentable.
  listOpenByRentable(rentableId: Id): Promise<Case[]>;
  listRecent(limit: number): Promise<Case[]>;
  setStatus(id: Id, status: CaseStatus, declineReason?: string): Promise<void>;
  addMember(caseId: Id, member: Case["members"][number]): Promise<void>;
}

export interface ApplicationsRepo {
  create(a: Application): Promise<void>;
  get(id: Id): Promise<Application | null>;
  listByCase(caseId: Id): Promise<Application[]>;
  setStatus(id: Id, status: Application["status"]): Promise<void>;
  saveAnswers(id: Id, answers: Record<string, string>): Promise<void>;
}

export interface ScreeningsRepo {
  save(r: ScreeningResult): Promise<void>;
  getByApplication(applicationId: Id): Promise<ScreeningResult | null>;
}

export interface LeaseVersionsRepo {
  create(v: LeaseVersion): Promise<void>;
  get(id: Id): Promise<LeaseVersion | null>;
  getCurrentByCase(caseId: Id): Promise<LeaseVersion | null>;
  getByEnvelope(envelopeRef: string): Promise<LeaseVersion | null>;
  update(v: LeaseVersion): Promise<void>;
}

export interface DecisionsRepo {
  save(d: LandlordDecision): Promise<void>;
  getByCase(caseId: Id): Promise<LandlordDecision | null>;
}

// Everything a use case can reach, handed in by app/wiring.ts.
export interface Repos {
  listings: ListingsRepo;
  cases: CasesRepo;
  applications: ApplicationsRepo;
  screenings: ScreeningsRepo;
  leaseVersions: LeaseVersionsRepo;
  decisions: DecisionsRepo;
}
