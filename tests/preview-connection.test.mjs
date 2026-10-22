import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewConnection } from '../app/js/preview-connection.js';

test('connection check upgrades the same recorder to HTTPS and requests review without sending a password or approving trust', async () => {
  const calls = [];
  const checker = createPreviewConnection({ key: 'preview-key', origin: 'http://127.0.0.1:4173', fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (url.includes('/certificate/inspect')) {
      assert.deepEqual(JSON.parse(options.body), { address: 'https://192.168.1.100' });
      return Response.json({ address: 'https://192.168.1.100', fingerprint: 'test-fingerprint', valid: true });
    }
    const target = new URL(new URL(url).searchParams.get('target'));
    assert.equal(target.searchParams.get('cmd'), 'GetDevInfo');
    assert.equal(options.body, undefined);
    if (target.protocol === 'http:') return new Response(JSON.stringify({ error: 'HTTPS required.', address: 'https://192.168.1.100' }),
      { status: 502, headers: { 'X-Reolink-Preview-Error': 'NVR_HTTPS_REDIRECT', 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ error: 'Certificate approval required.' }),
      { status: 502, headers: { 'X-Reolink-Preview-Error': 'NVR_CERTIFICATE', 'Content-Type': 'application/json' } });
  } });
  const result = await checker.check('192.168.1.100');
  assert.equal(result.address, 'https://192.168.1.100');
  assert.equal(result.certificate.fingerprint, 'test-fingerprint');
  assert.equal(calls.length, 3);
  assert.equal(calls.some(call => call.url.pathname.endsWith('/trust')), false);
});

test('connection check accepts an unauthenticated Reolink response and handles the older CGI path', async () => {
  const calls = [];
  const checker = createPreviewConnection({ key: 'key', origin: 'http://127.0.0.1:4173', fetchImpl: async url => {
    const target = new URL(new URL(url).searchParams.get('target'));
    calls.push(target.pathname);
    return target.pathname === '/api.cgi' ? new Response('', { status: 404 }) : Response.json([{ code: 1, error: { rspCode: -6 } }]);
  } });
  assert.deepEqual(await checker.check('https://192.168.1.100'), { address: 'https://192.168.1.100' });
  assert.deepEqual(calls, ['/api.cgi', '/cgi-bin/api.cgi']);
});
