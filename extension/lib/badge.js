// The toolbar icon, per tab: whether the site the tab is on is developer docs.
// A green check for docs sites, an amber "!" for sites that aren't, nothing
// when unknown. No request per visit: it is looked up in lists downloaded to
// the device (GET /sites/index: indexed docs sites, and notDocs), and in the
// verdicts the popup got from the library for sites you scooped (kept 7 days).
// Pages on private hosts are never looked up. Background indexing never shows
// on the icon (the popup shows it).
//
// The service worker downloads the list on install and every 6 hours
// (If-None-Match), and sets the icon on tab activation and page loads. Tab
// URLs are readable through the <all_urls> host permission; no "tabs"
// permission is needed.

import { siteKey } from './discover.js';
import { isPrivateHost, registrableDomain } from './hosts.js';

export const SITES_KEY = 'sitesIndex';
export const SITES_ALARM = 'sites-index';
export const SITES_PERIOD_MINUTES = 360;
export const SHOWN_KEY = 'badgeVerdictsShown';
export const VERDICTS_KEY = 'docsVerdicts';
export const VERDICT_TTL_MS = 7 * 24 * 3600_000;
export const BADGE = {
  docs: { text: '✓', color: '#2e7d32', title: 'scoop.md: developer docs' },
  not_docs: { text: '!', color: '#d97706', title: 'scoop.md: not developer docs' },
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
    return index && typeof index === 'object' ? { notDocs: [], ...index } : { sites: {}, notDocs: [], etag: null, fetchedAt: 0 };
  } catch {
    return { sites: {}, notDocs: [], etag: null, fetchedAt: 0 };
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
  const notDocs = (Array.isArray(res.data?.notDocs) ? res.data.notDocs : []).filter((h) => typeof h === 'string').slice(0, 50_000);
  await chromeApi.storage.local.set({ [SITES_KEY]: { sites, notDocs, etag: res.etag ?? null, fetchedAt: now } });
  return true;
}

export async function loadVerdicts(chromeApi) {
  try {
    const { [VERDICTS_KEY]: v } = await chromeApi.storage.local.get(VERDICTS_KEY);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// The popup's verdict for a host (from the library, not a guess), kept 7 days.
export async function rememberVerdict(chromeApi, host, verdict, now = Date.now()) {
  if (!host || !BADGE[verdict]) return;
  const all = await loadVerdicts(chromeApi);
  for (const [h, e] of Object.entries(all)) if (!(now - e.at <= VERDICT_TTL_MS)) delete all[h];
  all[host] = { v: verdict, at: now };
  try { await chromeApi.storage.local.set({ [VERDICTS_KEY]: all }); } catch {}
}

// 'docs', 'not_docs' or null (unknown) for a tab's URL: an indexed docs site;
// else the popup's recent verdict; else the not-docs list; else a docs.*
// site indexed on the same domain (stripe.com → docs.stripe.com).
export function verdictFor(url, { sites = {}, notDocs = [], verdicts = {} } = {}, now = Date.now()) {
  let host;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) return null;
    host = siteKey(url);
  } catch {
    return null;
  }
  if (sites[host] > 0) return 'docs';
  const seen = verdicts[host];
  if (seen && now - seen.at <= VERDICT_TTL_MS && BADGE[seen.v]) return seen.v;
  const domain = registrableDomain(host);
  if (notDocs.includes(host) || notDocs.includes(domain)) return 'not_docs';
  if (Object.keys(sites).some((s) => s.startsWith('docs.') && registrableDomain(s) === domain)) return 'docs';
  return null;
}

// What a tab's badge says: { verdict, text, title, color }.
export function badgeFor(url, state) {
  const verdict = verdictFor(url, state);
  return verdict ? { verdict, ...BADGE[verdict] } : { verdict: null, text: '', title: '', color: null };
}

// A check or a "!" drawn on the icon (16 and 32 px), where the browser can
// draw (OffscreenCanvas); otherwise the badge text. Cached per verdict.
const icons = {};
async function iconFor(chromeApi, verdict) {
  if (verdict in icons) return icons[verdict];
  icons[verdict] = null;
  try {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined' || !chromeApi.runtime?.getURL) return null;
    const imageData = {};
    for (const size of [16, 32]) {
      const res = await fetch(chromeApi.runtime.getURL(`icons/icon${size}.png`));
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, size, size);
      const r = size * 0.32;
      const cx = size - r - 0.5;
      const cy = size - r - 0.5;
      ctx.fillStyle = BADGE[verdict].color;
      ctx.strokeStyle = '#ffffff';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // A white halo, so the mark reads on the orange icon.
      const shape = () => {
        ctx.beginPath();
        if (verdict === 'docs') ctx.arc(cx, cy, r, 0, Math.PI * 2);
        else {
          ctx.moveTo(cx, cy - r * 1.1);
          ctx.lineTo(cx + r * 1.05, cy + r * 0.9);
          ctx.lineTo(cx - r * 1.05, cy + r * 0.9);
          ctx.closePath();
        }
      };
      shape();
      ctx.lineWidth = Math.max(1.5, size / 8);
      ctx.stroke();
      shape();
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, size / 10);
      if (verdict === 'docs') {
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.5, cy);
        ctx.lineTo(cx - r * 0.1, cy + r * 0.4);
        ctx.lineTo(cx + r * 0.55, cy - r * 0.4);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(cx, cy - r * 0.45);
        ctx.lineTo(cx, cy + r * 0.15);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy + r * 0.55, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    icons[verdict] = imageData;
  } catch {
    icons[verdict] = null;
  }
  return icons[verdict];
}

// Sets one tab's icon from what is stored now (the lists and the verdicts),
// so a verdict the popup just saved shows at once. Returns the verdict.
export async function setTabBadge(chromeApi, tab) {
  if (!tab?.id || tab.id < 0) return null;
  const [{ sites, notDocs }, verdicts] = await Promise.all([loadSites(chromeApi), loadVerdicts(chromeApi)]);
  const badge = badgeFor(tab.url ?? '', { sites, notDocs, verdicts });
  const tabId = tab.id;
  try {
    const drawn = badge.verdict ? await iconFor(chromeApi, badge.verdict) : null;
    if (drawn) {
      await chromeApi.action.setIcon({ tabId, imageData: drawn });
      await chromeApi.action.setBadgeText({ tabId, text: '' });
    } else {
      if (!badge.verdict && chromeApi.action.setIcon) {
        await chromeApi.action.setIcon({ tabId, path: { 16: 'icons/icon16.png', 32: 'icons/icon32.png' } }).catch?.(() => {});
      }
      if (badge.color) await chromeApi.action.setBadgeBackgroundColor({ tabId, color: badge.color });
      await chromeApi.action.setBadgeText({ tabId, text: badge.text });
    }
    await chromeApi.action.setTitle?.({ tabId, title: badge.title || DEFAULT_TITLE });
  } catch {}
  return badge.verdict;
}

// Every open tab.
export async function refreshTabs(chromeApi) {
  let tabs = [];
  try { tabs = await chromeApi.tabs.query({}); } catch {}
  for (const tab of tabs) await setTabBadge(chromeApi, tab);
}

// How often each verdict was shown: two numbers, sent hourly as
// badge_verdict_shown (lib/telemetry.js), nothing about which sites.
// Serialized, so icons set at the same moment are all counted.
let counting = Promise.resolve();
export function countShown(chromeApi, verdict) {
  counting = counting.then(async () => {
    const { [SHOWN_KEY]: counts = {} } = await chromeApi.storage.local.get(SHOWN_KEY);
    await chromeApi.storage.local.set({ [SHOWN_KEY]: { ...counts, [verdict]: (counts[verdict] ?? 0) + 1 } });
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
