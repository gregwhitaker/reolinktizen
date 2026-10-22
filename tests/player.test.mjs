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
  return { video, events, created, states, player: new CameraPlayer(video, state => states.push(state), library, options) };
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
