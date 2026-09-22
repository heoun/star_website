// HTTP surface of the new backend, mounted at /api/v2. Routes translate
// requests into use-case calls; no business logic lives here.

import type { Deps } from "../core/deps.ts";
import {
  FlowError, declineCase, handleEsignWebhook, handleScreeningWebhook,
  recordDecision, sendLease, sendToLandlord, submitApplication,
} from "../core/flow.ts";
import type { Principal } from "../contracts/domain.ts";
// Fake-only surfaces for the dev routes; legal here because app/ is the
// composition root. They disappear with their adapters, ring by ring.
import { listSent } from "../adapters/email-log/index.ts";
import { listEvents } from "../adapters/events-log/index.ts";
import { peekEnvelope } from "../adapters/esign-fake/index.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return (body && typeof body === "object") ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function requireStaff(principal: Principal | null): Principal {
  if (!principal || principal.kind !== "staff") {
    throw new FlowError(401, "Staff identity required. In dev, send x-dev-principal: staff:admin.");
  }
  if (principal.role !== "admin") throw new FlowError(403, "Use the assigned-case workspace at /admin/. The legacy v2 sandbox is admin-only.");
  return principal;
}

export interface RouteMeta { db: string; auth: string; email: string; storage: string }

export async function route(deps: Deps, request: Request, meta: RouteMeta): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/v2/, "") || "/";
  const method = request.method;
  const principal = await deps.auth.resolve(request);

  try {
    if (path === "/health") return json({ ok: true, ring: 5, db: meta.db, auth: meta.auth, email: meta.email, storage: meta.storage });

    if (path === "/listings" && method === "GET") {
      if (url.searchParams.get("scope") === "all") {
        requireStaff(principal);
        return json({ listings: await deps.repos.listings.listAll(200) });
      }
      return json({ listings: await deps.repos.listings.listPublished() });
    }

    const listingStatus = path.match(/^\/listings\/([A-Za-z0-9-]+)\/status$/);
    if (listingStatus && method === "POST") {
      const staff = requireStaff(principal);
      if (!deps.policy.can(staff, "listing.publish", { type: "listing", id: listingStatus[1]! })) {
        return json({ error: "Not allowed." }, 403);
      }
      const body = await readJson(request);
      const status = String(body.status || "");
      if (!["draft", "published", "rented", "archived"].includes(status)) {
        return json({ error: "Unknown listing status." }, 422);
      }
      await deps.repos.listings.setStatus(listingStatus[1]!, status as "draft" | "published" | "rented" | "archived");
      return json({ ok: true });
    }

    if (path === "/applications" && method === "POST") {
      const body = await readJson(request);
      const result = await submitApplication(deps, {
        listingId: String(body.listingId || ""),
        name: String(body.name || ""),
        email: String(body.email || ""),
        answers: (body.answers && typeof body.answers === "object") ? body.answers as Record<string, string> : {},
      });
      return json(result, 201);
    }

    if (path === "/screening/webhook" && method === "POST") {
      const result = await handleScreeningWebhook(deps, await readJson(request), headersOf(request));
      return json(result, result.handled ? 200 : 400);
    }

    if (path === "/esign/webhook" && method === "POST") {
      const result = await handleEsignWebhook(deps, await readJson(request), headersOf(request));
      return json(result, result.handled ? 200 : 400);
    }

    if (path === "/cases" && method === "GET") {
      requireStaff(principal);
      const cases = await deps.repos.cases.listRecent(50);
      const rows = [];
      for (const kase of cases) {
        const listing = await deps.repos.listings.get(kase.listingId);
        const applications = await deps.repos.applications.listByCase(kase.id);
        rows.push({
          ...kase,
          listing: listing && { unitLabel: listing.unitLabel, rent: listing.rent, status: listing.status },
          applicants: applications.map((a) => a.applicant.name),
        });
      }
      return json({ cases: rows });
    }

    const caseMatch = path.match(/^\/cases\/([A-Za-z0-9-]+)(\/.*)?$/);
    if (caseMatch) {
      const caseId = caseMatch[1]!;
      const rest = caseMatch[2] || "";
      const staff = requireStaff(principal);

      if (rest === "" && method === "GET") {
        const kase = await deps.repos.cases.get(caseId);
        if (!kase) return json({ error: "Case not found." }, 404);
        const applications = await deps.repos.applications.listByCase(caseId);
        const screenings = [];
        for (const app of applications) {
          screenings.push(await deps.repos.screenings.getByApplication(app.id));
        }
        const decision = await deps.repos.decisions.getByCase(caseId);
        const lease = await deps.repos.leaseVersions.getCurrentByCase(caseId);
        const listing = await deps.repos.listings.get(kase.listingId);
        return json({
          case: kase,
          listing: listing && { unitLabel: listing.unitLabel, rent: listing.rent, status: listing.status },
          applications, screenings, decision,
          lease: lease && { ...lease, values: undefined },
        });
      }
      if (rest === "/send-to-landlord" && method === "POST") {
        const body = await readJson(request);
        const recipients = Array.isArray(body.recipients) ? body.recipients.map(String) : [];
        return json(await sendToLandlord(deps, staff, caseId, recipients));
      }
      if (rest === "/decline" && method === "POST") {
        const body = await readJson(request);
        return json(await declineCase(deps, staff, caseId, String(body.reason || "Declined by staff")));
      }
      if (rest === "/lease/send" && method === "POST") {
        return json(await sendLease(deps, staff, caseId));
      }
    }

    if (path === "/landlord/decision") {
      const caseId = url.searchParams.get("case") || "";
      if (method === "GET") {
        return html(decisionPage(caseId, url.searchParams.get("llt") || ""));
      }
      if (method === "POST") {
        const body = await readJson(request);
        if (!principal) return json({ error: "This link is not valid." }, 403);
        return json(await recordDecision(deps, principal, caseId, body.approved === true, body.note ? String(body.note) : null));
      }
    }

    // ---------------------------------------------------------- dev routes
    // Conveniences over the fakes so a person can click through the flow.

    const screeningDev = path.match(/^\/dev\/screening\/([A-Za-z0-9-]+)$/);
    if (screeningDev && method === "GET") {
      const result = await handleScreeningWebhook(deps, { vendor: "screening-fake", screeningId: screeningDev[1] }, {});
      return json({ consented: true, ...result });
    }

    const esignDev = path.match(/^\/dev\/esign\/([A-Za-z0-9-]+)$/);
    if (esignDev && method === "GET") {
      const email = url.searchParams.get("email") || "";
      const result = await handleEsignWebhook(deps, { vendor: "esign-fake", envelopeId: esignDev[1], signerEmail: email }, {});
      return json({ signedAs: email, envelope: peekEnvelope(esignDev[1]!), ...result });
    }

    // Puts the seeded dev listing back on the market and closes whatever open
    // cases previous runs left on it, so the smoke flow starts clean against a
    // persistent store too.
    if (path === "/dev/reset" && method === "POST") {
      requireStaff(principal);
      const OPEN = ["open", "in_review", "sent_to_landlord", "approved", "lease_sent"];
      const recent = await deps.repos.cases.listRecent(100);
      const touched = new Set<string>();
      let closed = 0;
      for (const kase of recent) {
        if (OPEN.includes(kase.status)) {
          await deps.repos.cases.setStatus(kase.id, "closed", "Reset for a demo run");
          closed += 1;
        }
        touched.add(kase.listingId);
      }
      // Anything a demo run took off the market comes back.
      for (const listingId of touched) {
        await deps.repos.listings.setStatus(listingId, "published");
      }
      return json({ reset: true, closed, republished: touched.size });
    }

    if (path === "/dev/emails" && method === "GET") return json({ emails: listSent() });
    if (path === "/dev/events" && method === "GET") return json({ events: listEvents() });

    // Private files, served through the port with a staff identity — R2
    // bindings cannot presign, and this is the pattern the admin already uses.
    const fileMatch = path.match(/^\/files\/(listing-media|applicant-docs)\/(.+)$/);
    if (fileMatch && method === "GET") {
      requireStaff(principal);
      const bytes = await deps.storage.get(fileMatch[1] as "listing-media" | "applicant-docs", fileMatch[2]!);
      if (!bytes) return json({ error: "No such file." }, 404);
      return new Response(bytes.slice() as unknown as BodyInit, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }

    return json({ error: "Unknown /api/v2 endpoint." }, 404);
  } catch (error) {
    if (error instanceof FlowError) return json({ error: error.message }, error.status);
    console.error("[v2]", error);
    return json({ error: "Internal error." }, 500);
  }
}

function headersOf(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  request.headers.forEach((value, key) => { out[key] = value; });
  return out;
}

function decisionPage(caseId: string, token: string): string {
  return [
    "<!doctype html><meta charset=utf-8><title>Application Decision</title>",
    "<body style=\"font-family:system-ui;max-width:32rem;margin:4rem auto\">",
    "<h1>Application Decision</h1>",
    "<p>Case " + caseId + ". Approve this application package?</p>",
    "<button onclick=\"decide(true)\">Approve</button> ",
    "<button onclick=\"decide(false)\">Decline</button>",
    "<pre id=out></pre>",
    "<script>async function decide(approved){",
    "const r=await fetch(location.pathname+location.search,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({approved})});",
    "document.getElementById('out').textContent=await r.text();}</script>",
  ].join("\n");
}
