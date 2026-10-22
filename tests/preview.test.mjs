import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { previewServer } from '../scripts/serve.mjs';
import { isLocalAddress } from '../scripts/preview-bridge.mjs';
import { createNvrFetch } from '../app/js/transport.js';
import { ReolinkClient } from '../app/js/api.js';

async function localServer(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function preview(t) {
  const server = previewServer(0);
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const html = await fetch(origin).then(response => response.text());
  const key = html.match(/name="reolink-preview-key" content="([a-f0-9]+)"/)[1];
  return { origin, key, transport: createNvrFetch({ origin, key }) };
}

test('browser transport uses the real client for login, discovery, and unmodified snapshots', async t => {
  const seen = [];
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02]);
  const address = await localServer(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://localhost');
    seen.push({ url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (url.searchParams.get('cmd') === 'Snap') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(jpeg); return;
    }
    const command = JSON.parse(seen.at(-1).body)[0];
    const responses = {
      Login: { Token: { name: 'test-token', leaseTime: 60 } },
      GetChannelstatus: { status: [{ channel: 0, name: 'Connected camera', online: 1 }] },
      GetDevInfo: { DevInfo: { model: 'Test recorder' } },
      GetNetPort: { NetPort: { rtmpPort: 1935 } }
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ cmd: command.cmd, code: 0, value: responses[command.cmd] }]));
  });
  const { transport } = await preview(t);
  const client = new ReolinkClient({ address, username: 'viewer', password: 'p&? test' }, transport);
  t.after(() => client.close());
  assert.equal((await client.connect()).channels[0].name, 'Connected camera');
  assert.equal(JSON.parse(seen[0].body)[0].param.User.password, 'p&? test');
  assert.equal(seen[0].headers['x-reolink-preview-key'], undefined);
  assert.deepEqual(Buffer.from(await (await client.snapshot(0)).arrayBuffer()), jpeg);
  assert.equal(seen.at(-1).url.searchParams.get('token'), 'test-token');
});

test('preview rejects foreign origins, missing keys, nonlocal targets, and non-NVR paths', async t => {
  const { origin, key } = await preview(t);
  const url = `${origin}/__nvr?target=${encodeURIComponent('http://127.0.0.1:9/api.cgi')}`;
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(url, { headers: { 'X-Reolink-Preview-Key': key, Origin: 'https://elsewhere.example' } })).status, 403);
  for (const target of ['http://8.8.8.8/api.cgi', 'http://127.0.0.1/private', 'http://user:password@127.0.0.1/api.cgi', 'file:///api.cgi']) {
    assert.equal((await fetch(`${origin}/__nvr?target=${encodeURIComponent(target)}`, { headers: { 'X-Reolink-Preview-Key': key } })).status, 400);
  }
  for (const value of ['10.0.0.2', '192.168.68.1', '172.16.1.1', '::1', 'fd12::1']) assert.equal(isLocalAddress(value), true);
  for (const value of ['8.8.8.8', '172.32.1.1', '192.0.2.1', '::', '2001:4860:4860::8888']) assert.equal(isLocalAddress(value), false);
  const wrongHost = await new Promise(resolve => {
    const req = request(origin, { headers: { Host: 'elsewhere.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(wrongHost, 403);
});

test('live bytes stream immediately and closing the player closes the NVR connection', async t => {
  let closeStream;
  const closed = new Promise(resolve => { closeStream = resolve; });
  let receivedHeaders;
  const address = await localServer(t, (req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'video/x-flv' });
    res.write(Buffer.from('FLV'));
    res.on('close', closeStream);
  });
  const { transport } = await preview(t);
  const controller = new AbortController();
  const response = await transport(`${address}/flv?token=test-token`, {
    signal: controller.signal,
    headers: { Cookie: 'must-not-forward=1', Authorization: 'must-not-forward', Range: 'bytes=0-' }
  });
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), 'FLV');
  assert.equal(receivedHeaders.range, 'bytes=0-');
  assert.equal(receivedHeaders.cookie, undefined);
  assert.equal(receivedHeaders.authorization, undefined);
  controller.abort();
  await reader.cancel().catch(() => {});
  await Promise.race([closed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('NVR stream was not closed')), 2000);
    timer.unref();
  })]);
});

test('preview does not follow redirects; packaged-app transport remains direct', async t => {
  let destinationHits = 0;
  const destination = await localServer(t, (_req, res) => { destinationHits++; res.end(); });
  const address = await localServer(t, (_req, res) => { res.writeHead(302, { Location: `${destination}/api.cgi?token=must-not-display` }); res.end(); });
  const { transport } = await preview(t);
  await assert.rejects(transport(`${address}/flv?token=test-token`), error =>
    error.kind === 'network' && error.code === 502 && error.message.includes(`Enter ${destination} in NVR address`) && !error.message.includes('must-not-display'));
  assert.equal(destinationHits, 0);
  const direct = () => {};
  assert.equal(createNvrFetch({ fetchImpl: direct }), direct);
});

test('refused ports reach the API client as connection errors, not bad-password errors', async t => {
  const unused = createServer().listen(0, '127.0.0.1');
  await once(unused, 'listening');
  const address = `http://127.0.0.1:${unused.address().port}`;
  await new Promise(resolve => unused.close(resolve));
  const { transport } = await preview(t);
  const client = new ReolinkClient({ address, username: 'viewer', password: 'must-not-appear' }, transport);
  t.after(() => client.close());
  await assert.rejects(client.connect(), error => error.kind === 'network' && error.code === 502 &&
    /refused/.test(error.message) && /password has not been checked/.test(error.message) && !error.message.includes('must-not-appear'));
  assert.equal(client.loginFailure, null);
});

test('a restarted preview session is distinguished from an NVR authentication failure', async t => {
  let hits = 0;
  const address = await localServer(t, (_req, res) => {
    hits++;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ code: 1, error: { rspCode: -6 } }]));
  });
  const { origin, transport } = await preview(t);
  const staleTransport = createNvrFetch({ origin, key: 'expired-session' });
  const staleClient = new ReolinkClient({ address, username: 'viewer', password: 'secret' }, staleTransport);
  t.after(() => staleClient.close());
  await assert.rejects(staleClient.connect(), error => error.kind === 'preview' && /Reload/.test(error.message));
  assert.equal(hits, 0);
  const client = new ReolinkClient({ address, username: 'viewer', password: 'secret' }, transport);
  t.after(() => client.close());
  await assert.rejects(client.connect(), error => error.kind === 'auth');
  assert.equal(hits, 1);
});

test('a redirect to the known older CGI path uses the existing single login fallback', async t => {
  const paths = [];
  const address = await localServer(t, async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    paths.push(url.pathname);
    if (url.pathname === '/api.cgi') {
      res.writeHead(301, { Location: '/cgi-bin/api.cgi?cmd=Login' }); res.end(); return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(JSON.parse(Buffer.concat(chunks).toString())[0].param.User.password, 'test-password');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ code: 0, value: { Token: { name: 'legacy-token', leaseTime: 300 } } }]));
  });
  const { transport } = await preview(t);
  const client = new ReolinkClient({ address, username: 'viewer', password: 'test-password' }, transport);
  t.after(() => client.close());
  await client.login();
  assert.equal(client.apiPath, '/cgi-bin/api.cgi');
  assert.deepEqual(paths, ['/api.cgi', '/cgi-bin/api.cgi']);
});
