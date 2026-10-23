import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewConnection } from '../app/js/preview-connection.js';

test('connection check upgrades to HTTPS and continues without certificate approval or sending a password', async () => {
  const calls = [];
  const checker = createPreviewConnection({ key: 'preview-key', origin: 'http://127.0.0.1:4173', fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    assert.equal(new URL(url).pathname, '/__nvr');
    const target = new URL(new URL(url).searchParams.get('target'));
    assert.equal(target.searchParams.get('cmd'), 'GetDevInfo');
    assert.equal(options.body, undefined);
    if (target.protocol === 'http:') return new Response(JSON.stringify({ error: 'HTTPS required.', address: 'https://192.168.1.100' }),
      { status: 502, headers: { 'X-Reolink-Preview-Error': 'NVR_HTTPS_REDIRECT', 'Content-Type': 'application/json' } });
    return Response.json([{ code: 1, error: { rspCode: -6 } }]);
  } });
  const result = await checker.check('http://192.168.1.100');
  assert.deepEqual(result, { address: 'https://192.168.1.100' });
  assert.equal(calls.length, 2);
});

test('an older preview server gives restart guidance instead of reviving certificate approval', async () => {
  for (const code of ['NVR_CERTIFICATE', 'NVR_CERTIFICATE_CHANGED']) {
    let calls = 0;
    const checker = createPreviewConnection({ key: 'key', origin: 'http://127.0.0.1:4173', fetchImpl: async url => {
      calls++; assert.equal(new URL(url).pathname, '/__nvr');
      return Response.json({ error: 'Legacy certificate approval required.' }, { status: 502, headers: { 'X-Reolink-Preview-Error': code } });
    } });
    await assert.rejects(checker.check('192.168.1.100'), /Restart npm run dev/);
    assert.equal(calls, 1);
  }
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
