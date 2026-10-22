import { NvrError } from './api.js';
import { previewStream } from './preview-stream.js';

// Only the local preview server supplies this key. Packaged TV apps connect
// directly to the NVR using the same API client and video player.
export function createNvrFetch({ key = '', origin = '', streamMode = '', WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  if (!key) return fetchImpl;
  return async (url, options = {}) => {
    const endpoint = new URL('/__nvr', origin);
    endpoint.searchParams.set('target', String(url));
    const headers = new Headers(options.headers);
    headers.set('X-Reolink-Preview-Key', key);
    let response;
    try {
      response = streamMode === 'websocket' && new URL(url).pathname === '/flv'
        ? await previewStream(url, options, { key, origin, WebSocketImpl })
        : await fetchImpl(endpoint.href, { ...options, headers, credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new NvrError('The local preview server is unavailable. Start npm run dev, then reload this page.', 'preview');
    }
    if (!response.ok) {
      const bridgeCode = response.headers.get('X-Reolink-Preview-Error');
      const isJson = response.headers.get('Content-Type')?.includes('application/json');
      // Also understand 0.1.4 responses while the existing server is still running.
      const detail = bridgeCode || (isJson && [403, 502].includes(response.status))
        ? await response.clone().json().catch(() => null) : null;
      const legacy = detail && [
        'Cannot reach the NVR. Check its local address, port, and HTTPS certificate.',
        'NVR redirects are not supported. Check its HTTP/HTTPS address.',
        'Open the local Reolink TV preview to connect.'
      ].includes(detail.error);
      if ((bridgeCode || legacy) && detail && !Array.isArray(detail) && typeof detail.error === 'string' && detail.error.length <= 600) {
        let message = detail.error;
        if (!bridgeCode && response.status === 502) {
          message += ' This is a connection error, not a password rejection. Restart npm run dev for a more specific diagnosis.';
        } else if (!bridgeCode && response.status === 403) {
          message = 'The local preview session is unavailable. Reload this page and connect again.';
        }
        const kind = bridgeCode === 'NVR_LEGACY_API' ? 'format' :
          bridgeCode?.startsWith('NVR_') || response.status === 502 ? 'network' : 'preview';
        const error = new NvrError(message, kind, response.status);
        error.previewCode = bridgeCode;
        if (bridgeCode === 'NVR_HTTPS_REDIRECT') {
          try {
            const destination = new URL(detail.address);
            const source = new URL(url);
            if (source.protocol === 'http:' && destination.protocol === 'https:' && destination.hostname === source.hostname &&
                !destination.username && !destination.password && destination.href === destination.origin + '/') error.httpsAddress = destination.origin;
          } catch (_) {}
        }
        throw error;
      }
      if (bridgeCode) throw new NvrError('The local preview could not connect. Restart npm run dev, reload this page, and try again.', 'preview', response.status);
    }
    return response;
  };
}
