// Service worker: install, update and browser-update events, the daily active
// ping, the uninstall page's URL, sending queued usage statistics
// (lib/telemetry.js), following crawl requests in the background (lib/crawl.js:
// polled every 30 s), and the per-tab toolbar badge (lib/badge.js): the
// indexed-docs count for the tab's site, looked up in a list downloaded every
// 6 hours, never per visit. It reads tab URLs (host permission), never page
// content. Listeners are registered synchronously, as MV3 requires.

import { createTelemetry, FLUSH_ALARM, getInstallId, HOURLY_ALARM, QUEUE_KEY, RETRY_KEY, telemetryEnabled, uninstallUrl } from './lib/telemetry.js';
import { createLibrary, libraryUrl } from './lib/library.js';
import { CRAWL_ALARM, PENDING_KEY, live, loadPending, isTerminal, pollPending, updateBadge } from './lib/crawl.js';
import { countShown, loadSites, refreshSites, setTabBadge, SITES_ALARM, SITES_PERIOD_MINUTES, takeShownCounts } from './lib/badge.js';
import { siteKey } from './lib/discover.js';

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
  if (!(await chrome.alarms.get(SITES_ALARM))) chrome.alarms.create(SITES_ALARM, { periodInMinutes: SITES_PERIOD_MINUTES });
  // A crawl still running when the browser closed: keep following it. Finished
  // ones nobody picked up expire, so the ✓ doesn't stick.
  const pending = live(await loadPending(chrome));
  await chrome.storage.local.set({ [PENDING_KEY]: pending });
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
    await refreshSites(chrome, await library()).catch(() => {});
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
    // The list is refreshed every 6 hours; after a long break, at once.
    const { fetchedAt } = await loadSites(chrome);
    if (Date.now() - fetchedAt > SITES_PERIOD_MINUTES * 60_000) await refreshSites(chrome, await library()).catch(() => {});
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
  if (name === SITES_ALARM) {
    (async () => {
      if (await refreshSites(chrome, await library())) await updateBadge(chrome);
    })().catch(() => {});
    return;
  }
  if (name !== HOURLY_ALARM && name !== FLUSH_ALARM) return;
  (async () => {
    const t = createTelemetry({ beacon: null });
    if (name === HOURLY_ALARM) {
      await activePing(t);
      // Expires finished crawls nobody picked up, so their ✓ clears.
      await ensureAlarms();
      // How often each docs verdict was shown this hour: two numbers, no sites.
      for (const [verdict, count] of Object.entries(await takeShownCounts(chrome))) {
        if (count > 0) t.track('badge_verdict_shown', { verdict, count });
      }
    }
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

// The icon follows the tab: on switching tabs and when a page finishes loading.
// A verdict is counted as shown once per tab per site, not on every load.
const countedSite = new Map();
async function badgeTab(tab) {
  const verdict = await setTabBadge(chrome, tab);
  let site = null;
  try { site = siteKey(tab.url); } catch {}
  if (!verdict) return countedSite.delete(tab.id);
  const key = `${site} ${verdict}`;
  if (countedSite.get(tab.id) === key) return;
  countedSite.set(tab.id, key);
  await countShown(chrome, verdict);
}
chrome.tabs.onRemoved?.addListener((tabId) => countedSite.delete(tabId));

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(badgeTab).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' && !info.url) return;
  badgeTab(tab).catch(() => {});
});
