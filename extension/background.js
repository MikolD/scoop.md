// Service worker: install, update and browser-update events, the daily active
// ping, the uninstall page's URL, sending queued usage statistics
// (lib/telemetry.js), and following crawl requests the popup was closed on
// (lib/crawl.js: polled every 30 s, progress on the toolbar badge). It never
// touches tabs or page content. Listeners are registered synchronously, as
// MV3 requires.

import { createTelemetry, FLUSH_ALARM, getInstallId, HOURLY_ALARM, QUEUE_KEY, RETRY_KEY, telemetryEnabled, uninstallUrl } from './lib/telemetry.js';
import { createLibrary, libraryUrl } from './lib/library.js';
import { CRAWL_ALARM, loadPending, isTerminal, pollPending, updateBadge } from './lib/crawl.js';

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
  // A crawl still running when the browser closed: keep following it.
  const pending = await loadPending(chrome);
  if (Object.values(pending).some((e) => !isTerminal(e.state)) && !(await chrome.alarms.get(CRAWL_ALARM))) {
    chrome.alarms.create(CRAWL_ALARM, { periodInMinutes: 0.5 });
  }
  await updateBadge(chrome, pending);
}

async function library() {
  return createLibrary({
    baseUrl: await libraryUrl(chrome),
    installId: await getInstallId(chrome),
    client: `extension/${chrome.runtime.getManifest().version}`,
    telemetry: await telemetryEnabled(chrome),
  });
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
    // Not sent yet: on a new device, a synced "usage statistics off" may still be
    // on its way. The flush 30 s from now checks the setting again (and drops
    // the queue if it is off).
    chrome.alarms.create(FLUSH_ALARM, { delayInMinutes: 0.5 });
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
  if (name === CRAWL_ALARM) {
    (async () => pollPending(chrome, await library()))().catch(() => {});
    return;
  }
  if (name !== HOURLY_ALARM && name !== FLUSH_ALARM) return;
  (async () => {
    const t = createTelemetry({ beacon: null });
    if (name === HOURLY_ALARM) await activePing(t);
    await t.flush();
  })().catch(() => {});
});

// Switching usage statistics off (here or synced from another device) drops
// anything queued and changes what the uninstall page gets.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !('telemetry' in changes)) return;
  if (changes.telemetry.newValue === false) chrome.storage.local.remove([QUEUE_KEY, RETRY_KEY]).catch(() => {});
  setUninstallUrl();
});
