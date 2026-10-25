import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { discoverNvrs, lanInterfaces, lanBroadcasts, createDiscoveryHandler } from '../scripts/discovery.mjs';
import { id, nvr, reply, nativeReply } from './fixtures/discovery.mjs';

class Socket extends EventEmitter {
  sends = []; closes = 0;
  bind(port, address, callback) { this.bound = { port, address }; callback(); }
  setMulticastInterface(address) { this.interface = address; }
  setMulticastTTL(ttl) { this.ttl = ttl; }
  setBroadcast(value) { this.broadcast = value; }
  setTTL(ttl) { this.ttl = ttl; }
  send(bytes, port, group, callback) { this.sends.push({ bytes: [...bytes], text: bytes.toString(), port, group }); callback(); }
  close() { this.closes++; }
  receive(options = {}) { this.emit('message', Buffer.from(reply(options)), { address: options.ip || nvr.ip }); }
  receiveNative(options = {}) { this.emit('message', Buffer.from(nativeReply(options)), { address: options.ip || nvr.ip }); }
}

test('desktop probes each LAN interface, retries, deduplicates replies and releases sockets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets = [];
  const result = discoverNvrs({ interfaces: ['192.168.1.3', '10.0.0.3'], id,
    broadcasts: { '192.168.1.3': '192.168.1.255', '10.0.0.3': '10.0.0.255' },
    socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  t.mock.timers.tick(1);
  sockets[1].receiveNative(); sockets[0].receive(); sockets[0].receive({ relatesTo: 'stale' });
  sockets[2].receive({ ip: '10.0.0.100', model: 'RLC-810A', name: 'Camera' });
  t.mock.timers.tick(3500);
  assert.deepEqual((await result)[0], nvr);
  assert.equal((await result).length, 2);
  assert.equal(sockets.length, 4);
  for (const [i, socket] of sockets.entries()) {
    assert.equal(socket.bound.address, ['192.168.1.3', '10.0.0.3'][Math.floor(i / 2)]);
    if (i % 2) {
      assert.equal(socket.bound.port, 3000); assert.equal(socket.broadcast, true);
      assert.equal(socket.sends.length, 6);
      assert.ok(socket.sends.every(send => send.port === 2000 && send.bytes.join(',') === '170,170,0,0'));
      assert.deepEqual([...new Set(socket.sends.map(send => send.group))], [i === 1 ? '192.168.1.255' : '10.0.0.255', '255.255.255.255']);
    } else {
      assert.equal(socket.sends.length, 3);
      assert.equal(socket.interface, socket.bound.address);
      assert.equal(socket.bound.port, 0);
      assert.ok(socket.sends.every(send => send.port === 3702 && send.group === '239.255.255.250' && send.text.includes(id)));
    }
    assert.equal(socket.ttl, 1);
    assert.equal(socket.closes, 1);
  }
  t.mock.timers.tick(20000);
  assert.equal(sockets[0].sends.length, 3);
});

test('desktop search tolerates one failed interface and distinguishes no results from network failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets = [];
  const result = discoverNvrs({ interfaces: ['192.168.1.3', '10.0.0.3'], id,
    socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  sockets[0].emit('error', new Error('failed'));
  t.mock.timers.tick(3500);
  assert.deepEqual(await result, []);
  assert.ok(sockets.every(socket => socket.closes === 1));
  await assert.rejects(discoverNvrs({ interfaces: [] }), /home network/);
  await assert.rejects(discoverNvrs({ interfaces: ['10.0.0.3'], socketFactory: () => { throw new Error('EPERM'); } }), /unavailable/);
});

test('cancelling discovery closes sockets immediately and prevents delayed probes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(), sockets = [];
  const result = discoverNvrs({ signal: controller.signal, interfaces: ['192.168.1.3'],
    socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  controller.abort(); await rejected;
  t.mock.timers.tick(10000);
  assert.equal(sockets.length, 2);
  for (const socket of sockets) { assert.equal(socket.closes, 1); assert.equal(socket.sends.length, 0); }
  await assert.rejects(discoverNvrs({ signal: controller.signal, socketFactory: () => assert.fail('must not open') }), { name: 'AbortError' });
});

test('native discovery finds an NVR with no ONVIF reply, including on repeated searches', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bound = new Set();
  for (let search = 0; search < 3; search++) {
    const sockets = [];
    const result = discoverNvrs({ interfaces: ['192.168.1.3'], broadcasts: {}, id, socketFactory: () => {
      const socket = new Socket(); sockets.push(socket);
      socket.bind = (port, address, callback) => {
        assert.equal(bound.has(port), false, 'a previous search must release its reply port');
        bound.add(port); socket.bound = { port, address }; callback();
      };
      socket.close = () => { socket.closes++; bound.delete(socket.bound.port); };
      return socket;
    } });
    t.mock.timers.tick(1);
    if (search) sockets[1].receiveNative();
    t.mock.timers.tick(3500);
    assert.deepEqual(await result, search ? [{ ...nvr, name: nvr.model }] : []);
    assert.equal(bound.size, 0);
  }
});

test('native port conflicts are reported when ONVIF finds nothing, but do not discard ONVIF results', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const answer of [false, true]) {
    let onvif;
    const result = discoverNvrs({ interfaces: ['192.168.1.3'], id, socketFactory: options => {
      const socket = new Socket();
      if (typeof options === 'object') socket.bind = () => socket.emit('error', Object.assign(new Error('bind'), { code: 'EADDRINUSE' }));
      else onvif = socket;
      return socket;
    } });
    const rejected = answer ? null : assert.rejects(result, { code: 'DISCOVERY_PORT_BUSY' });
    t.mock.timers.tick(1);
    if (answer) onvif.receive();
    t.mock.timers.tick(3500);
    if (answer) assert.deepEqual(await result, [nvr]); else await rejected;
  }
  await assert.rejects(discoverNvrs({ interfaces: ['192.168.1.3'], socketFactory: () => {
    throw Object.assign(new Error('private system detail'), { code: 'EPERM' });
  } }), error => error.code === 'DISCOVERY_BLOCKED' && !error.message.includes('private'));
});

test('directed broadcasts follow the real interface netmask and exclude invalid masks and VPNs', () => {
  const entry = (address, netmask) => ({ address, netmask, family: 'IPv4', internal: false });
  assert.deepEqual(lanBroadcasts({ en0: [entry('192.168.68.64', '255.255.252.0')],
    eth0: [entry('10.3.4.5', '255.255.0.0')], utun0: [entry('10.0.0.5', '255.255.255.0')],
    bad: [entry('192.168.1.2', '255.0.255.0')], point: [entry('10.1.2.3', '255.255.255.255')] }),
  { '192.168.68.64': '192.168.71.255', '10.3.4.5': '10.3.255.255' });
});

test('a failed subnet broadcast does not prevent the limited broadcast from finding the recorder', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let native;
  const result = discoverNvrs({ interfaces: ['192.168.1.3'], broadcasts: { '192.168.1.3': '192.168.1.255' }, id,
    socketFactory: options => {
      const socket = new Socket();
      if (typeof options === 'object') {
        native = socket;
        const send = socket.send.bind(socket);
        socket.send = (bytes, port, group, callback) => group === '192.168.1.255' ?
          callback(Object.assign(new Error('unreachable subnet'), { code: 'ENETUNREACH' })) : send(bytes, port, group, callback);
      }
      return socket;
    } });
  t.mock.timers.tick(1); native.receiveNative(); t.mock.timers.tick(3500);
  assert.deepEqual(await result, [{ ...nvr, name: nvr.model }]);
  assert.equal(native.sends.length, 3); assert.equal(native.closes, 1);
});

test('LAN interface selection excludes loopback, VPN, public and IPv6 interfaces', () => {
  const entry = (address, other = {}) => ({ address, family: 'IPv4', internal: false, ...other });
  assert.deepEqual(lanInterfaces({ lo0: [entry('127.0.0.1', { internal: true })],
    en0: [entry('192.168.1.3'), entry('fe80::1', { family: 'IPv6' })], en1: [entry('192.168.1.3')],
    utun3: [entry('10.0.0.2')], tailscale0: [entry('10.0.0.4')], wg0: [entry('10.0.0.5')],
    eth0: [entry('10.1.1.3')], eth1: [entry('8.8.8.8')] }), ['192.168.1.3', '10.1.1.3']);
});

const key = 'test-preview-session';
function request({ headers = {}, method = 'POST', query = '' } = {}) {
  const req = { method, headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173',
    'x-reolink-preview-key': key, ...headers } };
  const res = new EventEmitter();
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = body => { res.body = JSON.parse(body); res.writableEnded = true; };
  return { req, res, url: new URL(`http://127.0.0.1:4173/__nvr/discover${query}`) };
}

test('discovery endpoint rejects unauthorized callers and any client-specified search target or body', async () => {
  const handler = createDiscoveryHandler(() => assert.fail('must not scan'));
  for (const [options, status] of [
    [{ headers: { 'x-reolink-preview-key': '' } }, 403], [{ headers: { origin: 'https://other.example' } }, 403],
    [{ headers: { 'sec-fetch-site': 'cross-site' } }, 403], [{ method: 'GET' }, 405],
    [{ query: '?target=10.0.0.1' }, 400], [{ headers: { 'content-length': '12' } }, 400],
    [{ headers: { 'transfer-encoding': 'chunked' } }, 400]
  ]) {
    const { req, res, url } = request(options); await handler(req, res, url, key);
    assert.equal(res.status, status);
  }
});

test('endpoint permits one active scan, aborts on disconnect and becomes available again', async () => {
  let signal, scans = 0;
  const handler = createDiscoveryHandler(options => {
    scans++; signal = options.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const first = request(), pending = handler(first.req, first.res, first.url, key);
  const second = request(); await handler(second.req, second.res, second.url, key);
  assert.equal(scans, 1); assert.equal(second.res.status, 429);
  first.res.emit('close'); await pending; assert.equal(signal.aborted, true);
  const third = request(), next = handler(third.req, third.res, third.url, key);
  assert.equal(scans, 2); handler.close(); await next; assert.equal(signal.aborted, true);
});

test('endpoint returns devices without caching and hides internal network errors', async () => {
  const success = request();
  await createDiscoveryHandler(async () => [nvr])(success.req, success.res, success.url, key);
  assert.equal(success.res.status, 200);
  assert.deepEqual(success.res.body, { devices: [nvr] });
  assert.equal(success.res.headers['Cache-Control'], 'no-store');
  const failure = request();
  await createDiscoveryHandler(async () => { throw new Error('sensitive internal error'); })(failure.req, failure.res, failure.url, key);
  assert.equal(failure.res.status, 503); assert.doesNotMatch(JSON.stringify(failure.res.body), /sensitive/);
  for (const code of ['DISCOVERY_PORT_BUSY', 'DISCOVERY_BLOCKED']) {
    const known = request();
    await createDiscoveryHandler(async () => { throw Object.assign(new Error('sensitive internal error'), { code }); })(known.req, known.res, known.url, key);
    assert.equal(known.res.headers['X-Reolink-Preview-Error'], code);
    assert.doesNotMatch(JSON.stringify(known.res.body), /sensitive/);
  }
});
