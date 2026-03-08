const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8000;
const root = __dirname;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

const server = http.createServer((req, res) => {
  const safePath = req.url.split("?")[0];
  const filePath = path.join(root, safePath === "/" ? "index.html" : safePath.replace(/^\//, ""));
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(root)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.stat(resolved, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      return res.end("Not found");
    }

    const ext = path.extname(resolved).toLowerCase();
    const type = mime[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    fs.createReadStream(resolved).pipe(res);
  });
});

const HOST = "127.0.0.1";
server.listen(PORT, HOST, () => {
  console.log(`Dev server running at http://${HOST}:${PORT}`);
});
