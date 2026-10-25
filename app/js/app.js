import { ReolinkClient, normalizeAddress } from './api.js';
import { readSettings, saveSettings } from './storage.js';
import { moveFocus, registerRemote } from './navigation.js';
import { CameraPlayer } from './player.js';
import { SnapshotPoller } from './snapshots.js';
import { DemoClient, demoScene } from './demo.js';
import { OVERVIEW_LAYOUTS, normalizeOverviewLayout, resolveOverviewLayout, overviewPage } from './overview.js';
import { createNvrFetch } from './transport.js';
import { createPreviewConnection } from './preview-connection.js';
import { GridFullscreen } from './fullscreen.js';
import { LiveGrid } from './live-grid.js';
import { createDiscovery } from './discovery.js';
import { DiscoveryUI } from './discovery-ui.js';

const $ = id => document.getElementById(id);
const previewKey = document.querySelector('meta[name="reolink-preview-key"]')?.content || '';
const previewStreamMode = document.querySelector('meta[name="reolink-preview-streams"]')?.content || '';
const nvrFetch = createNvrFetch({ key: previewKey, origin: location.origin, streamMode: previewStreamMode });
const previewConnection = previewKey ? createPreviewConnection({ key: previewKey, origin: location.origin }) : null;
let previewController = null;
const QUALITY = { sub: 'Fluent', ext: 'Balanced', main: 'Clear' };
let settings = readSettings();
let client = null, candidate = null, poller = null;
let channels = [];
let screen = 'settings', filter = 'all', page = 0, selected = null;
let cycleEnabled = false, cycleTimer = null, statusTimer = null, hideTimer = null, toastTimer = null;
let playerState = 'idle', paused = false, connectGeneration = 0, connecting = false;
let restoreFocus = null, dialogAction = null;
let settingsBeforeDemo = null;
let gridHideTimer = null, gridFocusId = null;
let setupStep = 'search', loginSource = 'select', credentialAddress = '';
const liveGrid = new LiveGrid(updateGridStream);
const discovery = new DiscoveryUI({
  root: $('discovery'), status: $('discovery-status'),
  results: $('discovery-results'), button: $('discover-button'),
  scan: createDiscovery({ key: previewKey, origin: location.origin, isTV: Boolean(globalThis.tizen?.application) }),
  onSelect: device => selectRecorder(device),
  onState: renderDiscovery
});

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

function setScreen(next) {
  if (next !== 'settings') discovery.stop();
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
    card.innerHTML = '<div class="camera-placeholder"><svg viewBox="0 0 80 80" fill="none" aria-hidden="true"><rect x="8" y="20" width="46" height="40" rx="8" stroke="currentColor" stroke-width="2"/><path d="m54 32 19-10v36L54 48" stroke="currentColor" stroke-width="2"/><circle cx="30" cy="40" r="10" stroke="currentColor" stroke-width="2"/></svg></div><img class="camera-preview" alt="" hidden><video class="camera-live" playsinline autoplay muted tabindex="-1" aria-hidden="true" hidden></video><div class="camera-shade"></div><div class="card-top"><span class="channel-tag"></span><span class="card-star"></span></div><div class="card-bottom"><div><span class="camera-name"></span><span class="preview-status"></span></div></div>';
    card.addEventListener('click', () => openCamera(channel.id));
  }
  card.querySelector('.channel-tag').textContent = `CAM ${String(channel.id + 1).padStart(2, '0')}`;
  card.querySelector('.camera-name').textContent = channel.name;
  card.querySelector('.card-star').textContent = settings.favorites.includes(channel.id) ? '★' : '';
  if (!existing || !gridFullscreen.active || client?.demo || channel.online === false || channel.sleeping) {
    card.querySelector('.preview-status').textContent = channel.online === false ? 'Offline' : channel.sleeping ? 'Sleeping' : 'Loading preview…';
  }
  return card;
}

function updateGridStream(id, state) {
  if (screen !== 'grid' || !gridFullscreen.active) return;
  const card = $(`camera-${id}`);
  if (!card) return;
  card.dataset.streamState = state.state;
  // Keep the video renderable while it prepares its first frame.
  card.querySelector('.camera-live').hidden = state.state === 'error';
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
  $('camera-count').textContent = channels.filter(channel => channel.online === true && !channel.sleeping).length;
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
  $('empty-description').textContent = filter === 'favorites' ? 'Open a camera and select Favorite to keep it here.' : 'Check that cameras are connected to your NVR and this account has permission to view them.';
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
      const changed = JSON.stringify(updated) !== JSON.stringify(channels);
      channels = updated;
      if (changed && screen === 'grid') renderGrid(document.activeElement.id);
    } catch (_) { /* Keep the last channel list and retry on the next poll. */ }
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
  for (const key of ['address', 'username', 'password']) $(key).value = source[key];
  $('address').value = source.address.replace(/^https:\/\//, '');
  $('password').type = 'password';
  $('show-password').textContent = 'Show';
  $('show-password').setAttribute('aria-label', 'Show password');
  credentialAddress = source.address;
}

function showSetupStep(step) {
  setupStep = step;
  $('discovery').hidden = !['search', 'select'].includes(step);
  $('manual-form').hidden = step !== 'manual';
  $('connection-form').hidden = step !== 'login';
  const copy = {
    search: ['Find your NVR', 'We’ll look for Reolink recorders on your local network.'],
    select: ['Choose your NVR', 'Select the recorder you want to view on this TV.'],
    manual: ['Add your NVR', 'Enter your recorder’s IP address to connect directly.'],
    login: ['Sign in to your NVR', 'Use the account on your Reolink recorder. Your connection will be remembered.']
  }[step];
  $('settings-title').textContent = copy[0];
  $('settings-description').textContent = copy[1];
  const current = step === 'login' ? 2 : ['select', 'manual'].includes(step) ? 1 : 0;
  ['search', 'select', 'login'].forEach((name, index) => {
    const item = $(`setup-${name}-step`);
    item.classList.toggle('complete', index < current);
    if (index === current) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
}

function renderDiscovery({ state }) {
  if (screen !== 'settings' || !['search', 'select'].includes(setupStep)) return;
  const searching = state === 'searching', found = state === 'results';
  showSetupStep(found ? 'select' : 'search');
  $('discovery').classList.toggle('searching', searching);
  $('discovery').classList.toggle('has-results', found);
  $('discovery-visual').hidden = found;
  $('discovery-title').textContent = {
    idle: 'Find a recorder', searching: 'Searching for your NVR', results: 'Available recorders',
    empty: 'No NVR found', error: 'Search couldn’t finish', stopped: 'Search paused', unavailable: 'Connect manually'
  }[state];
  $('discover-button').hidden = searching || state === 'unavailable' || state === 'idle';
  // Do not take focus from someone choosing manual entry while a scan completes.
  const active = document.activeElement;
  if (!document.hidden && $('dialog-overlay').hidden &&
      (active === document.body || active === $('discovery-title') || active === $('discover-button'))) {
    if (searching) $('discovery-title').focus();
    else {
      const fallback = $('discover-button').hidden ? $('manual-button') : $('discover-button');
      ($('discovery-results').querySelector('button') || fallback).focus();
    }
  }
}

function startSetupSearch() {
  showSetupStep('search');
  $('discovery-title').focus();
  if (!document.hidden) discovery.start();
}

function returnToRecorders() {
  $('form-error').hidden = true;
  if (['results', 'empty', 'error', 'unavailable'].includes(discovery.state)) {
    showSetupStep('select');
    renderDiscovery({ state: discovery.state });
    ($('discovery-results').querySelector('button') || $('manual-button')).focus();
  } else startSetupSearch();
}

function showManualAddress() {
  showSetupStep('manual');
  discovery.stop();
  $('manual-error').hidden = true;
  $('address').focus();
}

function selectRecorder(device, source = 'select') {
  if (screen !== 'settings' || connecting) return;
  const address = normalizeAddress(device.address || device.ip);
  // Changing recorders must not carry a previously entered password with it.
  if (address !== credentialAddress) {
    $('password').value = '';
    $('password').type = 'password';
    $('show-password').textContent = 'Show';
    $('show-password').setAttribute('aria-label', 'Show password');
  }
  credentialAddress = address;
  $('address').value = address.replace(/^https:\/\//, '');
  $('selected-recorder-name').textContent = device.name || 'Reolink NVR';
  $('selected-recorder-address').textContent = $('address').value;
  loginSource = source;
  showSetupStep('login');
  discovery.stop();
  $('form-error').hidden = true;
  $('username').focus();
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
  discovery.reset();
  $('settings-cancel').hidden = !client;
  $('form-error').hidden = true;
  if ($('address').value) selectRecorder({ address: $('address').value });
  else startSetupSearch();
}

function readForm() {
  const previous = settingsBeforeDemo || settings;
  const value = { ...previous, favorites: [...previous.favorites] };
  for (const key of ['address', 'username', 'password']) value[key] = $(key).value;
  value.address = normalizeAddress(value.address);
  value.username = value.username.trim();
  if (!value.username || !value.password) throw new Error('Enter your NVR username and password.');
  if (value.address !== previous.address || value.username !== previous.username) {
    value.favorites = [];
    value.lastChannel = null;
  }
  return value;
}

function setConnecting(value) {
  connecting = value;
  if (value) discovery.stop();
  $('discover-button').disabled = value || Boolean(discovery.controller);
  for (const button of $('discovery-results').querySelectorAll('button')) button.disabled = value;
  $('connect-button').disabled = value;
  $('connect-button').textContent = value ? 'Signing in…' : 'Sign in';
  for (const id of ['username', 'password', 'show-password', 'change-recorder']) $(id).disabled = value;
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
    $('address').value = result.address.replace(/^https:\/\//, '');
    $('selected-recorder-address').textContent = $('address').value;
    credentialAddress = result.address;
    return true;
  } finally {
    clearTimeout(timer);
    if (previewController === controller) previewController = null;
  }
}

async function connect(value) {
  const generation = ++connectGeneration;
  candidate?.close();
  let nextClient, failure;
  setConnecting(true);
  $('form-error').hidden = true;
  try {
    // Check the web address before sending a password. The local preview
    // accepts the NVR certificate automatically; this probe has no credentials.
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
    // A successful sign-in is remembered on both the browser and the TV.
    settings = { ...value, remember: true };
    settingsBeforeDemo = null;
    channels = result.channels;
    selected = settings.lastChannel;
    filter = 'all'; page = 0;
    persist();
    // Setup/demo launch links should not override the saved connection on reload.
    const launchUrl = new URL(location.href);
    for (const flag of ['connect', 'demo']) {
      if (launchUrl.searchParams.get(flag) === '1') launchUrl.searchParams.delete(flag);
    }
    if (launchUrl.href !== location.href) {
      try { history.replaceState(history.state, '', launchUrl.href); }
      catch (_) { /* Some packaged TV runtimes do not expose browser history. */ }
    }
    $('password').value = '';
    goGrid();
  } catch (error) {
    nextClient?.logout();
    if (generation !== connectGeneration) return;
    candidate = null;
    failure = error;
    $('form-error').textContent = error.message;
    $('form-error').hidden = false;
    $('form-error').scrollIntoView({ block: 'nearest' });
  } finally {
    if (generation === connectGeneration) {
      setConnecting(false);
      if (failure && screen === 'settings' && !document.hidden && $('dialog-overlay').hidden) {
        $(failure.kind === 'auth' ? 'password' : 'connect-button').focus();
      }
    }
  }
}

async function openDemo() {
  connectGeneration++;
  previewController?.abort();
  candidate?.close(); candidate = null;
  setConnecting(false);
  poller?.stop(); liveGrid.stop(); player.stop();
  if (!client?.demo) {
    settingsBeforeDemo = { ...settings, favorites: [...settings.favorites] };
    settings = { ...settings, favorites: [], lastChannel: null };
  }
  if (client) client.logout();
  client = new DemoClient();
  channels = (await client.connect()).channels;
  selected = null; page = 0; filter = 'all';
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
  discovery.stop();
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
    $('connect-button').focus();
    return;
  }
  if (screen === 'settings' && setupStep === 'manual') { returnToRecorders(); return; }
  if (screen === 'settings' && setupStep === 'login') {
    if (loginSource === 'manual') showManualAddress();
    else returnToRecorders();
    return;
  }
  if (screen === 'settings' && client) { $('password').value = ''; goGrid(); return; }
  showDialog('Leave Reolink TV?', 'Your saved connection will be here next time.', 'Exit app', () => {
    poller?.stop(); liveGrid.stop(); player.stop(); clearTimeout(statusTimer); stopCycle();
    client?.logout();
    try {
      if (globalThis.tizen?.application) globalThis.tizen.application.getCurrentApplication().exit();
      else { client = null; channels = []; openSettings(); toast('TV app would close here.'); }
    } catch (_) { toast('Press Home on your remote to leave the app.'); }
  });
}

$('connection-form').addEventListener('submit', event => {
  event.preventDefault();
  if (connecting || setupStep !== 'login') return;
  try { connect(readForm()); }
  catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; $('form-error').scrollIntoView({ block: 'nearest' }); }
});
$('manual-button').onclick = showManualAddress;
$('manual-back').onclick = returnToRecorders;
$('login-back').onclick = back;
$('change-recorder').onclick = back;
$('manual-form').addEventListener('submit', event => {
  event.preventDefault();
  try { selectRecorder({ address: $('address').value }, 'manual'); }
  catch (error) { $('manual-error').textContent = error.message; $('manual-error').hidden = false; }
});
$('address').addEventListener('input', () => {
  connectGeneration++; previewController?.abort(); candidate?.close(); candidate = null;
  setConnecting(false);
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
$('settings-cancel').onclick = () => {
  connectGeneration++; previewController?.abort(); candidate?.close(); candidate = null; setConnecting(false);
  $('password').value = '';
  goGrid();
};
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
$('show-password').onclick = () => {
  const show = $('password').type === 'password';
  $('password').type = show ? 'text' : 'password';
  $('show-password').textContent = show ? 'Hide' : 'Show';
  $('show-password').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
};
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
  if (document.hidden) { discovery.stop(); poller?.stop(); liveGrid.stop(); player.stop(); clearTimeout(statusTimer); clearInterval(cycleTimer); clearTimeout(hideTimer); clearTimeout(gridHideTimer); }
  else {
    if (screen === 'settings' && setupStep === 'search' && ['idle', 'stopped'].includes(discovery.state) && $('dialog-overlay').hidden) startSetupSearch();
    if (screen === 'viewer' && selected !== null && !paused) openCamera(selected, true);
    else if (screen === 'grid') { startGridMedia(); revealGridControls(); }
    scheduleCycle(); startStatusPoll();
  }
});
window.addEventListener('pagehide', () => { discovery.stop(); poller?.stop(); liveGrid.stop(); player.stop(); client?.logout(); });
window.addEventListener('resize', scaleStage);
registerRemote(); scaleStage(); clock(); setInterval(clock, 1000);
fillForm();
const launchMode = new URLSearchParams(location.search);
if (launchMode.get('demo') === '1' && launchMode.get('connect') !== '1') openDemo();
else if (settings.password && settings.address) {
  selectRecorder({ address: settings.address });
  connect(settings);
} else startSetupSearch();
