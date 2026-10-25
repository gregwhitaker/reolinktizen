import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryUI } from '../app/js/discovery-ui.js';
import { nvr } from './fixtures/discovery.mjs';

// Minimal DOM surface for the controller; full-app DOM checks are recorded in
// docs/VALIDATION.md. Deliberately no innerHTML so results must use text nodes.
class Element extends EventTarget {
  value = ''; textContent = ''; children = []; attributes = new Map(); disabled = false;
  ownerDocument = { createElement: () => new Element() };
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
}
function fixture(scan, value = '') {
  const fields = Object.fromEntries(['root', 'address', 'status', 'results', 'button'].map(name => [name, new Element()]));
  fields.address.value = value;
  const selected = [];
  const states = [];
  const ui = new DiscoveryUI({ ...fields, scan, onState: state => states.push(state), onSelect: device => {
    selected.push(device); fields.address.value = device.ip; fields.address.dispatchEvent(new Event('input'));
  } });
  return { ...fields, selected, states, ui };
}

test('first-time setup shows search, then an explicit choice even for a single NVR', async () => {
  const f = fixture(async () => [nvr]); await f.ui.start();
  assert.equal(f.address.value, ''); assert.deepEqual(f.selected, []);
  assert.deepEqual(f.states.map(s => s.state), ['searching', 'results']);
  assert.equal(f.states[1].count, 1);
  assert.equal(f.results.children.length, 1); assert.equal(f.button.disabled, false);
  f.results.children[0].onclick();
  assert.equal(f.address.value, nvr.ip); assert.deepEqual(f.selected, [nvr]);
});

test('multiple recorders and unknown devices are selectable using ordinary remote-focusable buttons', async () => {
  const devices = [nvr, { ...nvr, ip: '192.168.1.101', name: '<b>literal device name</b>', kind: 'device' },
    { ...nvr, ip: '192.168.1.102', name: 'Second recorder' }];
  const f = fixture(async () => devices); await f.ui.start();
  assert.equal(f.address.value, ''); assert.equal(f.results.children.length, 3);
  const option = f.results.children[1];
  assert.equal(option.type, 'button'); assert.equal(option.children[0].textContent, devices[1].name);
  option.onclick(); assert.equal(f.address.value, devices[1].ip);
  const cameraOnly = fixture(async () => [devices[1]]); await cameraOnly.ui.start();
  assert.equal(cameraOnly.address.value, ''); assert.equal(cameraOnly.results.children.length, 1);
});

test('discovery preserves saved, typed, and typed-then-cleared addresses', async () => {
  for (const mode of ['saved', 'typed', 'cleared']) {
    let complete;
    const f = fixture(() => new Promise(resolve => { complete = resolve; }), mode === 'saved' ? '10.0.0.5:8443' : '');
    const search = f.ui.start();
    if (mode !== 'saved') {
      f.address.value = '10.0.0.6'; f.address.dispatchEvent(new Event('input'));
      if (mode === 'cleared') { f.address.value = ''; f.address.dispatchEvent(new Event('input')); }
    }
    const before = f.address.value; complete([nvr]); await search;
    assert.equal(f.address.value, before); assert.equal(f.selected.length, 0); assert.equal(f.results.children.length, 1);
  }
});

test('leaving setup cancels discovery and ignores late results', async () => {
  let complete, signal;
  const f = fixture(value => { signal = value; return new Promise(resolve => { complete = resolve; }); });
  const search = f.ui.start(); assert.equal(f.button.disabled, true);
  f.ui.stop(); assert.equal(signal.aborted, true); complete([nvr]); await search;
  assert.equal(f.selected.length, 0); assert.equal(f.button.disabled, false);
  assert.equal(f.ui.state, 'stopped'); assert.equal(f.results.children.length, 0);
  assert.deepEqual(f.states.map(s => s.state), ['searching', 'stopped']);
});

test('a new search supersedes old results and reports no-results and errors without blocking manual entry', async () => {
  const requests = [];
  const f = fixture(signal => new Promise((resolve, reject) => requests.push({ signal, resolve, reject })));
  const first = f.ui.start(), second = f.ui.start();
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve([]); await second; requests[0].resolve([nvr]); await first;
  assert.equal(f.ui.state, 'empty'); assert.equal(f.selected.length, 0);
  const third = f.ui.start(); requests[2].reject(new Error('Check local network access.')); await third;
  assert.equal(f.status.textContent, 'Check local network access.'); assert.equal(f.button.disabled, false);
  assert.equal(f.address.disabled, false);
});

test('unsupported static hosting ends search with a manual-entry fallback', async () => {
  const f = fixture(null); await f.ui.start();
  assert.equal(f.ui.state, 'unavailable'); assert.match(f.status.textContent, /IP address/);
  assert.equal(f.button.disabled, true); assert.equal(f.address.disabled, false);
});

test('Search again runs a fresh scan after an empty result and makes the recorder selectable', async () => {
  let scans = 0;
  const f = fixture(async () => ++scans === 1 ? [] : [nvr], '10.0.0.5:8443');
  await f.button.onclick();
  assert.equal(f.ui.state, 'empty');
  assert.equal(f.button.textContent, 'Search again');
  await f.button.onclick();
  assert.equal(scans, 2); assert.equal(f.results.children.length, 1);
  f.results.children[0].onclick(); assert.equal(f.address.value, nvr.ip);
  assert.equal(f.button.disabled, false);
});

test('finished results survive leaving and returning; a fresh scan replaces them', async () => {
  let scans = 0;
  const f = fixture(async () => ++scans === 1 ? [nvr] : []);
  await f.ui.start(); f.ui.stop();
  assert.equal(f.ui.state, 'results'); assert.equal(f.results.children.length, 1);
  assert.deepEqual(f.ui.devices, [nvr]);
  await f.ui.start();
  assert.equal(f.ui.state, 'empty'); assert.equal(f.results.children.length, 0);
  assert.deepEqual(f.ui.devices, []);
});
