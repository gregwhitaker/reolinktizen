import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraPlayer } from '../app/js/player.js';
import { nextInDirection } from '../app/js/navigation.js';
import { SnapshotPoller } from '../app/js/snapshots.js';

function fixture(options = {}) {
  const events = new Map();
  const video = { addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key), pause() {}, load() {}, removeAttribute() {}, currentTime: 0, play: () => Promise.resolve() };
  const created = [];
  const library = { LoggingControl: {}, Events: { ERROR: 'error' }, getFeatureList: () => ({ mseLivePlayback: true }), createPlayer: (source, config) => {
    const fake = { source, config, handlers: {}, on(key, fn) { this.handlers[key] = fn; }, attachMediaElement() {}, load() {}, play: () => Promise.resolve(), pause() {}, unload() {}, detachMediaElement() {}, destroy() { this.destroyed = true; } };
    created.push(fake); return fake;
  } };
  const states = [];
  return { video, events, created, states, library, player: new CameraPlayer(video, state => states.push(state), library, options) };
}

test('grid video excludes audio, bounds old buffers and removes event listeners on disposal', async () => {
  const { player, video, events, created } = fixture({ videoOnly: true });
  player.setAudio(true);
  await player.play({ streamUrl: async () => 'http://example.test/flv' }, 0, 'sub');
  assert.equal(video.muted, true);
  assert.equal(created[0].source.hasAudio, false);
  assert.equal(created[0].config.autoCleanupMaxBackwardDuration, 5);
  assert.equal(created[0].config.autoCleanupMinBackwardDuration, 2);
  player.destroy();
  assert.equal(events.size, 0);
  assert.equal(created[0].destroyed, true);
  assert.equal(player.watchdog, null);
});

test('an obsolete decoder cannot interrupt the replacement after a retry', async () => {
  const { player, created } = fixture();
  await player.play({ streamUrl: async () => 'http://example.test/flv' }, 0, 'sub');
  created[0].handlers.error('NetworkError');
  clearTimeout(player.retryTimer); player.retryTimer = null;
  await player.start(player.generation);
  created[0].handlers.error('MediaError');
  assert.equal(player.player, created[1]);
  assert.equal(created[1].destroyed, undefined);
  assert.equal(player.retryTimer, null);
  player.destroy();
});

test('switching cameras discards late stream URLs and never creates a second decoder', async () => {
  const { player, created } = fixture();
  let resolveFirst;
  const client = { streamUrl: id => id === 0 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve('http://example.test/camera1') };
  const first = player.play(client, 0, 'sub');
  await player.play(client, 1, 'sub');
  resolveFirst('http://example.test/stale');
  await first;
  assert.equal(created.length, 1);
  assert.equal(created[0].source.url, 'http://example.test/camera1');
  player.stop();
  assert.equal(created[0].destroyed, true);
  assert.equal(player.watchdog, null);
});

test('stream errors use credential fallback then Fluent, and stop cancels retries', async () => {
  const { player, created } = fixture();
  const client = { streamUrl: async () => 'http://example.test/flv?token=secret' };
  await player.play(client, 0, 'main', 'auto');
  created[0].handlers.error('NetworkError', 'Do not surface this URL');
  assert.equal(player.auth, 'credentials');
  assert.equal(created[0].destroyed, true);
  clearTimeout(player.retryTimer); player.retryTimer = null;
  await player.start(player.generation);
  created[1].handlers.error('MediaError');
  assert.equal(player.quality, 'sub');
  assert.equal(player.fellBack, true);
  player.stop();
  assert.equal(player.retryTimer, null);
});

test('errors after disposal do not schedule reconnects', async () => {
  const { player, created, states } = fixture();
  await player.play({ streamUrl: async () => 'http://example.test/flv' }, 0, 'sub');
  player.stop();
  created[0].handlers.error('NetworkError');
  assert.equal(player.retryTimer, null);
  assert.equal(states.some(state => state.state === 'reconnecting'), false);
});

test('automatic stream sign-in reuses a proven method across cameras, but not across connections', async () => {
  const first = fixture(), next = fixture(), independent = fixture(), forced = fixture();
  const client = { streamUrl: async () => 'http://example.test/flv' };
  const fixtures = [first, next, independent, forced];
  try {
    await first.player.play(client, 0, 'sub');
    first.created[0].handlers.error('NetworkError');
    clearTimeout(first.player.retryTimer); first.player.retryTimer = null;
    await first.player.start(first.player.generation);
    assert.equal(first.player.auth, 'credentials');
    first.events.get('playing')();
    first.player.stop();
    await next.player.play(client, 1, 'sub');
    assert.equal(next.player.auth, 'credentials');
    await independent.player.play({ ...client }, 0, 'sub');
    assert.equal(independent.player.auth, 'token');
    await forced.player.play(client, 2, 'sub', 'token');
    assert.equal(forced.player.auth, 'token');
  } finally { fixtures.forEach(item => item.player.destroy()); }
});

test('failed authentication attempts are not cached and a remembered method can be renegotiated', async () => {
  const first = fixture(), second = fixture(), third = fixture();
  const client = { streamUrl: async () => 'http://example.test/flv' };
  try {
    await first.player.play(client, 0, 'sub');
    first.created[0].handlers.error('NetworkError');
    await second.player.play(client, 1, 'sub');
    assert.equal(second.player.auth, 'token');
    clearTimeout(first.player.retryTimer); first.player.retryTimer = null;
    await first.player.start(first.player.generation);
    first.events.get('playing')();
    await second.player.play(client, 1, 'sub');
    assert.equal(second.player.auth, 'credentials');
    second.created.at(-1).handlers.error('NetworkError');
    assert.equal(second.player.auth, 'token');
    clearTimeout(second.player.retryTimer); second.player.retryTimer = null;
    await second.player.start(second.player.generation);
    second.events.get('playing')();
    await third.player.play(client, 2, 'sub');
    assert.equal(third.player.auth, 'token');
  } finally { [first, second, third].forEach(item => item.player.destroy()); }
});

test('an interrupted established feed keeps its working sign-in method on reconnect', async () => {
  const { player, created, events } = fixture();
  await player.play({ streamUrl: async () => 'http://example.test/flv' }, 0, 'sub');
  events.get('playing')();
  created[0].handlers.error('NetworkError');
  assert.equal(player.auth, 'token');
  player.destroy();
});

test('initial authentication fallback starts without the normal reconnect backoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { player, created } = fixture();
  t.after(() => player.destroy());
  await player.play({ streamUrl: async () => 'http://example.test/flv' }, 0, 'sub');
  created[0].handlers.error('NetworkError');
  t.mock.timers.tick(0);
  await Promise.resolve();
  assert.equal(created.length, 2);
  assert.equal(player.auth, 'credentials');
});

test('a silent automatic sign-in switches transport without replacing the decoder and shares the working method', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = fixture(), next = fixture(), calls = [];
  first.library.BaseLoader = class { destroy() {} };
  first.library.LoaderStatus = { kIdle: 0, kConnecting: 1, kBuffering: 2, kError: 3 };
  first.library.LoaderErrors = { EXCEPTION: 'Exception', HTTP_STATUS_CODE_INVALID: 'HttpStatusCodeInvalid' };
  const client = {
    streamUrl: async (id, quality, auth) => auth,
    fetch: async (auth, options) => {
      calls.push({ auth, signal: options.signal });
      return new Response(new ReadableStream({ start(controller) {
        if (auth === 'credentials') controller.enqueue(Uint8Array.from([70, 76, 86, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0]));
      } }));
    }
  };
  t.after(() => { first.player.destroy(); next.player.destroy(); });
  await first.player.play(client, 0, 'sub');
  const instance = first.created[0];
  const loader = new instance.config.customLoader({ getConfig: url => ({ url, headers: {} }) }, {});
  instance.destroy = () => loader.destroy();
  const chunks = [];
  loader._onDataArrival = bytes => chunks.push(bytes);
  loader.open(instance.source, { from: 0 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chunks.length, 1);
  assert.deepEqual(calls.map(call => call.auth), ['token', 'credentials']);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(first.created.length, 1);
  assert.equal(first.player.auth, 'credentials');
  assert.equal(first.player.retryTimer, null);
  await next.player.play(client, 1, 'sub');
  assert.equal(next.player.auth, 'credentials');
  // Authenticated but unsupported media should fall back in quality, not auth.
  instance.handlers.error('MediaError');
  assert.equal(first.player.auth, 'credentials');
  assert.equal(calls[1].signal.aborted, true);
});

test('an explicit sign-in method is never raced against another method', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { player, created, library } = fixture(), calls = [];
  library.BaseLoader = class { destroy() {} };
  library.LoaderStatus = { kIdle: 0, kConnecting: 1, kBuffering: 2, kError: 3 };
  library.LoaderErrors = { EXCEPTION: 'Exception', HTTP_STATUS_CODE_INVALID: 'HttpStatusCodeInvalid' };
  await player.play({ streamUrl: async (id, quality, auth) => auth, fetch: async auth => {
    calls.push(auth); return new Response(new ReadableStream({}));
  } }, 0, 'sub', 'token');
  const loader = new created[0].config.customLoader({ getConfig: url => ({ url, headers: {} }) }, {});
  created[0].destroy = () => loader.destroy();
  t.after(() => player.destroy());
  loader.open(created[0].source, { from: 0 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10000);
  assert.deepEqual(calls, ['token']);
});

test('D-pad navigation stays in the current row or column before diagonals', () => {
  const current = { x: 0, y: 0, width: 100, height: 100 };
  const candidates = [{ element: 'right', rect: { x: 120, y: 0, width: 100, height: 100 } }, { element: 'down', rect: { x: 0, y: 120, width: 100, height: 100 } }, { element: 'diagonal', rect: { x: 110, y: 110, width: 100, height: 100 } }];
  assert.equal(nextInDirection(current, candidates, 'right'), 'right');
  assert.equal(nextInDirection(current, candidates, 'down'), 'down');
  assert.equal(nextInDirection(current, candidates, 'left'), null);
});

test('snapshot polling is bounded to two requests and ignores old pages', async () => {
  let inFlight = 0, max = 0;
  const pending = [];
  const updates = [];
  const client = { snapshot: async id => {
    inFlight++; max = Math.max(max, inFlight);
    await new Promise(resolve => pending.push(resolve));
    inFlight--; return new Blob(['image'], { type: 'image/jpeg' });
  } };
  const poller = new SnapshotPoller(client, 5000, id => updates.push(id));
  poller.start([0, 1, 2, 3].map(id => ({ id, online: true })));
  assert.equal(max, 2);
  poller.stop();
  pending.forEach(resolve => resolve());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(updates, []);
  assert.equal(poller.urls.size, 0);
});
