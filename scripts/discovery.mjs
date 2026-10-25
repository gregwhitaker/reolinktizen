import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DISCOVERY_GROUP, DISCOVERY_PORT, DISCOVERY_DURATION, DISCOVERY_RETRIES,
  REOLINK_DISCOVERY_GROUP, REOLINK_DISCOVERY_PORT, REOLINK_REPLY_PORT, DISCOVERY_PORT_BUSY, DISCOVERY_BLOCKED,
  discoveryProbe, reolinkDiscoveryProbe, parseDiscoveryPacket, addDiscovered, sortDiscovered, isLanIPv4 } from '../app/js/discovery-protocol.js';
import { previewAuthorized, bridgeFailure } from './preview-bridge.mjs';

export function lanInterfaces(interfaces = networkInterfaces()) {
  return [...new Set(Object.entries(interfaces).filter(([name]) => !/^(lo|utun|tun|wg|tailscale)/i.test(name))
    .flatMap(([, entries]) => entries || []).filter(item => !item.internal &&
      (item.family === 'IPv4' || item.family === 4) && isLanIPv4(item.address)).map(item => item.address))].slice(0, 8);
}

export function lanBroadcasts(interfaces = networkInterfaces()) {
  const allowed = new Set(lanInterfaces(interfaces));
  const broadcasts = {};
  for (const entries of Object.values(interfaces)) for (const item of entries || []) {
    if (!allowed.has(item.address) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(item.netmask || '')) continue;
    const mask = item.netmask.split('.').map(Number);
    if (mask.some(byte => byte > 255) || !/^1+0{2,}$/.test(mask.map(byte => byte.toString(2).padStart(8, '0')).join(''))) continue;
    broadcasts[item.address] = item.address.split('.').map((byte, index) => Number(byte) | (255 ^ mask[index])).join('.');
  }
  return broadcasts;
}

function discoveryError(code = 'DISCOVERY_NETWORK') {
  return Object.assign(new Error(code === 'DISCOVERY_PORT_BUSY' ? DISCOVERY_PORT_BUSY : code === 'DISCOVERY_BLOCKED' ?
    DISCOVERY_BLOCKED : 'Network discovery is unavailable. Check local network access and try again.'), { code });
}

export function discoverNvrs({ signal, interfaces = lanInterfaces(), socketFactory = createSocket,
  broadcasts = lanBroadcasts(), duration = DISCOVERY_DURATION, retries = DISCOVERY_RETRIES, id = `urn:uuid:${randomUUID()}` } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!interfaces.length) return Promise.reject(new Error('Connect to your home network, then search again.'));
  return new Promise((resolve, reject) => {
    const sockets = new Set(), timers = new Set(), devices = new Map();
    const probe = Buffer.from(discoveryProbe(id)), nativeProbe = Buffer.from(reolinkDiscoveryProbe());
    let settled = false, sent = false, nativeSent = false, failed = 0, portBusy = false, blocked = false;
    const failure = () => discoveryError(blocked ? 'DISCOVERY_BLOCKED' : portBusy ? 'DISCOVERY_PORT_BUSY' : 'DISCOVERY_NETWORK');
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
    timers.add(setTimeout(() => finish(devices.size || (sent && (nativeSent || (!portBusy && !blocked))) ? null : failure()), duration));
    for (const address of interfaces) for (const native of [false, true]) {
      if (settled) break;
      let socket, dead = false, packets = 0;
      const fail = error => {
        if (dead || settled) return;
        dead = true; failed++;
        if (native && error?.code === 'EADDRINUSE') portBusy = true;
        if (['EACCES', 'EPERM'].includes(error?.code)) blocked = true;
        if (socket) { sockets.delete(socket); try { socket.close(); } catch (_) { /* Not bound yet. */ } }
        if (failed === interfaces.length * 2) finish(devices.size ? null : failure());
      };
      try {
        socket = socketFactory(native ? { type: 'udp4', reuseAddr: true } : 'udp4'); sockets.add(socket);
        socket.on('error', fail);
        socket.on('message', (bytes, peer) => {
          if (settled || dead || ++packets > 256 || bytes.length > 65536 || peer.address === address) return;
          for (const device of parseDiscoveryPacket(bytes, peer.address, id)) addDiscovered(devices, device);
        });
        socket.bind(native ? REOLINK_REPLY_PORT : 0, address, () => {
          if (settled || dead) { try { socket.close(); } catch (_) {} return; }
          try {
            if (native) { socket.setBroadcast(true); socket.setTTL(1); }
            else { socket.setMulticastInterface(address); socket.setMulticastTTL(1); }
            const destinations = native ? [...new Set([broadcasts[address], REOLINK_DISCOVERY_GROUP].filter(Boolean))] : [DISCOVERY_GROUP];
            for (const delay of retries) timers.add(setTimeout(() => {
              if (settled || dead) return;
              let remaining = destinations.length, succeeded = false, lastError;
              const sentProbe = error => {
                if (settled || dead) return;
                if (error) lastError = error;
                else { succeeded = true; sent = true; if (native) nativeSent = true; }
                if (--remaining === 0 && !succeeded) fail(lastError);
              };
              for (const destination of destinations) {
                if (settled || dead) break;
                try { socket.send(native ? nativeProbe : probe, native ? REOLINK_DISCOVERY_PORT : DISCOVERY_PORT, destination,
                  sentProbe); }
                catch (error) { sentProbe(error); }
              }
            }, delay));
          } catch (error) { fail(error); }
        });
      } catch (error) { fail(error); }
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
    } catch (error) {
      if (!controller.signal.aborted) {
        const known = ['DISCOVERY_PORT_BUSY', 'DISCOVERY_BLOCKED'].includes(error.code);
        bridgeFailure(res, 503, known ? error.code : 'DISCOVERY_NETWORK', known ? discoveryError(error.code).message :
          'Could not search your network. Check local network access, or enter the NVR IP address.');
      }
    } finally {
      res.removeListener('close', cancel);
      if (active === controller) active = null;
    }
  };
  handler.close = () => active?.abort();
  return handler;
}
