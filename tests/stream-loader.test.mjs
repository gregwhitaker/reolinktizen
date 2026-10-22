import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamLoader } from '../app/js/stream-loader.js';

class BaseLoader {
  constructor(type) { this.type = type; }
  destroy() { this._onDataArrival = null; this._onError = null; }
}
const library = { BaseLoader, LoaderStatus: { kIdle: 0, kConnecting: 1, kBuffering: 2, kError: 3 }, LoaderErrors: { EXCEPTION: 'Exception', HTTP_STATUS_CODE_INVALID: 'HttpStatusCodeInvalid' } };
const seek = { getConfig: url => ({ url, headers: {} }) };

test('destroy immediately cancels a stalled stream after its first chunk', async () => {
  let cancelled = false, signal;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); }, cancel() { cancelled = true; } });
  const Loader = createStreamLoader(library, async (url, options) => { signal = options.signal; return new Response(stream); });
  const loader = new Loader(seek, {});
  const chunks = [];
  loader._onDataArrival = buffer => chunks.push(new Uint8Array(buffer));
  loader.open({ url: 'http://nvr/flv?token=secret' }, { from: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chunks.length, 1);
  loader.destroy();
  await loader.pending;
  assert.equal(cancelled, true);
  assert.equal(signal.aborted, true);
});

test('a late HTTP response after cancellation does not deliver chunks', async () => {
  let resolveFetch, cancelled = false;
  const Loader = createStreamLoader(library, () => new Promise(resolve => { resolveFetch = resolve; }));
  const loader = new Loader(seek, {});
  let chunks = 0;
  loader._onDataArrival = () => { chunks++; };
  loader.open({ url: 'http://nvr/flv' }, { from: 0 });
  loader.abort();
  resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await loader.pending;
  assert.equal(chunks, 0);
  assert.equal(cancelled, true);
});

test('HTTP failures cancel the response body and never expose the authenticated URL', async () => {
  let cancelled = false;
  const Loader = createStreamLoader(library, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 403 }));
  const loader = new Loader(seek, {});
  const errors = [];
  loader._onError = (...args) => errors.push(args);
  loader.open({ url: 'http://nvr/flv?password=secret' }, { from: 0 });
  await loader.pending;
  assert.equal(cancelled, true);
  assert.equal(errors[0][1].code, 403);
  assert.equal(JSON.stringify(errors).includes('secret'), false);
  loader.destroy();
});
