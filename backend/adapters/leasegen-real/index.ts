// The one real adapter in Ring 1: wraps the existing lease engine unchanged.
// worker/lease.js supplies deal-value mapping, layered resolution and the
// docx fill; the template is the same /admin/lease-template.docx asset the
// current admin uses. Property-settings layers are empty until the database
// ring lands, so draft builds carry [ TO BE COMPLETED ] where a manager
// value belongs — exactly what the engine does today for an unset building.

// The legacy engine is JavaScript; allowJs resolves it, esbuild bundles it.
import { dealValues, fillTemplate, resolveValues } from "../../../worker/lease.js";
import type { LeaseGenPort } from "../../contracts/leasegen.ts";
import type { Repos } from "../../contracts/repos.ts";

interface WorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export function makeRealLeaseGen(repos: Repos, env: WorkerEnv, request: Request): LeaseGenPort {
  return {
    async build(caseId, mode) {
      const kase = await repos.cases.get(caseId);
      if (!kase) throw new Error("Case not found.");
      const listing = await repos.listings.get(kase.listingId);
      const applications = await repos.applications.listByCase(caseId);
      const active = applications.filter((a) => a.status !== "withdrawn");
      const primary = active.find((a) => kase.members.some((m) => m.applicationId === a.id && m.role === "primary")) ?? active[0];
      if (!listing || !primary) throw new Error("Case has no listing or no applicant.");

      const now = new Date();
      const today = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };

      // Shape the domain objects into what the legacy engine reads.
      const legacyApplication = {
        name: active.map((a) => a.applicant.name).join(", "),
        email: primary.applicant.email,
        current_address: primary.answers["current_address"] || "",
        move_in: kase.moveInDate || "",
        lease_term_months: primary.answers["lease_term_months"] || "12",
        concession_terms: primary.answers["concession_terms"] || "",
      };
      const legacyListing = {
        location: primary.answers["listing_location"] || "Queens, NY",
        unit: listing.unitLabel,
        price_amount: listing.rent,
        created_at: null,
      };

      const deal = dealValues({ application: legacyApplication, listing: legacyListing, building: null, today });
      const resolved = resolveValues({ layers: {}, deal, overrides: {} }) as {
        values: Record<string, string>; missing: string[];
      };
      const { values, missing } = resolved;

      if (mode === "final" && missing.length > 0) {
        return { documents: [], missing, values };
      }

      const marked = mode === "draft"
        ? { ...values, ...Object.fromEntries(missing.map((id: string) => [id, "[ TO BE COMPLETED ]"])) }
        : values;

      const docx = await fillTemplate(env, request, marked);
      return {
        documents: [{ name: "Lease", docx: new Uint8Array(docx) }],
        missing,
        values,
      };
    },
  };
}
