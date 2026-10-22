import { connect } from 'node:tls';
import { isIP } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { localLookup, localOrigin, previewAuthorized, bridgeFailure, connectionFailure } from './preview-bridge.mjs';

export class PreviewCertificates {
  constructor() { this.pending = new Map(); this.approved = new Map(); }
  has(origin) { return this.approved.has(origin); }

  async inspect(input) {
    const address = localOrigin(input);
    if (address.protocol !== 'https:') throw new Error('Certificate inspection requires HTTPS.');
    const host = address.hostname.replace(/^\[|\]$/g, '');
    const certificate = await new Promise((resolve, reject) => {
      // Inspection performs only a TLS handshake. It never sends HTTP data,
      // credentials or tokens, and cannot itself approve a certificate.
      const socket = connect({ host, port: Number(address.port) || 443,
        servername: isIP(host) ? undefined : host, lookup: localLookup,
        rejectUnauthorized: false }, () => {
        try {
          const raw = socket.getPeerCertificate().raw;
          if (!raw) throw new Error('No peer certificate.');
          resolve(new X509Certificate(raw));
        } catch (error) { reject(error); }
        finally { socket.destroy(); }
      });
      const timer = setTimeout(() => socket.destroy(Object.assign(new Error('Inspection timed out.'), { code: 'ETIMEDOUT' })), 6000);
      socket.once('close', () => clearTimeout(timer));
      socket.once('error', reject);
    });
    const now = Date.now();
    const valid = now >= Date.parse(certificate.validFrom) && now <= Date.parse(certificate.validTo);
    const entry = { pem: certificate.toString(), fingerprint: certificate.fingerprint256,
      validFrom: certificate.validFrom, validTo: certificate.validTo, expires: now + 5 * 60 * 1000, valid };
    this.pending.delete(address.origin);
    if (this.pending.size >= 32) this.pending.delete(this.pending.keys().next().value);
    this.pending.set(address.origin, entry);
    return { address: address.origin, fingerprint: entry.fingerprint, validFrom: entry.validFrom,
      validTo: entry.validTo, valid, changed: this.has(address.origin) && this.approved.get(address.origin).fingerprint !== entry.fingerprint };
  }

  approve(input, fingerprint) {
    const address = localOrigin(input);
    const entry = this.pending.get(address.origin);
    if (!entry || !entry.valid || entry.expires < Date.now() || entry.fingerprint !== fingerprint) {
      throw new Error('Certificate review expired or did not match. Check the address again.');
    }
    if (!this.approved.has(address.origin) && this.approved.size >= 32) throw new Error('Restart the preview to clear old approvals.');
    this.approved.set(address.origin, entry);
    this.pending.delete(address.origin);
    return { address: address.origin, fingerprint: entry.fingerprint, approved: true };
  }

  options(origin) {
    const entry = this.approved.get(origin);
    if (!entry) return {};
    return { ca: entry.pem, rejectUnauthorized: true,
      checkServerIdentity: (_hostname, certificate) => certificate.fingerprint256 === entry.fingerprint ? undefined :
        Object.assign(new Error('The recorder certificate changed.'), { code: 'NVR_PIN_CHANGED' }) };
  }
}

export async function certificateRequest(req, res, url, key, certificates) {
  if (!previewAuthorized(req, key)) {
    bridgeFailure(res, 403, 'PREVIEW_SESSION', 'The local preview session is unavailable. Reload this page and connect again.'); return;
  }
  if (req.method !== 'POST') { bridgeFailure(res, 405, 'PREVIEW_METHOD', 'Use POST for certificate review.'); return; }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) { bridgeFailure(res, 413, 'PREVIEW_REQUEST', 'Request is too large.'); return; }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
    const address = localOrigin(body.address);
    if (address.protocol !== 'https:') throw new Error();
  } catch (_) { bridgeFailure(res, 400, 'NVR_ADDRESS', 'Enter the recorder’s local HTTPS address.'); return; }
  let result;
  try {
    if (url.pathname.endsWith('/inspect')) result = await certificates.inspect(body.address);
    else result = certificates.approve(body.address, body.fingerprint);
  } catch (error) {
    if (url.pathname.endsWith('/trust')) {
      bridgeFailure(res, 409, 'PREVIEW_CERTIFICATE_REVIEW', 'The certificate review expired or no longer matches. Check the address again.'); return;
    }
    const failure = connectionFailure(error);
    bridgeFailure(res, 502, failure.code, failure.message); return;
  }
  if (!res.destroyed) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(result));
  }
}
