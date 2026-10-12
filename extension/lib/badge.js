// The toolbar badge, per tab: how many docs pages the library has indexed for
// the site the tab is on (from a downloaded list, so no request per visit),
// or a crawl this install asked for: "…" while it runs, "✓" when it's ready.
// The crawl wins for its own site. Pages on private hosts are never looked up.
//
// The service worker downloads GET /sites/index on install and every 6 hours
// (If-None-Match), and sets the badge on tab activation and page loads. Tab
// URLs are readable through the <all_urls> host permission; no "tabs"
// permission is needed.

import { siteKey } from './discover.js';
import { isPrivateHost } from './hosts.js';

export const SITES_KEY = 'sitesIndex';
export const SITES_ALARM = 'sites-index';
export const SITES_PERIOD_MINUTES = 360;
export const SHOWN_KEY = 'badgeShownCount';
export const BADGE_COLOR = '#c2410c';

// 14, 230, 1.2k, 12k, 1.2m: at most four characters, as the badge allows.
export function compactCount(n) {
  if (!(n > 0)) return '';
  if (n < 1000) return String(Math.floor(n));
  const unit = n < 1_000_000 ? ['k', 1000] : ['m', 1_000_000];
  const v = n / unit[1];
  return `${v < 10 ? Math.floor(v * 10) / 10 : Math.floor(v)}${unit[0]}`;
}

export async function loadSites(chromeApi) {
  try {
    const { [SITES_KEY]: index } = await chromeApi.storage.local.get(SITES_KEY);
    return index && typeof index === 'object' ? index : { sites: {}, etag: null, fetchedAt: 0 };
  } catch {
    return { sites: {}, etag: null, fetchedAt: 0 };
  }
}

// Downloads the list unless unchanged (304). Returns whether it changed.
export async function refreshSites(chromeApi, library, now = Date.now()) {
  const current = await loadSites(chromeApi);
  const res = await library.sitesIndex(current.etag);
  if (!res.ok) return false;
  if (res.notModified) {
    await chromeApi.storage.local.set({ [SITES_KEY]: { ...current, fetchedAt: now } });
    return false;
  }
  const list = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.sites) ? res.data.sites : [];
  const sites = {};
  for (const { site, pages } of list) if (typeof site === 'string' && pages > 0) sites[site] = pages;
  await chromeApi.storage.local.set({ [SITES_KEY]: { sites, etag: res.etag ?? null, fetchedAt: now } });
  return true;
}

// What a tab's badge says: { text, title }.
export function badgeFor(url, { sites = {}, pending = {} } = {}) {
  let site;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) return { text: '', title: '' };
    site = siteKey(url);
  } catch {
    return { text: '', title: '' };
  }
  const crawl = pending[site];
  if (crawl && !crawl.delivered && crawl.state === 'complete') return { text: '✓', title: `scoop.md: the docs for ${site} are ready` };
  if (crawl && !['complete', 'rejected', 'failed'].includes(crawl.state)) return { text: '…', title: `scoop.md: indexing the docs for ${site}` };
  const pages = sites[site];
  if (pages > 0) return { text: compactCount(pages), title: `scoop.md: ${pages} docs indexed for ${site}`, count: true };
  return { text: '', title: '' };
}

const DEFAULT_TITLE = 'Scoop to agent';

export async function setTabBadge(chromeApi, tab, state) {
  if (!tab?.id || tab.id < 0) return;
  const { text, title } = badgeFor(tab.url ?? '', state);
  try {
    await chromeApi.action.setBadgeBackgroundColor({ tabId: tab.id, color: BADGE_COLOR });
    await chromeApi.action.setBadgeText({ tabId: tab.id, text });
    await chromeApi.action.setTitle?.({ tabId: tab.id, title: title || DEFAULT_TITLE });
  } catch {}
  return text;
}

// Every open tab, or only the ones on one site.
export async function refreshTabs(chromeApi, state, { site } = {}) {
  let tabs = [];
  try { tabs = await chromeApi.tabs.query({}); } catch {}
  for (const tab of tabs) {
    if (site) {
      try { if (siteKey(tab.url) !== site) continue; } catch { continue; }
    }
    await setTabBadge(chromeApi, tab, state);
  }
}

// How often a page-count badge was shown: one number, sent hourly as
// badge_count_shown (lib/telemetry.js), nothing about which sites.
// Serialized, so badges set at the same moment are all counted.
let counting = Promise.resolve();
export function countShown(chromeApi, n = 1) {
  counting = counting.then(async () => {
    const { [SHOWN_KEY]: count = 0 } = await chromeApi.storage.local.get(SHOWN_KEY);
    await chromeApi.storage.local.set({ [SHOWN_KEY]: count + n });
  }).catch(() => {});
  return counting;
}

export async function takeShownCount(chromeApi) {
  try {
    const { [SHOWN_KEY]: count = 0 } = await chromeApi.storage.local.get(SHOWN_KEY);
    if (count) await chromeApi.storage.local.remove(SHOWN_KEY);
    return count;
  } catch {
    return 0;
  }
}
