import { ReolinkClient, normalizeAddress } from './api.js';
import { readSettings, saveSettings, forgetSettings, DEFAULTS } from './storage.js';
import { moveFocus, registerRemote } from './navigation.js';
import { CameraPlayer } from './player.js';
import { SnapshotPoller } from './snapshots.js';
import { DemoClient, demoScene } from './demo.js';
import { OVERVIEW_LAYOUTS, normalizeOverviewLayout, resolveOverviewLayout, overviewPage } from './overview.js';
import { createNvrFetch } from './transport.js';
import { createPreviewConnection } from './preview-connection.js';
import { GridFullscreen } from './fullscreen.js';
import { LiveGrid } from './live-grid.js';

const $ = id => document.getElementById(id);
const previewKey = document.querySelector('meta[name="reolink-preview-key"]')?.content || '';
const previewStreamMode = document.querySelector('meta[name="reolink-preview-streams"]')?.content || '';
const nvrFetch = createNvrFetch({ key: previewKey, origin: location.origin, streamMode: previewStreamMode });
const previewConnection = previewKey ? createPreviewConnection({ key: previewKey, origin: location.origin }) : null;
let previewController = null, pendingCertificate = null;
const QUALITY = { sub: 'Fluent', ext: 'Balanced', main: 'Clear' };
let settings = readSettings();
let client = null, candidate = null, poller = null;
let channels = [], recorder = null;
let screen = 'settings', filter = 'all', page = 0, selected = null;
let cycleEnabled = false, cycleTimer = null, statusTimer = null, hideTimer = null, toastTimer = null;
let playerState = 'idle', paused = false, connectGeneration = 0, connecting = false;
let restoreFocus = null, dialogAction = null;
let settingsBeforeDemo = null;
let gridHideTimer = null, gridFocusId = null;
const liveGrid = new LiveGrid(updateGridStream);

const gridFullscreen = new GridFullscreen(document, active => {
  $('dashboard').classList.toggle('grid-fullscreen', active);
  $('dashboard').classList.remove('grid-controls-hidden');
  $('grid-fullscreen-controls').hidden = !active;
  $('fullscreen-grid').setAttribute('aria-pressed', String(active));
  $('header').hidden = screen === 'viewer' || (screen === 'grid' && active);
  $('back-grid').textContent = active ? '← Camera grid' : '← All cameras';
  clearTimeout(gridHideTimer);
  startGridMedia();
  if (screen === 'grid') {
    if (active) { focusGridCamera(); revealGridControls(); }
    else if ($('layout-overlay').hidden && $('dialog-overlay').hidden) $('fullscreen-grid').focus();
  }
  scaleStage();
});

const player = new CameraPlayer($('live-video'), state => {
  if (screen !== 'viewer') return;
  if (state.state === 'notice') { toast(state.message); return; }
  playerState = state.state;
  $('live-badge').textContent = state.state === 'live' ? 'LIVE' : state.state.toUpperCase();
  $('live-badge').classList.toggle('pending', state.state !== 'live');
  $('player-message').hidden = state.state === 'live';
  $('player-message').classList.toggle('error', state.state === 'error');
  $('retry-video').hidden = state.state !== 'error';
  $('player-message-title').textContent = { connecting: 'Opening camera…', buffering: 'Buffering…', reconnecting: 'Reconnecting…', error: 'Camera unavailable' }[state.state] || '';
  $('player-message-detail').textContent = state.message || (state.state === 'reconnecting' ? `Trying again${state.attempt ? ` · attempt ${state.attempt} of 4` : ''}` : 'Connecting directly to your NVR');
  if (state.quality) updateQuality(state.quality);
  if (state.state === 'error') { revealControls(false); $('retry-video').focus(); }
  if (state.state === 'live') {
    $('audio-button').textContent = player.audio ? 'Sound on' : 'Sound off';
    $('audio-button').setAttribute('aria-pressed', String(player.audio));
    scheduleHide();
  }
});

function scaleStage() {
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  $('stage').style.transform = `scale(${scale})`;
  $('stage').style.left = `${(window.innerWidth - 1920 * scale) / 2}px`;
  $('stage').style.top = `${(window.innerHeight - 1080 * scale) / 2}px`;
}

function clock() {
  const value = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('clock').textContent = value;
  $('viewer-clock').textContent = value;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

function persist() {
  if (client?.demo) return;
  try { saveSettings(settings); }
  catch (_) { toast('Your settings could not be saved. This connection works until you close the app.'); }
}

function setConnection(text, style = '') {
  $('connection').className = `connection ${style}`;
  $('connection').replaceChildren(document.createElement('i'), document.createTextNode(text));
}

function setScreen(next) {
  if (next !== 'grid') { liveGrid.stop(); poller?.stop(); }
  screen = next;
  $('dashboard').hidden = next !== 'grid';
  $('settings').hidden = next !== 'settings';
  $('viewer').hidden = next !== 'viewer';
  $('header').hidden = next === 'viewer' || (next === 'grid' && gridFullscreen.active);
  clearTimeout(gridHideTimer);
  if (next === 'grid') revealGridControls();
}

function focusGridCamera() {
  const previous = gridFocusId && $(gridFocusId);
  (previous || $('camera-grid').querySelector('button') || $('empty-action')).focus();
}

function revealGridControls() {
  clearTimeout(gridHideTimer);
  if (!gridFullscreen.active || screen !== 'grid') return;
  $('dashboard').classList.remove('grid-controls-hidden');
  if (document.hidden || !$('layout-overlay').hidden || !$('dialog-overlay').hidden) return;
  gridHideTimer = setTimeout(() => {
    if ($('grid-fullscreen-controls').contains(document.activeElement)) focusGridCamera();
    clearTimeout(gridHideTimer);
    $('dashboard').classList.add('grid-controls-hidden');
  }, 5000);
}

function toggleGridFullscreen() {
  if (gridFullscreen.active) gridFullscreen.exit();
  else if (filteredChannels().length) gridFullscreen.enter();
}

function changePage(delta) {
  const next = overviewPage(filteredChannels(), settings.overviewLayout, page + delta).page;
  if (next === page) return;
  page = next;
  renderGrid();
}

function filteredChannels() {
  return channels.filter(channel => filter !== 'favorites' || settings.favorites.includes(channel.id));
}

function watchableChannels() { return filteredChannels().filter(channel => channel.online !== false && !channel.sleeping); }

function placeTile(element, tile) {
  element.style.gridColumn = `${tile.column} / span ${tile.columnSpan}`;
  element.style.gridRow = `${tile.row} / span ${tile.rowSpan}`;
}

function makeCard(channel, tile, layout) {
  const existing = $(`camera-${channel.id}`);
  const card = existing || document.createElement('button');
  card.classList.add('camera-card');
  card.classList.toggle('offline', channel.online === false);
  placeTile(card, tile);
  card.classList.toggle('compact', (tile.rowSpan === 1 && layout.rows >= 3) || (tile.columnSpan === 1 && layout.columns >= 4));
  card.classList.toggle('dense', tile.rowSpan === 1 && layout.rows >= 4);
  card.classList.toggle('tiny', tile.rowSpan === 1 && layout.rows >= 5);
  card.id = `camera-${channel.id}`;
  card.setAttribute('aria-label', `${channel.name}, ${channel.online === false ? 'offline' : 'open live video'}`);
  card.dataset.channel = channel.id;
  if (!existing) {
    card.innerHTML = '<div class="camera-placeholder"><svg viewBox="0 0 80 80" fill="none" aria-hidden="true"><rect x="8" y="20" width="46" height="40" rx="8" stroke="currentColor" stroke-width="2"/><path d="m54 32 19-10v36L54 48" stroke="currentColor" stroke-width="2"/><circle cx="30" cy="40" r="10" stroke="currentColor" stroke-width="2"/></svg></div><img class="camera-preview" alt="" hidden><video class="camera-live" playsinline autoplay muted tabindex="-1" aria-hidden="true" hidden></video><div class="camera-shade"></div><div class="card-top"><span class="channel-tag"></span><span class="card-star"></span></div><div class="card-bottom"><div><span class="camera-name"></span><span class="preview-status"></span></div><span class="camera-arrow" aria-hidden="true">↗</span></div>';
    card.addEventListener('click', () => openCamera(channel.id));
  }
  card.querySelector('.channel-tag').textContent = `CAM ${String(channel.id + 1).padStart(2, '0')}`;
  card.querySelector('.camera-name').textContent = channel.name;
  card.querySelector('.card-star').textContent = settings.favorites.includes(channel.id) ? '★' : '';
  if (!existing || !gridFullscreen.active || channel.online === false || channel.sleeping) {
    card.querySelector('.preview-status').textContent = channel.online === false ? 'Offline' : channel.sleeping ? 'Sleeping' : 'Loading preview…';
  }
  return card;
}

function updateGridStream(id, state) {
  if (screen !== 'grid' || !gridFullscreen.active) return;
  const card = $(`camera-${id}`);
  if (!card) return;
  card.dataset.streamState = state.state;
  card.querySelector('.camera-live').hidden = !['live', 'buffering'].includes(state.state);
  card.querySelector('.preview-status').textContent = {
    live: 'LIVE · Fluent', connecting: 'Connecting live…', buffering: 'Buffering…',
    reconnecting: `Reconnecting${state.attempt ? ` · ${state.attempt}/4` : ''}…`,
    error: 'Unavailable · OK to try this camera alone'
  }[state.state] || '';
  updateGridSummary();
}

function updateGridSummary() {
  const { total, live, failed } = liveGrid.summary;
  $('grid-fullscreen-label').textContent = client?.demo ? 'Demo · Illustrations' :
    total ? `${filter === 'favorites' ? 'Favorites · ' : ''}Live · ${live}/${total}${failed ? ` · ${failed} unavailable` : ''}` : 'No online cameras';
  $('grid-retry').hidden = failed === 0;
}

function startGridMedia() {
  poller?.stop();
  if (!client || screen !== 'grid' || document.hidden) { liveGrid.stop(); return; }
  const visible = overviewPage(filteredChannels(), settings.overviewLayout, page).cameras;
  const live = gridFullscreen.active && !client.demo;
  for (const channel of visible) {
    const card = $(`camera-${channel.id}`);
    if (!card) continue;
    card.querySelector('img').hidden = true;
    if (!live || channel.online === false || channel.sleeping) {
      delete card.dataset.streamState;
      card.querySelector('.camera-live').hidden = true;
      card.querySelector('.preview-status').textContent = channel.online === false ? 'Offline' : channel.sleeping ? 'Sleeping' : 'Loading preview…';
    }
  }
  if (live) {
    liveGrid.sync(client, visible.map(channel => ({ ...channel, video: $(`camera-${channel.id}`).querySelector('.camera-live') })), settings.streamAuth);
  } else {
    liveGrid.stop();
    startSnapshots();
  }
  updateGridSummary();
}

function startSnapshots() {
  poller?.stop();
  if (!client || screen !== 'grid' || document.hidden || (gridFullscreen.active && !client.demo)) return;
  const visible = overviewPage(filteredChannels(), settings.overviewLayout, page).cameras;
  poller = new SnapshotPoller(client, settings.refresh * 1000, (id, url, error) => {
    const card = $(`camera-${id}`);
    if (!card) return;
    if (url) {
      const img = card.querySelector('img');
      img.src = url;
      img.hidden = false;
      card.querySelector('.preview-status').textContent = client.demo ? 'Demo illustration' : `Snapshot · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    } else {
      // Keep the last frame, but always label it stale when refresh fails.
      const img = card.querySelector('img');
      card.querySelector('.preview-status').textContent = img.hidden ? 'Preview unavailable · OK to try live' : 'Last snapshot · refresh failed';
    }
  });
  poller.start(visible);
}

function renderGrid(focusId) {
  poller?.stop();
  const list = filteredChannels();
  const overview = overviewPage(list, settings.overviewLayout, page);
  const { layout, pages } = overview;
  page = overview.page;
  $('camera-count').textContent = channels.length;
  $('nvr-name').textContent = recorder?.name || 'HOME NVR';
  $('overview-status').textContent = client?.demo ? 'DEMO · No cameras connected' : `${recorder?.model || 'Reolink NVR'} · Refresh every ${settings.refresh}s`;
  $('filter-all').classList.toggle('active', filter === 'all');
  $('filter-favorites').classList.toggle('active', filter === 'favorites');
  $('filter-all').setAttribute('aria-pressed', String(filter === 'all'));
  $('filter-favorites').setAttribute('aria-pressed', String(filter === 'favorites'));
  $('layout-label').textContent = settings.overviewLayout === 'auto' ? `Auto · ${layout.count}` : layout.value === '2-vertical' ? '2 stacked' : `${layout.count} ${layout.count === 1 ? 'camera' : 'cameras'}`;
  $('layout-button').setAttribute('aria-label', `Camera layout, ${settings.overviewLayout === 'auto' ? 'Auto, ' : ''}${layout.count} per page, ${layout.detail}`);
  $('camera-grid').style.setProperty('--grid-columns', layout.columns);
  $('camera-grid').style.setProperty('--grid-rows', layout.rows);
  $('camera-grid').classList.toggle('compact-grid', layout.rows >= 3 || layout.columns >= 4);
  $('camera-grid').classList.toggle('dense-grid', layout.rows >= 4);
  $('camera-grid').classList.toggle('tiny-grid', layout.rows >= 5);
  const cards = overview.cameras.map((channel, index) => makeCard(channel, layout.tiles[index], layout));
  for (const card of [...$('camera-grid').children]) if (!cards.includes(card)) card.remove();
  cards.forEach((card, index) => {
    if ($('camera-grid').children[index] !== card) $('camera-grid').insertBefore(card, $('camera-grid').children[index] || null);
  });
  $('camera-grid').hidden = list.length === 0;
  $('empty-state').hidden = list.length > 0;
  $('empty-title').textContent = filter === 'favorites' ? 'No favorites yet' : 'No cameras found';
  $('empty-description').textContent = filter === 'favorites' ? 'Open a camera and select Favorite to keep it here.' : 'Check that cameras are connected to your NVR and this account has permission to view them. You can also set a manual channel count in Connection options.';
  $('empty-action').textContent = filter === 'favorites' ? 'Show all cameras' : 'Connection settings';
  $('page-label').textContent = `${page + 1} / ${pages}`;
  $('page-prev').disabled = page === 0;
  $('page-next').disabled = page === pages - 1;
  $('fullscreen-grid').disabled = list.length === 0;
  $('fullscreen-layout-label').textContent = $('layout-label').textContent;
  $('fullscreen-page').textContent = $('page-label').textContent;
  $('fullscreen-prev').disabled = $('page-prev').disabled;
  $('fullscreen-next').disabled = $('page-next').disabled;
  $('cycle-grid').disabled = watchableChannels().length === 0;
  startGridMedia();
  requestAnimationFrame(() => {
    if (screen !== 'grid' || !$('layout-overlay').hidden || !$('dialog-overlay').hidden) return;
    const target = focusId ? $(focusId) : null;
    (target && !target.disabled && target.getClientRects().length ? target : $('camera-grid').querySelector('button') || $('empty-action')).focus();
  });
}

function openLayout() {
  clearTimeout(gridHideTimer);
  $('layout-auto').setAttribute('aria-pressed', String(settings.overviewLayout === 'auto'));
  $('layout-options').replaceChildren(...OVERVIEW_LAYOUTS.filter(layout => layout.value !== 'auto').map(layout => {
    const button = document.createElement('button');
    button.id = `layout-${layout.value}`;
    button.className = 'layout-option';
    button.setAttribute('aria-pressed', String(settings.overviewLayout === layout.value));
    button.setAttribute('aria-label', `${layout.count} ${layout.count === 1 ? 'camera' : 'cameras'}, ${layout.detail}`);
    const diagram = document.createElement('span');
    diagram.className = `layout-diagram${layout.count === 2 ? ` two-camera-diagram ${layout.value === '2-vertical' ? 'stacked' : 'side-by-side'}` : ''}`;
    diagram.setAttribute('aria-hidden', 'true');
    diagram.style.setProperty('--columns', layout.columns);
    diagram.style.setProperty('--rows', layout.rows);
    for (const tile of layout.tiles) {
      const cell = document.createElement('i');
      placeTile(cell, tile);
      diagram.append(cell);
    }
    const label = document.createElement('strong');
    label.textContent = `${layout.count} ${layout.count === 1 ? 'camera' : 'cameras'}`;
    const detail = document.createElement('span');
    detail.className = 'layout-detail';
    detail.textContent = layout.detail;
    button.append(diagram, label, detail);
    button.onclick = () => applyLayout(layout.value);
    return button;
  }));
  $('layout-overlay').hidden = false;
  $('layout-button').setAttribute('aria-expanded', 'true');
  $('fullscreen-layout').setAttribute('aria-expanded', 'true');
  $(`layout-${settings.overviewLayout}`).focus();
}

function closeLayout() {
  $('layout-overlay').hidden = true;
  $('layout-button').setAttribute('aria-expanded', 'false');
  $('fullscreen-layout').setAttribute('aria-expanded', 'false');
  (gridFullscreen.active ? $('fullscreen-layout') : $('layout-button')).focus();
  revealGridControls();
}

function applyLayout(value) {
  const list = filteredChannels();
  const { start } = overviewPage(list, settings.overviewLayout, page);
  settings.overviewLayout = normalizeOverviewLayout(value);
  // Keep the first camera on the old page visible after the layout changes.
  page = Math.floor(start / resolveOverviewLayout(settings.overviewLayout, list.length).count);
  // Layout is a TV preference, so persist it in demo mode without saving demo favorites.
  if (settingsBeforeDemo) settingsBeforeDemo.overviewLayout = settings.overviewLayout;
  try { saveSettings(settingsBeforeDemo || settings); }
  catch (_) { toast('This layout works now, but could not be saved for next time.'); }
  closeLayout();
  renderGrid(gridFullscreen.active ? 'fullscreen-layout' : 'layout-button');
}

function startStatusPoll() {
  clearTimeout(statusTimer);
  if (!client || client.demo || document.hidden || screen === 'settings') return;
  const current = client;
  statusTimer = setTimeout(async () => {
    try {
      const updated = await current.channels();
      if (client !== current) return;
      setConnection('Local connection', 'connected');
      const changed = JSON.stringify(updated) !== JSON.stringify(channels);
      channels = updated;
      if (changed && screen === 'grid') renderGrid(document.activeElement.id);
    } catch (_) { if (client === current) setConnection('Connection interrupted'); }
    if (client === current) startStatusPoll();
  }, 30000);
}

function goGrid() {
  stopCycle();
  player.stop();
  clearTimeout(hideTimer);
  paused = false;
  setScreen('grid');
  renderGrid(selected === null ? null : `camera-${selected}`);
  startStatusPoll();
}

function fillForm() {
  const source = settingsBeforeDemo || settings;
  for (const key of ['address', 'username', 'password', 'quality', 'refresh', 'cycle']) $(key).value = source[key];
  $('channel-count').value = source.channelCount;
  $('rtmp-port').value = source.rtmpPort;
  $('stream-auth').value = source.streamAuth;
  $('remember').checked = source.remember;
}

function openSettings() {
  setScreen('settings');
  gridFullscreen.exit();
  stopCycle();
  poller?.stop();
  player.stop();
  clearTimeout(statusTimer);
  clearTimeout(hideTimer);
  fillForm();
  $('settings-cancel').hidden = !client;
  $('form-error').hidden = true;
  $('form-status').hidden = true;
  clearCertificate();
  $('settings-title').textContent = client ? 'Connection settings' : 'Connect your NVR';
  $('address').focus();
}

function readForm() {
  const previous = settingsBeforeDemo || settings;
  const value = { ...previous, favorites: [...previous.favorites] };
  for (const key of ['address', 'username', 'password', 'quality']) value[key] = $(key).value;
  value.address = normalizeAddress(value.address);
  value.username = value.username.trim();
  if (!value.username || !value.password) throw new Error('Enter your NVR username and password.');
  value.remember = $('remember').checked;
  value.channelCount = Number($('channel-count').value);
  value.rtmpPort = Number($('rtmp-port').value);
  if (!Number.isInteger(value.channelCount) || value.channelCount < 0 || value.channelCount > 64) throw new Error('Channel count must be between 0 and 64.');
  if (!Number.isInteger(value.rtmpPort) || value.rtmpPort < 0 || value.rtmpPort > 65535) throw new Error('RTMP port must be between 0 and 65535.');
  value.refresh = Number($('refresh').value);
  value.cycle = Number($('cycle').value);
  value.streamAuth = $('stream-auth').value;
  if (value.address !== previous.address || value.username !== previous.username) {
    value.favorites = [];
    value.lastChannel = null;
  }
  return value;
}

function setConnecting(value) {
  connecting = value;
  $('connect-button').disabled = value;
  $('connect-button').textContent = value ? 'Connecting…' : 'Connect to NVR →';
  $('check-address').disabled = value;
  $('certificate-trust').disabled = value || !pendingCertificate?.valid;
}

function clearCertificate() {
  pendingCertificate = null;
  $('certificate-review').hidden = true;
}

async function preparePreview(value, generation) {
  previewController?.abort();
  const controller = new AbortController();
  previewController = controller;
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const result = await previewConnection.check(value.address, controller.signal);
    if (generation !== connectGeneration) return false;
    value.address = result.address;
    $('address').value = result.address;
    if (result.certificate) {
      pendingCertificate = result.certificate;
      $('certificate-title').textContent = result.certificate.changed ? 'Your recorder’s certificate changed' : 'Approve your recorder’s certificate';
      $('certificate-address').textContent = result.address;
      $('certificate-fingerprint').textContent = result.certificate.fingerprint;
      $('certificate-validity').textContent = result.certificate.valid ?
        `Certificate expires ${new Date(result.certificate.validTo).toLocaleDateString()}.` :
        'This certificate is expired or not yet valid. Correct the recorder’s certificate before connecting.';
      $('certificate-review').hidden = false;
      $('certificate-cancel').focus();
      $('certificate-review').scrollIntoView({ block: 'start' });
      return false;
    }
    return true;
  } finally {
    clearTimeout(timer);
    if (previewController === controller) previewController = null;
  }
}

async function connect(value) {
  const generation = ++connectGeneration;
  candidate?.close();
  let nextClient;
  clearCertificate();
  $('form-status').hidden = true;
  setConnecting(true);
  $('form-error').hidden = true;
  try {
    // Determine the correct web address and obtain certificate approval before
    // sending a password. The check itself never includes login credentials.
    if (previewConnection && !await preparePreview(value, generation)) return;
    if (generation !== connectGeneration) return;
    nextClient = new ReolinkClient(value, nvrFetch);
    candidate = nextClient;
    const result = await nextClient.connect();
    if (generation !== connectGeneration) { nextClient.close(); return; }
    poller?.stop();
    const oldClient = client;
    client = nextClient;
    candidate = null;
    if (oldClient) oldClient.logout();
    settings = value;
    settingsBeforeDemo = null;
    recorder = result;
    channels = result.channels;
    selected = settings.lastChannel;
    filter = 'all'; page = 0;
    persist();
    $('password').value = '';
    setConnection('Local connection', 'connected');
    goGrid();
  } catch (error) {
    nextClient?.logout();
    if (generation !== connectGeneration) return;
    candidate = null;
    $('form-error').textContent = error.message;
    $('form-error').hidden = false;
    $('form-error').scrollIntoView({ block: 'nearest' });
  } finally {
    if (generation === connectGeneration) setConnecting(false);
  }
}

async function openDemo() {
  connectGeneration++;
  previewController?.abort(); clearCertificate();
  candidate?.close(); candidate = null;
  setConnecting(false);
  poller?.stop(); liveGrid.stop(); player.stop();
  if (!client?.demo) {
    settingsBeforeDemo = { ...settings, favorites: [...settings.favorites] };
    settings = { ...settings, favorites: [], lastChannel: null };
  }
  if (client) client.logout();
  client = new DemoClient();
  recorder = await client.connect();
  channels = recorder.channels;
  selected = null; page = 0; filter = 'all';
  setConnection('Demo mode', 'demo');
  $('password').value = '';
  goGrid();
}

function updateQuality(quality) {
  $('quality-label').textContent = `${QUALITY[quality]} stream${player.fellBack ? ' · Compatibility fallback' : ''}`;
  $('quality-button').textContent = `Quality: ${QUALITY[quality]}`;
}

function updateFavorite() {
  const favorite = settings.favorites.includes(selected);
  $('favorite-button').textContent = favorite ? '★ Favorited' : '☆ Favorite';
  $('favorite-button').setAttribute('aria-pressed', String(favorite));
}

function openCamera(id, preserveCycle = false) {
  const channel = channels.find(item => item.id === id);
  if (!channel) return;
  if (channel.online === false) { toast('This camera is offline. Check its connection to the NVR.'); return; }
  if (channel.sleeping) { toast('This camera is sleeping. Wake it in Reolink, then try again.'); return; }
  if (!preserveCycle) stopCycle();
  selected = id;
  settings.lastChannel = id;
  persist();
  const list = filteredChannels();
  const index = list.findIndex(item => item.id === id);
  if (index >= 0) page = Math.floor(index / resolveOverviewLayout(settings.overviewLayout, list.length).count);
  poller?.stop();
  paused = false;
  setScreen('viewer');
  $('viewer-name').textContent = channel.name;
  $('viewer-channel').textContent = `CAMERA ${String(id + 1).padStart(2, '0')}`;
  $('demo-label').hidden = !client.demo;
  $('demo-scene').hidden = !client.demo;
  $('live-video').hidden = Boolean(client.demo);
  updateFavorite();
  updateQuality(settings.quality);
  if (client.demo) {
    player.stop();
    $('demo-scene').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(demoScene(id))}`;
    $('player-message').hidden = true;
    $('live-badge').textContent = 'DEMO';
    $('live-badge').classList.add('pending');
    playerState = 'live';
  } else player.play(client, id, settings.quality, settings.streamAuth);
  revealControls();
  $('back-grid').focus();
  startStatusPoll();
}

function nextCamera(delta) {
  const list = watchableChannels();
  if (!list.length) { stopCycle(); toast('No online cameras in this view.'); return; }
  const index = list.findIndex(channel => channel.id === selected);
  const next = list[(index + delta + list.length) % list.length];
  openCamera(next.id, true);
}

function stopCycle() {
  cycleEnabled = false;
  clearInterval(cycleTimer); cycleTimer = null;
  $('cycle-button').textContent = '↻ Cycle off';
  $('cycle-button').setAttribute('aria-pressed', 'false');
}

function scheduleCycle() {
  clearInterval(cycleTimer);
  if (cycleEnabled && !document.hidden) cycleTimer = setInterval(() => nextCamera(1), settings.cycle * 1000);
}

function toggleCycle() {
  if (cycleEnabled) { stopCycle(); return; }
  if (watchableChannels().length < 2) { toast('Camera cycling needs at least two online cameras.'); return; }
  cycleEnabled = true;
  $('cycle-button').textContent = `↻ Every ${settings.cycle}s`;
  $('cycle-button').setAttribute('aria-pressed', 'true');
  scheduleCycle();
}

function toggleFavorite() {
  const index = settings.favorites.indexOf(selected);
  if (index >= 0) settings.favorites.splice(index, 1); else settings.favorites.push(selected);
  updateFavorite(); persist();
}

function revealControls(autoHide = true) {
  $('viewer').classList.remove('controls-hidden');
  clearTimeout(hideTimer);
  if (autoHide) scheduleHide();
}

function scheduleHide() {
  clearTimeout(hideTimer);
  if (screen === 'viewer' && playerState === 'live' && !paused && !document.hidden) {
    hideTimer = setTimeout(() => {
      if (!$('dialog-overlay').hidden) return;
      $('viewer').classList.add('controls-hidden');
      if ($('viewer-controls').contains(document.activeElement)) document.activeElement.blur();
    }, 7000);
  }
}

function pauseLive() {
  if (screen !== 'viewer' || client.demo) return;
  paused = !paused;
  if (!paused) { openCamera(selected, true); scheduleCycle(); return; }
  player.stop(); clearInterval(cycleTimer); clearTimeout(hideTimer);
  playerState = 'paused';
  $('live-badge').textContent = 'PAUSED';
  $('live-badge').classList.add('pending');
  $('player-message').hidden = false;
  $('player-message').classList.add('error');
  $('player-message-title').textContent = 'Live view paused';
  $('player-message-detail').textContent = 'Press Play/Pause or Retry live video to return to live.';
  $('retry-video').hidden = false;
  revealControls(false);
  $('retry-video').focus();
}

function showDialog(title, description, actionLabel, action) {
  clearTimeout(hideTimer);
  clearTimeout(gridHideTimer);
  restoreFocus = document.activeElement;
  dialogAction = action;
  $('dialog-title').textContent = title;
  $('dialog-description').textContent = description;
  $('dialog-confirm').textContent = actionLabel;
  $('dialog-cancel').textContent = actionLabel === 'Exit app' ? 'Stay' : 'Cancel';
  $('dialog-overlay').hidden = false;
  $('dialog-cancel').focus();
}

function closeDialog() {
  $('dialog-overlay').hidden = true;
  dialogAction = null;
  if (restoreFocus?.getClientRects().length) restoreFocus.focus();
  scheduleHide();
  revealGridControls();
}

function back() {
  if (!$('layout-overlay').hidden) { closeLayout(); return; }
  if (!$('dialog-overlay').hidden) { closeDialog(); return; }
  if (screen === 'viewer') { goGrid(); return; }
  if (screen === 'grid' && gridFullscreen.active) { gridFullscreen.exit(); return; }
  if (screen === 'settings' && connecting) {
    connectGeneration++; previewController?.abort(); candidate?.close(); candidate = null; setConnecting(false);
    if (client) goGrid();
    return;
  }
  if (screen === 'settings' && client) { $('password').value = ''; goGrid(); return; }
  showDialog('Leave Reolink TV?', 'Your saved connection will be here next time.', 'Exit app', () => {
    poller?.stop(); liveGrid.stop(); player.stop(); clearTimeout(statusTimer); stopCycle();
    client?.logout();
    try {
      if (globalThis.tizen?.application) globalThis.tizen.application.getCurrentApplication().exit();
      else { client = null; channels = []; setConnection('Your home, in view'); openSettings(); toast('TV app would close here.'); }
    } catch (_) { toast('Press Home on your remote to leave the app.'); }
  });
}

$('connection-form').addEventListener('submit', event => {
  event.preventDefault();
  if (connecting) return;
  try { connect(readForm()); }
  catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; $('form-error').scrollIntoView({ block: 'nearest' }); }
});
$('check-address').onclick = async () => {
  if (connecting || !previewConnection) return;
  const generation = ++connectGeneration;
  clearCertificate();
  $('form-error').hidden = true; $('form-status').hidden = true;
  setConnecting(true);
  try {
    const value = { address: normalizeAddress($('address').value) };
    if (await preparePreview(value, generation)) {
      $('form-status').textContent = `Recorder API reached at ${value.address}. Enter your recorder login and connect.`;
      $('form-status').hidden = false;
      $('password').focus();
    }
  } catch (error) {
    if (generation !== connectGeneration) return;
    $('form-error').textContent = error.message; $('form-error').hidden = false;
    $('form-error').scrollIntoView({ block: 'nearest' });
  } finally { if (generation === connectGeneration) setConnecting(false); }
};
$('certificate-cancel').onclick = () => { clearCertificate(); $('address').focus(); };
$('certificate-trust').onclick = async () => {
  if (connecting || !pendingCertificate?.valid) return;
  const review = pendingCertificate;
  if (normalizeAddress($('address').value) !== review.address) { clearCertificate(); return; }
  const generation = ++connectGeneration;
  const controller = new AbortController();
  previewController = controller;
  const timer = setTimeout(() => controller.abort(), 10000);
  setConnecting(true);
  try {
    await previewConnection.trust(review.address, review.fingerprint, controller.signal);
    if (generation !== connectGeneration) return;
    clearCertificate();
    $('form-status').textContent = 'Certificate approved for this preview session. Connect to NVR to sign in.';
    $('form-status').hidden = false;
    $('password').focus();
  } catch (error) {
    if (generation !== connectGeneration) return;
    $('form-error').textContent = error.message; $('form-error').hidden = false;
    $('form-error').scrollIntoView({ block: 'nearest' });
  } finally {
    clearTimeout(timer);
    if (previewController === controller) previewController = null;
    if (generation === connectGeneration) setConnecting(false);
  }
};
$('address').addEventListener('input', () => {
  connectGeneration++; previewController?.abort(); candidate?.close(); candidate = null;
  clearCertificate(); $('form-status').hidden = true; setConnecting(false);
});
$('settings-button').onclick = openSettings;
$('layout-button').onclick = openLayout;
$('fullscreen-grid').onclick = toggleGridFullscreen;
$('exit-fullscreen-grid').onclick = () => gridFullscreen.exit();
$('fullscreen-layout').onclick = openLayout;
$('fullscreen-prev').onclick = () => changePage(-1);
$('fullscreen-next').onclick = () => changePage(1);
$('grid-retry').onclick = () => { liveGrid.retryFailed(); revealGridControls(); };
$('dashboard').addEventListener('pointermove', revealGridControls);
$('dashboard').addEventListener('focusin', event => {
  if (event.target.classList.contains('camera-card')) gridFocusId = event.target.id;
  revealGridControls();
});
$('layout-auto').onclick = () => applyLayout('auto');
$('layout-close').onclick = closeLayout;
$('settings-cancel').onclick = back;
$('demo-button').onclick = openDemo;
$('back-grid').onclick = goGrid;
$('retry-video').onclick = () => { openCamera(selected, true); scheduleCycle(); };
$('prev-camera').onclick = () => nextCamera(-1);
$('next-camera').onclick = () => nextCamera(1);
$('cycle-button').onclick = toggleCycle;
$('cycle-grid').onclick = () => { const first = watchableChannels()[0]; if (first) { openCamera(first.id); toggleCycle(); } };
$('favorite-button').onclick = toggleFavorite;
$('audio-button').onclick = () => {
  if (client.demo) { toast('Demo previews have no audio.'); return; }
  player.setAudio(!player.audio);
  $('audio-button').textContent = player.audio ? 'Sound on' : 'Sound off';
  $('audio-button').setAttribute('aria-pressed', String(player.audio));
  scheduleHide();
};
$('quality-button').onclick = () => {
  settings.quality = settings.quality === 'sub' ? 'main' : 'sub';
  persist(); openCamera(selected, true);
  $('quality-button').focus();
  if (settings.quality === 'main') toast('Clear needs an H.264 main stream. H.265/4K falls back to Fluent.');
};
for (const mode of ['all', 'favorites']) $(`filter-${mode}`).onclick = () => { filter = mode; page = 0; renderGrid(`filter-${mode}`); };
$('page-prev').onclick = () => changePage(-1);
$('page-next').onclick = () => changePage(1);
$('empty-action').onclick = () => { if (filter === 'favorites') { filter = 'all'; renderGrid(); } else openSettings(); };
$('advanced-toggle').onclick = () => {
  $('advanced').hidden = !$('advanced').hidden;
  $('advanced-toggle').setAttribute('aria-expanded', String(!$('advanced').hidden));
  $('advanced-toggle').querySelector('span').textContent = $('advanced').hidden ? '＋' : '−';
  if (!$('advanced').hidden) $('quality').focus();
};
$('show-password').onclick = () => {
  const show = $('password').type === 'password';
  $('password').type = show ? 'text' : 'password';
  $('show-password').textContent = show ? 'Hide' : 'Show';
  $('show-password').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
};
$('forget-button').onclick = () => showDialog('Forget this connection?', 'This removes the saved NVR login and favorites from this TV.', 'Forget connection', () => {
  connectGeneration++; candidate?.close(); candidate = null; setConnecting(false);
  poller?.stop(); liveGrid.stop(); player.stop(); client?.logout(); client = null;
  try { forgetSettings(); } catch (_) { toast('Unable to remove saved settings.'); return; }
  settings = { ...DEFAULTS, favorites: [] };
  settingsBeforeDemo = null;
  channels = []; selected = null;
  setConnection('Your home, in view');
  openSettings();
});
$('dialog-cancel').onclick = closeDialog;
$('dialog-confirm').onclick = () => { const action = dialogAction; closeDialog(); action?.(); };
$('viewer').addEventListener('pointermove', () => revealControls());
$('viewer').addEventListener('click', event => { if (event.target.tagName !== 'BUTTON') revealControls(); });

// On TV, select an input to edit; arrows first move focus between form fields.
const isTV = Boolean(globalThis.tizen?.application);
if (isTV) {
  for (const input of document.querySelectorAll('input:not([type="checkbox"])')) {
    input.readOnly = true;
    input.addEventListener('blur', () => { input.readOnly = true; input.dataset.editing = ''; });
    input.addEventListener('click', () => { input.blur(); input.readOnly = false; input.dataset.editing = 'true'; input.focus(); });
  }
}

document.addEventListener('keydown', event => {
  const code = event.keyCode;
  const key = event.key;
  const active = document.activeElement;
  const editingInput = active?.tagName === 'INPUT' && active.type !== 'checkbox' && (!isTV || active.dataset.editing === 'true');
  const editingSelect = active?.tagName === 'SELECT' && active.dataset.editing === 'true';
  const isBack = code === 10009 || key === 'Escape' || key === 'BrowserBack';
  if (editingInput || editingSelect) {
    if (isBack || key === 'Enter' || code === 65376 || code === 65385) {
      event.preventDefault();
      active.dataset.editing = '';
      if (isTV && active.tagName === 'INPUT') { active.readOnly = true; active.blur(); active.focus(); }
      else if (key === 'Enter' && active.tagName === 'INPUT') moveFocus($('settings'), 'down');
      return;
    }
    // Let the TV IME own its arrow keys and text entry.
    if (isTV || editingSelect || key === 'ArrowLeft' || key === 'ArrowRight') return;
  }
  if (isBack) { event.preventDefault(); back(); return; }
  const scope = !$('layout-overlay').hidden ? $('layout-overlay') : !$('dialog-overlay').hidden ? $('dialog-overlay') : screen === 'viewer' ? $('viewer') : screen === 'settings' ? $('settings') : $('dashboard');
  if (scope === $('dashboard')) {
    if ((key?.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) || code === 404) {
      event.preventDefault(); toggleGridFullscreen(); return;
    }
    if (gridFullscreen.active) {
      revealGridControls();
      if ([427, 428].includes(code)) { event.preventDefault(); changePage(code === 427 ? 1 : -1); return; }
      if (code === 457) { event.preventDefault(); $('exit-fullscreen-grid').focus(); return; }
    }
  }
  if (key === 'Tab' && (scope === $('layout-overlay') || scope === $('dialog-overlay') || (scope === $('dashboard') && gridFullscreen.active))) {
    event.preventDefault();
    const buttons = [...scope.querySelectorAll('button:not(:disabled)')].filter(button => button.getClientRects().length && getComputedStyle(button).visibility !== 'hidden');
    const index = buttons.indexOf(active);
    buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    return;
  }
  const direction = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[key] || { 37: 'left', 39: 'right', 38: 'up', 40: 'down' }[code];
  if (direction) {
    event.preventDefault();
    if (screen === 'viewer' && $('dialog-overlay').hidden && $('viewer').classList.contains('controls-hidden')) {
      if (direction === 'left' || direction === 'right') nextCamera(direction === 'left' ? -1 : 1);
      else { revealControls(); $('back-grid').focus(); }
      return;
    }
    if (screen === 'viewer') revealControls();
    moveFocus(scope, direction);
    return;
  }
  if (key === 'Enter' || code === 13) {
    event.preventDefault();
    if (screen === 'viewer' && $('viewer').classList.contains('controls-hidden') && $('dialog-overlay').hidden) { revealControls(); $('back-grid').focus(); return; }
    if (active?.tagName === 'SELECT') { active.dataset.editing = 'true'; active.click(); return; }
    if (active?.tagName === 'INPUT' && active.type !== 'checkbox') { active.blur(); active.readOnly = false; active.dataset.editing = 'true'; active.focus(); return; }
    active?.click();
    if (screen === 'viewer') scheduleHide();
    return;
  }
  if (screen === 'viewer' && $('dialog-overlay').hidden) {
    if ([427, 428].includes(code)) { event.preventDefault(); nextCamera(code === 427 ? 1 : -1); }
    else if ([10252, 19, 415].includes(code)) { event.preventDefault(); pauseLive(); }
    else if (code === 413) { event.preventDefault(); goGrid(); }
    else if (code === 405) { event.preventDefault(); toggleFavorite(); revealControls(); }
    else if (code === 406) { event.preventDefault(); toggleCycle(); revealControls(); }
    else if (code === 457) { event.preventDefault(); revealControls(); $('back-grid').focus(); }
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { poller?.stop(); liveGrid.stop(); player.stop(); clearTimeout(statusTimer); clearInterval(cycleTimer); clearTimeout(hideTimer); clearTimeout(gridHideTimer); }
  else {
    if (screen === 'viewer' && selected !== null && !paused) openCamera(selected, true);
    else if (screen === 'grid') { startGridMedia(); revealGridControls(); }
    scheduleCycle(); startStatusPoll();
  }
});
window.addEventListener('pagehide', () => { poller?.stop(); liveGrid.stop(); player.stop(); client?.logout(); });
window.addEventListener('resize', scaleStage);
registerRemote(); scaleStage(); clock(); setInterval(clock, 1000);
if (previewKey) {
  $('check-address').hidden = false;
  $('remember-label').textContent = 'Remember password in this browser';
  $('setup-device').textContent = 'this computer';
  $('welcome-device').textContent = 'YOUR BROWSER';
  setConnection('Connect your NVR');
}
fillForm();
const launchMode = new URLSearchParams(location.search);
if (launchMode.get('connect') === '1') {
  $('demo-button').hidden = true;
  $('address').focus();
}
else if (launchMode.get('demo') === '1') openDemo();
else if (settings.password && settings.address) connect(settings);
else $('address').focus();
