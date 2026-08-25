const fs = require("fs");
const path = require("path");
const { renderHtmlFile } = require("./render-html");

const root = path.resolve(__dirname, "..");
// Page sources live under site/; the build flattens them into dist/, so the
// deployed URL structure is unchanged by the site/ prefix.
const site = path.join(root, "site");
const dist = path.join(root, "dist");

const copyTargets = ["index.html", "buy", "rental", "commercial", "listings", "new-development", "contact-us", "our-team", "property", "apply", "portal", "admin", "png", "video", "data", "shared", "favicon.ico", "favicon.svg", "apple-touch-icon.png"];

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const target of copyTargets) {
  const source = path.join(site, target);
  const destination = path.join(dist, target);
  if (!fs.existsSync(source)) continue;
  copyRendered(source, destination);
}

// The lease template ships as an asset so the Worker can fetch it when filling
// a lease. It lands under /admin/, which wrangler.jsonc routes through the
// Worker, so Cloudflare Access gates it like the rest of the admin.
const leaseTemplate = path.join(root, "lease", "template", "lease-template.docx");
if (fs.existsSync(leaseTemplate)) {
  fs.mkdirSync(path.join(dist, "admin"), { recursive: true });
  fs.copyFileSync(leaseTemplate, path.join(dist, "admin", "lease-template.docx"));
} else {
  console.warn("Warning: lease/template/lease-template.docx is missing; lease generation will fail.");
}

fs.writeFileSync(path.join(dist, ".assetsignore"), "*.php\n");

console.log("Build complete. Deploy files from ./dist");

function copyRendered(source, destination) {
  const stats = fs.statSync(source);

  if (stats.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });

    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyRendered(path.join(source, entry.name), path.join(destination, entry.name));
    }

    return;
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });

  if (path.extname(source).toLowerCase() === ".html") {
    fs.writeFileSync(destination, renderHtmlFile(source));
    return;
  }

  fs.copyFileSync(source, destination);
}
