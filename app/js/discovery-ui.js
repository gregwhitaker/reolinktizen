export class DiscoveryUI {
  constructor({ root, status, results, button, scan, onSelect, onState = () => {} }) {
    Object.assign(this, { root, status, results, button, scan, onSelect, onState });
    this.generation = 0;
    this.state = 'idle';
    this.devices = [];
    button.onclick = () => this.start();
  }

  update(state, message) {
    this.state = state;
    this.button.disabled = state === 'searching' || !this.scan;
    this.status.textContent = message;
    this.onState({ state, count: this.devices.length });
  }

  stop() {
    this.generation++;
    const pending = this.controller;
    this.controller?.abort();
    this.controller = null;
    this.button.disabled = !this.scan;
    this.button.textContent = 'Search again';
    this.root.removeAttribute('aria-busy');
    if (pending) this.update('stopped', 'Search again to find your recorder, or enter its IP address.');
  }

  reset() {
    this.stop();
    this.devices = [];
    this.results.replaceChildren();
    this.update('idle', '');
  }

  async start() {
    this.stop();
    this.devices = [];
    this.results.replaceChildren();
    if (!this.scan) {
      this.update('unavailable', 'Automatic search is unavailable here. Enter your recorder’s IP address to continue.');
      return;
    }
    const generation = this.generation;
    const controller = new AbortController(); this.controller = controller;
    this.button.disabled = true;
    this.root.setAttribute('aria-busy', 'true');
    this.update('searching', 'Looking for recorders on your network…');
    try {
      const devices = await this.scan(controller.signal);
      if (generation !== this.generation) return;
      this.devices = devices;
      // Always let the owner choose, including when only one recorder replies.
      for (const device of devices) {
        const option = this.root.ownerDocument.createElement('button');
        option.type = 'button'; option.className = 'discovered-device';
        const name = this.root.ownerDocument.createElement('strong');
        name.textContent = device.name;
        const detail = this.root.ownerDocument.createElement('span');
        detail.textContent = `${device.ip}${device.model && device.model !== device.name ? ` · ${device.model}` : ''}${device.kind !== 'nvr' ? ' · Reolink device' : ''}`;
        option.append(name, detail);
        option.onclick = () => this.onSelect(device);
        this.results.append(option);
      }
      this.update(devices.length ? 'results' : 'empty', devices.length ?
        `${devices.length} ${devices.length === 1 ? 'device' : 'devices'} found on your network. Select your recorder to continue.` :
        'Make sure your recorder is powered on and connected to the same network.');
    } catch (error) {
      if (generation !== this.generation) return;
      this.update('error', controller.signal.aborted ? 'Search timed out. Try again or enter your recorder’s IP address.' :
        error?.message || 'Could not search your network. Enter your recorder’s IP address.');
    } finally {
      if (generation === this.generation) {
        this.controller = null;
        this.button.disabled = false;
        this.root.removeAttribute('aria-busy');
      }
    }
  }
}
