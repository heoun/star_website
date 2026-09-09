#!/usr/bin/env node
// The smoke test: boots the Worker with fakes on a scratch port and walks the
// whole flow over HTTP. Exit 0 means the system runs end to end.
//
//   listing -> two competing applications -> screening -> review ->
//   landlord decision -> lease (real docx) -> tenant signs -> landlord signs ->
//   executed, filed, listing rented, competing case closed.

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = process.env.SMOKE_PORT || "8791";
const BASE = `http://127.0.0.1:${PORT}/api/v2`;
const STAFF = { "x-dev-principal": "staff:admin", "Content-Type": "application/json" };

let failures = 0;
function ok(name, condition, detail = "") {
  const mark = condition ? "ok " : "FAIL";
  console.log(`  ${mark} ${name}${condition ? "" : `  ${detail}`}`);
  if (!condition) failures += 1;
}

async function get(url, headers = {}) {
  const response = await fetch(url, { headers });
  return { status: response.status, body: await parse(response), raw: response };
}
async function post(url, body, headers = STAFF) {
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: await parse(response) };
}
async function parse(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function waitForHealth(deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const { status } = await get(`${BASE}/health`);
      if (status === 200) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function run() {
  console.log("smoke: building site assets…");
  const build = spawnSync(process.execPath, [path.join(root, "scripts/build.js")], { cwd: root, stdio: "inherit" });
  if (build.status !== 0) { console.error("smoke: build failed"); process.exit(1); }

  const vars = ["--var", "BACKEND_V2:on", "--var", "DEV_REAL_EMAIL:false"];
  // SMOKE_DB=memory forces the in-memory store even when .dev.vars carries
  // database credentials — the zero-secrets path CI exercises.
  if (process.env.SMOKE_DB === "memory") {
    // CI parity: no database and no identity secrets, whatever .dev.vars holds.
    vars.push("--var", "SUPABASE_URL:disabled", "--var", "DEV_ADMIN_EMAIL:", "--var", "CF_ACCESS_TEAM_DOMAIN:", "--var", "RESEND_API_KEY:");
  }

  let wrangler = null;
  const stop = () => {
    if (!wrangler) return;
    try { process.kill(-wrangler.pid, "SIGTERM"); } catch {}
    wrangler = null;
  };
  const boot = async () => {
    console.log(`smoke: starting wrangler dev on :${PORT}…`);
    wrangler = spawn(
      "npx",
      ["--yes", "wrangler@4", "dev", "--port", PORT, "--ip", "127.0.0.1", ...vars],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    wrangler.stdout.on("data", () => {});
    wrangler.stderr.on("data", (chunk) => process.env.SMOKE_VERBOSE && process.stderr.write(chunk));
    if (!(await waitForHealth(90_000))) {
      console.error("smoke: the dev server never became healthy");
      stop();
      process.exit(1);
    }
  };
  process.on("exit", stop);
  process.on("SIGINT", () => { stop(); process.exit(130); });

  await boot();
  const health = await get(`${BASE}/health`);
  console.log(`smoke: store is ${health.body.db}`);
  const reset = await post(`${BASE}/dev/reset`, {});
  ok("store reset for a clean run", reset.status === 200, JSON.stringify(reset.body));

  console.log("smoke: walking the flow…");

  // 1. A published listing exists — the seeded one in memory, the real
  // inventory on supabase.
  const listings = await get(`${BASE}/listings`);
  ok("a published listing is served", listings.status === 200 && listings.body.listings?.length >= 1, JSON.stringify(listings.body).slice(0, 300));
  if (!listings.body.listings?.length) {
    console.error("smoke: no published listing to work with — on supabase, apply backend/migrations/0002 and publish at least one residential rental.");
    stop();
    process.exit(1);
  }
  const listingId = listings.body.listings[0].id;
  console.log(`smoke: using listing ${listingId} (${listings.body.listings[0].unitLabel})`);

  // 2. Two competing applications on the same unit.
  const a = await post(`${BASE}/applications`, {
    listingId, name: "Ada Tenant", email: "ada@example.com",
    answers: { move_in: "2026-10-01", lease_term_months: "12", current_address: "1 Test St, Queens, NY", listing_location: "41-15 Main St, Flushing, NY" },
  });
  ok("application A accepted", a.status === 201 && a.body.caseId, JSON.stringify(a.body));
  const b = await post(`${BASE}/applications`, { listingId, name: "Bob Rival", email: "bob@example.com", answers: { move_in: "2026-10-15" } });
  ok("application B accepted", b.status === 201 && b.body.caseId && b.body.caseId !== a.body.caseId, JSON.stringify(b.body));

  // 3. A's screening completes via the consent link.
  const consent = await get(`http://127.0.0.1:${PORT}${a.body.screeningUrl}`);
  ok("screening completes through the fake vendor", consent.status === 200 && consent.body.handled === true, JSON.stringify(consent.body));

  let kase = await get(`${BASE}/cases/${a.body.caseId}`, STAFF);
  ok("case A moved to in_review", kase.body.case?.status === "in_review", JSON.stringify(kase.body.case));
  ok("screening stored a score", Number.isFinite(kase.body.screenings?.[0]?.creditScore), JSON.stringify(kase.body.screenings));

  // 4. Staff cannot skip ahead; landlord package goes out to Admin-picked recipients.
  const early = await post(`${BASE}/cases/${a.body.caseId}/lease/send`, {});
  ok("lease before approval is refused", early.status === 409, JSON.stringify(early.body));
  const sent = await post(`${BASE}/cases/${a.body.caseId}/send-to-landlord`, { recipients: ["owner@example.com"] });
  ok("decision package sent", sent.status === 200 && sent.body.decisionUrl, JSON.stringify(sent.body));

  // Ring 3: identity checks. On a dev machine the two-lock identity admits
  // loopback staff; in CI the fake refuses a request with no identity at all.
  const authKind = health.body.auth;
  const noHeader = await get(`${BASE}/cases/${a.body.caseId}`);
  if (authKind === "real") {
    ok("loopback dev identity admits staff without a header", noHeader.status === 200, `status=${noHeader.status}`);
  } else {
    ok("staff routes refuse a request with no identity", noHeader.status === 401, `status=${noHeader.status}`);
  }

  // 5. The landlord decides through the link — no staff header.
  const decisionUrl = sent.body.decisionUrl.startsWith("http")
    ? sent.body.decisionUrl
    : `http://127.0.0.1:${PORT}${sent.body.decisionUrl}`;
  ok("decision link is absolute for the email", sent.body.decisionUrl.startsWith("http"), sent.body.decisionUrl);
  const tamperedUrl = decisionUrl.replace(/llt=([^&]+)/, (_m, t) => `llt=${t.slice(0, -4)}AAAA`);
  const tampered = await post(tamperedUrl, { approved: true }, { "Content-Type": "application/json" });
  ok("a tampered landlord link is refused", tampered.status === 403, `status=${tampered.status} ${JSON.stringify(tampered.body)}`);
  const page = await get(decisionUrl);
  ok("decision page renders", page.status === 200 && String(page.body).includes("Approve"));
  const decided = await post(decisionUrl, { approved: true }, { "Content-Type": "application/json" });
  ok("landlord approval recorded", decided.status === 200 && decided.body.ok === true, JSON.stringify(decided.body));

  // 6. Lease goes out for signature — a real docx from the real engine.
  const lease = await post(`${BASE}/cases/${a.body.caseId}/lease/send`, {});
  ok("lease sent for signature", lease.status === 200 && lease.body.envelopeId, JSON.stringify(lease.body).slice(0, 300));
  ok("draft reports its missing manager values", Array.isArray(lease.body.missing) && lease.body.missing.length > 0);
  const links = lease.body.signerLinks;
  ok("tenant signs before landlord", links?.length === 2 && links[0].email === "ada@example.com");

  // 7. Signing out of order is refused; in order it completes.
  const outOfOrder = await get(`http://127.0.0.1:${PORT}${links[1].url}`);
  ok("landlord cannot sign first", outOfOrder.body.handled === false, JSON.stringify(outOfOrder.body));
  const tenantSigned = await get(`http://127.0.0.1:${PORT}${links[0].url}`);
  ok("tenant signature -> partially_signed", tenantSigned.body.status === "partially_signed", JSON.stringify(tenantSigned.body));
  const landlordSigned = await get(`http://127.0.0.1:${PORT}${links[1].url}`);
  ok("landlord signature -> executed", landlordSigned.body.status === "executed", JSON.stringify(landlordSigned.body));

  // 8. The world after execution.
  kase = await get(`${BASE}/cases/${a.body.caseId}`, STAFF);
  ok("case A is executed", kase.body.case?.status === "executed");
  ok("executed lease is filed", kase.body.lease?.executedFileKey, JSON.stringify(kase.body.lease));

  const noAuthFile = await fetch(`http://127.0.0.1:${PORT}/api/v2/files/applicant-docs/${kase.body.lease.executedFileKey}`, { headers: {} });
  if (health.body.auth === "fake") {
    ok("private file refused without identity", noAuthFile.status === 401, `status=${noAuthFile.status}`);
  }
  const filed = await fetch(`http://127.0.0.1:${PORT}/api/v2/files/applicant-docs/${kase.body.lease.executedFileKey}`, { headers: STAFF });
  const bytes = new Uint8Array(await filed.arrayBuffer());
  ok("filed lease is a real docx", filed.status === 200 && bytes.length > 10_000 && bytes[0] === 0x50 && bytes[1] === 0x4b, `len=${bytes.length}`);

  const caseB = await get(`${BASE}/cases/${b.body.caseId}`, STAFF);
  ok("competing case closed as unit unavailable", caseB.body.case?.status === "closed" && caseB.body.case?.declineReason === "Unit no longer available", JSON.stringify(caseB.body.case));

  const after = await get(`${BASE}/listings`);
  ok("listing left the market", !after.body.listings?.some((l) => l.id === listingId), JSON.stringify((after.body.listings || []).map((l) => l.id)));

  const emails = await get(`${BASE}/dev/emails`);
  const templates = new Set((emails.body.emails || []).map((e) => e.template));
  for (const wanted of ["application_received", "decision_package", "decision_recorded", "lease_sent", "lease_executed"]) {
    ok(`email went out: ${wanted}`, templates.has(wanted));
  }

  if (health.body.db === "supabase") {
    console.log("smoke: restarting the server to prove the data survives…");
    stop();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await boot();
    const revisit = await get(`${BASE}/cases/${a.body.caseId}`, STAFF);
    ok("executed case survives a restart", revisit.body.case?.status === "executed", JSON.stringify(revisit.body.case));
    ok("filed lease key survives a restart", revisit.body.lease?.executedFileKey === kase.body.lease.executedFileKey);
  }

  stop();
  console.log(failures === 0 ? "\nsmoke: PASS — the flow runs end to end." : `\nsmoke: ${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => { console.error("smoke: crashed:", error); process.exit(1); });
