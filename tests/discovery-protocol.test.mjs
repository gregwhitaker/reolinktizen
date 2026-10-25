import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryProbe, reolinkDiscoveryProbe, parseDiscoveryReply, parseDiscoveryPacket,
  parseReolinkDiscoveryReply, addDiscovered, automaticDevice, isLanIPv4 } from '../app/js/discovery-protocol.js';
import { id, nvr, reply, nativeReply } from './fixtures/discovery.mjs';

test('ONVIF replies identify Reolink recorders while using HTTPS web port, not ONVIF port', () => {
  for (const prefix of ['d', 'wsdd', 'discovery']) {
    assert.deepEqual(parseDiscoveryReply(reply({ prefix }), nvr.ip, id), [nvr]);
  }
  assert.match(discoveryProbe(id), /<d:Probe\/>/);
  assert.match(discoveryProbe(id), /<a:MessageID>urn:uuid:/);
  assert.throws(() => discoveryProbe('<bad>'));
});

test('discovery ignores unrelated, malformed, oversized and externally redirected advertisements', () => {
  const invalid = [
    reply({ relatesTo: 'urn:uuid:old-search' }), reply({ manufacturer: 'Other', model: 'IPC', name: 'camera' }),
    reply({ xaddr: 'https://8.8.8.8/onvif/device_service' }), reply({ xaddr: 'https://recorder.example/onvif' }),
    reply({ xaddr: 'https://user:secret@192.168.1.100/onvif' }), reply({ xaddr: 'file:///etc/passwd' }),
    reply().replace('</d:ProbeMatch>', '</x:ProbeMatch>'), '<!DOCTYPE e [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + reply(),
    reply() + ' '.repeat(65536), '<s:Envelope>bad xml', reply().replaceAll('http://schemas.xmlsoap.org/ws/2005/04/discovery', 'fake')
  ];
  for (const xml of invalid) assert.deepEqual(parseDiscoveryReply(xml, nvr.ip, id), []);
  for (const ip of ['127.0.0.1', '8.8.8.8', '192.168.01.100', '192.168.1.999', '::1', '0.0.0.0']) {
    assert.equal(isLanIPv4(ip), false);
    assert.deepEqual(parseDiscoveryReply(reply({ ip }), ip, id), []);
  }
  for (const ip of ['10.1.1.2', '172.16.0.2', '172.31.0.2', '169.254.3.4']) assert.equal(isLanIPv4(ip), true);
});

test('unknown Reolink cameras remain selectable but never fill the NVR field automatically', () => {
  const camera = parseDiscoveryReply(reply({ model: 'RLC-810A', name: 'Front door' }), nvr.ip, id)[0];
  assert.equal(camera.kind, 'device');
  assert.equal(automaticDevice([camera]), null);
  assert.equal(automaticDevice([camera, nvr]), nvr);
  assert.equal(automaticDevice([nvr, { ...nvr, ip: '192.168.1.101' }]), null);
});

test('device names are decoded as text, bounded, and cleaned of markup and controls', () => {
  const [device] = parseDiscoveryReply(reply({ name: '<script>\u0000House & garage</script>' + 'x'.repeat(150) }), nvr.ip, id);
  assert.ok(device.name.startsWith('scriptHouse & garage/script'));
  assert.equal(device.name.length, 96);
  assert.doesNotMatch(device.name, /[<>\u0000]/);
});

test('native discovery identifies recorders without ONVIF and exposes no credential fields', () => {
  assert.deepEqual([...reolinkDiscoveryProbe()], [0xaa, 0xaa, 0, 0]);
  for (const model of ['RLN16-410', 'RLN12W', 'RLN36']) {
    const devices = parseDiscoveryPacket(nativeReply({ model }), nvr.ip, id);
    assert.deepEqual(devices, [{ ...nvr, name: model, model }]);
    assert.equal(automaticDevice(devices), devices[0]);
    assert.doesNotMatch(JSON.stringify(devices), /access.key/);
  }
  assert.deepEqual(parseDiscoveryPacket(new TextEncoder().encode(reply()), nvr.ip, id), [nvr]);
  const [camera] = parseReolinkDiscoveryReply(nativeReply({ model: 'RLC-810A' }), nvr.ip);
  assert.equal(camera.kind, 'device'); assert.equal(automaticDevice([camera]), null);
  const [unknown] = parseReolinkDiscoveryReply(nativeReply({ model: '', kind: 'IPC' }), nvr.ip);
  assert.equal(unknown.kind, 'device'); assert.equal(unknown.name, 'Reolink device');
});

test('native discovery ignores malformed packets and uses only the private UDP sender as the address', () => {
  const unknown = nativeReply({ model: 'Unrelated device', kind: 'other' });
  const invalidText = nativeReply({ model: '' }); invalidText.set([78, 86, 82, 1], 132);
  const unterminated = nativeReply({ model: '' }); unterminated.fill(65, 132, 164); unterminated.set([78, 86, 82], 132);
  for (const bytes of [unknown, invalidText, unterminated, new Uint8Array(388), new Uint8Array(0), nativeReply().subarray(0, 227), new Uint8Array(4097)]) {
    assert.deepEqual(parseReolinkDiscoveryReply(bytes, nvr.ip), []);
  }
  for (const source of ['8.8.8.8', '127.0.0.1', '192.168.1.999']) assert.deepEqual(parseDiscoveryPacket(nativeReply(), source, id), []);
  const bytes = nativeReply(); bytes.set(new TextEncoder().encode('https://8.8.8.8/'), 4);
  assert.equal(parseDiscoveryPacket(bytes, nvr.ip, id)[0].address, nvr.address);
});

test('a native NVR reply with a zero prefix and empty model is found and selected automatically', () => {
  const bytes = nativeReply({ model: '', kind: 'NVR' });
  assert.deepEqual([...bytes.subarray(0, 4)], [0, 0, 0, 0]);
  const devices = parseDiscoveryPacket(bytes, nvr.ip, id);
  assert.deepEqual(devices, [{ ip: nvr.ip, address: nvr.address, name: 'Reolink NVR', model: '', kind: 'nvr' }]);
  assert.equal(automaticDevice(devices), devices[0]);
  assert.doesNotMatch(JSON.stringify(devices), /access.key/);
  const found = new Map(); addDiscovered(found, devices[0]); addDiscovered(found, devices[0]);
  assert.deepEqual([...found.values()], devices);
});

test('native identity comes from bounded type/model fields rather than an echoed request prefix', () => {
  for (const prefix of [[0, 0, 0, 0], [1, 0, 0, 0], [0xaa, 0xaa, 0, 0]]) {
    const bytes = nativeReply({ model: '', kind: 'NVR' }); bytes.set(prefix);
    assert.equal(parseDiscoveryPacket(bytes, nvr.ip, id)[0]?.kind, 'nvr');
  }
  const echoedRequest = new Uint8Array(388); echoedRequest.set(reolinkDiscoveryProbe());
  assert.deepEqual(parseDiscoveryPacket(echoedRequest, nvr.ip, id), []);
});

test('an NVR type fallback does not replace an ONVIF name or model in either arrival order', () => {
  const native = parseReolinkDiscoveryReply(nativeReply({ model: '', kind: 'NVR' }), nvr.ip)[0];
  for (const ordered of [[native, nvr], [nvr, native]]) {
    const devices = new Map(); for (const device of ordered) addDiscovered(devices, device);
    assert.deepEqual([...devices.values()], [nvr]);
  }
});

test('native and ONVIF results merge without losing the name or NVR identity in either arrival order', () => {
  const native = parseReolinkDiscoveryReply(nativeReply(), nvr.ip)[0];
  for (const ordered of [[native, nvr], [nvr, native]]) {
    const devices = new Map(); for (const device of ordered) addDiscovered(devices, device);
    addDiscovered(devices, { ...native, kind: 'device', model: '' });
    assert.deepEqual([...devices.values()], [nvr]);
  }
});
