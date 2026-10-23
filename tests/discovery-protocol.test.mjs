import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryProbe, parseDiscoveryReply, automaticDevice, isLanIPv4 } from '../app/js/discovery-protocol.js';
import { id, nvr, reply } from './fixtures/discovery.mjs';

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
