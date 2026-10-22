import test from 'node:test';
import assert from 'node:assert/strict';
import { ReolinkClient, normalizeAddress, normalizeChannels } from '../app/js/api.js';
import { readSettings, saveSettings, forgetSettings } from '../app/js/storage.js';

const config = { address: '192.168.1.100', username: 'viewer', password: 'a&b+?#= pass', channelCount: 0 };
function response(value, cmd = 'GetChannelstatus') { return new Response(JSON.stringify([{ cmd, code: 0, value }]), { headers: { 'Content-Type': 'application/json' } }); }
function authError() { return new Response(JSON.stringify([{ code: 1, error: { rspCode: -6, detail: 'please login' } }])); }
function createMock(handler) {
  const calls = [];
  const fetch = async (url, options) => {
    const parsed = new URL(url);
    const cmd = parsed.searchParams.get('cmd');
    const body = options.body ? JSON.parse(options.body)[0] : null;
    calls.push({ url: parsed, options, cmd, body });
    return handler({ cmd, body, url: parsed, options, calls });
  };
  return { fetch, calls };
}

test('addresses accept ports and IPv6, and reject embedded credentials and paths', () => {
  assert.equal(normalizeAddress(' 192.168.1.100:8080 '), 'http://192.168.1.100:8080');
  assert.equal(normalizeAddress('https://nvr.local/'), 'https://nvr.local');
  assert.equal(normalizeAddress('http://[::1]:8000'), 'http://[::1]:8000');
  for (const input of ['', 'ftp://nvr', 'http://u:p@nvr', 'http://nvr/path', 'http://nvr/?token=abc', 'http://nvr/#x']) assert.throws(() => normalizeAddress(input));
});

test('channel normalization preserves NVR ids, offline and sleeping state, and deduplicates', () => {
  const result = normalizeChannels({ status: [
    { channel: 7, name: 'Garage', online: 1 }, { channel: '0', name: 'Door', online: '0' },
    { channel: 2, name: 'Battery', online: 1, sleep: 1 }, { channel: 7, name: 'Duplicate' }, { channel: -1 }, { channel: 100 }
  ] });
  assert.deepEqual(result.map(c => c.id), [0, 2, 7]);
  assert.equal(result[0].online, false);
  assert.equal(result[1].sleeping, true);
  assert.throws(() => normalizeChannels({}));
});

test('login sends credentials only in POST body, shares concurrent login, discovers channels and RTMP port', async () => {
  const mock = createMock(({ cmd }) => {
    if (cmd === 'Login') return response({ Token: { name: 'token-1', leaseTime: 3600 } });
    if (cmd === 'GetChannelstatus') return response({ status: [{ channel: 3, name: 'Side', online: 1 }] });
    if (cmd === 'GetDevInfo') return response({ DevInfo: { model: 'RLN8-410', name: 'Home' } });
    if (cmd === 'GetNetPort') return response({ NetPort: { rtmpPort: 1936 } });
  });
  const client = new ReolinkClient(config, mock.fetch);
  await Promise.all([client.login(), client.login(), client.login()]);
  const data = await client.connect();
  assert.equal(mock.calls.filter(c => c.cmd === 'Login').length, 1);
  const login = mock.calls[0];
  assert.equal(login.url.searchParams.has('password'), false);
  assert.equal(login.body.param.User.password, config.password);
  assert.equal(data.channels[0].id, 3);
  const url = new URL(await client.streamUrl(3));
  assert.equal(url.searchParams.get('stream'), 'channel3_sub.bcs');
  assert.equal(url.searchParams.get('port'), '1936');
  assert.equal(url.searchParams.get('token'), 'token-1');
  assert.equal(url.searchParams.has('password'), false);
  client.close();
});

test('credential stream fallback safely encodes reserved characters', async () => {
  const mock = createMock(() => response({ Token: { name: 'token', leaseTime: 300 } }));
  const client = new ReolinkClient(config, mock.fetch);
  const url = new URL(await client.streamUrl(0, 'main', 'credentials'));
  assert.equal(url.searchParams.get('password'), config.password);
  assert.equal(url.searchParams.has('token'), false);
  assert.equal(url.searchParams.get('stream'), 'channel0_main.bcs');
  await assert.rejects(client.streamUrl(-1), /Invalid camera/);
  client.close();
});

test('a rejected session is refreshed once across concurrent commands', async () => {
  let logins = 0;
  const mock = createMock(({ cmd, url }) => {
    if (cmd === 'Login') return response({ Token: { name: `token-${++logins}`, leaseTime: 3600 } });
    if (url.searchParams.get('token') === 'token-1') return authError();
    return response({ status: [{ channel: 0, online: 1 }] });
  });
  const client = new ReolinkClient(config, mock.fetch);
  await client.login();
  const values = await Promise.all([client.channels(), client.channels(), client.channels()]);
  assert.equal(logins, 2);
  assert.equal(values.length, 3);
  client.close();
});

test('invalid login is not retried or leaked in an error message', async () => {
  const mock = createMock(() => authError());
  const client = new ReolinkClient(config, mock.fetch);
  await assert.rejects(client.connect(), error => error.kind === 'auth' && !error.message.includes(config.password));
  await assert.rejects(client.login(), error => error.kind === 'auth');
  assert.equal(mock.calls.length, 1);
  client.close();
});

test('older CGI path is tried only when the first endpoint is missing', async () => {
  const mock = createMock(({ url }) => url.pathname === '/api.cgi' ? new Response('', { status: 404 }) : response({ Token: { name: 'legacy', leaseTime: 300 } }));
  const client = new ReolinkClient(config, mock.fetch);
  await client.login();
  assert.equal(client.apiPath, '/cgi-bin/api.cgi');
  assert.equal(mock.calls.length, 2);
  client.close();
});

test('expiry logs out the old session and renews before requesting a stream', async () => {
  let now = 0, logins = 0;
  const mock = createMock(({ cmd }) => cmd === 'Login' ? response({ Token: { name: `t-${++logins}`, leaseTime: 100 } }) : response({}));
  const client = new ReolinkClient(config, mock.fetch, () => now);
  await client.login();
  now = 90000;
  const url = new URL(await client.streamUrl(0));
  assert.equal(url.searchParams.get('token'), 't-2');
  assert.equal(mock.calls.filter(c => c.cmd === 'Logout').length, 1);
  client.close();
});

test('snapshot refresh retries JSON session failures and accepts JPEG with a generic MIME type', async () => {
  let logins = 0, snaps = 0;
  const mock = createMock(({ cmd }) => {
    if (cmd === 'Login') return response({ Token: { name: `token-${++logins}`, leaseTime: 100 } });
    if (++snaps === 1) return authError();
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), { headers: { 'Content-Type': 'application/octet-stream' } });
  });
  const client = new ReolinkClient(config, mock.fetch);
  const blob = await client.snapshot(0);
  assert.equal(blob.type, 'image/jpeg');
  assert.equal(logins, 2);
  assert.equal(snaps, 2);
  client.close();
});

test('closing a client aborts in-flight work and clears credentials', async () => {
  const mock = createMock(({ options }) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
  const client = new ReolinkClient(config, mock.fetch);
  const pending = client.login();
  client.close();
  await assert.rejects(pending, error => error.kind === 'cancelled');
  assert.equal(client.settings.password, '');
  assert.equal(client.controllers.size, 0);
});

test('password persistence is opt-in, forgetting clears data, malformed settings recover', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  saveSettings({ ...readSettings(storage), ...config }, storage);
  assert.equal(readSettings(storage).password, '');
  assert.equal([...data.values()][0].includes(config.password), false);
  saveSettings({ ...readSettings(storage), ...config, remember: true }, storage);
  assert.equal(readSettings(storage).password, config.password);
  forgetSettings(storage);
  assert.equal(data.size, 0);
  data.set('reolink-tv.settings.v1', '{corrupt');
  assert.equal(readSettings(storage).quality, 'sub');
});
