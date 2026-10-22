import { Readable, Writable } from 'node:stream';
import { WebSocketServer, WebSocket } from './vendor/ws/wrapper.mjs';
import { bridgeNvr, previewAuthorized } from './preview-bridge.mjs';

// Each upgraded socket carries one FLV stream, outside the browser's HTTP/1
// connection pool. API calls remain available even with a large live grid.
class StreamResponse extends Writable {
  constructor(socket) {
    super({ highWaterMark: 64 * 1024 });
    this.socket = socket;
    this.headersSent = false;
    this.on('error', () => {}); // Network failures close this tile, not the server.
  }
  writeHead(status, headers) {
    if (this.destroyed || this.headersSent) return;
    this.headersSent = true;
    this.socket.send(JSON.stringify({ status, headers }), error => { if (error) this.destroy(); });
  }
  flushHeaders() {}
  _write(chunk, encoding, done) {
    if (this.socket.readyState !== WebSocket.OPEN) { done(new Error('Video connection closed.')); return; }
    // send's completion supplies backpressure to the upstream HTTP response.
    this.socket.send(chunk, { binary: true }, done);
  }
  _final(done) { this.socket.close(1000); done(); }
  _destroy(error, done) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(error ? 1011 : 1000);
    done(error);
  }
}

export function attachPreviewStreams(server, key, certificates) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const port = server.address()?.port;
    const validHost = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(req.headers.host);
    if (!validHost || req.url !== '/__nvr/stream' || req.headers.origin !== `http://${req.headers.host}`) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      const authTimer = setTimeout(() => ws.terminate(), 5000);
      let response;
      ws.on('error', () => response?.destroy());
      ws.on('close', () => { clearTimeout(authTimer); response?.destroy(); });
      ws.once('message', (bytes, binary) => {
        clearTimeout(authTimer);
        let message, target;
        try {
          if (binary) throw new Error();
          message = JSON.parse(bytes.toString());
          target = new URL(message.target);
          if (typeof message.key !== 'string' || target.pathname !== '/flv') throw new Error();
        } catch (_) { ws.close(1008, 'Invalid video request.'); return; }
        // Credentials and the preview key travel in this first message, never
        // in the WebSocket URL. Reuse the HTTP bridge's complete target, TLS,
        // redirect, DNS, timeout, and credential-header protections.
        const relay = Readable.from([]);
        relay.method = 'GET';
        relay.headers = { host: req.headers.host, origin: req.headers.origin, 'x-reolink-preview-key': message.key };
        if (!previewAuthorized(relay, key)) { ws.close(1008, 'Reload the preview and connect again.'); return; }
        if (typeof message.range === 'string' && /^bytes=\d+-\d*$/.test(message.range)) relay.headers.range = message.range;
        response = new StreamResponse(ws);
        const url = new URL('/__nvr', `http://${req.headers.host}`);
        url.searchParams.set('target', target.href);
        bridgeNvr(relay, response, url, key, certificates).catch(() => response.destroy());
        ws.on('message', () => ws.close(1008, 'One stream per connection.'));
      });
    });
  });
  server.on('close', () => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); });
  return sockets;
}
