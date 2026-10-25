import { isLanIPv4, sortDiscovered, DISCOVERY_PORT_BUSY, DISCOVERY_BLOCKED } from './discovery-protocol.js';

function validatedDevices(value) {
  if (!Array.isArray(value)) throw new Error('Invalid discovery response.');
  const found = new Map();
  for (const item of value.slice(0, 64)) {
    if (!item || !isLanIPv4(item.ip) || item.address !== `https://${item.ip}`) continue;
    found.set(item.ip, { ip: item.ip, address: item.address,
      name: String(item.name || 'Reolink device').slice(0, 96), model: String(item.model || '').slice(0, 96),
      kind: item.kind === 'nvr' ? 'nvr' : 'device' });
  }
  return sortDiscovered(found.values());
}

export function createDiscovery({ key = '', origin = '', isTV = false,
  fetchImpl = globalThis.fetch?.bind(globalThis), workerFactory = url => new Worker(url),
  random = globalThis.crypto, timeout = 12000 } = {}) {
  if (key) return async signal => {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    if (signal?.aborted) throw signal.reason;
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(new URL('/__nvr/discover', origin).href, {
        method: 'POST', headers: { 'X-Reolink-Preview-Key': key }, signal: controller.signal,
        credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store'
      });
      if (response.status === 404) throw new Error('Restart npm run dev and reload to enable discovery.');
      if (response.status === 403) throw new Error('Reload this page to search your network.');
      if (response.status === 429) throw new Error('A network search is already running. Try again shortly.');
      if (!response.ok && response.headers.get('X-Reolink-Preview-Error') === 'DISCOVERY_PORT_BUSY') throw new Error(DISCOVERY_PORT_BUSY);
      if (!response.ok && response.headers.get('X-Reolink-Preview-Error') === 'DISCOVERY_BLOCKED') throw new Error(DISCOVERY_BLOCKED);
      if (!response.ok) throw new Error('Could not search your network. Enter the NVR IP address or try again.');
      return validatedDevices((await response.json()).devices);
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) throw new Error('Network search timed out. Enter the NVR IP address or try again.');
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    }
  };
  if (!isTV) return null;
  return signal => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    let worker, timer, settled = false, shutdownTimer;
    const stop = () => { clearTimeout(shutdownTimer); worker?.terminate(); };
    const finish = (error, devices, graceful = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (graceful && worker) {
        try {
          worker.postMessage({ type: 'cancel' });
          shutdownTimer = setTimeout(stop, 1000);
        } catch (_) { stop(); }
      } else stop();
      if (error) reject(error); else resolve(devices);
    };
    const abort = () => finish(signal.reason || new DOMException('Search cancelled.', 'AbortError'), null, true);
    try {
      const bytes = random.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
      const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
      const id = `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      worker = workerFactory(new URL('./discovery-worker.js', import.meta.url));
      worker.onmessage = event => {
        if (settled) { stop(); return; }
        if (event.data?.type === 'result') {
          try { finish(null, validatedDevices(event.data.devices)); } catch (error) { finish(error); }
        } else if (event.data?.type === 'error') finish(new Error(event.data.message));
      };
      worker.onerror = () => {
        if (settled) stop();
        else finish(new Error('TV discovery could not start. Enter the NVR IP address.'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(new Error('Network search timed out. Enter the NVR IP address or try again.'), null, true), timeout);
      worker.postMessage({ type: 'scan', id });
    } catch (error) { finish(error); }
  });
}
