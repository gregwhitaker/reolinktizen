import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from '../scripts/vendor/ws/wrapper.mjs';
import { previewServer } from '../scripts/serve.mjs';
import { createNvrFetch } from '../app/js/transport.js';

async function setup(t, handler) {
  const nvr = createServer(handler).listen(0, '127.0.0.1');
  const preview = previewServer(0);
  await Promise.all([once(nvr, 'listening'), once(preview, 'listening')]);
  t.after(() => { nvr.closeAllConnections(); nvr.close(); preview.closeAllConnections(); preview.close(); });
  const origin = `http://127.0.0.1:${preview.address().port}`;
  const address = `http://127.0.0.1:${nvr.address().port}`;
  const html = await (await fetch(origin)).text();
  assert.match(html, /name="reolink-preview-streams" content="websocket"/);
  const key = html.match(/name="reolink-preview-key" content="([a-f0-9]+)"/)[1];
  const socketUrls = [];
  class Socket extends WebSocket {
    constructor(url) { super(url, { origin }); socketUrls.push(url); }
  }
  return { origin, address, key, Socket, socketUrls, transport: createNvrFetch({ origin, key, streamMode: 'websocket', WebSocketImpl: Socket }) };
}

test('25 independent live transports deliver exact bytes while the recorder API stays responsive', async t => {
  let active = 0;
  const received = [];
  const { address, origin, transport, socketUrls } = await setup(t, (req, res) => {
    if (req.url.startsWith('/api.cgi')) { res.end('API available'); return; }
    received.push(req.headers);
    active++;
    res.writeHead(200, { 'Content-Type': 'video/x-flv' });
    res.write(Buffer.from([70, 76, 86, 0, 1, 255]));
    res.on('close', () => active--);
  });
  const controllers = Array.from({ length: 25 }, () => new AbortController());
  t.after(() => controllers.forEach(controller => controller.abort()));
  const responses = await Promise.all(controllers.map((controller, id) => transport(`${address}/flv?stream=channel${id}_sub.bcs&token=private-token`, {
    signal: controller.signal, headers: { Cookie: 'private-cookie', Authorization: 'private-header', Range: 'bytes=0-' }
  })));
  assert.equal(active, 25);
  const readers = responses.map(response => response.body.getReader());
  for (const reader of readers) assert.deepEqual(Buffer.from((await reader.read()).value), Buffer.from([70, 76, 86, 0, 1, 255]));
  assert.ok(socketUrls.every(url => url === origin.replace('http:', 'ws:') + '/__nvr/stream'));
  assert.ok(received.every(headers => !headers.cookie && !headers.authorization && !headers['x-reolink-preview-key'] && headers.range === 'bytes=0-'));
  assert.equal(await (await transport(`${address}/api.cgi`)).text(), 'API available');
  controllers.forEach(controller => controller.abort());
  await Promise.all(readers.map(reader => reader.cancel().catch(() => {})));
  const deadline = Date.now() + 2000;
  while (active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(active, 0);
});

test('stream handshakes reject foreign origins and stale keys before reaching the recorder', async t => {
  let hits = 0;
  const { address, origin, key, Socket } = await setup(t, (_req, res) => { hits++; res.end(); });
  const denied = new WebSocket(origin.replace('http:', 'ws:') + '/__nvr/stream', { origin: 'https://foreign.example' });
  denied.on('error', () => {});
  const status = await new Promise(resolve => denied.on('unexpected-response', (req, res) => { resolve(res.statusCode); res.resume(); req.destroy(); }));
  assert.equal(status, 403);
  const stale = createNvrFetch({ origin, key: key + 'wrong', streamMode: 'websocket', WebSocketImpl: Socket });
  await assert.rejects(stale(`${address}/flv?token=do-not-send`));
  assert.equal(hits, 0);
});

test('video sockets retain destination restrictions and never follow authenticated redirects', async t => {
  let hits = 0;
  const { address, transport } = await setup(t, (_req, res) => {
    hits++;
    res.writeHead(302, { Location: 'http://public.example/flv?token=do-not-expose' }); res.end();
  });
  for (const target of ['http://8.8.8.8/flv', 'http://user:secret@127.0.0.1/flv', 'file:///flv', `${address}/private`]) {
    await assert.rejects(transport(target));
  }
  assert.equal(hits, 0);
  await assert.rejects(transport(`${address}/flv?token=secret`), error => !error.message.includes('secret') && !error.message.includes('do-not-expose'));
  assert.equal(hits, 1);
});

test('cancelling before video headers arrive closes the pending upstream request', async t => {
  let started, closed;
  const requested = new Promise(resolve => { started = resolve; });
  const disconnected = new Promise(resolve => { closed = resolve; });
  const { address, transport } = await setup(t, (req, res) => { started(); res.on('close', closed); });
  const controller = new AbortController();
  const result = transport(`${address}/flv`, { signal: controller.signal });
  await requested;
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  await Promise.race([disconnected, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Upstream did not close')), 2000); timer.unref();
  })]);
});
