// The popup's stages and the docs index: loader → copied → content, the
// three package sources (index, shared skill, local), and crawl requests
// (waiting, "Copy this page now", fallbacks, resuming after a reopen, and the
// service worker's badge). The real popup.js runs against a mock of the
// library's contract (helpers/mock-library.js) with chrome.* stubbed.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { parseHTML, DOMParser } from 'linkedom';
import { startMockLibrary, packageFor } from './helpers/mock-library.js';
import { sleep, stageLog, timing } from '../extension/lib/ux.js';
import { PENDING_KEY, CRAWL_ALARM, READY_TTL_MS, live, progressText, pollPending, rememberCrawl, forgetCrawl, updateBadge } from '../extension/lib/crawl.js';
import { createLibrary } from '../extension/lib/library.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const MANIFEST = JSON.parse(read('../extension/manifest.json'));
const GUIDE = read('./fixtures/nav-leak.html');
const SITE = 'docs.example.com';
const PAGE = `https://${SITE}/docs/guide`;

let docs; let docsUrl; let mock;
const realFetch = globalThis.fetch;

before(async () => {
  docs = createServer((req, res) => {
    if (req.url === '/docs/guide' || req.url === '/docs/other') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(GUIDE);
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((r) => docs.listen(0, '127.0.0.1', r));
  docsUrl = `http://127.0.0.1:${docs.address().port}`;
  // docs.example.com is served by the local docs server; api.scoop.md by the mock.
  globalThis.fetch = (url, init) => {
    const s = String(url);
    if (s.startsWith(`https://${SITE}`)) return realFetch(s.replace(`https://${SITE}`, docsUrl), init);
    if (s.startsWith('https://api.scoop.md/v1')) return realFetch(s.replace('https://api.scoop.md/v1', mock.url), init);
    return realFetch(url, init);
  };
});

after(() => { globalThis.fetch = realFetch; docs.close(); mock?.close(); });

beforeEach(() => {
  Object.assign(timing, { loaderMs: 60, celebrateMs: 120, reducedMs: 20, pollMs: 15 });
  stageLog.length = 0;
});

const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out waiting');
};

// Opens the popup on `url`; returns at once (ready resolves when the scoop is done).
async function openPopup(url, { local = {}, share = true, installType = 'development', reduced = false, sync = {}, clipboardFails = false } = {}) {
  const { document } = parseHTML(read('../extension/popup.html'));
  const clipboard = { text: null, writes: [], writeText: async (t) => {
    if (clipboardFails) throw new Error('Document is not focused.');
    clipboard.text = t; clipboard.writes.push({ at: Date.now(), stage: document.body.dataset.stage });
  } };
  // The execCommand fallback in a browser that refuses it too (linkedom has neither select nor execCommand).
  Object.getPrototypeOf(document.createElement('textarea')).select ??= () => {};
  document.execCommand ??= () => false;
  globalThis.getSelection ??= () => null;
  // Every text written to the live regions, in order.
  const writes = { announce: [], 'wait-phase': [] };
  for (const id of Object.keys(writes)) {
    const el = document.getElementById(id);
    let proto = el;
    let found;
    while ((proto = Object.getPrototypeOf(proto)) && !(found = Object.getOwnPropertyDescriptor(proto, 'textContent')));
    Object.defineProperty(el, 'textContent', { get() { return found.get.call(el); }, set(v) { writes[id].push(v); found.set.call(el, v); }, configurable: true });
  }
  // linkedom has no activeElement: record focus calls instead.
  const focused = [];
  for (const id of ['copy', 'copy-now']) document.getElementById(id).focus = () => focused.push(id);
  const badge = { text: null, history: [] };
  const alarms = {};
  globalThis.document = document;
  globalThis.DOMParser = DOMParser;
  globalThis.matchMedia = (q) => ({ matches: q.includes('reduced-motion') ? reduced : false });
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true });
  local.devLibraryUrl ??= mock.url;
  local.telemetryNoticeShown ??= true;
  globalThis.chrome = {
    storage: {
      sync: {
        get: async (defaults) => ({ ...(typeof defaults === 'object' ? defaults : {}), share, ...sync }),
        remove: async () => {},
        set: async (o) => Object.assign(sync, o),
      },
      local: {
        get: async (key) => (typeof key === 'string' ? (key in local ? { [key]: local[key] } : {}) : { ...local }),
        set: async (o) => { Object.assign(local, structuredClone(o)); },
        remove: async (keys) => { for (const k of [keys].flat()) delete local[k]; },
      },
    },
    tabs: { query: async () => [{ id: 1, url, title: 'Guide' }] },
    scripting: { executeScript: async () => [{ result: '<html><body><main><h1>Private</h1><p>Only for you.</p></main></body></html>' }] },
    runtime: { getManifest: () => MANIFEST, openOptionsPage() {}, setUninstallURL: async () => {} },
    management: { getSelf: async () => ({ installType }) },
    alarms: { create: (name, info) => { alarms[name] = info; }, clear: async (name) => { delete alarms[name]; return true; }, get: async (name) => alarms[name] },
    action: { setBadgeText: async ({ text }) => { badge.text = text; badge.history.push(text); }, setBadgeBackgroundColor: async () => {} },
  };
  const popup = await import(`../extension/popup.js?${Math.random()}`);
  const $ = (id) => document.getElementById(id);
  return { $, clipboard, badge, alarms, local, document, focused, writes, ready: popup.ready };
}

const posts = (path) => mock.log.filter((e) => e.method === 'POST' && e.path === path);
const gets = (prefix) => mock.log.filter((e) => e.method === 'GET' && e.path.startsWith(prefix));
const stages = () => stageLog.map((s) => s.name);
const queued = (local, name) => (local.telemetryQueue ?? []).filter((e) => e.name === name).map((e) => e.props);

async function withMock(opts, fn) {
  mock = await startMockLibrary(opts);
  try { return await fn(); } finally { mock.close(); }
}

test('the loader stays at least loaderMs, the copy lands before the copied moment, then the content is revealed', () => withMock({ sites: { [SITE]: { status: 'not_devtool' } } }, async () => {
  timing.loaderMs = 300;
  const p = await openPopup(PAGE);
  await p.ready;
  assert.deepEqual(stages(), ['loading', 'copied', 'content']);
  const [loading, copiedStage, content] = stageLog;
  assert.ok(copiedStage.at - loading.at >= 290, `loader shown for ${copiedStage.at - loading.at} ms`);
  assert.equal(p.clipboard.writes.length, 1);
  assert.equal(p.clipboard.writes[0].stage, 'loading', 'copied while the loader was still up');
  assert.ok(p.clipboard.writes[0].at <= copiedStage.at);
  assert.ok(content.at - copiedStage.at >= timing.celebrateMs - 10);
  await sleep(80);
  assert.equal(p.$('announce').textContent, 'Copied. Paste it into your agent.', 'announced with the status text');
  assert.deepEqual(p.writes.announce, ['', 'Copied. Paste it into your agent.'], 'cleared first, so a repeat is announced again');
  assert.deepEqual(p.focused, ['copy'], 'focus moves to the Copy button');
  assert.equal(p.$('content').hidden, false);
  assert.ok(p.$('content').classList.contains('reveal'));
  assert.equal(p.$('loader').hidden, true);
  assert.equal(p.$('copied-stage').hidden, true);
  assert.deepEqual(queued(p.local, 'copied_animation_shown'), [{ reducedMotion: false }]);
}));

test('reduced motion: a short, still moment instead of the animation', () => withMock({ sites: { [SITE]: { status: 'not_devtool' } } }, async () => {
  Object.assign(timing, { celebrateMs: 400, reducedMs: 20 });
  const p = await openPopup(PAGE, { reduced: true });
  await p.ready;
  const copiedAt = stageLog.find((s) => s.name === 'copied').at;
  const contentAt = stageLog.find((s) => s.name === 'content').at;
  assert.equal(p.document.body.dataset.motion, 'reduced');
  assert.ok(contentAt - copiedAt < 200, `held ${contentAt - copiedAt} ms`);
  assert.deepEqual(queued(p.local, 'copied_animation_shown'), [{ reducedMotion: true }]);
  // The stylesheet turns the motion off for these users.
  assert.match(read('../extension/popup.css'), /@media \(prefers-reduced-motion: reduce\)[\s\S]*#copied-stage:not\(\[hidden\]\) \.doc[^}]*animation: none/);
}));

test('indexed site: the page-anchored package from the index, nothing crawled', () => withMock({ sites: { [SITE]: { indexed: true, status: 'ready' } } }, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  assert.equal(p.clipboard.text, packageFor(SITE, PAGE));
  assert.match(p.$('summary').textContent, /KB · from the docs\.example\.com docs index$/);
  const pkg = gets('/v1/packages');
  assert.equal(pkg.length, 1);
  assert.deepEqual(pkg[0].query, { site: SITE, url: PAGE });
  assert.equal(posts('/v1/crawl-requests').length, 0);
  assert.equal(posts('/v1/skills').length, 0, 'an index package is not shared back');
  const result = queued(p.local, 'scoop_result')[0];
  assert.deepEqual(result.sourceKinds, ['index']);
  assert.equal(result.indexHit, true);
}));

const SKILL = {
  id: 'sk_shared', site: SITE, pageUrl: `https://${SITE}/docs/other`, worked: 4, failed: 0, relatedLinks: [],
  sections: [{ kind: 'page-md', label: 'This page: Other', url: `https://${SITE}/docs/other.md`, content: '# Other\n\nShared skill text.' }],
};

test('not indexed (empty) but shared: the library skill, no crawl', () => withMock({ skill: SKILL, sites: { [SITE]: { status: 'empty' } } }, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  assert.match(p.clipboard.text, /Shared skill text\./);
  assert.match(p.$('summary').textContent, /shared, worked for 4 people$/);
  assert.equal(p.$('feedback').hidden, false);
  assert.equal(posts('/v1/crawl-requests').length, 0);
  assert.equal(gets('/v1/packages').length, 0);
}));

test('never-seen site with a shared skill: the skill now, a crawl requested in the background', () => withMock({ skill: SKILL, sites: { [SITE]: {} } }, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  assert.match(p.clipboard.text, /Shared skill text\./);
  await waitFor(() => p.local[PENDING_KEY]?.[SITE]);
  assert.equal(posts('/v1/crawl-requests').length, 1);
  assert.equal(p.local[PENDING_KEY][SITE].state, 'queued');
  assert.equal(p.badge.text, '…');
  assert.ok(p.alarms[CRAWL_ALARM], 'the service worker will follow it');
}));

test('not developer docs: built here as before, no crawl request', () => withMock({ sites: { [SITE]: { status: 'not_devtool' } } }, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  assert.match(p.clipboard.text, /# Get started with Widgets/);
  assert.match(p.$('summary').textContent, /1 source on docs\.example\.com$/);
  assert.equal(posts('/v1/crawl-requests').length, 0);
  assert.equal(posts('/v1/skills').length, 1, 'shared as before');
}));

test('crawl lifecycle: queued → running → indexing → complete delivers the page-anchored package', () => withMock({ sites: { [SITE]: {} } }, async () => {
  const labels = [];
  mock.close();
  mock = await startMockLibrary({
    sites: { [SITE]: {} },
    onRequest: (e) => { if (e.method === 'GET' && e.path.startsWith('/v1/crawl-requests/')) labels.push(globalThis.document.getElementById('wait-phase').textContent); },
  });
  const p = await openPopup(PAGE);
  await p.ready;
  assert.equal(posts('/v1/crawl-requests').length, 1);
  assert.deepEqual(posts('/v1/crawl-requests')[0].body, { url: PAGE });
  assert.ok(posts('/v1/crawl-requests')[0].install, 'sent with the install ID');
  assert.deepEqual(stages(), ['loading', 'waiting', 'loading', 'copied', 'content'], 'back to the loader while the package is fetched');
  assert.equal(p.$('copy-now').disabled, true, 'no second copy once the crawl completed');
  assert.equal(p.$('wait-phase').getAttribute('aria-live'), 'polite');
  for (const l of ['Waiting for a crawler', "Checking it's developer docs", 'Finding the docs', 'Reading the docs', 'Indexing']) {
    assert.ok(labels.includes(l), `showed "${l}" (saw ${JSON.stringify(labels)})`);
  }
  const phases = p.writes['wait-phase'];
  assert.ok(phases.every((t, i) => i === 0 || t !== phases[i - 1]), `written only when it changes: ${JSON.stringify(phases)}`);
  assert.ok(phases.every((t) => !/\d/.test(t)), 'no counts in the live phase line');
  assert.equal(p.clipboard.text, packageFor(SITE, PAGE));
  assert.equal(p.local[PENDING_KEY][SITE], undefined, 'delivered: nothing left pending');
  assert.equal(p.badge.text, '');
  assert.deepEqual(queued(p.local, 'crawl_request'), [{ site: SITE, state: 'queued' }]);
  const [wait] = queued(p.local, 'crawl_wait');
  assert.equal(wait.outcome, 'complete');
  assert.ok(wait.durationMs >= 0);
}));

for (const [crawl, note, state] of [
  ['rejected', "This doesn't look like developer docs, so we copied just this page.", 'rejected'],
  ['failed', "We couldn't read the docs for docs.example.com, so we copied just this page.", 'failed'],
  ['429', 'The docs index is busy right now, so we copied just this page.', 'rate_limited'],
]) {
  test(`crawl request ${crawl}: this page is copied, with a short note`, () => withMock({ sites: { [SITE]: { crawl } } }, async () => {
    const p = await openPopup(PAGE);
    await p.ready;
    assert.match(p.clipboard.text, /# Get started with Widgets/);
    assert.equal(p.$('crawl-note').textContent, note);
    assert.equal(p.$('crawl-note').hidden, false);
    assert.ok(!stages().includes('waiting'));
    assert.deepEqual(queued(p.local, 'crawl_request'), [{ site: SITE, state }]);
    assert.equal(p.local[PENDING_KEY], undefined);
  }));
}

test('rejected while waiting: this page is copied with the gentle note', () => withMock({
  sites: { [SITE]: { steps: [{ state: 'queued', phase: 'gate' }, { state: 'running', phase: 'gate' }, { state: 'rejected', phase: 'gate', reason: 'not_devtool' }] } },
}, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  assert.match(p.clipboard.text, /# Get started with Widgets/);
  assert.equal(p.$('crawl-note').textContent, "This doesn't look like developer docs, so we copied just this page.");
  assert.equal(queued(p.local, 'crawl_wait')[0].outcome, 'rejected');
  assert.equal(p.local[PENDING_KEY][SITE], undefined);
}));

test('"Copy this page now" copies at once; the crawl carries on in the background', () => withMock({ sites: { [SITE]: { hold: true } } }, async () => {
  const p = await openPopup(PAGE);
  await waitFor(() => p.document.body.dataset.stage === 'waiting' && gets('/v1/crawl-requests/').length >= 2);
  assert.equal(p.clipboard.text, null, 'nothing copied while waiting');
  p.$('copy-now').onclick();
  await p.ready;
  assert.match(p.clipboard.text, /# Get started with Widgets/);
  assert.match(p.$('crawl-note').textContent, /still figuring out the docs for docs\.example\.com/);
  assert.equal(p.document.body.dataset.stage, 'content', JSON.stringify(stageLog));
  assert.notEqual(p.local[PENDING_KEY][SITE].state, 'complete');
  assert.equal(p.badge.text, '…');
  assert.equal(queued(p.local, 'crawl_wait')[0].outcome, 'copied_page');
  const polls = gets('/v1/crawl-requests/').length;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(gets('/v1/crawl-requests/').length, polls, 'the popup stopped polling');
}));

test('reopening after the crawl finished in the background delivers the result', () => withMock({ sites: { [SITE]: { indexed: true } } }, async () => {
  const local = { [PENDING_KEY]: { [SITE]: { requestId: 'cr_9', site: SITE, url: PAGE, state: 'complete', startedAt: Date.now() - 60_000 } } };
  const p = await openPopup(PAGE, { local });
  await p.ready;
  assert.equal(p.clipboard.text, packageFor(SITE, PAGE));
  assert.equal(posts('/v1/crawl-requests').length, 0);
  assert.equal(p.local[PENDING_KEY][SITE], undefined);
  assert.equal(p.badge.text, '');
}));

test('reopening while the crawl still runs resumes the waiting view (no new request)', () => withMock({ sites: { [SITE]: {} } }, async () => {
  const r = mock.newRequest(SITE, PAGE);
  r.advance(); r.advance(); // running, discover
  const local = { [PENDING_KEY]: { [SITE]: { requestId: r.view().id, site: SITE, url: PAGE, state: 'running', startedAt: Date.now() } } };
  const p = await openPopup(PAGE, { local });
  await p.ready;
  assert.equal(posts('/v1/crawl-requests').length, 0);
  assert.ok(stages().includes('waiting'));
  assert.equal(p.clipboard.text, packageFor(SITE, PAGE));
}));

test('service worker: follows a crawl after the popup closed, with the badge, and stops the alarm when done', () => withMock({ sites: { [SITE]: {} } }, async () => {
  const r = mock.newRequest(SITE, PAGE);
  const local = { devLibraryUrl: mock.url };
  const badge = [];
  const alarms = {};
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  globalThis.chrome = {
    storage: {
      local: { get: async (k) => (typeof k === 'string' ? (k in local ? { [k]: local[k] } : {}) : { ...local }), set: async (o) => { Object.assign(local, structuredClone(o)); }, remove: async (ks) => { for (const k of [ks].flat()) delete local[k]; } },
      sync: { get: async (d) => ({ ...d, telemetry: false }) },
      onChanged: on('storage'),
    },
    runtime: { getManifest: () => MANIFEST, onInstalled: on('installed'), onStartup: on('startup'), setUninstallURL: async () => {} },
    management: { getSelf: async () => ({ installType: 'development' }) },
    alarms: { create: (n, i) => { alarms[n] = i; }, clear: async (n) => { delete alarms[n]; return true; }, get: async (n) => alarms[n], onAlarm: on('alarm') },
    action: { setBadgeText: async ({ text }) => { badge.push(text); }, setBadgeBackgroundColor: async () => {} },
  };
  await import(`../extension/background.js?${Math.random()}`);
  await rememberCrawl(globalThis.chrome, { requestId: r.view().id, site: SITE, url: PAGE, state: 'queued' });
  assert.ok(alarms[CRAWL_ALARM], 'polled every 30 s');
  assert.equal(alarms[CRAWL_ALARM].periodInMinutes, 0.5);
  assert.equal(badge.at(-1), '…');
  for (let i = 0; i < 8 && local[PENDING_KEY][SITE].state !== 'complete'; i++) {
    listeners.alarm({ name: CRAWL_ALARM });
    const before = mock.log.length;
    await waitFor(() => mock.log.length > before);
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.equal(local[PENDING_KEY][SITE].state, 'complete');
  assert.equal(badge.at(-1), '✓');
  assert.equal(alarms[CRAWL_ALARM], undefined, 'nothing running: the alarm stops');
  await forgetCrawl(globalThis.chrome, SITE);
  assert.equal(badge.at(-1), '');
}));

test('pollPending drops failed and expired requests and clears the badge', async () => {
  const local = {};
  const badge = [];
  const chromeApi = {
    storage: { local: { get: async (k) => (k in local ? { [k]: local[k] } : {}), set: async (o) => Object.assign(local, structuredClone(o)) } },
    alarms: { create() {}, clear: async () => true },
    action: { setBadgeText: async ({ text }) => badge.push(text), setBadgeBackgroundColor: async () => {} },
  };
  const now = Date.now();
  local[PENDING_KEY] = {
    'a.example.com': { requestId: 'cr_a', site: 'a.example.com', state: 'running', startedAt: now },
    'b.example.com': { requestId: 'cr_b', site: 'b.example.com', state: 'running', startedAt: now - 3 * 3_600_000 },
  };
  const library = { crawlRequest: async () => ({ ok: true, status: 200, data: { state: 'failed', phase: 'fetch' } }) };
  assert.equal(await pollPending(chromeApi, library, now), '');
  assert.deepEqual(local[PENDING_KEY], {});
});

test('no crawl request, status or package lookup for pages on private hosts (store install)', () => withMock({ sites: {} }, async () => {
  const p = await openPopup(`${docsUrl}/docs/guide`, { installType: 'normal' });
  await p.ready;
  assert.match(p.clipboard.text, /# Get started with Widgets/);
  assert.equal(mock.log.length, 0, `nothing reached the library: ${JSON.stringify(mock.log.map((e) => e.path))}`);
}));

test('no crawl request or package lookup for a page that only renders signed in', () => withMock({ sites: { [SITE]: {} } }, async () => {
  const p = await openPopup(`https://${SITE}/docs/missing`);
  await p.ready;
  assert.match(p.clipboard.text, /# Private/);
  assert.equal(posts('/v1/crawl-requests').length, 0);
  assert.equal(gets('/v1/packages').length, 0);
}));

test('sharing off: no crawl request (asking for one contributes, like sharing)', () => withMock({ sites: { [SITE]: {} } }, async () => {
  const p = await openPopup(PAGE, { share: false });
  await p.ready;
  assert.match(p.clipboard.text, /# Get started with Widgets/);
  assert.equal(posts('/v1/crawl-requests').length, 0);
}));

test('progressText: friendly labels, counts and how far along', () => {
  assert.deepEqual(progressText({ state: 'queued', etaSeconds: 150 }), { label: 'Waiting for a crawler', count: 'About 3 minutes', fraction: null });
  assert.equal(progressText({ state: 'running', phase: 'gate' }).label, "Checking it's developer docs");
  assert.deepEqual(progressText({ state: 'running', phase: 'browser', pagesFound: 1 }), { label: 'Reading the docs', count: '1 page found', fraction: null });
  assert.deepEqual(progressText({ state: 'running', phase: 'discover', pagesFound: 30 }), { label: 'Finding the docs', count: '30 pages found', fraction: null });
  assert.deepEqual(progressText({ state: 'indexing', phase: 'index', pagesFound: 40, pagesIndexed: 10 }), { label: 'Indexing', count: '10 of 40 pages indexed', fraction: 0.25 });
  assert.equal(progressText({ state: 'indexing', phase: 'index', pagesFound: 3, pagesIndexed: 0 }).fraction, null, 'an empty bar looks stuck');
});

test('library client: the index calls follow the contract', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/packages')) return new Response('# pkg', { status: 200, headers: { 'content-type': 'text/markdown' } });
    if (url.endsWith('/crawl-requests')) return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow' } }), { status: 429, headers: { 'retry-after': '30' } });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const lib = createLibrary({ baseUrl: 'https://api.scoop.md/v1', installId: 'i', client: 'extension/0.4.0', fetchImpl });
  assert.deepEqual(await lib.pagePackage(SITE, `${PAGE}?a=b`), { ok: true, status: 200, data: '# pkg' });
  assert.equal(calls[0].url, `https://api.scoop.md/v1/packages?site=${SITE}&url=${encodeURIComponent(`${PAGE}?a=b`)}`);
  const refused = await lib.requestCrawl(PAGE);
  assert.equal(refused.status, 429);
  assert.equal(refused.retryAfter, 30);
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers['x-scoop-install'], 'i');
  assert.deepEqual(JSON.parse(calls[1].init.body), { url: PAGE });
  await lib.siteStatus(SITE);
  await lib.crawlRequest('cr_1');
  assert.equal(calls[2].url, `https://api.scoop.md/v1/sites/${SITE}/status`);
  assert.equal(calls[3].url, 'https://api.scoop.md/v1/crawl-requests/cr_1');
});

test('a failed copy is announced with the status text too, with no copied moment', () => withMock({ sites: { [SITE]: { status: 'not_devtool' } } }, async () => {
  const p = await openPopup(PAGE, { clipboardFails: true });
  await p.ready;
  assert.equal(p.$('status').textContent, 'Ready. Click Copy to put it on your clipboard.');
  await sleep(80);
  assert.equal(p.$('announce').textContent, 'Ready. Click Copy to put it on your clipboard.');
  assert.ok(!stages().includes('copied'));
  assert.deepEqual(p.focused, ['copy']);
}));

test('waiting is announced once; phases are announced by the live phase line', () => withMock({ sites: { [SITE]: { hold: true } } }, async () => {
  const p = await openPopup(PAGE);
  await waitFor(() => p.document.body.dataset.stage === 'waiting' && p.$('announce').textContent);
  assert.equal(p.$('announce').textContent, 'Figuring out the docs for docs.example.com…');
  assert.equal(p.$('wait-phase').getAttribute('aria-live'), 'polite');
  p.$('copy-now').onclick();
  await p.ready;
}));

test('a pending crawl that completed but whose package is missing asks /packages once, then builds here', () => withMock({ sites: { [SITE]: { indexed: true, packages404: true } } }, async () => {
  const local = { [PENDING_KEY]: { [SITE]: { requestId: 'cr_9', site: SITE, url: PAGE, state: 'complete', startedAt: Date.now(), updatedAt: Date.now() } } };
  const p = await openPopup(PAGE, { local });
  await p.ready;
  assert.equal(gets('/v1/packages').length, 1);
  assert.match(p.clipboard.text, /# Get started with Widgets/);
}));

test('two popups on one site: one crawl request, one tracked entry', () => withMock({ sites: { [SITE]: { hold: true } } }, async () => {
  const first = await openPopup(PAGE);
  await waitFor(() => first.document.body.dataset.stage === 'waiting');
  first.$('copy-now').onclick();
  await first.ready;
  const second = await openPopup(PAGE, { local: first.local });
  await waitFor(() => second.document.body.dataset.stage === 'waiting');
  second.$('copy-now').onclick();
  await second.ready;
  assert.equal(posts('/v1/crawl-requests').length, 1, 'the second popup resumed the first one');
  assert.deepEqual(Object.keys(second.local[PENDING_KEY]), [SITE]);
  // And if both had asked, the server answers with the same request: still one entry.
  const lib = createLibrary({ baseUrl: mock.url, installId: 'x', client: 't' });
  const [a, b] = await Promise.all([lib.requestCrawl(PAGE), lib.requestCrawl(PAGE)]);
  assert.equal(a.data.id, b.data.id);
  const chromeApi = { storage: { local: { get: async (k) => ({ [k]: second.local[k] }), set: async (o) => Object.assign(second.local, structuredClone(o)) } }, alarms: { create() {} }, action: {} };
  await rememberCrawl(chromeApi, { requestId: a.data.id, site: SITE, url: PAGE, state: a.data.state });
  await rememberCrawl(chromeApi, { requestId: b.data.id, site: SITE, url: PAGE, state: b.data.state });
  assert.equal(Object.keys(second.local[PENDING_KEY]).length, 1);
}));

test('a ✓ nobody picked up expires; a running request past its time is dropped', async () => {
  const now = Date.now();
  const pending = {
    'a.example.com': { state: 'complete', updatedAt: now - READY_TTL_MS - 1 },
    'b.example.com': { state: 'running', startedAt: now - 3 * 3_600_000 },
    'c.example.com': { state: 'complete', updatedAt: now },
  };
  assert.deepEqual(Object.keys(live(pending, now)), ['c.example.com']);
  const badge = [];
  const chromeApi = { action: { setBadgeText: async ({ text }) => badge.push(text), setBadgeBackgroundColor: async () => {} } };
  assert.equal(await updateBadge(chromeApi, { 'a.example.com': pending['a.example.com'] }, now), '');
  assert.equal(await updateBadge(chromeApi, { 'c.example.com': pending['c.example.com'] }, now), '✓');
});

test('pollPending merges into what is stored now: an entry the popup delivered meanwhile stays gone', async () => {
  const local = { [PENDING_KEY]: { 'a.example.com': { requestId: 'cr_a', site: 'a.example.com', state: 'running', startedAt: Date.now() } } };
  const chromeApi = {
    storage: { local: { get: async (k) => ({ [k]: structuredClone(local[k]) }), set: async (o) => Object.assign(local, structuredClone(o)) } },
    alarms: { create() {}, clear: async () => true },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
  const library = {
    crawlRequest: async () => {
      // The popup delivers the result while the service worker is still asking.
      delete local[PENDING_KEY]['a.example.com'];
      local[PENDING_KEY]['b.example.com'] = { requestId: 'cr_b', site: 'b.example.com', state: 'queued', startedAt: Date.now() };
      return { ok: true, status: 200, data: { state: 'complete', phase: 'done' } };
    },
  };
  await pollPending(chromeApi, library);
  assert.deepEqual(Object.keys(local[PENDING_KEY]), ['b.example.com'], 'not resurrected, and the new entry kept');
});

test('settings explain that the index lookup still sends the page address with sharing off', () => {
  assert.match(read('../extension/options.html'), /Turning this off stops uploads; looking up this page in the docs index still sends its address\./);
  const privacy = read('../site/src/pages/privacy.astro');
  assert.ok((privacy.match(/whatever the sharing setting/g) ?? []).length >= 2, 'the short version and the index section');
  assert.match(privacy, /Turn sharing off[^<]*still sent to look it up in the index/);
});

test('service worker: the hourly alarm clears a ✓ nobody picked up', () => withMock({ sites: {} }, async () => {
  const local = { devLibraryUrl: mock.url, [PENDING_KEY]: { [SITE]: { requestId: 'cr_old', site: SITE, url: PAGE, state: 'complete', startedAt: 0, updatedAt: Date.now() - READY_TTL_MS - 60_000 } } };
  const badge = [];
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  globalThis.chrome = {
    storage: {
      local: { get: async (k) => (typeof k === 'string' ? (k in local ? { [k]: local[k] } : {}) : { ...local }), set: async (o) => { Object.assign(local, structuredClone(o)); }, remove: async () => {} },
      sync: { get: async (d) => ({ ...d, telemetry: false }) },
      onChanged: on('storage'),
    },
    runtime: { getManifest: () => MANIFEST, onInstalled: on('installed'), onStartup: on('startup'), setUninstallURL: async () => {} },
    management: { getSelf: async () => ({ installType: 'development' }) },
    alarms: { create() {}, clear: async () => true, get: async () => ({}), onAlarm: on('alarm') },
    action: { setBadgeText: async ({ text }) => { badge.push(text); }, setBadgeBackgroundColor: async () => {} },
  };
  await import(`../extension/background.js?${Math.random()}`);
  listeners.alarm({ name: 'telemetry-hourly' });
  await waitFor(() => badge.length);
  assert.equal(badge.at(-1), '');
  assert.deepEqual(local[PENDING_KEY], {});
}));
