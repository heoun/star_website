import { handlePublicOnboarding } from "../worker/administration.js";
// Local, synthetic role demo. It runs the actual Worker handlers and repository
// adapter against isolated fixtures. It cannot reach a real Supabase project.
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { handleAdminRequest } from "../worker/admin.js";
import { createWorkspaceFixtures } from "../backend/tools/workspace-fixtures.mjs";
import { completeDemoState, annotateDemoTemplate, DEMO_ENCRYPTION_KEY, MOCK_PREVIEW_TENANCY } from "./demo-data.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), dist = resolve(root, "dist");
const port = Number(process.env.DEMO_PORT || 8792);
const stateFile = process.env.DEMO_STATE || resolve(tmpdir(), "star-role-workspace-demo.json");
let saved;
if (existsSync(stateFile)) saved = JSON.parse(await readFile(stateFile, "utf8"));
const fixture = createWorkspaceFixtures(saved);
if (saved && !saved.demo_seed) await writeFile(`${stateFile}.before-complete-mock.json`, JSON.stringify(saved), {flag:"wx"}).catch(error => { if (error.code !== "EEXIST") throw error; });
await completeDemoState(fixture.state);
await mkdir(dirname(stateFile), {recursive:true});
await writeFile(stateFile, JSON.stringify(fixture.state));
fixture.env.APP_ENCRYPTION_KEY = DEMO_ENCRYPTION_KEY;
if (!fixture.state.staff.some(s => s.email === "peer-admin@example.test")) fixture.state.staff.push({email:"peer-admin@example.test",name:"Riley · Admin",role:"manager",active:true,property_ids:[],account_version:0});
globalThis.fetch = fixture.fetch;
const demoPeople = () => ({ owner: ["manager", "platform-owner@example.test"], admin: ["manager", "admin@example.test"], "agent-a": ["agent", "agent-a@example.test"], "agent-b": ["agent", "agent-b@example.test"], landlord: ["landlord", "owner@example.test"],
  ...Object.fromEntries(fixture.state.staff.flatMap((member,index) => member.role === "landlord" && member.active && member.email !== "owner@example.test" ? [[`partner-${index}`, ["landlord", member.email]]] : [])) });
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
let mockTemplate;
async function asset(request) {
  const path = decodeURIComponent(new URL(request.url).pathname);
  if (path === "/__demo/annotations.js") return new Response(await readFile(new URL("./demo-assets/annotations.js", import.meta.url)), {headers:{"Content-Type":"text/javascript", "Cache-Control":"no-store"}});
  let file = resolve(dist, `.${path}${path.endsWith("/") ? "index.html" : ""}`);
  if (!file.startsWith(`${dist}/`)) return new Response("Not found", { status: 404 });
  try {
    let bytes = await readFile(file);
    if (path === "/admin/lease-template.docx") {
      mockTemplate ||= annotateDemoTemplate(bytes);
      bytes = Buffer.from(await mockTemplate);
    }
    if (path === "/admin/" || path === "/admin/index.html") bytes = Buffer.from(bytes.toString().replace('<div class="topright">', '<div class="topright"><a href="/__demo" style="white-space:nowrap;font-size:12px">Demo roles</a>'));
    if (extname(file) === ".html") bytes = Buffer.from(bytes.toString().replace('</body>', '<script type="module" src="/__demo/annotations.js"></script></body>'));
    return new Response(bytes, { headers: { "Content-Type": mime[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" } });
  } catch { return new Response("Not found", { status: 404 }); }
}
let pendingSave = Promise.resolve();
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const people = demoPeople();
    if (url.pathname === "/__demo/inbox") {
      const esc = v => String(v || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
      res.writeHead(200, {"Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store", "Referrer-Policy":"no-referrer"});
      res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Synthetic demo inbox</title><style>body{font:16px system-ui;color:#193446;max-width:840px;margin:40px auto;padding:20px}article{padding:24px;border:1px solid #dde5e8;border-radius:12px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}a{color:inherit}</style><a href="/__demo">← Demo roles</a><h1>Local demo inbox</h1><p>These messages were saved locally. No email was sent.</p>${fixture.state.emails.slice().reverse().map(m=>`<article><p>To: ${esc([].concat(m.to).join(", "))}</p><h2>${esc(m.subject)}</h2><pre>${esc(m.text)}</pre>${/http[^\s]+\/landlord-onboarding\/#[a-f0-9]{64}/.exec(m.text)?.[0] ? `<a href="${esc(/http[^\s]+\/landlord-onboarding\/#[a-f0-9]{64}/.exec(m.text)[0])}">Open landlord form →</a>` : ""}</article>`).join("") || "<p>No invitations yet. Create one from Admin → Landlord onboarding.</p>"}`); return;
    }
    if (url.pathname === "/__demo") {
      // Approved partners are selectable in this isolated demo so the full
      // intake → account → property access flow can be inspected in the UI.
      const role = url.searchParams.get("role");
      if (people[role]) { res.writeHead(303, { Location: "/admin/#/overview", "Set-Cookie": `star_demo_role=${role}; Path=/; HttpOnly; SameSite=Lax` }); res.end(); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      const esc = v => String(v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Star workspace · synthetic demo</title><style>body{font:16px system-ui;background:#f6f7f9;color:#132d42;max-width:720px;margin:12vh auto;padding:24px}a{display:block;background:white;border:1px solid #dce3e8;border-radius:10px;margin:14px 0;padding:20px;color:inherit;text-decoration:none}p{line-height:1.8;color:#5d707c}</style><h1>Explore each workspace</h1><p>Isolated demo with synthetic people and properties. Changes are saved locally. No messages, payments, checks or signature requests are sent.</p>${Object.entries(people).map(([key, [role, email]]) => `<a href="/__demo?role=${key}"><b>${key === "owner" ? "Platform owner" : key === "admin" ? "Admin" : role === "landlord" ? "Landlord" : key === "agent-a" ? "Agent A" : "Agent B"}</b><br>${esc(email)}</a>`).join("")}`); return;
    }
    const cookies = req.headers.cookie || "";
    const selected = /(?:^|;\s*)star_demo_role=([^;]+)/.exec(cookies)?.[1];
    let [role, email] = people[selected] || people.admin;
    if (email !== people.owner[1]) {
      const member = fixture.state.staff.find(s => s.email === email);
      if (member?.active) role = member.role;
      else email = ""; // Suspended demo accounts fail the same API entry check.
    }
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
    let request = new Request(url, { method: req.method, headers: req.headers, ...(["GET", "HEAD"].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
    if (url.pathname === "/api/admin/lease/document" && req.method === "POST" && role === "manager") {
      const body = await request.clone().json().catch(() => null);
      if (body?.listing_id) request = new Request(url, {method:req.method, headers:req.headers, body:JSON.stringify({...body, overrides:{...MOCK_PREVIEW_TENANCY, ...body.overrides}})});
    }
    let response;
    if (url.pathname.startsWith("/api/admin/")) {
      response = await handleAdminRequest(request, { ...fixture.env, DEV_ADMIN_ROLE: role, DEV_ADMIN_EMAIL: email, OWNER_EMAIL: "platform-owner@example.test", LOCAL_EMAIL_SINK: { send: async message => { fixture.state.emails.push(message); } }, ASSETS: { fetch: asset } }, { waitUntil(p) { p.catch(() => {}); } }, url.pathname);
      if (!["GET", "HEAD"].includes(req.method) && response.ok) {
        await completeDemoState(fixture.state);
        const snapshot = JSON.stringify(fixture.state);
        pendingSave = pendingSave.then(async () => { await mkdir(dirname(stateFile), { recursive: true }); await writeFile(stateFile, snapshot); });
        await pendingSave;
      }
    } else if (url.pathname === "/api/landlord-onboarding") {
      response = await handlePublicOnboarding(request, fixture.env);
      if (req.method === "POST" && response.ok) { const snapshot = JSON.stringify(fixture.state); pendingSave = pendingSave.then(() => writeFile(stateFile, snapshot)); await pendingSave; }
    } else response = await asset(request);
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { console.error(error.message); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Demo request failed." })); }
});
server.listen(port, "127.0.0.1", () => console.log(`Synthetic role demo: http://127.0.0.1:${port}/__demo`));
