import { automaticDevice } from './discovery-protocol.js';

export class DiscoveryUI {
  constructor({ root, address, status, results, button, scan, onSelect }) {
    Object.assign(this, { root, address, status, results, button, scan, onSelect });
    this.generation = 0;
    this.edits = 0;
    address.addEventListener('input', () => { this.edits++; });
    button.onclick = () => this.start();
    root.hidden = !scan;
  }

  stop() {
    this.generation++;
    if (this.controller) this.status.textContent = 'Search stopped. Enter the NVR IP address or search again.';
    this.controller?.abort();
    this.controller = null;
    this.button.disabled = false;
    this.button.textContent = 'Search again';
    this.root.removeAttribute('aria-busy');
  }

  reset() {
    this.stop();
    this.results.replaceChildren();
    this.status.textContent = '';
    this.button.textContent = 'Find NVR';
  }

  async start() {
    if (!this.scan) return;
    this.stop();
    const generation = this.generation, edits = this.edits, initial = this.address.value;
    const controller = new AbortController(); this.controller = controller;
    this.button.disabled = true;
    this.button.textContent = 'Searching…';
    this.root.setAttribute('aria-busy', 'true');
    this.status.textContent = 'Looking for your NVR…';
    this.results.replaceChildren();
    try {
      const devices = await this.scan(controller.signal);
      if (generation !== this.generation) return;
      const automatic = !initial.trim() && this.address.value === initial && edits === this.edits ? automaticDevice(devices) : null;
      if (automatic) {
        this.onSelect(automatic);
        this.status.textContent = `Found ${automatic.model || automatic.name}.`;
      } else {
        this.status.textContent = devices.length ? 'Select your recorder.' : 'No NVR found. Enter its IP address, or enable ONVIF on the NVR and search again.';
      }
      if (!automatic || devices.length > 1) {
        for (const device of devices) {
          const option = this.root.ownerDocument.createElement('button');
          option.type = 'button'; option.className = 'discovered-device';
          const name = this.root.ownerDocument.createElement('strong');
          name.textContent = device.name;
          const detail = this.root.ownerDocument.createElement('span');
          detail.textContent = `${device.ip}${device.model && device.model !== device.name ? ` · ${device.model}` : ''}${device.kind !== 'nvr' ? ' · Reolink device' : ''}`;
          option.append(name, detail);
          option.onclick = () => {
            this.onSelect(device);
            this.status.textContent = `Selected ${device.model || device.name}.`;
          };
          this.results.append(option);
        }
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.status.textContent = controller.signal.aborted ? 'Search timed out. Enter the NVR IP address or try again.' :
        error?.message || 'Could not search your network. Enter the NVR IP address.';
    } finally {
      if (generation === this.generation) {
        this.controller = null;
        this.button.disabled = false;
        this.button.textContent = 'Search again';
        this.root.removeAttribute('aria-busy');
      }
    }
  }
}
