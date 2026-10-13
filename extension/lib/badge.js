// The toolbar badge, per tab: "1" when the site has an llms.txt (its own or a
// ready one prepared by scoop.md), "2" when it also has instructions for
// agents, nothing otherwise (unknown, not a developer site, or still being
// prepared). No request per visit: it is looked up in the list downloaded to
// the device (GET /sites/index: llms { host: 1 | 2 }) and in what the popup
// learned from GET /v1/llms for sites you opened it on (kept 7 days). Pages on
// private hosts are never looked up.
//
// The service worker downloads the list on install and every 6 hours
// (If-None-Match), and sets the badge on tab activation and page loads. Tab
// URLs are readable through the <all_urls> host permission; no "tabs"
// permission is needed.

import { siteKey } from './discover.js';
import { isPrivateHost } from './hosts.js';

export const SITES_KEY = 'sitesIndex';
export const SITES_ALARM = 'sites-index';
export const SITES_PERIOD_MINUTES = 360;
export const SHOWN_KEY = 'badgeLlmsShown';
export const LEARNED_KEY = 'llmsLevels';
export const LEARNED_TTL_MS = 7 * 24 * 3600_000;
export const BADGE_COLOR = '#c2410c';
export const BADGE = {
  1: { text: '1', title: 'scoop.md: llms.txt available' },
  2: { text: '2', title: 'scoop.md: llms.txt + instructions for agents' },
};
const DEFAULT_TITLE = 'Scoop to agent';

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
    return index && typeof index === 'object' ? { llms: {}, ...index } : { sites: {}, llms: {}, etag: null, fetchedAt: 0 };
  } catch {
    return { sites: {}, llms: {}, etag: null, fetchedAt: 0 };
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
  // { host: 1 | 2 }; an older list without it shows nothing.
  const llms = {};
  const given = res.data?.llms && typeof res.data.llms === 'object' && !Array.isArray(res.data.llms) ? res.data.llms : {};
  for (const [host, level] of Object.entries(given).slice(0, 100_000)) if (level === 1 || level === 2) llms[host] = level;
  await chromeApi.storage.local.set({ [SITES_KEY]: { sites, llms, etag: res.etag ?? null, fetchedAt: now } });
  return true;
}

export async function loadLearned(chromeApi) {
  try {
    const { [LEARNED_KEY]: v } = await chromeApi.storage.local.get(LEARNED_KEY);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// What the popup learned from GET /v1/llms for a host: 0 (nothing to show),
// 1 or 2; kept 7 days, and newer than the list.
export async function rememberLlms(chromeApi, host, level, now = Date.now()) {
  if (!host || ![0, 1, 2].includes(level)) return;
  const all = await loadLearned(chromeApi);
  for (const [h, e] of Object.entries(all)) if (!(now - e.at <= LEARNED_TTL_MS)) delete all[h];
  all[host] = { level, at: now };
  try { await chromeApi.storage.local.set({ [LEARNED_KEY]: all }); } catch {}
}

// 0, 1 or 2 for a tab's URL: what the popup learned recently, else the list.
export function llmsLevelFor(url, { llms = {}, learned = {} } = {}, now = Date.now()) {
  let host;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) return 0;
    host = siteKey(url);
  } catch {
    return 0;
  }
  const seen = learned[host];
  if (seen && now - seen.at <= LEARNED_TTL_MS && [0, 1, 2].includes(seen.level)) return seen.level;
  const level = llms[host] ?? llms[`www.${host}`];
  return level === 1 || level === 2 ? level : 0;
}

// What a tab's badge says: { level, text, title }.
export function badgeFor(url, state) {
  const level = llmsLevelFor(url, state);
  return level ? { level, ...BADGE[level] } : { level: 0, text: '', title: '' };
}

// Sets one tab's badge from what is stored now (the list and what the popup
// learned), so an answer the popup just got shows at once. Returns the level.
export async function setTabBadge(chromeApi, tab) {
  if (!tab?.id || tab.id < 0) return 0;
  const [{ llms }, learned] = await Promise.all([loadSites(chromeApi), loadLearned(chromeApi)]);
  const badge = badgeFor(tab.url ?? '', { llms, learned });
  const tabId = tab.id;
  try {
    await chromeApi.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
    await chromeApi.action.setBadgeTextColor?.({ tabId, color: '#ffffff' });
    await chromeApi.action.setBadgeText({ tabId, text: badge.text });
    await chromeApi.action.setTitle?.({ tabId, title: badge.title || DEFAULT_TITLE });
  } catch {}
  return badge.level;
}

// Every open tab.
export async function refreshTabs(chromeApi) {
  let tabs = [];
  try { tabs = await chromeApi.tabs.query({}); } catch {}
  for (const tab of tabs) await setTabBadge(chromeApi, tab);
}

// How often each badge was shown: two numbers, sent hourly as
// badge_llms_shown (lib/telemetry.js), nothing about which sites.
// Serialized, so badges set at the same moment are all counted.
let counting = Promise.resolve();
export function countShown(chromeApi, level) {
  counting = counting.then(async () => {
    const { [SHOWN_KEY]: counts = {} } = await chromeApi.storage.local.get(SHOWN_KEY);
    await chromeApi.storage.local.set({ [SHOWN_KEY]: { ...counts, [level]: (counts[level] ?? 0) + 1 } });
  }).catch(() => {});
  return counting;
}

export async function takeShownCounts(chromeApi) {
  try {
    const { [SHOWN_KEY]: counts = {} } = await chromeApi.storage.local.get(SHOWN_KEY);
    if (Object.keys(counts).length) await chromeApi.storage.local.remove(SHOWN_KEY);
    return counts;
  } catch {
    return {};
  }
}
