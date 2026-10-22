export class NvrError extends Error {
  constructor(message, kind = 'network', code = null) {
    super(message);
    this.name = 'NvrError';
    this.kind = kind;
    this.code = code;
  }
}

export function normalizeAddress(input) {
  const text = String(input || '').trim();
  if (!text) throw new NvrError('Enter your NVR’s local IP address.', 'settings');
  let url;
  try { url = new URL(text.includes('://') ? text : `http://${text}`); }
  catch (_) { throw new NvrError('Enter an IP address or hostname, with an optional port.', 'settings'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') {
    throw new NvrError('Use an HTTP or HTTPS address without a path, username, or password.', 'settings');
  }
  return url.origin;
}

export function normalizeChannels(value) {
  const raw = value?.status || value?.Status || value?.Channelstatus?.status;
  if (!Array.isArray(raw)) throw new NvrError('This NVR did not return a camera list. Try manual channel count in Connection options.', 'channels');
  const seen = new Set();
  return raw.filter(item => {
    const id = Number(item.channel);
    if (!Number.isInteger(id) || id < 0 || id > 63 || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map(item => ({
    id: Number(item.channel),
    name: String(item.name || `Camera ${Number(item.channel) + 1}`),
    online: item.online === undefined ? null : Number(item.online) === 1,
    sleeping: Number(item.sleep) === 1
  })).sort((a, b) => a.id - b.id);
}

function responseError(item, login = false) {
  const code = Number(item?.error?.rspCode ?? item?.value?.rspCode ?? item?.code);
  // Reolink uses -6/-7/-27 for authentication/session failures on different firmware.
  const auth = login || [-6, -7, -27].includes(code);
  return new NvrError(auth ? 'NVR sign-in failed. Check the username, password, and camera viewing permissions.' :
    `The NVR could not complete this request (code ${Number.isFinite(code) ? code : 'unknown'}).`, auth ? 'auth' : 'api', code);
}

export class ReolinkClient {
  constructor(settings, fetchImpl = globalThis.fetch.bind(globalThis), now = Date.now) {
    this.settings = { ...settings, address: normalizeAddress(settings.address) };
    this.fetch = fetchImpl;
    this.now = now;
    this.token = '';
    this.expires = 0;
    this.apiPath = '/api.cgi';
    this.loginPromise = null;
    this.loginFailure = null;
    this.controllers = new Set();
    this.closed = false;
    this.rtmpPort = Number(settings.rtmpPort) || 1935;
  }

  async request(url, options = {}, timeout = 10000, asBlob = false) {
    if (this.closed) throw new NvrError('Connection closed.', 'cancelled');
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await this.fetch(url, { ...options, signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new NvrError(
        response.status === 401 || response.status === 403 ? 'The NVR rejected this session.' : `The NVR returned HTTP ${response.status}.`,
        [401, 403].includes(response.status) ? 'auth' : 'http', response.status);
      if (asBlob) {
        const blob = await response.blob();
        if (blob.type.startsWith('image/')) return blob;
        // Some NVRs send JPEG bytes as application/octet-stream.
        const signature = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
        if (signature[0] === 0xff && signature[1] === 0xd8) return new Blob([blob], { type: 'image/jpeg' });
        try {
          const data = JSON.parse(await blob.text());
          if (Array.isArray(data) && data[0]?.code !== 0) throw responseError(data[0]);
        } catch (error) { if (error instanceof NvrError) throw error; }
        throw new NvrError('Snapshot unavailable on this channel.', 'snapshot');
      }
      try { return await response.json(); }
      catch (_) {
        if (controller.signal.aborted) throw new NvrError(this.closed ? 'Connection closed.' : 'The NVR response timed out.', this.closed ? 'cancelled' : 'network');
        throw new NvrError('This address did not return a Reolink API response. Check the NVR’s HTTP port.', 'format');
      }
    } catch (error) {
      if (error instanceof NvrError) throw error;
      if (this.closed) throw new NvrError('Connection closed.', 'cancelled');
      throw new NvrError(controller.signal.aborted ? 'The NVR did not respond in time.' :
        'Cannot reach the NVR. Check its address, HTTP/HTTPS port, certificate, and that this device is on the same network.', 'network');
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  async commandRaw(cmd, param = {}, token = this.token) {
    const url = new URL(this.settings.address + this.apiPath);
    url.searchParams.set('cmd', cmd);
    if (token) url.searchParams.set('token', token);
    const data = await this.request(url.href, {
      method: 'POST',
      // Avoid unnecessary CORS preflight; the CGI endpoint accepts a JSON text body.
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify([{ cmd, action: 0, param }])
    });
    const item = Array.isArray(data) ? data[0] : null;
    if (!item || typeof item.code !== 'number') throw new NvrError('Unexpected response from the NVR.', 'format');
    if (item.code !== 0) throw responseError(item, cmd === 'Login');
    return item.value || {};
  }

  async login() {
    if (this.closed) throw new NvrError('Connection closed.', 'cancelled');
    if (this.loginFailure) throw this.loginFailure;
    if (this.token && this.expires > this.now()) return;
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const oldToken = this.token;
      this.token = '';
      if (oldToken) await this.commandRaw('Logout', {}, oldToken).catch(() => {});
      let value;
      const params = { User: { userName: this.settings.username, password: this.settings.password } };
      try { value = await this.commandRaw('Login', params, ''); }
      catch (error) {
        if (this.apiPath !== '/api.cgi' || !(error.kind === 'format' || error.code === 404)) throw error;
        this.apiPath = '/cgi-bin/api.cgi';
        value = await this.commandRaw('Login', params, '');
      }
      if (!value.Token?.name) throw new NvrError('The NVR did not issue a session token.', 'auth');
      this.token = value.Token.name;
      const lease = Number(value.Token.leaseTime) || 3600;
      this.expires = this.now() + Math.max(1, lease - Math.min(60, lease / 5)) * 1000;
    })();
    try { await this.loginPromise; }
    catch (error) {
      // Avoid account lockouts: a rejected password needs a new explicit connection.
      if (error.kind === 'auth') this.loginFailure = error;
      throw error;
    } finally { this.loginPromise = null; }
  }

  async command(cmd, param = {}) {
    await this.login();
    const usedToken = this.token;
    try { return await this.commandRaw(cmd, param, usedToken); }
    catch (error) {
      if (error.kind !== 'auth') throw error;
      if (this.token === usedToken) { this.token = ''; this.expires = 0; }
      await this.login();
      return this.commandRaw(cmd, param);
    }
  }

  async channels() {
    if (Number(this.settings.channelCount) > 0) {
      return Array.from({ length: Math.min(64, Number(this.settings.channelCount)) }, (_, id) => ({ id, name: `Camera ${id + 1}`, online: null, sleeping: false }));
    }
    return normalizeChannels(await this.command('GetChannelstatus'));
  }

  async connect() {
    await this.login();
    const channels = await this.channels();
    const info = await this.command('GetDevInfo').catch(() => ({}));
    const ports = await this.command('GetNetPort').catch(() => ({}));
    if (ports.NetPort?.rtmpPort && !this.settings.rtmpPort) this.rtmpPort = ports.NetPort.rtmpPort;
    return { channels, model: String(info.DevInfo?.model || 'Reolink NVR'), name: String(info.DevInfo?.name || 'Home NVR') };
  }

  async snapshot(channel) {
    await this.login();
    for (let attempt = 0; attempt < 2; attempt++) {
      const usedToken = this.token;
      const url = new URL(this.settings.address + this.apiPath);
      for (const [key, value] of Object.entries({ cmd: 'Snap', channel, snapType: 'sub', width: 640, height: 360, token: usedToken, rs: this.now() })) url.searchParams.set(key, value);
      try { return await this.request(url.href, {}, 8000, true); }
      catch (error) {
        if (error.kind !== 'auth' || attempt) throw error;
        if (this.token === usedToken) { this.token = ''; this.expires = 0; }
        await this.login();
      }
    }
  }

  async streamUrl(channel, quality = 'sub', auth = 'token') {
    if (!Number.isInteger(channel) || channel < 0 || channel > 63 || !['main', 'sub', 'ext'].includes(quality)) throw new NvrError('Invalid camera or stream.', 'settings');
    await this.login();
    const url = new URL(this.settings.address + '/flv');
    url.searchParams.set('port', this.rtmpPort);
    url.searchParams.set('app', 'bcs');
    url.searchParams.set('stream', `channel${channel}_${quality}.bcs`);
    if (auth === 'credentials') {
      url.searchParams.set('user', this.settings.username);
      url.searchParams.set('password', this.settings.password);
    } else url.searchParams.set('token', this.token);
    return url.href;
  }

  async logout() {
    if (this.token && !this.closed) await this.commandRaw('Logout').catch(() => {});
    this.close();
  }

  close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.token = '';
    this.settings.password = '';
  }
}
