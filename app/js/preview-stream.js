// Expose the preview WebSocket as a fetch-style response so the normal FLV
// loader keeps its cancellation, authentication fallback, and reconnect logic.
export function previewStream(url, options, { key, origin, WebSocketImpl = globalThis.WebSocket }) {
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(new DOMException('Video cancelled.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const endpoint = new URL('/__nvr/stream', origin);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocketImpl(endpoint.href);
    socket.binaryType = 'arraybuffer';
    let controller, receivedHeaders = false, ended = false;
    const body = new ReadableStream({
      start(value) { controller = value; },
      cancel() { finish(); }
    }, { highWaterMark: 512 * 1024, size: chunk => chunk.byteLength });
    const timer = setTimeout(() => finish(new Error('Video connection timed out.')), 10000);
    const abort = () => finish(new DOMException('Video cancelled.', 'AbortError'));
    function finish(error) {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (!receivedHeaders) reject(error || new Error('Video connection closed.'));
      try { if (error) controller.error(error); else controller.close(); } catch (_) {}
      if (socket.readyState < 2) socket.close();
    }
    signal?.addEventListener('abort', abort, { once: true });
    socket.onopen = () => {
      if (ended) { socket.close(); return; }
      const range = new Headers(options.headers).get('Range');
      socket.send(JSON.stringify({ key, target: String(url), ...(range ? { range } : {}) }));
    };
    socket.onmessage = event => {
      if (ended) return;
      try {
        if (!receivedHeaders) {
          if (typeof event.data !== 'string') throw new Error();
          const metadata = JSON.parse(event.data);
          if (!Number.isInteger(metadata.status) || metadata.status < 200 || metadata.status > 599) throw new Error();
          const response = new Response(body, { status: metadata.status, headers: metadata.headers });
          receivedHeaders = true;
          clearTimeout(timer);
          resolve(response);
        } else {
          if (!(event.data instanceof ArrayBuffer)) throw new Error();
          if (controller.desiredSize < -4 * 1024 * 1024) throw new Error();
          controller.enqueue(new Uint8Array(event.data));
        }
      } catch (_) { finish(new Error('Video transport interrupted.')); }
    };
    socket.onerror = () => finish(new Error('Video connection failed.'));
    socket.onclose = event => finish(event.code === 1000 ? undefined : new Error('Video connection interrupted.'));
  });
}
