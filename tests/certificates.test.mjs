import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { previewServer } from '../scripts/serve.mjs';
import { createNvrFetch } from '../app/js/transport.js';

async function fixtureServer(t, handler) {
  const key = await readFile(new URL('./fixtures/tls-key.pem', import.meta.url));
  const cert = await readFile(new URL('./fixtures/tls-cert.pem', import.meta.url));
  const server = createServer({ key, cert }, handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { server, key, address: `https://127.0.0.1:${server.address().port}` };
}

async function preview(t) {
  const server = previewServer(0);
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const html = await fetch(origin).then(response => response.text());
  const key = html.match(/name="reolink-preview-key" content="([a-f0-9]+)"/)[1];
  return { origin, key, transport: createNvrFetch({ origin, key }), certificate: (action, body, extraHeaders = {}) =>
    fetch(`${origin}/__nvr/certificate/${action}`, { method: 'POST', headers: {
      'X-Reolink-Preview-Key': key, 'Content-Type': 'application/json', ...extraHeaders
    }, body: JSON.stringify(body) }) };
}

test('certificate inspection sends no HTTP data; explicit approval pins login to one origin and one certificate', async t => {
  let requests = 0;
  const nvr = await fixtureServer(t, async (req, res) => {
    requests++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'test-login-body');
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]');
  });
  const client = await preview(t);
  const login = () => client.transport(`${nvr.address}/api.cgi`, { method: 'POST', body: 'test-login-body' });
  await assert.rejects(login(), error => error.previewCode === 'NVR_CERTIFICATE');
  assert.equal(requests, 0);
  const inspection = await client.certificate('inspect', { address: nvr.address });
  assert.equal(inspection.status, 200);
  const certificate = await inspection.json();
  assert.equal(certificate.valid, true);
  assert.match(certificate.fingerprint, /^[A-F0-9:]{95}$/);
  assert.equal(requests, 0);
  assert.equal((await client.certificate('trust', { address: nvr.address, fingerprint: 'wrong' })).status, 409);
  await assert.rejects(login(), error => error.previewCode === 'NVR_CERTIFICATE');
  assert.equal((await client.certificate('trust', { address: nvr.address, fingerprint: certificate.fingerprint })).status, 200);
  assert.equal((await login()).status, 200);
  assert.equal(requests, 1);

  const other = await fixtureServer(t, (_req, res) => { requests++; res.end(); });
  await assert.rejects(client.transport(`${other.address}/api.cgi`), error => error.previewCode === 'NVR_CERTIFICATE');
  assert.equal(requests, 1);
  const restarted = await preview(t);
  await assert.rejects(restarted.transport(`${nvr.address}/api.cgi`), error => error.previewCode === 'NVR_CERTIFICATE');
  assert.equal(requests, 1);

  nvr.server.setSecureContext({ key: nvr.key, cert: await readFile(new URL('./fixtures/tls-changed-cert.pem', import.meta.url)) });
  await assert.rejects(login(), error => error.previewCode === 'NVR_CERTIFICATE_CHANGED');
  assert.equal(requests, 1, 'changed certificates must fail before login data is sent');
});

test('certificate review rejects foreign origins, missing keys, nonlocal destinations and unreviewed approvals', async t => {
  const client = await preview(t);
  const body = { address: 'https://127.0.0.1', fingerprint: 'not-reviewed' };
  assert.equal((await client.certificate('trust', body)).status, 409);
  assert.equal((await client.certificate('trust', body, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await fetch(`${client.origin}/__nvr/certificate/trust`, { method: 'POST', body: JSON.stringify(body) })).status, 403);
  for (const address of ['https://8.8.8.8', 'http://127.0.0.1', 'https://user:password@127.0.0.1', 'https://127.0.0.1/path']) {
    assert.equal((await client.certificate('inspect', { address })).status, 400);
  }
});
