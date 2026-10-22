export class SnapshotPoller {
  constructor(client, interval, update) {
    this.client = client;
    this.interval = interval;
    this.update = update;
    this.generation = 0;
    this.urls = new Map();
  }
  start(channels) {
    this.stop();
    const generation = this.generation;
    const tick = async () => {
      const queue = channels.filter(channel => channel.online !== false && !channel.sleeping).slice();
      const worker = async () => {
        while (queue.length && generation === this.generation) {
          const channel = queue.shift();
          try {
            const blob = await this.client.snapshot(channel.id);
            if (generation !== this.generation) return;
            const url = URL.createObjectURL(blob);
            const old = this.urls.get(channel.id);
            this.urls.set(channel.id, url);
            this.update(channel.id, url, null);
            if (old) URL.revokeObjectURL(old);
          } catch (error) {
            if (generation === this.generation) this.update(channel.id, null, error);
          }
        }
      };
      await Promise.all([worker(), worker()]);
      if (generation === this.generation) this.timer = setTimeout(tick, this.interval);
    };
    tick();
  }
  stop() {
    this.generation++;
    clearTimeout(this.timer);
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}
