// Service worker: install, update and browser-update events, the daily active
// ping, the uninstall page's URL, and sending queued usage statistics
// (lib/telemetry.js). It never touches tabs or page content. Listeners are
// registered synchronously, as MV3 requires.

import { createTelemetry, FLUSH_ALARM, HOURLY_ALARM, uninstallUrl } from './lib/telemetry.js';

const LAST_ACTIVE_KEY = 'telemetryLastActiveDay';
const BROWSER_KEY = 'telemetryBrowserVersion';

const today = () => new Date().toISOString().slice(0, 10);

function browserVersion() {
  const brands = navigator.userAgentData?.brands ?? [];
  return (brands.find((b) => !/not.?a.?brand|chromium/i.test(b.brand)) ?? brands.find((b) => /chromium/i.test(b.brand)))?.version ?? '';
}

async function setUninstallUrl() {
  try { await chrome.runtime.setUninstallURL(await uninstallUrl(chrome)); } catch {}
}

// One active_daily per UTC day the browser runs, checked hourly.
async function activePing(t) {
  const { [LAST_ACTIVE_KEY]: last } = await chrome.storage.local.get(LAST_ACTIVE_KEY);
  if (last === today()) return;
  await chrome.storage.local.set({ [LAST_ACTIVE_KEY]: today() });
  t.track('active_daily');
}

async function ensureAlarms() {
  if (!(await chrome.alarms.get(HOURLY_ALARM))) chrome.alarms.create(HOURLY_ALARM, { delayInMinutes: 1, periodInMinutes: 60 });
}

chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  (async () => {
    const t = createTelemetry({ beacon: null });
    const version = chrome.runtime.getManifest().version;
    const browser = browserVersion();
    const { [BROWSER_KEY]: lastBrowser } = await chrome.storage.local.get(BROWSER_KEY);
    if (reason === 'install') t.track('install', { reason });
    else if (reason === 'update' && previousVersion !== version) t.track('update', { from: previousVersion, to: version });
    else if (reason === 'chrome_update') t.track('browser_update', { from: lastBrowser || undefined, to: browser || undefined });
    if (browser) await chrome.storage.local.set({ [BROWSER_KEY]: browser });
    await ensureAlarms();
    await setUninstallUrl();
    await activePing(t);
    await t.flush();
  })().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    const t = createTelemetry({ beacon: null });
    await ensureAlarms();
    await setUninstallUrl();
    await activePing(t);
    await t.flush();
  })().catch(() => {});
});

chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name !== HOURLY_ALARM && name !== FLUSH_ALARM) return;
  (async () => {
    const t = createTelemetry({ beacon: null });
    if (name === HOURLY_ALARM) await activePing(t);
    await t.flush();
  })().catch(() => {});
});

// Switching usage statistics off (or on) changes what the uninstall page gets.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && 'telemetry' in changes) setUninstallUrl();
});
