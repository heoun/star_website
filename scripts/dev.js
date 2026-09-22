// The development server: the real Worker, on your machine.
//
// `node server.js` (npm run preview) serves the files under site/ and nothing
// else — no Worker, so no /api, no /admin, no listings from Supabase, no lease
// generation. This runs `wrangler dev` instead, which executes worker/index.js
// exactly as Cloudflare does, against a local R2 bucket and the local dist/.
//
// The one thing wrangler will not do is notice that site/ is the source and
// dist/ is the build output, so this watches site/ and re-renders changed files
// into dist/ as you save. Wrangler picks the new bytes up on its own.
//
// Configuration lives in .dev.vars, which is gitignored; .dev.vars.example says
// what belongs in it.

const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const { renderHtmlFile } = require("./render-html");

const root = path.resolve(__dirname, "..");
const site = path.join(root, "site");
const dist = path.join(root, "dist");
const leaseTemplate = path.join(root, "lease", "template", "lease-template.docx");
const devVars = path.join(root, ".dev.vars");

const port = process.env.PORT || "8787";
// Anything after `--` is handed to wrangler, e.g. `npm run dev -- --remote`.
const signingScheduler = process.argv.includes("--signing-scheduler");
const scheduleMs=process.env.STAR_TESTING_SCHEDULE_MS==='15000'?15000:60000;
const extraArgs = process.argv.slice(2).filter(arg => arg !== "--signing-scheduler");
if (signingScheduler) {
  // Keep this opt-in mode on the DocuSign demo account, including cron runs.
  extraArgs.push("--test-scheduled", "--var", "DOCUSIGN_ENVIRONMENT:demo");
}

// A changed file under one of these re-renders on its own. Everything else in
// site/ (partials/, which are inlined rather than copied) forces a full build,
// because one edit there changes every page.
const COPIED = new Set([
  "index.html", "buy", "rental", "commercial", "listings", "new-development",
  "contact-us", "our-team", "property", "apply", "portal", "login", "landlord-onboarding", "admin", "png", "video",
  "data", "shared", "favicon.ico", "favicon.svg", "apple-touch-icon.png"
]);

function fullBuild() {
  // A child process, because render-html.js caches the header template for the
  // life of the process — an in-process rebuild would keep serving the old one.
  const result = spawnSync(process.execPath, [path.join(__dirname, "build.js")], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"]
  });
  return result.status === 0;
}

function checkConfiguration() {
  if (!fs.existsSync(devVars)) {
    console.log("\n  No .dev.vars found. Pages will render, but the admin, the");
    console.log("  listings feed and lease generation need it — copy");
    console.log("  .dev.vars.example to .dev.vars and fill it in.\n");
    return;
  }

  const values = new Map();
  const commented = new Set();

  for (const line of fs.readFileSync(devVars, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // A key filled in after the "#" is the easy mistake to make, and it looks
    // exactly like a key that was never there — so say which it is.
    const bare = trimmed.startsWith("#") ? trimmed.replace(/^#+\s*/, "") : trimmed;
    const at = bare.indexOf("=");
    if (at === -1) continue;

    const name = bare.slice(0, at).trim();
    if (trimmed.startsWith("#")) commented.add(name);
    else values.set(name, bare.slice(at + 1).trim().replace(/^["']|["']$/g, ""));
  }

  const wanted = [

    ["SUPABASE_URL", "listings fall back to the bundled file"],
    ["SUPABASE_SERVICE_ROLE_KEY", "listings fall back to the bundled file"],
    ["APP_ENCRYPTION_KEY", "the apply form will refuse to submit"]
  ];

  const problems = wanted
    .filter(([name]) => !values.get(name))
    .map(([name, consequence]) => {
      const state = values.has(name) ? "empty"
        : commented.has(name) ? "still commented out"
          : "not there";
      return `    ${name}  — ${state}, so ${consequence}`;
    });

  if (problems.length === 0) return;

  console.log("\n  .dev.vars:");
  for (const problem of problems) console.log(problem);
  console.log("");
}

// Where a source file lands in dist/, or null if the build does not copy it.
function distPathFor(sourcePath) {
  const relative = path.relative(site, sourcePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const [top] = relative.split(path.sep);
  return COPIED.has(top) ? path.join(dist, relative) : null;
}

function syncOne(sourcePath) {
  const destination = distPathFor(sourcePath);
  if (!destination) return null;

  if (!fs.existsSync(sourcePath)) {
    fs.rmSync(destination, { force: true, recursive: true });
    return `removed ${path.relative(root, sourcePath)}`;
  }

  if (fs.statSync(sourcePath).isDirectory()) return null;

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (path.extname(sourcePath).toLowerCase() === ".html") {
    fs.writeFileSync(destination, renderHtmlFile(sourcePath));
  } else {
    fs.copyFileSync(sourcePath, destination);
  }
  return path.relative(root, sourcePath);
}

// Wrangler does report a busy port, but under a kj::Exception stack trace that
// buries it. Checking first turns that into one line and a way out.
function portInUse(value) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (error) => resolve(error.code === "EADDRINUSE"));
    probe.once("listening", () => probe.close(() => resolve(false)));
    probe.listen(Number(value), "127.0.0.1");
  });
}

async function main() {
  if (await portInUse(port)) {
    console.error(`\n  Port ${port} is already in use — another dev server is probably still running.\n`);
    const inspect = `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
    const other = "PORT=8788 npm run dev";
    const column = Math.max(inspect.length, other.length) + 4;
    console.error(`    ${inspect.padEnd(column)}# see what has it`);
    console.error(`    ${other.padEnd(column)}# or run on another port\n`);
    process.exit(1);
  }
  start();
}

function start() {
console.log("Building…");
if (!fullBuild()) {
  console.error("The initial build failed. Fix the error above and try again.");
  process.exit(1);
}
checkConfiguration();

const wrangler = spawn(
  "npx",
  ["--no-install", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--var", "APP_ENV:local", ...extraArgs],
  { cwd: root, stdio: "inherit" }
);

// Wrangler exposes this local test route but does not run cron on a timer.
// The handler's durable jobs enforce retry timing and provider polling limits.
let scheduledBusy = false;
const scheduledTimer = signingScheduler ? setInterval(async () => {
  if (scheduledBusy) return;
  scheduledBusy = true;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__scheduled`, {
      signal: AbortSignal.timeout(55000), redirect: "error"
    });
    await response.body?.cancel();
    if (!response.ok) console.warn(`  Local scheduled handler returned ${response.status}.`);
  } catch {
    console.warn("  Local scheduled handler unavailable; retrying on the next tick.");
  } finally {
    scheduledBusy = false;
  }
}, scheduleMs) : null;
if (signingScheduler) console.log(`Local rental/signing jobs run every ${scheduleMs/1000} seconds; DocuSign uses demo credentials.`);

// Coalesce the burst of events an editor emits when it saves a file.
const pending = new Set();
let timer = null;
let varsTimer = null;

function schedule(sourcePath) {
  pending.add(sourcePath);
  clearTimeout(timer);
  timer = setTimeout(flush, 80);
}

function flush() {
  const changed = [...pending];
  pending.clear();

  // An edit to a partial or to the renderer itself changes every page.
  const needsFullBuild = changed.some(
    (file) => file.startsWith(path.join(site, "partials")) || file === path.join(__dirname, "render-html.js")
  );

  try {
    if (needsFullBuild) {
      console.log(fullBuild() ? "  rebuilt every page" : "  rebuild failed");
      return;
    }

    for (const file of changed) {
      const label = syncOne(file);
      if (label) console.log(`  ${label}`);
    }
  } catch (error) {
    console.error(`  ${error.message}`);
  }
}

// macOS can report a file read (atime only) as a change. The build requires
// this renderer, so rebuilding on every notification creates a restart loop.
const rendererPath = path.join(__dirname, "render-html.js");
function rendererVersion() {
  const stats = fs.statSync(rendererPath);
  return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
}
let lastRendererVersion = rendererVersion();
const watchers = [
  fs.watch(site, { recursive: true }, (_event, name) => {
    if (name) schedule(path.join(site, name));
  }),
  fs.watch(rendererPath, () => {
    let version;
    try { version = rendererVersion(); } catch { return; } // An editor may replace the file.
    if (version === lastRendererVersion) return;
    lastRendererVersion = version;
    schedule(rendererPath);
  })
];

// Wrangler reloads the Worker when .dev.vars changes, so the advice printed at
// startup would otherwise stay on screen contradicting what is now loaded. A
// key that was not there when wrangler started is a different matter: it reads
// the file once, so a brand new name needs a restart to become a binding.
if (fs.existsSync(devVars)) {
  watchers.push(fs.watch(devVars, () => {
    clearTimeout(varsTimer);
    varsTimer = setTimeout(() => {
      checkConfiguration();
      console.log("  .dev.vars changed — restart `npm run dev` if you added a name that was not there before.\n");
    }, 150);
  }));
}

if (fs.existsSync(leaseTemplate)) {
  watchers.push(fs.watch(leaseTemplate, () => {
    fs.mkdirSync(path.join(dist, "admin"), { recursive: true });
    fs.copyFileSync(leaseTemplate, path.join(dist, "admin", "lease-template.docx"));
    console.log("  lease/template/lease-template.docx");
  }));
}

console.log(`Watching site/ — saved changes appear on http://127.0.0.1:${port} without a restart.`);

function shutdown() {
  clearInterval(scheduledTimer);
  for (const watcher of watchers) watcher.close();
  if (!wrangler.killed) wrangler.kill("SIGTERM");
}

process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
wrangler.on("exit", (code) => { shutdown(); process.exit(code ?? 0); });
}

main();
