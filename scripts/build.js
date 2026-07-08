const fs = require("fs");
const path = require("path");
const { renderHtmlFile } = require("./render-html");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

const copyTargets = ["index.html", "buy", "rental", "commercial", "listings", "new-development", "contact-us", "our-team", "jpg", "png", "data", "shared"];

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const target of copyTargets) {
  const source = path.join(root, target);
  const destination = path.join(dist, target);
  if (!fs.existsSync(source)) continue;
  copyRendered(source, destination);
}

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
