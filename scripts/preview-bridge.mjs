import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

const PATHS = new Set(['/api.cgi', '/cgi-bin/api.cgi', '/flv']);

export function isLocalAddress(address) {
  const ip = address.toLowerCase();
  if (ip.startsWith('::ffff:')) return isLocalAddress(ip.slice(7));
  if (isIP(ip) === 6) return ip === '::1' || /^(fc|fd)/.test(ip) || /^fe[89ab]/.test(ip);
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

// Validate the addresses used for the actual connection, including DNS results.
export function localLookup(hostname, options, callback) {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(item => !isLocalAddress(item.address))) {
      return callback(Object.assign(new Error('Only local NVR addresses are supported.'), { code: 'NONLOCAL_ADDRESS' }));
    }
    if (options?.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

export function previewAuthorized(req, key) {
  const supplied = Buffer.from(String(req.headers['x-reolink-preview-key'] || ''));
  const expected = Buffer.from(key);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) &&
    (!req.headers.origin || req.headers.origin === `http://${req.headers.host}`) &&
    (!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']));
}

export function bridgeFailure(res, status, code, message, details = {}) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Reolink-Preview-Error': code, 'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify({ error: message, code, ...details }));
}

// Never expose raw socket errors: they can include request URLs or credentials.
export function connectionFailure(error) {
  const codes = [error?.code, ...(error?.errors || []).map(item => item.code)];
  const has = (...values) => codes.some(code => values.includes(code));
  if (has('DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_REVOKED')) {
    return { code: 'NVR_CERTIFICATE', message: 'The recorder’s HTTPS certificate was rejected. Restart npm run dev and reload the page to use automatic certificate acceptance.' };
  }
  if (has('ENOTFOUND', 'EAI_AGAIN')) {
    return { code: 'NVR_DNS', message: 'The NVR hostname could not be found. Enter its local IP address from Reolink → NVR settings → Network.' };
  }
  if (has('NONLOCAL_ADDRESS')) {
    return { code: 'NVR_NONLOCAL', message: 'This hostname does not resolve exclusively to local addresses. Enter the NVR’s local IP address.' };
  }
  if (has('ECONNREFUSED')) {
    return { code: 'NVR_REFUSED', message: 'The connection to this NVR address and port was refused. Check that HTTP or HTTPS is enabled in the NVR’s Server Settings and enter that port. The password has not been checked.' };
  }
  if (has('EHOSTUNREACH', 'ENETUNREACH', 'EACCES', 'EPERM')) {
    return { code: 'NVR_UNREACHABLE', message: 'This computer cannot reach the NVR on the local network. Check its IP address, network connection, VPN/firewall, and the terminal app’s Local Network access in macOS Settings.' };
  }
  if (has('ETIMEDOUT', 'ESOCKETTIMEDOUT')) {
    return { code: 'NVR_TIMEOUT', message: 'The NVR did not respond at this address and port. Check its local IP, enabled HTTP/HTTPS port, and that this computer is on the same network.' };
  }
  if (has('ECONNRESET', 'EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER') || codes.some(code => /^(HPE_|ERR_SSL_|ERR_TLS_)/.test(code || ''))) {
    return { code: 'NVR_PROTOCOL', message: 'The connection closed or did not return a valid HTTP response. Check that http:// or https:// matches the NVR’s enabled web port. Use the HTTP/HTTPS port, not the Basic Service, RTSP, or RTMP port.' };
  }
  return { code: 'NVR_CONNECTION', message: 'The preview could not establish a connection to the NVR. Check its local address, enabled HTTP/HTTPS port, and network access.' };
}

export function redirectFailure(target, location) {
  const fallback = { code: 'NVR_REDIRECT', message: 'The NVR redirected the request without a usable API address. Check its HTTP/HTTPS port in Server Settings.' };
  if (typeof location !== 'string' || !location || location.length > 8192) return fallback;
  let destination;
  try { destination = new URL(location, target); }
  catch (_) { return fallback; }
  if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) return fallback;
  if (destination.hostname !== target.hostname) {
    return { code: 'NVR_REDIRECT', message: 'This address redirects to a different hostname. Check that you entered the recorder’s own local IP address and HTTP/HTTPS port.' };
  }
  if (target.protocol === 'https:' && destination.protocol === 'http:') {
    return { code: 'NVR_REDIRECT', message: 'The NVR redirected HTTPS to an unencrypted HTTP connection. Check the recorder’s HTTPS settings and port.' };
  }
  // Some Reolink firmware redirects every HTTP URL to the HTTPS home page,
  // dropping /api.cgi. Suggest its HTTPS origin; do not forward login data.
  if (target.protocol === 'http:' && destination.protocol === 'https:' &&
      (destination.pathname === '/' || PATHS.has(destination.pathname))) {
    return { code: 'NVR_HTTPS_REDIRECT', address: destination.origin,
      message: `The recorder requires HTTPS. Use ${destination.origin}.` };
  }
  if (!PATHS.has(destination.pathname)) {
    return { code: 'NVR_REDIRECT', message: 'This address redirects API requests to a web page instead of the Reolink API. Check that it is the recorder’s HTTP/HTTPS address, not a router or camera-viewing portal.' };
  }
  if (destination.origin !== target.origin) {
    // Display only the same recorder's origin. Location may contain a token or password.
    return { code: 'NVR_REDIRECT', message: `The recorder redirected this request to ${destination.origin}. Enter ${destination.origin} in NVR address and connect again. Your login was not forwarded.` };
  }
  if (target.pathname === '/api.cgi' && destination.pathname === '/cgi-bin/api.cgi') {
    return { code: 'NVR_LEGACY_API', message: 'The recorder uses the older Reolink API path.' };
  }
  return { code: 'NVR_REDIRECT', message: 'The recorder redirected back to the same API address. Check its HTTP/HTTPS settings and port; the preview stopped to avoid a redirect loop.' };
}

export async function bridgeNvr(req, res, requestUrl, key, { http = httpRequest, https = httpsRequest } = {}) {
  if (!previewAuthorized(req, key)) {
    bridgeFailure(res, 403, 'PREVIEW_SESSION', 'The local preview session is unavailable. Reload this page and connect again.'); return;
  }
  if (!['GET', 'POST'].includes(req.method)) { bridgeFailure(res, 405, 'PREVIEW_METHOD', 'Unsupported method.'); return; }
  let target;
  try { target = new URL(requestUrl.searchParams.get('target')); }
  catch (_) { bridgeFailure(res, 400, 'NVR_ADDRESS', 'Enter a valid local NVR address.'); return; }
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash ||
      !PATHS.has(target.pathname) || (target.pathname === '/flv' && req.method !== 'GET') ||
      (isIP(host) && !isLocalAddress(host))) {
    bridgeFailure(res, 400, 'NVR_ADDRESS', 'Only local Reolink API and video endpoints are supported.'); return;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) { bridgeFailure(res, 413, 'PREVIEW_REQUEST', 'Request is too large.'); return; }
      chunks.push(chunk);
    }
  } catch (_) { return; }
  if (res.destroyed) return;
  const headers = {};
  for (const name of ['content-type', 'accept', 'range']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  const body = Buffer.concat(chunks);
  if (req.method === 'POST') headers['content-length'] = body.length;
  const upstream = (target.protocol === 'https:' ? https : http)(target, {
    method: req.method, headers, lookup: localLookup, agent: false,
    // Always accept the local NVR's certificate, as requested. This is scoped
    // to validated LAN destinations and this request, never process-wide TLS.
    ...(target.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
  }, response => {
    clearTimeout(connectionTimer);
    const status = response.statusCode || 502;
    // Never follow an NVR redirect with a token or password attached.
    if (status >= 300 && status < 400) {
      const failure = redirectFailure(target, response.headers.location);
      response.destroy();
      bridgeFailure(res, 502, failure.code, failure.message, failure.address ? { address: failure.address } : {});
      return;
    }
    const outgoing = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (response.headers[name]) outgoing[name] = response.headers[name];
    }
    res.writeHead(status, outgoing);
    res.flushHeaders();
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  const timedOut = () => upstream.destroy(Object.assign(new Error('NVR timed out.'), { code: 'ETIMEDOUT' }));
  // Return a useful diagnosis before the API client's own 8–10 second timeout.
  // Once headers arrive, live video can run indefinitely while bytes keep flowing.
  const connectionTimer = setTimeout(timedOut, 6500);
  res.on('close', () => { clearTimeout(connectionTimer); upstream.destroy(); });
  upstream.setTimeout(20000, timedOut);
  upstream.on('error', error => {
    clearTimeout(connectionTimer);
    const failure = connectionFailure(error);
    bridgeFailure(res, 502, failure.code, failure.message);
  });
  upstream.end(body);
}
