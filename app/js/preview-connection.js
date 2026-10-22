import { NvrError, normalizeAddress } from './api.js';
import { createNvrFetch } from './transport.js';

export function createPreviewConnection({ key, origin, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  const transport = createNvrFetch({ key, origin, fetchImpl });
  async function certificate(action, body, signal) {
    const response = await fetchImpl(new URL(`/__nvr/certificate/${action}`, origin).href, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reolink-Preview-Key': key },
      body: JSON.stringify(body), signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store'
    });
    if (response.status === 404) throw new NvrError('Restart npm run dev to enable certificate review, then reload this page.', 'preview');
    const value = await response.json();
    if (!response.ok) throw new NvrError(value.error || 'Certificate review failed. Check the address again.', 'preview', response.status);
    return value;
  }
  return {
    async check(input, signal) {
      let address = normalizeAddress(input);
      let path = '/api.cgi';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await transport(`${address}${path}?cmd=GetDevInfo`, { signal });
          if (response.status === 404 && path === '/api.cgi') { path = '/cgi-bin/api.cgi'; continue; }
          // An authentication challenge proves the web service is reachable.
          if ([401, 403].includes(response.status)) { await response.body?.cancel(); return { address }; }
          const data = await response.json().catch(() => null);
          if (!response.ok || !Array.isArray(data) || typeof data[0]?.code !== 'number') {
            throw new NvrError('This address did not return a Reolink API response. Check the recorder’s HTTP/HTTPS port.', 'format');
          }
          return { address };
        } catch (error) {
          if (error.httpsAddress && address.startsWith('http:')) { address = error.httpsAddress; continue; }
          if (error.previewCode === 'NVR_LEGACY_API' && path === '/api.cgi') { path = '/cgi-bin/api.cgi'; continue; }
          if (['NVR_CERTIFICATE', 'NVR_CERTIFICATE_CHANGED'].includes(error.previewCode)) {
            return { address, certificate: await certificate('inspect', { address }, signal) };
          }
          throw error;
        }
      }
      throw new NvrError('The recorder keeps redirecting. Check its HTTPS address and port.', 'network');
    },
    trust: (address, fingerprint, signal) => certificate('trust', { address, fingerprint }, signal)
  };
}
