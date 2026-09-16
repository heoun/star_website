// Point a development tunnel at this listener, not at the full admin server.
// The Worker remains responsible for HMAC verification and durable processing.
const http = require('node:http');
const {Readable, pipeline} = require('node:stream');
const webhookPath = '/api/webhooks/docusign';
const maxBody = 1024 * 1024;

function createWebhookForwarder(workerPort = 8787) {
  if (!Number.isInteger(Number(workerPort)) || Number(workerPort) < 1 || Number(workerPort) > 65535) {
    throw new Error('Invalid local Worker port.');
  }
  const target = `http://127.0.0.1:${Number(workerPort)}${webhookPath}`;
  const server = http.createServer((req, res) => {
    const reply = (status, message) => {
      res.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'});
      res.end(message);
    };
    if (req.url !== webhookPath) { req.resume(); return reply(404, 'Not found'); }
    if (req.method !== 'POST') { req.resume(); return reply(405, 'Method not allowed'); }
    if (Number(req.headers['content-length']) > maxBody) { req.resume(); return reply(413, 'Payload too large'); }
    let total = 0, rejected = false;
    const chunks = [];
    req.on('data', chunk => {
      if (rejected) return;
      total += chunk.length;
      if (total > maxBody) {
        rejected = true; chunks.length = 0; reply(413, 'Payload too large'); return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => { rejected = true; chunks.length = 0; res.destroy(); });
    req.on('end', async () => {
      if (rejected) return;
      const headers = {'Content-Type': req.headers['content-type'] || 'application/json'};
      for (const [name, value] of Object.entries(req.headers)) {
        if (/^x-docusign-signature-\d+$/.test(name) && typeof value === 'string') headers[name] = value;
      }
      try {
        const upstream = await fetch(target, {
          method: 'POST', headers, body: Buffer.concat(chunks), redirect: 'manual',
          signal: AbortSignal.timeout(25000)
        });
        chunks.length = 0;
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') || 'application/json',
          'Cache-Control': 'no-store'
        });
        if (upstream.body) pipeline(Readable.fromWeb(upstream.body), res, () => {});
        else res.end();
      } catch {
        chunks.length = 0;
        if (!res.headersSent) reply(502, 'Local Worker unavailable');
        else res.destroy();
      }
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.setTimeout(35000, socket => socket.destroy());
  return server;
}

if (require.main === module) {
  const port = Number(process.env.DOCUSIGN_FORWARD_PORT || 8788);
  const server = createWebhookForwarder(Number(process.env.PORT || 8787));
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : 'Unable to start the webhook forwarder.');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`DocuSign webhook forwarder ready on http://127.0.0.1:${port}${webhookPath}`));
}

module.exports = {createWebhookForwarder};
