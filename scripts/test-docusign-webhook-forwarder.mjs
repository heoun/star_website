import assert from 'node:assert/strict';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import forwarder from './dev-docusign-webhook.js';

let calls = 0, received, upstreamStatus = 200, checks = 0;
const eq = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  received = {path: req.url, headers: req.headers, body: Buffer.concat(chunks)}; calls++;
  res.writeHead(upstreamStatus, {'Content-Type': 'application/json', Location: '/admin/'});
  res.end('{"received":true}');
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await listen(upstream);
const proxy = forwarder.createWebhookForwarder(upstream.address().port);
await listen(proxy);
const origin = `http://127.0.0.1:${proxy.address().port}`;
try {
  for (const path of ['/admin/', '/api/admin/cases', '/__scheduled', '/api/webhooks/docusign?path=/admin']) {
    eq((await fetch(origin + path, {method: 'POST'})).status, 404);
  }
  eq((await fetch(origin + '/api/webhooks/docusign')).status, 405);
  eq(calls, 0);
  const raw = Buffer.from('{\r\n  "event": "envelope-completed", "name": "租客"\r\n}');
  const signature = createHmac('sha256', 'synthetic-test-key').update(raw).digest('base64');
  const response = await fetch(origin + '/api/webhooks/docusign', {method: 'POST', body: raw,
    headers: {'X-DocuSign-Signature-1': signature, Cookie: 'private-session', Authorization: 'private-token'}});
  eq(response.status, 200); await response.text();
  eq(received.body, raw);
  eq(received.path, '/api/webhooks/docusign');
  eq(received.headers['x-docusign-signature-1'], signature);
  eq(received.headers.cookie, undefined);
  eq(received.headers.authorization, undefined);
  eq((await fetch(origin + '/api/webhooks/docusign', {method: 'POST', body: Buffer.alloc(1024 * 1024 + 1)})).status, 413);
  eq(calls, 1);
  upstreamStatus = 401;
  eq((await fetch(origin + '/api/webhooks/docusign', {method: 'POST', body: '{}'})).status, 401);
  upstreamStatus = 302;
  eq((await fetch(origin + '/api/webhooks/docusign', {method: 'POST', body: '{}', redirect: 'manual'})).status, 302);
  eq(calls, 3);
  console.log(`PASS ${checks} webhook forwarder checks: route isolation, unchanged HMAC body, credential filtering, size limit and response status`);
} finally {
  for (const server of [proxy, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
