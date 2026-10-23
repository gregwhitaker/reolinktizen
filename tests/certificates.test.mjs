import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Agent, request } from 'node:https';
import { connect, TLSSocket, createSecureContext } from 'node:tls';
import { Duplex, Readable, Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { X509Certificate } from 'node:crypto';
import { bridgeNvr, localLookup } from '../scripts/preview-bridge.mjs';

const key = await readFile(new URL('./fixtures/tls-key.pem', import.meta.url));
const certificates = await Promise.all(['tls-cert.pem', 'tls-changed-cert.pem', 'tls-expired-cert.txt']
  .map(name => readFile(new URL(`./fixtures/${name}`, import.meta.url))));

// Exercise real TLS encryption and certificate verification over in-memory
// duplex streams. No ports or LAN access are needed for these regression tests.
function fixture(t) {
  const streams = [], seen = [], optionsSeen = [];
  let certificate = certificates[0];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const bytes of req) chunks.push(bytes);
    seen.push({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString(), encrypted: req.socket.encrypted });
    if (req.url.startsWith('/flv')) { res.writeHead(200, { 'Content-Type': 'video/x-flv' }); res.end('FLV'); }
    else if (req.url.includes('cmd=Snap')) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(Buffer.from([255, 216, 255, 217])); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[{"code":0}]'); }
  });
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = options => {
    let clientPipe, serverPipe;
    clientPipe = new Duplex({ read() {}, write(bytes, encoding, done) { serverPipe.push(bytes); done(); }, final(done) { serverPipe.push(null); done(); } });
    serverPipe = new Duplex({ read() {}, write(bytes, encoding, done) { clientPipe.push(bytes); done(); }, final(done) { clientPipe.push(null); done(); } });
    const peer = new TLSSocket(serverPipe, { isServer: true, secureContext: createSecureContext({ key, cert: certificate }) });
    peer.on('error', () => {}); server.emit('connection', peer);
    const client = connect({ ...options, socket: clientPipe, lookup: () => assert.fail('fixture must not access the network') });
    streams.push(clientPipe, serverPipe, peer, client);
    return client;
  };
  t.after(() => { agent.destroy(); for (const stream of streams) stream.destroy(); server.close(); });
  const https = (target, options, callback) => {
    optionsSeen.push(options);
    assert.equal(options.lookup, localLookup, 'production requests must retain local-only DNS checks');
    return request(target, { ...options, agent }, callback);
  };
  async function relay({ target = 'https://127.0.0.1/api.cgi', body = '', headers = {}, method = body ? 'POST' : 'GET' } = {}) {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.method = method;
    req.headers = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'x-reolink-preview-key': 'session', ...headers };
    const chunks = [], res = new Writable({ write(bytes, encoding, done) { chunks.push(bytes); done(); } });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
    res.flushHeaders = () => {};
    const completed = once(res, 'finish');
    const url = new URL('http://127.0.0.1:4173/__nvr'); url.searchParams.set('target', target);
    await bridgeNvr(req, res, url, 'session', { https, http: () => assert.fail('HTTPS must not downgrade to HTTP') });
    await completed;
    return { status: res.status, bytes: Buffer.concat(chunks), headers: res.headers };
  }
  const strictRequest = (tlsOptions = {}) => new Promise((resolve, reject) => {
    const req = request('https://127.0.0.1/api.cgi', { agent, ...tlsOptions }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  return { relay, strictRequest, seen, optionsSeen, useCertificate: value => { certificate = value; } };
}

test('local HTTPS login, snapshots and video accept self-signed certificates without approval', { timeout: 5000 }, async t => {
  const f = fixture(t);
  assert.equal((await f.relay({ body: 'test-login-body' })).status, 200);
  assert.equal(f.seen[0].body, 'test-login-body');
  assert.deepEqual((await f.relay({ target: 'https://127.0.0.1/api.cgi?cmd=Snap' })).bytes, Buffer.from([255, 216, 255, 217]));
  assert.equal((await f.relay({ target: 'https://127.0.0.1/flv?token=test-token' })).bytes.toString(), 'FLV');
  assert.ok(f.seen.every(request => request.encrypted));
  assert.ok(f.optionsSeen.every(options => options.rejectUnauthorized === false && options.agent === false));
});

test('changed and expired recorder certificates are also accepted automatically', { timeout: 5000 }, async t => {
  const f = fixture(t);
  assert.notEqual(new X509Certificate(certificates[0]).fingerprint256, new X509Certificate(certificates[1]).fingerprint256);
  assert.ok(Date.parse(new X509Certificate(certificates[2]).validTo) < Date.now());
  for (const certificate of certificates) {
    f.useCertificate(certificate);
    assert.equal((await f.relay({ body: 'test-login-body' })).status, 200);
  }
  assert.equal(f.seen.length, 3);
  assert.ok(f.seen.every(request => request.encrypted));
});

test('certificate acceptance is per NVR request and does not disable ordinary TLS verification', { timeout: 5000 }, async t => {
  const f = fixture(t), originalEnvironment = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  assert.equal((await f.relay()).status, 200);
  await assert.rejects(f.strictRequest(), error => ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code));
  f.useCertificate(certificates[2]);
  await assert.rejects(f.strictRequest({ ca: certificates[2] }), error => error.code === 'CERT_HAS_EXPIRED');
  assert.equal(f.seen.length, 1, 'ordinary untrusted HTTPS must fail before sending HTTP data');
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, originalEnvironment);
});

test('automatic acceptance still rejects public destinations, foreign origins and missing preview keys', { timeout: 5000 }, async t => {
  const f = fixture(t);
  for (const target of ['https://8.8.8.8/api.cgi', 'https://[2001:4860:4860::8888]/api.cgi',
    'https://user:secret@127.0.0.1/api.cgi', 'https://127.0.0.1/private', 'file:///api.cgi']) {
    assert.equal((await f.relay({ target })).status, 400);
  }
  for (const headers of [{ origin: 'https://elsewhere.example' }, { 'x-reolink-preview-key': '' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await f.relay({ headers })).status, 403);
  }
  assert.equal(f.seen.length, 0); assert.equal(f.optionsSeen.length, 0);
});
