// Crawl requests: when a public docs site isn't in the library's docs index
// yet, the popup asks for a crawl (POST /crawl-requests) and follows it
// (GET /crawl-requests/:id every 2 s). The request is kept in
// chrome.storage.local from the moment it exists, so if the popup closes the
// service worker keeps polling it every 30 s (chrome.alarms' minimum) and
// shows progress on the toolbar badge: "…" while running, "✓" when ready.
// Reopening the popup on that site resumes the wait or delivers the result.

export const PENDING_KEY = 'crawlPending';
export const CRAWL_ALARM = 'crawl-poll';
// A request still running after this long is given up; a finished one waits
// this long to be picked up by the popup.
export const PENDING_TTL_MS = 2 * 3_600_000;
export const READY_TTL_MS = 24 * 3_600_000;
export const BADGE_COLOR = '#c2410c';

const TERMINAL = new Set(['complete', 'rejected', 'failed']);
export const isTerminal = (state) => TERMINAL.has(state);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function eta(seconds) {
  if (!(seconds > 0)) return '';
  return seconds < 60 ? ' (about a minute)' : ` (about ${Math.round(seconds / 60)} minutes)`;
}

// What the waiting view says about a request: a label, a count, and how far
// along it is (0–1) when that is known, else null for an indeterminate bar.
export function progressText(req = {}) {
  const found = req.pagesFound > 0 ? req.pagesFound : 0;
  const indexed = req.pagesIndexed > 0 ? req.pagesIndexed : 0;
  const count = found ? plural(found, 'page') + ' found' : '';
  if (req.state === 'queued') return { label: `Waiting for a crawler${eta(req.etaSeconds)}`, count: '', fraction: null };
  if (req.state === 'complete' || req.phase === 'done') return { label: 'Almost ready', count, fraction: 1 };
  switch (req.phase) {
    case 'gate': return { label: "Checking it's developer docs", count: '', fraction: null };
    case 'discover': return { label: 'Finding the docs', count, fraction: null };
    case 'fetch':
    case 'browser': return { label: found ? `Reading ${plural(found, 'page')}` : 'Reading the docs', count: '', fraction: null };
    case 'index': return {
      label: found ? `Indexing ${Math.min(indexed, found)}/${found}` : 'Indexing',
      count: '',
      // Nothing indexed yet: keep the bar moving rather than show it empty.
      fraction: found && indexed ? Math.min(1, indexed / found) : null,
    };
    default: return { label: 'Getting started', count, fraction: null };
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

// "✓" when a finished crawl is waiting to be picked up, "…" while one runs.
// One badge for the whole toolbar: knowing which tabs show a site would mean
// watching every tab's navigation, which the extension doesn't do.
export async function updateBadge(chromeApi, pending, now = Date.now()) {
  const entries = Object.values(live(pending ?? await loadPending(chromeApi), now));
  const text = entries.some((e) => e.state === 'complete') ? '✓' : entries.some((e) => !isTerminal(e.state)) ? '…' : '';
  try {
    await chromeApi.action?.setBadgeBackgroundColor?.({ color: BADGE_COLOR });
    await chromeApi.action?.setBadgeText?.({ text });
  } catch {}
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
  }
  const kept = live(pending, now);
  await savePending(chromeApi, kept);
  if (!Object.values(kept).some((e) => !isTerminal(e.state))) {
    try { await chromeApi.alarms?.clear(CRAWL_ALARM); } catch {}
  }
  return updateBadge(chromeApi, kept, now);
}
