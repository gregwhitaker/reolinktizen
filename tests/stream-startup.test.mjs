import test from 'node:test';
import assert from 'node:assert/strict';
import { openStartupStream } from '../app/js/stream-startup.js';

const header = Uint8Array.from([70, 76, 86, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0]);
const settle = () => new Promise(resolve => setImmediate(resolve));
const ready = () => new Response(header, { headers: { 'Content-Type': 'video/x-flv' } });
function fixture(t, fetchImpl) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(), selected = [], calls = [];
  t.after(() => controller.abort());
  const response = openStartupStream('primary', { signal: controller.signal, headers: { Range: 'bytes=0-' } }, {
    alternate: async () => 'alternate', onSelect: value => selected.push(value),
    fetchImpl: (url, options) => { calls.push({ url, options }); return fetchImpl(url, options); }
  });
  return { response, controller, calls, selected };
}

test('a healthy stream starts with one request and preserves a fragmented FLV header and all payload bytes', async t => {
  const payload = Uint8Array.from([...header, 1, 2, 3, 4]);
  const { response, calls, selected } = fixture(t, async () => new Response(new ReadableStream({
    start(controller) {
      for (const [start, end] of [[0, 2], [2, 4], [4, 7], [7, payload.length]]) controller.enqueue(payload.slice(start, end));
      controller.close();
    }
  }), { headers: { 'Content-Type': 'video/x-flv' } }));
  const result = await response;
  assert.equal(result.headers.get('Content-Type'), 'video/x-flv');
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), payload);
  t.mock.timers.tick(10000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Range, 'bytes=0-');
  assert.deepEqual(selected, [false]);
});

test('a silent connection tries the alternate after one second and cancels the losing reader', async t => {
  let cancelled = false;
  const { response, calls, selected } = fixture(t, async url => url === 'primary'
    ? new Response(new ReadableStream({ cancel() { cancelled = true; } })) : ready());
  await settle();
  t.mock.timers.tick(999);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(new Uint8Array(await (await response).arrayBuffer()), header);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(cancelled, true);
  assert.deepEqual(selected, [true]);
});

test('the original connection can still win after the alternate starts', async t => {
  let send, alternateCancelled = false;
  const { response, calls, selected } = fixture(t, async url => new Response(new ReadableStream(url === 'primary'
    ? { start(controller) { send = controller; } }
    : { cancel() { alternateCancelled = true; } })));
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.signal.aborted, false);
  send.enqueue(header); send.close();
  await (await response).arrayBuffer();
  assert.deepEqual(selected, [false]);
  assert.equal(alternateCancelled, true);
  assert.equal(calls[1].options.signal.aborted, true);
});

test('valid video headers keep their connection while waiting for a camera keyframe', async t => {
  const { response, calls } = fixture(t, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(header); } })));
  const result = await response;
  t.mock.timers.tick(20000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal.aborted, false);
  await result.body.cancel();
  assert.equal(calls[0].options.signal.aborted, true);
});

test('HTTP rejection, non-video bodies and failed connections try the alternate immediately', async t => {
  // Separate contexts keep each case's disposable stream independently owned.
  for (const failure of [() => new Response('denied', { status: 401 }), () => new Response('<html>login</html>'), () => { throw new Error('private URL'); }]) {
    const controller = new AbortController(), calls = [];
    const result = await openStartupStream('primary', { signal: controller.signal }, {
      alternate: async () => 'alternate',
      fetchImpl: async url => { calls.push(url); return url === 'primary' ? failure() : ready(); }
    });
    assert.deepEqual(calls, ['primary', 'alternate']);
    await result.arrayBuffer();
    controller.abort();
  }
});

test('aborting a quiet startup cancels both attempts and prevents delayed work', async t => {
  let cancelled = 0;
  const { response, controller, calls } = fixture(t, async () => new Response(new ReadableStream({ cancel() { cancelled++; } })));
  const rejected = assert.rejects(response, error => error.name === 'AbortError');
  await settle(); t.mock.timers.tick(1000); await settle();
  controller.abort();
  await rejected;
  assert.equal(cancelled, 2);
  assert.ok(calls.every(call => call.options.signal.aborted));
  t.mock.timers.tick(20000);
  assert.equal(calls.length, 2);
});

test('aborting before startup opens no connection', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(openStartupStream('primary', { signal: controller.signal }, {
    fetchImpl() { assert.fail('must not fetch'); }, alternate() { assert.fail('must not start alternate'); }
  }), error => error.name === 'AbortError');
});

test('a late response from the losing attempt is cancelled without replacing the winner', async t => {
  let resolvePrimary, cancelled = false;
  const { response, selected } = fixture(t, url => url === 'primary' ? new Promise(resolve => { resolvePrimary = resolve; }) : Promise.resolve(ready()));
  t.mock.timers.tick(1000);
  await (await response).arrayBuffer();
  resolvePrimary(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await settle();
  assert.equal(cancelled, true);
  assert.deepEqual(selected, [true]);
});

test('aborting a selected stream cancels the live reader', async t => {
  let cancelled = false;
  const { response, controller, calls } = fixture(t, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(header); }, cancel() { cancelled = true; }
  })));
  const reader = (await response).body.getReader();
  await reader.read();
  const pending = reader.read();
  controller.abort();
  assert.equal((await pending).done, true);
  assert.equal(cancelled, true);
  assert.equal(calls[0].options.signal.aborted, true);
});

test('two silent attempts time out together and close both upstreams', async t => {
  const { response, calls } = fixture(t, async () => new Response(new ReadableStream({})));
  const rejected = assert.rejects(response, /startup timed out/);
  await settle(); t.mock.timers.tick(1000); await settle(); t.mock.timers.tick(7000);
  await rejected;
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.options.signal.aborted));
});

test('two rejected attempts report a safe error without credentials or URL details', async t => {
  const { response } = fixture(t, async () => { throw new Error('http://nvr/flv?password=secret'); });
  await assert.rejects(response, error => error.message === 'Unable to open an NVR video stream.');
});
