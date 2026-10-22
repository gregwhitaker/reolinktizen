import { CameraPlayer } from './player.js';

// Reconcile only the visible page. A layout/status change can retain healthy
// streams; removed tiles release their sockets, decoders, listeners and timers.
export class LiveGrid {
  constructor(onState, Player = CameraPlayer) {
    this.onState = onState;
    this.Player = Player;
    this.entries = new Map();
  }

  sync(client, tiles, authMode = 'auto') {
    const wanted = new Map(tiles.filter(tile => !client.demo && tile.online !== false && !tile.sleeping).map(tile => [tile.id, tile]));
    for (const [id, entry] of this.entries) {
      if (!wanted.has(id) || wanted.get(id).video !== entry.video || entry.client !== client || entry.authMode !== authMode) {
        this.entries.delete(id);
        entry.player.destroy();
      }
    }
    for (const [id, tile] of wanted) {
      if (this.entries.has(id)) continue;
      const entry = { client, video: tile.video, authMode, state: 'connecting' };
      entry.player = new this.Player(tile.video, state => {
        if (this.entries.get(id) !== entry || state.state === 'notice') return;
        entry.state = state.state;
        this.onState(id, state);
      }, undefined, { videoOnly: true });
      this.entries.set(id, entry);
      this.play(id, entry);
    }
  }

  play(id, entry) {
    entry.player.setAudio(false);
    entry.player.play(entry.client, id, 'sub', entry.authMode).catch(() => {
      if (this.entries.get(id) !== entry) return;
      entry.player.stop();
      entry.state = 'error';
      this.onState(id, { state: 'error', message: 'Unable to open this camera.' });
    });
  }

  retryFailed() {
    for (const [id, entry] of this.entries) if (entry.state === 'error') this.play(id, entry);
  }

  get summary() {
    const entries = [...this.entries.values()];
    return { total: entries.length, live: entries.filter(entry => entry.state === 'live').length, failed: entries.filter(entry => entry.state === 'error').length };
  }

  stop() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.player.destroy();
  }
}
