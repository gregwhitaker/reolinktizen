import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionFailure, redirectFailure } from '../scripts/preview-bridge.mjs';
import { createNvrFetch } from '../app/js/transport.js';
import { ReolinkClient } from '../app/js/api.js';

test('TLS, DNS, routing, protocol and timeout failures give distinct safe diagnostics', () => {
  const cases = [
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'NVR_CERTIFICATE', /certificate/],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'NVR_CERTIFICATE', /certificate/],
    ['ENOTFOUND', 'NVR_DNS', /local IP/],
    ['NONLOCAL_ADDRESS', 'NVR_NONLOCAL', /local IP/],
    ['EHOSTUNREACH', 'NVR_UNREACHABLE', /network/],
    ['ETIMEDOUT', 'NVR_TIMEOUT', /did not respond/],
    ['HPE_INVALID_CONSTANT', 'NVR_PROTOCOL', /HTTP\/HTTPS port/],
    ['UNKNOWN', 'NVR_CONNECTION', /connection/]
  ];
  for (const [code, expected, pattern] of cases) {
    const failure = connectionFailure({ code, message: 'http://private/?password=secret', stack: 'private' });
    assert.equal(failure.code, expected);
    assert.match(failure.message, pattern);
    assert.equal(failure.message.includes('secret'), false);
  }
  assert.equal(connectionFailure({ errors: [{ code: 'ECONNREFUSED' }] }).code, 'NVR_REFUSED');
});

test('an already-running older preview also shows connection guidance instead of a bare 502', async () => {
  const transport = createNvrFetch({ origin: 'http://127.0.0.1:4173', key: 'key', fetchImpl: async () =>
    new Response(JSON.stringify({ error: 'Cannot reach the NVR. Check its local address, port, and HTTPS certificate.' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }) });
  const client = new ReolinkClient({ address: '192.168.1.100', username: 'viewer', password: 'secret' }, transport);
  await assert.rejects(client.connect(), error => error.kind === 'network' && /not a password rejection/.test(error.message));
  client.close();
});

test('a stopped preview server is reported separately and caller cancellation is preserved', async () => {
  const offline = createNvrFetch({ origin: 'http://127.0.0.1:4173', key: 'key', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline('http://192.168.1.100/api.cgi'), error => error.kind === 'preview' && /npm run dev/.test(error.message));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(offline('http://192.168.1.100/api.cgi', { signal: controller.signal }), TypeError);
});

test('upstream errors without a bridge marker do not masquerade as preview diagnostics', async () => {
  const response = new Response(JSON.stringify({ error: 'password=must-not-display' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  const transport = createNvrFetch({ origin: 'http://127.0.0.1:4173', key: 'key', fetchImpl: async () => response });
  assert.equal(await transport('http://192.168.1.100/api.cgi'), response);
});

test('redirect guidance displays the same recorder HTTPS origin without credentials or query strings', () => {
  const target = new URL('http://192.168.1.100/api.cgi?cmd=Login');
  const failure = redirectFailure(target, 'https://192.168.1.100:8443/api.cgi?token=must-not-display&password=secret#private');
  assert.match(failure.message, /Use https:\/\/192\.168\.1\.100:8443/);
  assert.equal(failure.address, 'https://192.168.1.100:8443');
  for (const secret of ['must-not-display', 'secret', 'private', 'api.cgi']) assert.equal(failure.message.includes(secret), false);
  const relative = redirectFailure(target, '//192.168.1.100:8080/api.cgi?password=secret');
  assert.match(relative.message, /http:\/\/192\.168\.1\.100:8080/);
});

test('Reolink HTTP redirects to the HTTPS home page preserve the usable API origin', () => {
  const failure = redirectFailure(new URL('http://192.168.1.100/api.cgi?cmd=GetDevInfo'), 'https://192.168.1.100/');
  assert.equal(failure.code, 'NVR_HTTPS_REDIRECT');
  assert.equal(failure.address, 'https://192.168.1.100');
});

test('redirect guidance handles external hosts, embedded credentials, non-API paths and loops without recommending them', () => {
  const target = new URL('http://192.168.1.100/api.cgi');
  const cases = [
    ['https://elsewhere.example/api.cgi?token=secret', /different hostname/],
    ['https://user:secret@192.168.1.100/api.cgi', /without a usable/],
    ['/login?token=secret', /web page/],
    ['/api.cgi?token=secret', /same API address/],
    [undefined, /without a usable/]
  ];
  for (const [location, pattern] of cases) {
    const failure = redirectFailure(target, location);
    assert.match(failure.message, pattern);
    assert.equal(failure.message.includes('secret'), false);
    assert.equal(failure.message.includes('elsewhere.example'), false);
  }
  assert.match(redirectFailure(new URL('https://192.168.1.100/api.cgi'), 'http://192.168.1.100/api.cgi').message, /unencrypted/);
});
