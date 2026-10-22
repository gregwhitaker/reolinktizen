import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveGrid } from '../app/js/live-grid.js';
import { CameraPlayer } from '../app/js/player.js';

function fixture() {
  const players = [], states = [];
  class Player {
    constructor(video, update, library, options) { Object.assign(this, { video, update, options, plays: [] }); players.push(this); }
    setAudio(value) { this.audio = value; }
    async play(client, id, quality, auth) { this.plays.push({ client, id, quality, auth }); this.update({ state: 'connecting' }); }
    stop() { this.stopped = true; }
    destroy() { this.destroyed = true; }
  }
  const tiles = Array.from({ length: 25 }, (_, id) => ({ id, online: true, video: {} }));
  return { players, states, tiles, client: {}, grid: new LiveGrid((id, state) => states.push({ id, ...state }), Player) };
}

test('every visible online tile gets its own muted Fluent player, excluding offline and sleeping cameras', () => {
  const { grid, players, tiles, client } = fixture();
  tiles[6].online = false; tiles[14].sleeping = true;
  grid.sync(client, tiles, 'credentials');
  assert.equal(players.length, 23);
  assert.deepEqual(players.map(player => player.plays[0].id), tiles.filter(tile => tile.online && !tile.sleeping).map(tile => tile.id));
  assert.ok(players.every(player => player.audio === false && player.options.videoOnly && player.plays[0].quality === 'sub' && player.plays[0].auth === 'credentials'));
  players.forEach(player => player.update({ state: 'live' }));
  assert.deepEqual(grid.summary, { total: 23, live: 23, failed: 0 });
  grid.stop();
  assert.ok(players.every(player => player.destroyed));
});

test('changing the page/layout releases removed streams and retains unchanged visible players', () => {
  const { grid, players, tiles, client } = fixture();
  grid.sync(client, tiles.slice(0, 4));
  grid.sync(client, tiles.slice(0, 4));
  assert.equal(players.length, 4);
  grid.sync(client, tiles.slice(2, 6));
  assert.equal(players.length, 6);
  assert.equal(players[0].destroyed, true);
  assert.equal(players[1].destroyed, true);
  assert.equal(players[2].destroyed, undefined);
  assert.equal(players[3].plays.length, 1);
  assert.deepEqual([...grid.entries.keys()], [2, 3, 4, 5]);
  grid.stop();
});

test('a failed camera can retry independently without restarting healthy feeds', () => {
  const { grid, players, tiles, client } = fixture();
  grid.sync(client, tiles.slice(0, 4));
  players.forEach(player => player.update({ state: 'live' }));
  players[2].update({ state: 'error' });
  assert.deepEqual(grid.summary, { total: 4, live: 3, failed: 1 });
  grid.retryFailed();
  assert.deepEqual(players.map(player => player.plays.length), [1, 1, 2, 1]);
  grid.stop();
});

test('suspending/closing the grid ignores late events, and resuming creates fresh players', () => {
  const { grid, players, states, tiles, client } = fixture();
  grid.sync(client, tiles.slice(0, 4));
  grid.stop();
  const oldEvents = states.length;
  players[0].update({ state: 'live' });
  assert.equal(states.length, oldEvents);
  grid.sync(client, tiles.slice(0, 4));
  assert.equal(players.length, 8);
  assert.ok(players.slice(0, 4).every(player => player.destroyed));
  grid.sync({ demo: true }, tiles);
  assert.equal(grid.entries.size, 0);
  assert.equal(players.length, 8);
});

test('account, video element and availability changes dispose of obsolete players', () => {
  const { grid, players, tiles, client } = fixture();
  grid.sync(client, tiles.slice(0, 2));
  tiles[0] = { ...tiles[0], video: {} }; tiles[1].online = false;
  grid.sync(client, tiles.slice(0, 2));
  assert.ok(players[0].destroyed && players[1].destroyed);
  assert.equal(players.length, 3);
  grid.sync({}, tiles.slice(0, 2));
  assert.equal(players[2].destroyed, true);
  grid.stop();
});

test('leaving a grid while stream authentication is pending cannot create late decoders', async () => {
  const pending = [], created = [], videos = [];
  const library = { Events: { ERROR: 'error' }, getFeatureList: () => ({ mseLivePlayback: true }), createPlayer() { created.push({}); } };
  class Player extends CameraPlayer {
    constructor(video, update, ignored, options) { super(video, update, library, options); }
  }
  const grid = new LiveGrid(() => {}, Player);
  for (let id = 0; id < 4; id++) videos.push(Object.assign(new EventTarget(), { pause() {}, load() {}, removeAttribute() {} }));
  grid.sync({ streamUrl: () => new Promise(resolve => pending.push(resolve)) }, videos.map((video, id) => ({ video, id })));
  assert.equal(pending.length, 4);
  grid.stop();
  pending.forEach(resolve => resolve('http://example.test/flv'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(created.length, 0);
});
