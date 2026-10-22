import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { bridgeNvr, bridgeFailure } from './preview-bridge.mjs';
import { PreviewCertificates, certificateRequest } from './preview-certificates.mjs';
import { attachPreviewStreams } from './preview-streams.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../app');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.flv': 'video/x-flv' };
export function previewServer(port = 4173, host = '127.0.0.1') {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('The NVR preview must listen on loopback.');
  const key = randomBytes(32).toString('hex');
  const certificates = new PreviewCertificates();
  const server = createServer(async (req, res) => {
    const port = server.address().port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(req.headers.host)) {
      res.writeHead(403); res.end('Open the preview on localhost.'); return;
    }
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__nvr') {
      try { await bridgeNvr(req, res, url, key, certificates); }
      catch (_) { bridgeFailure(res, 502, 'PREVIEW_CONNECTION', 'The local preview could not open the NVR connection. Check the address and restart npm run dev.'); }
      return;
    }
    if (['/__nvr/certificate/inspect', '/__nvr/certificate/trust'].includes(url.pathname)) {
      try { await certificateRequest(req, res, url, key, certificates); }
      catch (_) { bridgeFailure(res, 502, 'PREVIEW_CERTIFICATE', 'Certificate review failed. Check the address and try again.'); }
      return;
    }
    if (url.pathname === '/$WEBAPIS/webapis/webapis.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('// Samsung APIs are supplied on TV.'); return; }
    let file;
    try { file = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)); }
    catch (_) { res.writeHead(400); res.end(); return; }
    if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    try {
      let bytes = await readFile(file);
      if (file === resolve(root, 'index.html')) {
        bytes = Buffer.from(bytes.toString().replace('<head>', `<head>\n  <meta name="reolink-preview-key" content="${key}">\n  <meta name="reolink-preview-streams" content="websocket">`));
      }
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(bytes);
    } catch (_) { res.writeHead(404); res.end('Not found'); }
  });
  attachPreviewStreams(server, key, certificates);
  server.listen(port, host, () => console.log(`Reolink TV: http://${host === '::1' ? '[::1]' : host}:${server.address().port}/ — connect to your local NVR`));
  return server;
}
if (typeof process !== 'undefined' && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) previewServer(Number(process.env.PORT) || 4173);
