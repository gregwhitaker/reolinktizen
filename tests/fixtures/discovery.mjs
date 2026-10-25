// Synthetic ONVIF replies; no real recorder identity or address is recorded.
export const id = 'urn:uuid:6ff25fb1-61da-41b6-a445-c0832fac663d';
export const nvr = { ip: '192.168.1.100', address: 'https://192.168.1.100', name: 'My recorder', model: 'RLN16-410', kind: 'nvr' };
// Synthetic native reply: type/model offsets match the fixed device-info record.
// The recorder observed on the LAN returned 388 bytes with a zero prefix, not
// the aa aa 00 00 request prefix. No real identity or packet is stored here.
// The tail marker makes accidental extraction of credential fields detectable.
export function nativeReply({ model = nvr.model, kind = '' } = {}) {
  const bytes = new Uint8Array(388);
  bytes.set(new TextEncoder().encode(kind).subarray(0, 31), 132);
  bytes.set(new TextEncoder().encode(model).subarray(0, 32), 196);
  bytes.set(new TextEncoder().encode('do-not-export-access-key'), 292);
  return bytes;
}
export function reply({ relatesTo = id, ip = nvr.ip, model = nvr.model, name = nvr.name,
  manufacturer = 'Reolink', xaddr = `http://${ip}:8000/onvif/device_service`, prefix = 'd' } = {}) {
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:${prefix}="http://schemas.xmlsoap.org/ws/2005/04/discovery">
<s:Header><a:RelatesTo>${relatesTo}</a:RelatesTo></s:Header>
<s:Body><${prefix}:ProbeMatches><${prefix}:ProbeMatch><a:EndpointReference><a:Address>urn:uuid:fixture</a:Address></a:EndpointReference>
<${prefix}:Types>tds:Device</${prefix}:Types><${prefix}:Scopes>onvif://www.onvif.org/name/${encodeURIComponent(name)} onvif://www.onvif.org/hardware/${encodeURIComponent(model)} onvif://www.onvif.org/manufacturer/${manufacturer}</${prefix}:Scopes>
<${prefix}:XAddrs>${xaddr}</${prefix}:XAddrs></${prefix}:ProbeMatch></${prefix}:ProbeMatches></s:Body></s:Envelope>`;
}
