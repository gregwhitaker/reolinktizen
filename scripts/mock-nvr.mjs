// Development-only Reolink simulator. Never included in the TV widget.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function mockNvr(port = 4174, { channelCount = 8, loopVideo = false } = {}) {
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 64) throw new Error('Simulator channel count must be between 1 and 64.');
  const flv = await readFile(resolve(root, '.cache/test.flv'));
  const jpeg = await readFile(resolve(root, '.cache/snapshot.jpg'));
  const metrics = { logins: 0, activeStreams: 0, openedStreams: 0, streamsByChannel: {}, snapshots: 0, rejectLogin: false, rejectTokenStreams: false };
  const packets = [];
  if (loopVideo) {
    for (let offset = 13; offset + 15 <= flv.length;) {
      const end = offset + 11 + flv.readUIntBE(offset + 1, 3) + 4;
      if (end > flv.length) throw new Error('Incomplete simulator FLV packet.');
      packets.push({ bytes: flv.subarray(offset, end), timestamp: flv.readUIntBE(offset + 4, 3) + flv[offset + 7] * 0x1000000 });
      offset = end;
    }
    if (!packets.length) throw new Error('Simulator FLV contains no packets.');
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4173');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/flv') {
      if (metrics.rejectTokenStreams && url.searchParams.has('token')) { res.writeHead(401); res.end(); return; }
      metrics.activeStreams++; metrics.openedStreams++;
      const channel = url.searchParams.get('stream') || 'unknown';
      metrics.streamsByChannel[channel] = (metrics.streamsByChannel[channel] || 0) + 1;
      res.writeHead(200, { 'Content-Type': 'video/x-flv' });
      let position = 0, loop = 0;
      const began = Date.now(), duration = loopVideo ? Math.max(...packets.map(packet => packet.timestamp)) + 100 : 0;
      if (loopVideo) res.write(flv.subarray(0, 13));
      const send = () => {
        if (loopVideo) {
          for (let count = 0; count < 64; count++) {
            const packet = packets[position], timestamp = packet.timestamp + loop * duration;
            if (timestamp > Date.now() - began) break;
            const bytes = Buffer.from(packet.bytes);
            bytes.writeUIntBE(timestamp % 0x1000000, 4, 3);
            bytes[7] = Math.floor(timestamp / 0x1000000) % 256;
            res.write(bytes);
            if (++position === packets.length) { position = 0; loop++; }
          }
          return;
        }
        const end = Math.min(position + Math.ceil(flv.length / 100), flv.length);
        if (position < flv.length) res.write(flv.subarray(position, end));
        position = end;
      };
      send();
      const timer = setInterval(send, loopVideo ? 20 : 100);
      res.on('close', () => { clearInterval(timer); metrics.activeStreams--; if (--metrics.streamsByChannel[channel] === 0) delete metrics.streamsByChannel[channel]; });
      return;
    }
    const cmd = url.searchParams.get('cmd');
    if (cmd === 'Snap') {
      metrics.snapshots++;
      res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(jpeg); return;
    }
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ cmd, code: 1, error: { rspCode: -6, detail: 'Please log in first.' } }]));
      return;
    }
    let body = '';
    for await (const bytes of req) body += bytes.toString();
    let data;
    try { data = JSON.parse(body)[0]; } catch (_) { res.writeHead(400); res.end(); return; }
    let value = {};
    if (cmd === 'Login') {
      metrics.logins++;
      if (metrics.rejectLogin || data.param.User.password !== 'demo') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify([{ cmd, code: 1, error: { rspCode: -6, detail: 'login failed' } }])); return;
      }
      value = { Token: { name: 'test-session-token', leaseTime: 3600 } };
    } else if (cmd === 'GetChannelstatus') value = { status: Array.from({ length: channelCount }, (_, channel) => ({ channel, name: ['Test entrance', 'Test driveway', 'Test garden', 'Test gate', 'Test garage', 'Test patio', 'Offline test', 'Last test'][channel] || `Test camera ${channel + 1}`, online: channel === 6 ? 0 : 1 })) };
    else if (cmd === 'GetDevInfo') value = { DevInfo: { model: 'SIMULATED NVR', name: 'STREAM TEST' } };
    else if (cmd === 'GetNetPort') value = { NetPort: { rtmpPort: 1935 } };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ cmd, code: 0, value }]));
  });
  server.listen(port, '127.0.0.1');
  return { server, metrics };
}
if (typeof process !== 'undefined' && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mockNvr(4174, { channelCount: Number(process.env.MOCK_CHANNEL_COUNT) || 8, loopVideo: process.env.MOCK_LOOP_VIDEO === '1' });
  console.log('Mock NVR on http://127.0.0.1:4174 — username: viewer, password: demo');
}
