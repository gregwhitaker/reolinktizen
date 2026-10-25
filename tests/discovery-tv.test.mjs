import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTvSockets } from '../app/js/discovery-tv-scan.js';
import { createDiscovery } from '../app/js/discovery.js';
import { id, nvr, reply, nativeReply } from './fixtures/discovery.mjs';

function nativeModule(packets = []) {
  let sender = '';
  return {
    HEAPU8: new Uint8Array(70000), sent: [], nativeSends: 0, closes: 0, opens: 0,
    _discovery_open() { this.opens++; return 3; }, _discovery_close() { this.closes++; },
    _discovery_buffer() { return 128; }, _discovery_sender() { return 1; }, UTF8ToString() { return sender; },
    _discovery_send(length) { this.sent.push(new TextDecoder().decode(this.HEAPU8.subarray(128, 128 + length))); return length; },
    _discovery_send_reolink() { this.nativeSends++; return 4; },
    _discovery_receive() {
      const next = packets.shift(); if (!next) return 0;
      sender = next.ip || nvr.ip;
      const bytes = next.native ? nativeReply(next) : new TextEncoder().encode(reply(next)); this.HEAPU8.set(bytes, 128); return bytes.length;
    }
  };
}

test('TV worker driver discovers and deduplicates devices using native UDP without HTTP', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const module = nativeModule([{ native: true }, {}, { ip: '192.168.1.101', model: 'RLC-810A', name: 'Camera' }]);
  const result = scanTvSockets(module, { id }); t.mock.timers.tick(3500);
  const devices = await result;
  assert.equal(devices.length, 2); assert.deepEqual(devices[0], nvr);
  assert.equal(module.opens, 1); assert.equal(module.closes, 1); assert.equal(module.sent.length, 3);
  assert.equal(module.nativeSends, 3);
  assert.ok(module.sent.every(xml => xml.includes(id) && xml.includes('<d:Probe/>')));
  t.mock.timers.tick(20000); assert.equal(module.sent.length, 3);
});

test('TV driver closes native sockets on cancellation, send failure and receive failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const failure of ['abort', 'send', 'receive', 'open', 'oversize']) {
    const module = nativeModule(), controller = new AbortController();
    if (failure === 'send') { module._discovery_send = () => -1; module._discovery_send_reolink = () => -1; }
    if (failure === 'receive') module._discovery_receive = () => -1;
    if (failure === 'open') module._discovery_open = () => -1;
    if (failure === 'oversize') module._discovery_receive = () => 65537;
    const result = scanTvSockets(module, { id, signal: controller.signal });
    const rejected = assert.rejects(result);
    if (failure === 'abort') controller.abort(); else t.mock.timers.tick(1);
    await rejected;
    assert.equal(module.closes, 1); t.mock.timers.tick(20000); assert.equal(module.closes, 1);
  }
});

test('TV discovery works without ONVIF and tolerates either transport being unavailable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const mode of [1, 2]) {
    const module = nativeModule([mode === 2 ? { native: true } : {}]);
    module._discovery_open = () => mode;
    const result = scanTvSockets(module, { id }); t.mock.timers.tick(3500);
    assert.deepEqual(await result, [{ ...nvr, name: mode === 2 ? nvr.model : nvr.name }]);
    assert.equal(module.sent.length, mode === 1 ? 3 : 0);
    assert.equal(module.nativeSends, mode === 2 ? 3 : 0);
    assert.equal(module.closes, 1);
  }
  const partial = nativeModule([{ native: true }]);
  partial._discovery_send = () => -1;
  const result = scanTvSockets(partial, { id }); t.mock.timers.tick(3500);
  assert.deepEqual(await result, [{ ...nvr, name: nvr.model }]);
});

test('TV reports an occupied native reply port only if ONVIF also finds no device', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const found of [false, true]) {
    const module = nativeModule(found ? [{}] : []); module._discovery_open = () => 5;
    const result = scanTvSockets(module, { id });
    const rejected = found ? null : assert.rejects(result, { code: 'DISCOVERY_PORT_BUSY' });
    t.mock.timers.tick(3500);
    if (found) assert.deepEqual(await result, [nvr]); else await rejected;
    assert.equal(module.closes, 1);
  }
});

test('TV driver limits packet processing so a noisy LAN cannot block cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const module = nativeModule(Array.from({ length: 1000 }, () => ({})));
  let received = 0; const original = module._discovery_receive.bind(module);
  module._discovery_receive = () => { received++; return original(); };
  const result = scanTvSockets(module, { id });
  assert.equal(received, 16);
  for (let i = 0; i < 120; i++) t.mock.timers.tick(30);
  assert.deepEqual(await result, [nvr]); assert.equal(received, 512);
});

function workerFixture(t, timeout = 12000) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = { messages: [], terminated: 0,
    postMessage(message) { this.messages.push(message); }, terminate() { this.terminated++; } };
  const scan = createDiscovery({ isTV: true, timeout,
    fetchImpl: () => assert.fail('TV must never call a desktop discovery server'),
    workerFactory(url) { assert.match(url.pathname, /\/discovery-worker\.js$/); return worker; } });
  return { worker, scan };
}

test('installed TV starts its own worker without a preview key and accepts validated results', async t => {
  const { worker, scan } = workerFixture(t);
  const result = scan();
  assert.equal(worker.messages[0].type, 'scan');
  assert.match(worker.messages[0].id, /^urn:uuid:[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  worker.onmessage({ data: { type: 'result', devices: [nvr, { ...nvr, ip: '8.8.8.8' }, { ...nvr, address: 'http://192.168.1.100' }] } });
  assert.deepEqual(await result, [nvr]); assert.equal(worker.terminated, 1);
  assert.equal(createDiscovery(), null);
});

test('TV cancellation asks the worker to close its socket before terminating it', async t => {
  const { worker, scan } = workerFixture(t), controller = new AbortController();
  const result = scan(controller.signal), rejected = assert.rejects(result, { name: 'AbortError' });
  controller.abort(); await rejected;
  assert.equal(worker.messages.at(-1).type, 'cancel'); assert.equal(worker.terminated, 0);
  worker.onmessage({ data: { type: 'cancelled' } }); assert.equal(worker.terminated, 1);
  t.mock.timers.tick(20000); assert.equal(worker.terminated, 1);
});

test('an unresponsive TV worker times out and is terminated after a cleanup grace period', async t => {
  const { worker, scan } = workerFixture(t, 50);
  const result = scan(), rejected = assert.rejects(result, /timed out/);
  t.mock.timers.tick(50); await rejected;
  assert.equal(worker.messages.at(-1).type, 'cancel'); assert.equal(worker.terminated, 0);
  t.mock.timers.tick(1000); assert.equal(worker.terminated, 1);
});

test('browser discovery sends only the preview key, never connection credentials or targets', async () => {
  let request;
  const scan = createDiscovery({ key: 'session', origin: 'http://127.0.0.1:4173', fetchImpl: async (url, options) => {
    request = { url, options }; return Response.json({ devices: [nvr] });
  } });
  assert.deepEqual(await scan(), [nvr]);
  assert.equal(request.url, 'http://127.0.0.1:4173/__nvr/discover');
  assert.equal(request.options.method, 'POST'); assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.body, undefined);
  assert.deepEqual(request.options.headers, { 'X-Reolink-Preview-Key': 'session' });
});

test('browser discovery propagates cancellation and explains stale servers and timeouts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [status, message] of [[404, /Restart npm run dev/], [403, /Reload/], [429, /already running/], [503, /Could not search/]]) {
    await assert.rejects(createDiscovery({ key: 'key', origin: 'http://localhost', fetchImpl: async () => new Response('', { status }) })(), message);
  }
  for (const [code, message] of [['DISCOVERY_PORT_BUSY', /Close the Reolink client/], ['DISCOVERY_BLOCKED', /Allow local network access/]]) {
    await assert.rejects(createDiscovery({ key: 'key', origin: 'http://localhost', fetchImpl: async () =>
      new Response('private error detail', { status: 503, headers: { 'X-Reolink-Preview-Error': code } }) })(), message);
  }
  const controller = new AbortController(); let signal;
  const scan = createDiscovery({ key: 'key', origin: 'http://localhost', timeout: 50,
    fetchImpl: (_, options) => new Promise((resolve, reject) => {
      signal = options.signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
  const cancelled = scan(controller.signal), rejected = assert.rejects(cancelled, { name: 'AbortError' });
  controller.abort(); await rejected; assert.equal(signal.aborted, true);
  const timed = scan(), timeout = assert.rejects(timed, /timed out/); t.mock.timers.tick(50); await timeout;
});
