// Persistence on Supabase Postgres through PostgREST, in the `backend` schema
// (see backend/migrations/0001_ring2_core_tables.sql). Self-contained client:
// the service role key stays in the Worker, RLS stays on, and no legacy code
// is involved.

import type {
  Application, Case, CaseStatus, LandlordDecision, LeaseVersion, Listing, ScreeningResult,
} from "../../contracts/domain.ts";
import type { Repos } from "../../contracts/repos.ts";

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

const OPEN_CASE_STATUSES: CaseStatus[] = ["open", "in_review", "sent_to_landlord", "approved", "lease_sent"];

function client(config: SupabaseConfig) {
  const base = config.url.replace(/\/+$/, "") + "/rest/v1";
  return async function pgrest(method: string, path: string, body?: unknown, prefer?: string, profile = "backend"): Promise<unknown> {
    const headers: Record<string, string> = {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      "Accept-Profile": profile,
      "Content-Profile": profile,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (prefer) headers.Prefer = prefer;

    const response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Supabase ${method} ${path} -> ${response.status}: ${detail.slice(0, 300)}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
}

// ------------------------------------------------------------ row mapping

// Ring 9: listings are the real inventory in public.listings. v2 does not
// alter that table; states the legacy `published` boolean cannot express live
// in the backend.listing_state overlay, and every rental carries a
// deterministic whole-unit rentable id, 'rl-<listing id>'.
interface PublicListingRow {
  id: string; title: string; property_name: string | null; unit: string | null;
  price_amount: number | string | null; building_id: string | null; published: boolean;
}
interface OverlayRow { listing_id: string; status: "rented" | "archived" }

function rentableIdFor(listingId: string): string {
  return `rl-${listingId}`;
}

function toListing(row: PublicListingRow, overlay?: OverlayRow): Listing {
  return {
    id: row.id,
    propertyId: row.building_id,
    unitLabel: row.unit || row.title,
    rentableId: rentableIdFor(row.id),
    rent: Number(row.price_amount) || 0,
    availableOn: null,
    status: overlay ? overlay.status : (row.published ? "published" : "draft"),
    agentUserId: null,
  };
}

const RENTAL_FILTER = "transaction_type=eq.rental&category=eq.residential";
// public.listings keys are uuids; ids from the retired sandbox world are not.
// Treating them as absent keeps old demo cases harmless instead of a 500.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LISTING_COLS = "select=id,title,property_name,unit,price_amount,building_id,published";

interface MemberRow { case_id?: string; person_id: string; role: Case["members"][number]["role"]; application_id: string | null }
interface CaseRow {
  id: string; rentable_id: string; listing_id: string; status: CaseStatus;
  move_in_date: string | null; decline_reason: string | null; case_members?: MemberRow[];
}
function toCase(row: CaseRow): Case {
  return {
    id: row.id,
    rentableId: row.rentable_id,
    listingId: row.listing_id,
    status: row.status,
    moveInDate: row.move_in_date,
    declineReason: row.decline_reason,
    members: (row.case_members || []).map((m) => ({
      personId: m.person_id, role: m.role, applicationId: m.application_id,
    })),
  };
}

interface ApplicationRow {
  id: string; case_id: string; applicant_id: string; applicant_name: string; applicant_email: string;
  status: Application["status"]; answers: Record<string, string>;
}
function toApplication(row: ApplicationRow): Application {
  return {
    id: row.id,
    caseId: row.case_id,
    applicant: { id: row.applicant_id, name: row.applicant_name, email: row.applicant_email },
    status: row.status,
    answers: row.answers || {},
  };
}

interface VersionRow {
  id: string; case_id: string; status: LeaseVersion["status"]; values: Record<string, string>;
  envelope_ref: string | null; executed_file_key: string | null;
}
function toVersion(row: VersionRow): LeaseVersion {
  return {
    id: row.id, caseId: row.case_id, status: row.status, values: row.values || {},
    envelopeRef: row.envelope_ref, executedFileKey: row.executed_file_key,
  };
}

const CASE_SELECT = "select=*,case_members(person_id,role,application_id)";

// ------------------------------------------------------------ repos

export function makeSupabaseRepos(config: SupabaseConfig): Repos {
  const pgrest = client(config);

  async function overlaysFor(ids: string[]): Promise<Map<string, OverlayRow>> {
    if (ids.length === 0) return new Map();
    const rows = await pgrest("GET", `/listing_state?listing_id=in.(${ids.map(encodeURIComponent).join(",")})`) as OverlayRow[];
    return new Map(rows.map((r) => [r.listing_id, r]));
  }

  return {
    listings: {
      async get(id) {
        if (!UUID.test(id)) return null;
        const rows = await pgrest("GET", `/listings?id=eq.${encodeURIComponent(id)}&${LISTING_COLS}`, undefined, undefined, "public") as PublicListingRow[];
        if (!rows[0]) return null;
        // The flow creates cases against the rentable, so its row must exist
        // before first use; the key is deterministic, the insert idempotent.
        await pgrest("POST", "/rentables?on_conflict=id", { id: rentableIdFor(id), kind: "whole_unit", unit_ref: id }, "resolution=ignore-duplicates");
        const overlays = await pgrest("GET", `/listing_state?listing_id=eq.${encodeURIComponent(id)}`) as OverlayRow[];
        return toListing(rows[0], overlays[0]);
      },
      async listPublished() {
        const rows = await pgrest("GET", `/listings?published=is.true&${RENTAL_FILTER}&order=created_at.desc,id.desc&${LISTING_COLS}`, undefined, undefined, "public") as PublicListingRow[];
        const overlays = await overlaysFor(rows.map((r) => r.id));
        return rows.map((r) => toListing(r, overlays.get(r.id)))
          .filter((l) => l.status === "published");
      },
      async listAll(limit) {
        const rows = await pgrest("GET", `/listings?${RENTAL_FILTER}&order=created_at.desc,id.desc&limit=${limit}&${LISTING_COLS}`, undefined, undefined, "public") as PublicListingRow[];
        const overlays = await overlaysFor(rows.map((r) => r.id));
        return rows.map((r) => toListing(r, overlays.get(r.id)));
      },
      async setStatus(id, status) {
        if (!UUID.test(id)) return;
        const key = encodeURIComponent(id);
        if (status === "published" || status === "draft") {
          await pgrest("DELETE", `/listing_state?listing_id=eq.${key}`);
          await pgrest("PATCH", `/listings?id=eq.${key}`, { published: status === "published" }, undefined, "public");
          return;
        }
        // rented / archived: v2-owned states; the site stops showing the
        // listing because published goes false — the auto-unpublish rule.
        await pgrest("POST", "/listing_state?on_conflict=listing_id", { listing_id: id, status, updated_at: new Date().toISOString() }, "resolution=merge-duplicates");
        await pgrest("PATCH", `/listings?id=eq.${key}`, { published: false }, undefined, "public");
      },
    },

    cases: {
      async create(c) {
        await pgrest("POST", "/cases", {
          id: c.id, rentable_id: c.rentableId, listing_id: c.listingId, status: c.status,
          move_in_date: c.moveInDate, decline_reason: c.declineReason,
        });
        if (c.members.length > 0) {
          await pgrest("POST", "/case_members", c.members.map((m) => ({
            case_id: c.id, person_id: m.personId, role: m.role, application_id: m.applicationId,
          })));
        }
      },
      async get(id) {
        const rows = await pgrest("GET", `/cases?id=eq.${encodeURIComponent(id)}&${CASE_SELECT}`) as CaseRow[];
        return rows[0] ? toCase(rows[0]) : null;
      },
      async listOpenByRentable(rentableId) {
        const statuses = OPEN_CASE_STATUSES.join(",");
        const rows = await pgrest(
          "GET",
          `/cases?rentable_id=eq.${encodeURIComponent(rentableId)}&status=in.(${statuses})&${CASE_SELECT}`,
        ) as CaseRow[];
        return rows.map(toCase);
      },
      async listRecent(limit) {
        const rows = await pgrest("GET", `/cases?order=created_at.desc&limit=${limit}&${CASE_SELECT}`) as CaseRow[];
        return rows.map(toCase);
      },
      async setStatus(id, status, declineReason) {
        const patch: Record<string, unknown> = { status };
        if (declineReason !== undefined) patch.decline_reason = declineReason;
        await pgrest("PATCH", `/cases?id=eq.${encodeURIComponent(id)}`, patch);
      },
      async addMember(caseId, member) {
        await pgrest("POST", "/case_members", {
          case_id: caseId, person_id: member.personId, role: member.role, application_id: member.applicationId,
        });
      },
    },

    applications: {
      async create(a) {
        await pgrest("POST", "/applications", {
          id: a.id, case_id: a.caseId, applicant_id: a.applicant.id,
          applicant_name: a.applicant.name, applicant_email: a.applicant.email,
          status: a.status, answers: a.answers,
        });
      },
      async get(id) {
        const rows = await pgrest("GET", `/applications?id=eq.${encodeURIComponent(id)}`) as ApplicationRow[];
        return rows[0] ? toApplication(rows[0]) : null;
      },
      async listByCase(caseId) {
        const rows = await pgrest("GET", `/applications?case_id=eq.${encodeURIComponent(caseId)}&order=created_at`) as ApplicationRow[];
        return rows.map(toApplication);
      },
      async setStatus(id, status) {
        await pgrest("PATCH", `/applications?id=eq.${encodeURIComponent(id)}`, { status });
      },
      async saveAnswers(id, answers) {
        const current = await pgrest("GET", `/applications?id=eq.${encodeURIComponent(id)}&select=answers`) as { answers: Record<string, string> }[];
        const merged = { ...(current[0]?.answers || {}), ...answers };
        await pgrest("PATCH", `/applications?id=eq.${encodeURIComponent(id)}`, { answers: merged });
      },
    },

    screenings: {
      async save(r) {
        await pgrest("POST", "/screenings", {
          application_id: r.applicationId, screening_id: r.screeningId, status: r.status,
          credit_score: r.creditScore, report_ref: r.reportRef, updated_at: new Date().toISOString(),
        }, "resolution=merge-duplicates");
      },
      async getByApplication(applicationId) {
        const rows = await pgrest("GET", `/screenings?application_id=eq.${encodeURIComponent(applicationId)}`) as {
          application_id: string; screening_id: string; status: ScreeningResult["status"];
          credit_score: number | null; report_ref: string | null;
        }[];
        const row = rows[0];
        if (!row) return null;
        return {
          screeningId: row.screening_id, applicationId: row.application_id,
          status: row.status, creditScore: row.credit_score, reportRef: row.report_ref,
        };
      },
    },

    leaseVersions: {
      async create(v) {
        await pgrest("POST", "/lease_versions", {
          id: v.id, case_id: v.caseId, status: v.status, values: v.values,
          envelope_ref: v.envelopeRef, executed_file_key: v.executedFileKey,
        });
      },
      async get(id) {
        const rows = await pgrest("GET", `/lease_versions?id=eq.${encodeURIComponent(id)}`) as VersionRow[];
        return rows[0] ? toVersion(rows[0]) : null;
      },
      async getCurrentByCase(caseId) {
        const rows = await pgrest(
          "GET",
          `/lease_versions?case_id=eq.${encodeURIComponent(caseId)}&order=created_at.desc&limit=1`,
        ) as VersionRow[];
        return rows[0] ? toVersion(rows[0]) : null;
      },
      async getByEnvelope(envelopeRef) {
        const rows = await pgrest("GET", `/lease_versions?envelope_ref=eq.${encodeURIComponent(envelopeRef)}`) as VersionRow[];
        return rows[0] ? toVersion(rows[0]) : null;
      },
      async update(v) {
        await pgrest("PATCH", `/lease_versions?id=eq.${encodeURIComponent(v.id)}`, {
          status: v.status, values: v.values, envelope_ref: v.envelopeRef, executed_file_key: v.executedFileKey,
        });
      },
    },

    decisions: {
      async save(d) {
        await pgrest("POST", "/decisions", {
          case_id: d.caseId, approved: d.approved, decided_at: d.decidedAt,
          contact_id: d.contactId, note: d.note,
        }, "resolution=merge-duplicates");
      },
      async getByCase(caseId) {
        const rows = await pgrest("GET", `/decisions?case_id=eq.${encodeURIComponent(caseId)}`) as {
          case_id: string; approved: boolean; decided_at: string; contact_id: string; note: string | null;
        }[];
        const row = rows[0];
        if (!row) return null;
        return { caseId: row.case_id, approved: row.approved, decidedAt: row.decided_at, contactId: row.contact_id, note: row.note };
      },
    },
  };
}
