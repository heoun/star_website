const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

const copyTargets = ["index.html", "jpg", "png", "data"];

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const target of copyTargets) {
  const source = path.join(root, target);
  const destination = path.join(dist, target);
  if (!fs.existsSync(source)) continue;
  fs.cpSync(source, destination, { recursive: true });
}

console.log("Build complete. Deploy files from ./dist");
