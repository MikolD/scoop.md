// Crawl requests: when a public docs site isn't in the library's docs index
// yet, the popup asks for a crawl (POST /crawl-requests) in the background,
// after copying the best package it has. The request is kept in
// chrome.storage.local; the service worker polls it every 30 s
// (chrome.alarms' minimum) and the toolbar badge shows it on that site's
// tabs: "…" while running, "✓" when ready (lib/badge.js). Reopening the popup
// on that site copies the full docs.

import { loadSites, refreshTabs } from './badge.js';

export const PENDING_KEY = 'crawlPending';
export const CRAWL_ALARM = 'crawl-poll';
// A request still running after this long is given up; a finished one waits
// this long to be picked up by the popup.
export const PENDING_TTL_MS = 2 * 3_600_000;
export const READY_TTL_MS = 24 * 3_600_000;

const TERMINAL = new Set(['complete', 'rejected', 'failed']);
export const isTerminal = (state) => TERMINAL.has(state);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function eta(seconds) {
  if (!(seconds > 0)) return '';
  return seconds < 60 ? 'About a minute' : `About ${Math.round(seconds / 60)} minutes`;
}

// What the waiting view says about a request: a label (the phase only, so a
// screen reader hears phase changes, not every count), a count shown beside
// it, and how far along it is (0–1) when that is known, else null for an
// indeterminate bar.
export function progressText(req = {}) {
  const found = req.pagesFound > 0 ? req.pagesFound : 0;
  const indexed = req.pagesIndexed > 0 ? req.pagesIndexed : 0;
  const pages = found ? plural(found, 'page') : '';
  if (req.state === 'queued') return { label: 'Waiting for a crawler', count: eta(req.etaSeconds), fraction: null };
  if (req.state === 'complete' || req.phase === 'done') return { label: 'Almost ready', count: pages, fraction: 1 };
  switch (req.phase) {
    case 'gate': return { label: "Checking it's developer docs", count: '', fraction: null };
    case 'discover': return { label: 'Finding the docs', count: found ? `${pages} found` : '', fraction: null };
    case 'fetch':
    case 'browser': return { label: 'Reading the docs', count: found ? `${pages} found` : '', fraction: null };
    case 'index': return {
      label: 'Indexing',
      count: found ? `${Math.min(indexed, found)} of ${pages} indexed` : '',
      // Nothing indexed yet: keep the bar moving rather than show it empty.
      fraction: found && indexed ? Math.min(1, indexed / found) : null,
    };
    default: return { label: 'Getting started', count: pages, fraction: null };
  }
}

export async function loadPending(chromeApi) {
  try {
    const { [PENDING_KEY]: pending } = await chromeApi.storage.local.get(PENDING_KEY);
    return pending && typeof pending === 'object' ? pending : {};
  } catch {
    return {};
  }
}

async function savePending(chromeApi, pending) {
  try { await chromeApi.storage.local.set({ [PENDING_KEY]: pending }); } catch {}
}

// One entry per site: { requestId, site, url, state, startedAt, updatedAt }.
export async function rememberCrawl(chromeApi, entry, now = Date.now()) {
  const pending = await loadPending(chromeApi);
  pending[entry.site] = { startedAt: now, ...pending[entry.site], ...entry, updatedAt: now };
  await savePending(chromeApi, pending);
  if (!isTerminal(pending[entry.site].state)) {
    try { chromeApi.alarms?.create(CRAWL_ALARM, { periodInMinutes: 0.5 }); } catch {}
  }
  await updateBadge(chromeApi, pending);
}

export async function forgetCrawl(chromeApi, site) {
  const pending = await loadPending(chromeApi);
  if (!(site in pending)) return;
  delete pending[site];
  await savePending(chromeApi, pending);
  await updateBadge(chromeApi, pending);
}

// Entries still worth showing: a running request not yet given up on, a
// finished one not yet expired (so a ✓ nobody picked up doesn't stay forever).
export function live(pending, now = Date.now()) {
  return Object.fromEntries(Object.entries(pending).filter(([, e]) => (e.state === 'complete'
    ? now - (e.updatedAt ?? now) <= READY_TTL_MS
    : isTerminal(e.state) || now - (e.startedAt ?? now) <= PENDING_TTL_MS)));
}

// Re-draws the per-tab badges (lib/badge.js) after a crawl changed. Returns
// what the crawls amount to: "✓" when a finished one is waiting to be picked
// up, "…" while one runs (a crawl whose pages were already delivered never ✓).
export async function updateBadge(chromeApi, pending, now = Date.now()) {
  const kept = live(pending ?? await loadPending(chromeApi), now);
  const entries = Object.values(kept);
  const text = entries.some((e) => e.state === 'complete' && !e.delivered) ? '✓' : entries.some((e) => !isTerminal(e.state)) ? '…' : '';
  const { sites } = await loadSites(chromeApi);
  await refreshTabs(chromeApi, { sites, pending: kept });
  return text;
}

// The service worker's poll: every request still running is asked once.
// Rejected and failed ones are dropped (the popup copies the page as usual);
// complete ones stay until the popup delivers them or they expire. The alarm
// stops when nothing is running.
export async function pollPending(chromeApi, library, now = Date.now()) {
  const updates = {};
  for (const [site, e] of Object.entries(await loadPending(chromeApi))) {
    if (isTerminal(e.state)) continue;
    if (now - (e.startedAt ?? now) > PENDING_TTL_MS) {
      updates[site] = { requestId: e.requestId, state: 'failed' };
      continue;
    }
    const res = await library.crawlRequest(e.requestId);
    if (res.ok && res.data?.state) updates[site] = { requestId: e.requestId, state: res.data.state, phase: res.data.phase, updatedAt: now };
    else if (res.status === 404) updates[site] = { requestId: e.requestId, state: 'failed' };
  }
  // The popup may have delivered or replaced an entry while we were asking:
  // merge into what is stored now, per site and only for the same request.
  const pending = await loadPending(chromeApi);
  for (const [site, u] of Object.entries(updates)) {
    if (pending[site]?.requestId === u.requestId) Object.assign(pending[site], u);
  }
  for (const [site, e] of Object.entries(pending)) {
    if (e.state === 'rejected' || e.state === 'failed') delete pending[site];
    else if (e.state === 'complete' && e.delivered) delete pending[site];
  }
  const kept = live(pending, now);
  await savePending(chromeApi, kept);
  if (!Object.values(kept).some((e) => !isTerminal(e.state))) {
    try { await chromeApi.alarms?.clear(CRAWL_ALARM); } catch {}
  }
  return updateBadge(chromeApi, kept, now);
}
