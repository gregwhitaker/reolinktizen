import { DISCOVERY_DURATION, DISCOVERY_RETRIES, DISCOVERY_PORT_BUSY, discoveryProbe, parseDiscoveryPacket,
  addDiscovered, sortDiscovered } from './discovery-protocol.js';

// Keep the socket module in its worker until close() has run. Terminating an
// active worker alone does not guarantee the TV's native socket is released.
export function scanTvSockets(module, { id, signal, duration = DISCOVERY_DURATION,
  retries = DISCOVERY_RETRIES } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const bytes = new TextEncoder().encode(discoveryProbe(id));
  return new Promise((resolve, reject) => {
    let settled = false, packets = 0;
    const timers = [], devices = new Map();
    const finish = error => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try { module._discovery_close(); } catch (_) { /* Runtime may have aborted. */ }
      if (error) reject(error); else resolve(sortDiscovered(devices.values()));
    };
    const abort = () => finish(signal.reason || new DOMException('Search cancelled.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const available = module._discovery_open();
      if (!Number.isInteger(available) || available <= 0 || available > 7) throw new Error('Could not open TV network discovery. Check the network connection.');
      let modes = available & 3;
      const portBusy = () => Object.assign(new Error(DISCOVERY_PORT_BUSY), { code: 'DISCOVERY_PORT_BUSY' });
      if (!modes) throw available & 4 ? portBusy() : new Error('Could not open TV network discovery. Check the network connection.');
      const buffer = module._discovery_buffer();
      for (const delay of retries) timers.push(setTimeout(() => {
        if (settled) return;
        try {
          if (modes & 1) {
            module.HEAPU8.set(bytes, buffer);
            if (module._discovery_send(bytes.length) !== bytes.length) modes &= ~1;
          }
          if ((modes & 2) && module._discovery_send_reolink() !== 4) modes &= ~2;
          if (!modes) throw new Error('Could not send a network search from this TV.');
        } catch (error) { finish(error); }
      }, delay));
      const read = () => {
        if (settled) return;
        try {
          // Limit work per tick so cancel messages and remote input stay responsive.
          for (let i = 0; i < 16 && packets < 512; i++) {
            const count = module._discovery_receive();
            if (count < 0) throw new Error('The TV network search was interrupted.');
            if (!count) break;
            if (count > 65536) throw new Error('Invalid network discovery response.');
            packets++;
            const source = module.UTF8ToString(module._discovery_sender());
            for (const device of parseDiscoveryPacket(module.HEAPU8.subarray(buffer, buffer + count), source, id)) addDiscovered(devices, device);
          }
        } catch (error) { finish(error); return; }
        timers.push(setTimeout(read, 30));
      };
      read();
      if (!settled) timers.push(setTimeout(() => finish(!devices.size && (available & 4) ? portBusy() : null), duration));
    } catch (error) { finish(error); }
  });
}
