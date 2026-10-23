import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DISCOVERY_GROUP, DISCOVERY_PORT, DISCOVERY_DURATION, DISCOVERY_RETRIES,
  discoveryProbe, parseDiscoveryReply, sortDiscovered, isLanIPv4 } from '../app/js/discovery-protocol.js';
import { previewAuthorized, bridgeFailure } from './preview-bridge.mjs';

export function lanInterfaces(interfaces = networkInterfaces()) {
  return [...new Set(Object.entries(interfaces).filter(([name]) => !/^(lo|utun|tun|wg|tailscale)/i.test(name))
    .flatMap(([, entries]) => entries || []).filter(item => !item.internal &&
      (item.family === 'IPv4' || item.family === 4) && isLanIPv4(item.address)).map(item => item.address))].slice(0, 8);
}

export function discoverNvrs({ signal, interfaces = lanInterfaces(), socketFactory = createSocket,
  duration = DISCOVERY_DURATION, retries = DISCOVERY_RETRIES, id = `urn:uuid:${randomUUID()}` } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!interfaces.length) return Promise.reject(new Error('Connect to your home network, then search again.'));
  return new Promise((resolve, reject) => {
    const sockets = new Set(), timers = new Set(), devices = new Map();
    const probe = Buffer.from(discoveryProbe(id));
    let settled = false, sent = false, failed = 0;
    const finish = error => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) { try { socket.close(); } catch (_) { /* Already closed. */ } }
      if (error) reject(error); else resolve(sortDiscovered(devices.values()));
    };
    const abort = () => finish(signal.reason || new DOMException('Search cancelled.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    timers.add(setTimeout(() => finish(sent ? null : new Error('Network discovery is unavailable. Check local network access and try again.')), duration));
    for (const address of interfaces) {
      let socket, dead = false, packets = 0;
      const fail = () => {
        if (dead || settled) return;
        dead = true; failed++;
        if (socket) { sockets.delete(socket); try { socket.close(); } catch (_) { /* Not bound yet. */ } }
        if (failed === interfaces.length) finish(new Error('Network discovery is unavailable. Check local network access and try again.'));
      };
      try {
        socket = socketFactory('udp4'); sockets.add(socket);
        socket.on('error', fail);
        socket.on('message', (bytes, peer) => {
          if (settled || dead || ++packets > 256 || bytes.length > 65536 || peer.address === address) return;
          for (const device of parseDiscoveryReply(bytes.toString('utf8'), peer.address, id)) {
            if (devices.size < 64 || devices.has(device.ip)) {
              if (devices.get(device.ip)?.kind !== 'nvr') devices.set(device.ip, device);
            }
          }
        });
        socket.bind(0, address, () => {
          if (settled || dead) { try { socket.close(); } catch (_) {} return; }
          try {
            socket.setMulticastInterface(address);
            socket.setMulticastTTL(1);
            for (const delay of retries) timers.add(setTimeout(() => {
              if (settled || dead) return;
              try { socket.send(probe, DISCOVERY_PORT, DISCOVERY_GROUP, error => { if (error) fail(); else sent = true; }); }
              catch (_) { fail(); }
            }, delay));
          } catch (_) { fail(); }
        });
      } catch (_) { fail(); }
    }
  });
}

export function createDiscoveryHandler(scan = discoverNvrs) {
  let active = null;
  const handler = async (req, res, url, key) => {
    if (!previewAuthorized(req, key)) { bridgeFailure(res, 403, 'PREVIEW_SESSION', 'Reload this page to search your network.'); return; }
    if (req.method !== 'POST') { bridgeFailure(res, 405, 'PREVIEW_METHOD', 'Use POST for discovery.'); return; }
    if (url.search || Number(req.headers['content-length'] || 0) !== 0 || req.headers['transfer-encoding']) {
      bridgeFailure(res, 400, 'PREVIEW_REQUEST', 'Discovery takes no addresses or credentials.'); return;
    }
    if (active) { bridgeFailure(res, 429, 'DISCOVERY_BUSY', 'A network search is already running. Try again shortly.'); return; }
    const controller = new AbortController(); active = controller;
    const cancel = () => controller.abort();
    res.once('close', cancel);
    try {
      const devices = await scan({ signal: controller.signal });
      if (!res.destroyed && !controller.signal.aborted) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify({ devices }));
      }
    } catch (_) {
      if (!controller.signal.aborted) bridgeFailure(res, 503, 'DISCOVERY_NETWORK', 'Could not search your network. Check local network access, or enter the NVR IP address.');
    } finally {
      res.removeListener('close', cancel);
      if (active === controller) active = null;
    }
  };
  handler.close = () => active?.abort();
  return handler;
}
