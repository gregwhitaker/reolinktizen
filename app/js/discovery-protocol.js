// Reolink LAN broadcast and ONVIF, shared by desktop and on-TV UDP transports.
export const DISCOVERY_GROUP = '239.255.255.250';
export const DISCOVERY_PORT = 3702;
export const REOLINK_DISCOVERY_GROUP = '255.255.255.255';
export const REOLINK_DISCOVERY_PORT = 2000;
export const REOLINK_REPLY_PORT = 3000;
export const DISCOVERY_PORT_BUSY = 'Another app is using the Reolink discovery port. Close the Reolink client and search again, or enter the NVR IP address.';
export const DISCOVERY_BLOCKED = 'Network discovery was blocked. Allow local network access for the app running the preview, then search again.';
export const DISCOVERY_DURATION = 3500;
export const DISCOVERY_RETRIES = [0, 700, 1800];

export function isLanIPv4(value) {
  if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  const parts = value.split('.').map(Number);
  if (parts.some((part, i) => part > 255 || String(part) !== value.split('.')[i])) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function discoveryProbe(id) {
  if (!/^urn:uuid:[\da-f-]{36}$/i.test(id)) throw new Error('Invalid discovery message ID.');
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">
<s:Header><a:MessageID>${id}</a:MessageID><a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To><a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action><a:ReplyTo><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo></s:Header>
<s:Body><d:Probe/></s:Body></s:Envelope>`;
}

function elements(xml, name) {
  // Read only bounded text fields. Never resolve entities or follow XML links.
  const tag = `(?:[\\w.-]+:)?${name}`;
  return [...xml.matchAll(new RegExp(`<(${tag})(?:\\s[^<>]*)?>([\\s\\S]*?)<\\/\\1\\s*>`, 'g'))].map(match => match[2]);
}

function decode(value) {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]);
}

function label(value) {
  return value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 96);
}

export function reolinkDiscoveryProbe() { return new Uint8Array([0xaa, 0xaa, 0, 0]); }

function nativeIdentityField(bytes, offset) {
  const field = bytes.subarray(offset, offset + 32);
  const end = field.indexOf(0);
  if (end < 0 || field.subarray(0, end).some(byte => byte < 32 || byte > 126)) return null;
  return new TextDecoder().decode(field.subarray(0, end)).trim();
}

export function parseReolinkDiscoveryReply(bytes, source) {
  if (!isLanIPv4(source) || !(bytes instanceof Uint8Array) || bytes.length < 228 || bytes.length > 4096) return [];
  // Replies are device-info records, not echoes of the aa aa 00 00 probe.
  // The observed recorder leaves the model empty but supplies NVR at offset 132.
  // Read only bounded identity fields; UID/MAC/access-key fields stay unused.
  const type = nativeIdentityField(bytes, 132), model = nativeIdentityField(bytes, 196);
  if (type === null || model === null) return [];
  const nvrModel = /^RLN\d+[A-Z]*(?:-[\w]+)?$|^NVR\b/i.test(model);
  const knownType = /^(?:NVR|IPC|smart_nvr|smart_cam|smart_bell)$/i.test(type);
  if (!knownType && !nvrModel && !/^RLC-[\w-]+$/i.test(model)) return [];
  const kind = /^(?:NVR|smart_nvr)$/i.test(type) || nvrModel ? 'nvr' : 'device';
  return [{ ip: source, address: `https://${source}`, name: model || (kind === 'nvr' ? 'Reolink NVR' : 'Reolink device'), model, kind }];
}

export function parseDiscoveryPacket(bytes, source, id) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 65536) return [];
  const native = parseReolinkDiscoveryReply(bytes, source);
  if (native.length) return native;
  // Binary records must not fall through to XML decoding of unrelated fields.
  if (bytes.includes(0)) return [];
  return parseDiscoveryReply(new TextDecoder().decode(bytes), source, id);
}

export function addDiscovered(devices, device) {
  const previous = devices.get(device.ip);
  if (!previous && devices.size >= 64) return;
  const model = previous?.model || device.model;
  const named = [previous, device].find(item => item?.name && item.name !== item.model && !['Reolink device', 'Reolink NVR'].includes(item.name));
  const kind = previous?.kind === 'nvr' || device.kind === 'nvr' ? 'nvr' : 'device';
  devices.set(device.ip, { ...device, model, name: named?.name || model || (kind === 'nvr' ? 'Reolink NVR' : 'Reolink device'), kind });
}

export function parseDiscoveryReply(xml, source, id) {
  if (!isLanIPv4(source) || typeof xml !== 'string' || xml.length > 65536 ||
      /<!DOCTYPE|<!ENTITY/i.test(xml) || !xml.includes('http://schemas.xmlsoap.org/ws/2005/04/discovery') ||
      elements(xml, 'RelatesTo')[0]?.trim() !== id) return [];
  const devices = [];
  for (const match of elements(xml, 'ProbeMatch').slice(0, 32)) {
    const scopes = (elements(match, 'Scopes')[0] || '').trim().split(/\s+/).map(value => {
      try { return decodeURIComponent(decode(value)); } catch (_) { return ''; }
    });
    const identity = scopes.filter(value => /\/(name|hardware|manufacturer|type)\//i.test(value)).join(' ');
    const model = identity.match(/\bRLN\d+(?:[A-Z]*)(?:-[\w]+)?\b/i)?.[0] || '';
    if (!/\breolink\b/i.test(identity) && !model) continue;
    // An advertisement can suggest an address, never approve a certificate or
    // choose a destination different from the UDP sender. ONVIF's service port
    // is not necessarily the recorder's HTTPS web/API port.
    const matchesSender = (elements(match, 'XAddrs')[0] || '').trim().split(/\s+/).some(value => {
      try {
        const url = new URL(decode(value));
        return ['http:', 'https:'].includes(url.protocol) && url.hostname === source && !url.username && !url.password;
      } catch (_) { return false; }
    });
    if (!matchesSender) continue;
    const name = label(scopes.find(value => /\/name\//i.test(value))?.split(/\/name\//i)[1] || model || 'Reolink device');
    const kind = model || /\bNVR\b|NetworkVideoRecorder/i.test(identity) ? 'nvr' : 'device';
    devices.push({ ip: source, address: `https://${source}`, name, model: label(model), kind });
  }
  return devices;
}

export function sortDiscovered(devices) {
  return [...devices].sort((a, b) => (a.kind === 'nvr' ? 0 : 1) - (b.kind === 'nvr' ? 0 : 1) ||
    a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

export function automaticDevice(devices) {
  const recorders = devices.filter(device => device.kind === 'nvr');
  return recorders.length === 1 ? recorders[0] : null;
}
