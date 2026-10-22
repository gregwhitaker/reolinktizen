import { normalizeOverviewLayout } from './overview.js';

const KEY = 'reolink-tv.settings.v1';
export const DEFAULTS = { address: '', username: 'admin', password: '', remember: false, quality: 'sub', channelCount: 0, rtmpPort: 0, streamAuth: 'auto', refresh: 5, cycle: 20, overviewLayout: 'auto', favorites: [], lastChannel: null };

export function readSettings(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage.getItem(KEY) || '{}');
    return {
      ...DEFAULTS, ...value,
      quality: ['sub', 'ext', 'main'].includes(value.quality) ? value.quality : 'sub',
      streamAuth: ['auto', 'token', 'credentials'].includes(value.streamAuth) ? value.streamAuth : 'auto',
      channelCount: Math.min(64, Math.max(0, Number(value.channelCount) || 0)),
      refresh: [3, 5, 10].includes(Number(value.refresh)) ? Number(value.refresh) : 5,
      cycle: [10, 20, 30, 60].includes(Number(value.cycle)) ? Number(value.cycle) : 20,
      overviewLayout: normalizeOverviewLayout(value.overviewLayout),
      favorites: Array.isArray(value.favorites) ? value.favorites.filter(id => Number.isInteger(id) && id >= 0 && id < 64) : [],
      password: value.remember === true ? String(value.password || '') : '',
      remember: value.remember === true
    };
  } catch (_) { return { ...DEFAULTS, favorites: [] }; }
}

export function saveSettings(settings, storage = globalThis.localStorage) {
  const value = {};
  for (const key of Object.keys(DEFAULTS)) value[key] = settings[key] ?? DEFAULTS[key];
  if (!settings.remember) value.password = '';
  storage.setItem(KEY, JSON.stringify(value));
}

export function forgetSettings(storage = globalThis.localStorage) { storage.removeItem(KEY); }
