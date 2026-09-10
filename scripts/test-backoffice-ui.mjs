// Browser regression for the three-role workspace, driven the way an agent
// works it: queue, case, verify, approve, landlord, lease, signatures, archive,
// with the isolation checks the roles depend on. Starts its own isolated demo
// server on synthetic records; never reads .dev.vars or a real database.
// npm run build && PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-backoffice-ui.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createWorkspaceFixtures, ids } from "../backend/tools/workspace-fixtures.mjs";
import { LEASE_REGISTRY } from "../worker/lease.js";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const scratch = await mkdtemp(join(tmpdir(), "star-workspace-ui-"));
const port = process.env.UI_PORT || "8793", base = `http://127.0.0.1:${port}`;

// The demo starts from the fixtures plus the one thing the lease step needs:
// a property whose every landlord value is answered, so the final lease can be
// produced. Synthetic values, in this scratch file only.
const seeded = createWorkspaceFixtures().state;
const synthetic = field => field.type === "checkbox" ? false : field.type === "choice" ? field.options[0]
  : field.type === "money" ? "$25.00" : field.type === "integer" ? "1" : field.type === "date" ? "10/01/2026"
    : field.type === "email" ? "owner@example.test" : "Synthetic value";
seeded.settings[ids.property] = Object.fromEntries(LEASE_REGISTRY.fields.filter(field => field.source === "manager").map(field => [field.id, synthetic(field)]));
await writeFile(join(scratch, "state.json"), JSON.stringify(seeded));

const server = spawn(process.execPath, [new URL("./demo-workspace.mjs", import.meta.url).pathname], {
  env: { ...process.env, DEMO_PORT: port, DEMO_STATE: join(scratch, "state.json") }, stdio: ["ignore", "pipe", "pipe"]
});
let browser;
let checks = 0;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Demo server did not start")), 15000);
    server.stdout.on("data", bytes => { if (String(bytes).includes("Synthetic role demo:")) { clearTimeout(timeout); resolve(); } });
    server.once("error", error => { clearTimeout(timeout); reject(error); });
    server.once("exit", code => { clearTimeout(timeout); reject(new Error(`Demo server exited: ${code}`)); });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const check = (value, label) => { assert(value, label); checks++; };
  // Each role lands on its own home; the admin's is a dashboard, the others a
  // queue. The queue itself is opened by address when a test needs it.
  const signIn = async role => { await page.goto(`${base}/__demo?role=${role}`); await page.locator(".pagehead").first().waitFor(); };
  const openQueue = async () => { await page.goto(`${base}/admin/#/applications`); await page.locator("#route-cases .cw-rows").waitFor(); };
  const openCase = async id => { await page.goto(`${base}/admin/#/applications/${id}`); await page.locator(".cw-next-panel, .cw-review-layout").first().waitFor(); };
  const nextStep = () => page.locator(".cw-next-panel h2").first().innerText();
  // Submits one of the case's action forms the way a person does: opening the
  // disclosure it sits in, filling what it asks, and waiting for the page to
  // say it saved.
  const submit = async (action, fill = {}) => {
    await page.locator(".cw-saved").evaluateAll(nodes => nodes.forEach(node => node.remove()));
    const form = page.locator(`form[data-action="${action}"]`).first();
    const section = form.locator('xpath=ancestor::section[@role="tabpanel"][1]');
    if (await section.count() && !(await section.isVisible())) await page.locator(`#${await section.getAttribute('aria-labelledby')}`).click();
    const details = form.locator("xpath=ancestor::details[1]");
    if (await details.count()) await details.locator(":scope > summary").click();
    for (const [name, value] of Object.entries(fill)) {
      const field = form.locator(`[name="${name}"]`);
      if (await field.getAttribute("type") === "checkbox") await field.setChecked(Boolean(value));
      else if (await field.evaluate(node => node.tagName) === "SELECT") await field.selectOption(value); else await field.fill(value);
    }
    await form.locator('button[type="submit"]').click();
    await page.locator(".cw-saved").waitFor();
  };

  // Admin: every case, including the one nobody works yet.
  await signIn("admin");
  await openQueue();
  check(await page.locator(".cw-row").count() === 4, "Admin sees all four cases");
  check(await page.getByText("Assign a Responsible Agent").count() === 1, "The unassigned case asks the admin for an agent");

  // Agent A: only assigned cases, with the complete synthetic uploads.
  await signIn("agent-a");
  check(await page.getByRole("heading", { name: "My Tasks" }).isVisible(), "The agent's home is My Tasks");
  await page.locator("#route-overview .cw-rows").waitFor();
  await page.getByRole("button", { name: /^All Rentals/ }).click();
  check(await page.locator(".cw-row").count() === 2, "Agent A sees two assigned cases");

  await page.getByLabel(/^Stage/).selectOption("landlord");
  check(await page.locator(".cw-row").count() === 1, "Stage selection filters the queue");

  // The case page: the applicant in one strip, the next step first, the
  // request already drafted.
  await openCase(ids.a);
  check(await page.getByRole("heading", {name:"Applicant at a glance"}).isVisible(), "The review summary leads the page");
  check(await page.locator('.cw-review-contact a[href^="mailto:"]').count() === 1, "The applicant's email is a link");
  check(await page.getByText("Admin Private Note", { exact: true }).count() === 0, "The admin note is absent for an agent");
  check(await page.locator('.cw-decision > summary').count() === 3, "The reviewer has three decisions");
  await page.getByRole("link", { name: "Open Full Application" }).first().click();
  await page.locator("#appl-panel").waitFor(); checks++;
  await page.goto(`${base}/admin/#/applications/${ids.b}`);
  await page.getByRole("alert").filter({ hasText: "Application not found." }).waitFor(); checks++;

  // The chain, as the agent works it.
  await openCase(ids.a);
  await submit("review_and_recommend", { fee: "paid", screening: "received", documents: "verified", reason: "Provider report REF-001, fee receipt F-001, documents reviewed.", landlord_email: "owner@example.test", confirmed: true });
  check((await page.locator(".cw-saved").innerText()).includes("emailed"), "The agent is told the landlord was emailed");
  check(await nextStep() === "Waiting for the Landlord", "A sent recommendation waits on the landlord");
  check((await page.locator("a.desk-button", { hasText: "Email the Landlord" }).first().getAttribute("href")).startsWith("mailto:owner@example.test?"), "The landlord reminder is drafted");
  await page.goto(`${base}/__demo/inbox`);
  check(await page.getByText("Rental recommendation for Parkside Residences, Unit 2A").count() >= 1, "The landlord's email is in the demo inbox");

  // Landlord: the recommendation and nothing from the application.
  await signIn("landlord");
  await page.locator("#route-overview .cw-rows").waitFor();
  check(await page.locator(".cw-row").count() === 2, "Only shared recommendations reach the landlord");
  check(await page.locator(".cw-row", { hasText: "a month" }).count() === 2, "Each row states the rent on offer");
  // A counter-offer on the other recommendation: figures, not just a comment.
  await openCase(ids.shared);
  const counter = page.locator('form[data-action="landlord_changes"]');
  await counter.locator("xpath=ancestor::details[1]").locator(":scope > summary").click();
  await counter.locator('[name="rent.monthly"]').fill("2900");
  await counter.locator('[name="reason"]').fill("Please consider a slightly higher rent.");
  await counter.locator('button[type="submit"]').click();
  await page.getByRole("heading", { name: "Decision Recorded" }).waitFor(); checks++;
  // The recommendation for Casey: the tenant summary, what Star checked, yes.
  await openCase(ids.a);
  check(await page.getByRole("link", { name: "Open Full Application" }).count() === 0, "The landlord has no dossier link");
  check(await page.locator(".cw-strip a").count() === 0, "The landlord sees no contact details");
  check(await page.getByRole("heading", { name: "About the Tenant" }).isVisible() && await page.getByText("$120,000").count() >= 1, "The landlord sees the stated income");
  check(await page.locator(".pill", { hasText: "Done" }).count() === 3, "and the three things Star verified");
  check((await page.locator("a.desk-button", { hasText: "Email the Agent" }).getAttribute("href")).startsWith("mailto:agent-a@example.test?"), "and can email the agent who sent it");
  await submit("landlord_accept");
  check(await page.getByText("agreed to these terms").count() === 1, "The landlord's decision is shown back");
  await page.reload(); await page.getByText("agreed to these terms").waitFor(); checks++;
  await page.getByRole("link", { name: "My properties", exact: true }).click();
  check(!await page.locator("#dropzone").isVisible(), "No landlord marketing import");

  // Agent: the final lease, the signatures, the archive.
  await signIn("agent-a");
  await openCase(ids.shared);
  check(await page.getByLabel("Review & decide", {exact:true}).getByText("Landlord requested changes", {exact:true}).isVisible(), "A counter-offer comes back to the agent");
  check(await page.locator('form[data-action="review_and_recommend"] input[name="rent.monthly"]').inputValue() === "2900", "with the proposed rent already in the form");
  await openCase(ids.a);
  check(await nextStep() === "Prepare the Final Lease", "Landlord consent leads to the lease");
  await page.getByText("Every value the lease needs is answered").waitFor();
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("button[data-download-lease]").click()]);
  check(download.suggestedFilename().endsWith(".docx"), "The final lease downloads as a Word file");
  const bytes = await readFile(await download.path());
  check(bytes.subarray(0, 2).toString() === "PK" && bytes.length > 10000, "and is a real document");
  await page.locator(".cw-next-panel h2", { hasText: "Send the Lease for Tenant Signatures" }).waitFor(); checks++;
  check((await page.locator("a.desk-button", { hasText: "Email the Tenant" }).first().getAttribute("href")).startsWith("mailto:casey.morgan@example.test?"), "The lease email to the tenant is drafted");
  await submit("record_tenant_signature", { reason: "Signing receipt SIGN-001 confirms all tenants." });
  check(await nextStep() === "Get the Landlord's Signature", "Tenants sign before the landlord");
  await signIn("landlord"); await openCase(ids.a);
  check(await nextStep() === "Your Signature Is Next", "The landlord is told their signature is next");
  await signIn("agent-a"); await openCase(ids.a);
  await submit("record_landlord_signature", { reason: "Signing receipt SIGN-002 confirms the landlord." });
  check(await nextStep() === "Archive the Signed Lease", "Both signatures lead to the archive");
  await page.locator(".cw-saved").evaluateAll(nodes => nodes.forEach(node => node.remove()));
  await page.locator('#archive-lease input[type="file"]').setInputFiles({ name: "executed.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 synthetic fully signed lease") });
  await page.locator('#archive-lease button[type="submit"]').click();
  await page.locator(".cw-saved").waitFor();
  check(await nextStep() === "Lease Complete", "The archive completes the case");
  check(await page.locator('a[href$="/signed-lease"]').count() >= 1, "The signed PDF is downloadable");

  // The landlord gets the signed PDF; the other agent still gets nothing.
  await signIn("landlord");
  await page.getByRole("link", { name: "Lease documents", exact: true }).click();
  await page.locator(".cw-row-file").waitFor(); checks++;
  await signIn("agent-b");
  await page.goto(`${base}/admin/#/applications/${ids.a}`);
  await page.getByRole("alert").filter({ hasText: "Application not found." }).waitFor(); checks++;

  // A phone: nothing overflows, on the queue or on a case.
  for (const role of ["admin", "agent-a", "landlord"]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(role);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${role} home fits a phone`);
    await openQueue();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${role} queue fits a phone`);
    await openCase(ids.a);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${role} case page fits a phone`);
  }
  assert.deepEqual(errors, []); checks++;
  console.log(`PASS ${checks} role navigation, data scopes, the agent's chain from verification to archive, landlord consent and phone layout checks`);
} finally {
  await browser?.close();
  if (server.exitCode === null) { const closed = once(server, "exit"); server.kill("SIGTERM"); await closed; }
  await rm(scratch, { recursive: true, force: true });
}
