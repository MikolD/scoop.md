// The popup (0.5.0): loader → copied → content with the best package right
// away (index, shared skill, or the instant build: the page plus /quick
// sources), indexing in the background with "Upgrade to full docs", the
// Overview and Search tabs, and the service worker: crawl follow-up and the
// per-tab docs-count badge. The real popup.js and background.js run against a
// mock of the library's contract (helpers/mock-library.js), chrome.* stubbed.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { parseHTML, DOMParser } from 'linkedom';
import { startMockLibrary, packageFor } from './helpers/mock-library.js';
import { sleep, stageLog, timing } from '../extension/lib/ux.js';
import { PENDING_KEY, CRAWL_ALARM, READY_TTL_MS, live, progressText, pollPending, rememberCrawl, forgetCrawl } from '../extension/lib/crawl.js';
import { SITES_KEY, SITES_ALARM, badgeFor, compactCount, refreshSites } from '../extension/lib/badge.js';
import { createLibrary } from '../extension/lib/library.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const MANIFEST = JSON.parse(read('../extension/manifest.json'));
const GUIDE = read('./fixtures/nav-leak.html');
const SITE = 'docs.example.com';
const PAGE = `https://${SITE}/docs/guide`;
// A docs subdomain the server's /quick finds for SITE (served by the docs server under /sub).
const SUB = 'docs.example.org';

let docs; let docsUrl; let mock;
let failPackages = false;
let packageAttempts = 0;
const realFetch = globalThis.fetch;

before(async () => {
  docs = createServer((req, res) => {
    if (req.url === '/docs/guide' || req.url === '/docs/other') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(GUIDE);
    }
    if (req.url === '/sub/guide.md') {
      res.writeHead(200, { 'content-type': 'text/markdown' });
      return res.end('# Guide (Markdown twin)\n\nThe Markdown version of the guide, from the docs subdomain.\n');
    }
    if (req.url === '/sub/llms.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('# Example docs\n\n> The llms.txt index of the example docs.\n\n- [Guide](https://docs.example.org/guide.md)\n');
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((r) => docs.listen(0, '127.0.0.1', r));
  docsUrl = `http://127.0.0.1:${docs.address().port}`;
  // docs.example.com is served by the local docs server; api.scoop.md by the mock.
  globalThis.fetch = (url, init) => {
    const s = String(url);
    if (s.startsWith(`https://${SITE}`)) return realFetch(s.replace(`https://${SITE}`, docsUrl), init);
    if (s.startsWith(`https://${SUB}`)) return realFetch(s.replace(`https://${SUB}`, `${docsUrl}/sub`), init);
    if (s.startsWith('https://api.scoop.md/v1')) return realFetch(s.replace('https://api.scoop.md/v1', mock.url), init);
    if (s.includes('/v1/packages')) packageAttempts++;
    if (failPackages && s.includes('/v1/packages')) return Promise.reject(new TypeError('Failed to fetch'));
    return realFetch(url, init);
  };
});

after(() => { globalThis.fetch = realFetch; docs.close(); mock?.close(); });

beforeEach(() => {
  failPackages = false;
  packageAttempts = 0;
  Object.assign(timing, { loaderMs: 60, celebrateMs: 120, reducedMs: 20, packageRetryMs: [10, 20, 40], followMs: 15, searchDebounceMs: 10 });
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
  const writes = { announce: [] };
  for (const id of Object.keys(writes)) {
    const el = document.getElementById(id);
    let proto = el;
    let found;
    while ((proto = Object.getPrototypeOf(proto)) && !(found = Object.getOwnPropertyDescriptor(proto, 'textContent')));
    Object.defineProperty(el, 'textContent', { get() { return found.get.call(el); }, set(v) { writes[id].push(v); found.set.call(el, v); }, configurable: true });
  }
  // linkedom has no activeElement: record focus calls instead.
  const focused = [];
  for (const id of ['copy', 'copy-overview', 'copy-selected', 'tab-page', 'tab-overview', 'tab-search', 'search-q']) document.getElementById(id).focus = () => focused.push(id);
  const badge = { text: null, history: [], titles: [] };
  const alarms = {};
  globalThis.document = document;
  globalThis.DOMParser = DOMParser;
  globalThis.matchMedia = (q) => ({ matches: q.includes('reduced-motion') ? reduced : false });
  const beacons = [];
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard, sendBeacon: (url, blob) => { beacons.push(blob); return true; } }, configurable: true });
  // Node has no window events: collect the popup's (pagehide) to fire them by hand.
  const windowListeners = {};
  globalThis.addEventListener = (type, fn) => { windowListeners[type] = fn; };
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
    tabs: { query: async () => [{ id: 1, url, title: 'Guide' }], get: async () => ({ id: 1, url }) },
    scripting: { executeScript: async () => [{ result: '<html><body><main><h1>Private</h1><p>Only for you.</p></main></body></html>' }] },
    runtime: { getManifest: () => MANIFEST, openOptionsPage() {}, setUninstallURL: async () => {} },
    management: { getSelf: async () => ({ installType }) },
    alarms: { create: (name, info) => { alarms[name] = info; }, clear: async (name) => { delete alarms[name]; return true; }, get: async (name) => alarms[name] },
    action: {
      setBadgeText: async ({ text }) => { badge.text = text; badge.history.push(text); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async ({ title }) => { badge.titles.push(title); },
    },
  };
  const popup = await import(`../extension/popup.js?${Math.random()}`);
  const $ = (id) => document.getElementById(id);
  return { $, clipboard, badge, alarms, local, document, focused, writes, beacons, windowListeners, ready: popup.ready };
}

const posts = (path) => mock.log.filter((e) => e.method === 'POST' && e.path === path);
const gets = (prefix) => mock.log.filter((e) => e.method === 'GET' && e.path.startsWith(prefix));
const stages = () => stageLog.map((s) => s.name);
const queued = (local, name) => (local.telemetryQueue ?? []).filter((e) => e.name === name).map((e) => e.props);

async function withMock(opts, fn) {
  mock = await startMockLibrary(opts);
  try { return await fn(); } finally { mock.close(); }
}

const SKILL = {
  id: 'sk_shared', site: SITE, pageUrl: `https://${SITE}/docs/other`, worked: 4, failed: 0, relatedLinks: [],
  sections: [{ kind: 'page-md', label: 'This page: Other', url: `https://${SITE}/docs/other.md`, content: '# Other\n\nShared skill text.' }],
};


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
  assert.equal(p.$('announce').textContent, 'Copied. Paste it into your agent.');
  assert.deepEqual(p.writes.announce, ['', 'Copied. Paste it into your agent.']);
  assert.deepEqual(p.focused, ['copy']);
  assert.equal(p.$('content').hidden, false);
  assert.equal(p.$('tabs').hidden, false, 'the tabs show with the content');
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
  assert.match(read('../extension/popup.css'), /@media \(prefers-reduced-motion: reduce\)[\s\S]*#copied-stage:not\(\[hidden\]\) \.doc[^}]*animation: none/);
}));

test('a failed copy is announced with the status text, with no copied moment', () => withMock({ sites: { [SITE]: { status: 'not_devtool' } } }, async () => {
  const p = await openPopup(PAGE, { clipboardFails: true });
  await p.ready;
  await sleep(80);
  assert.equal(p.$('announce').textContent, 'Ready. Click Copy to put it on your clipboard.');
  assert.ok(!stages().includes('copied'));
}));

test('(a) indexed site: the page-anchored package from the index; nothing crawled', () => withMock({ sites: { [SITE]: { indexed: true, status: 'ready' } } }, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  assert.equal(p.clipboard.text, packageFor(SITE, PAGE));
  assert.match(p.$('summary').textContent, /KB · from the docs\.example\.com docs index$/);
  assert.deepEqual(gets('/v1/packages')[0].query, { site: SITE, url: PAGE });
  assert.equal(posts('/v1/crawl-requests').length, 0);
  assert.equal(gets('/v1/quick').length, 0, 'no instant lookup when the index answers');
  const result = queued(p.local, 'scoop_result')[0];
  assert.deepEqual(result.sourceKinds, ['index']);
  assert.equal(result.indexHit, true);
}));

test('(b) not indexed but shared: the library skill now, and indexing in the background', () => withMock({ skill: SKILL, sites: { [SITE]: { hold: true } } }, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  assert.match(p.clipboard.text, /Shared skill text\./);
  assert.match(p.$('summary').textContent, /shared, worked for 4 people$/);
  await waitFor(() => p.local[PENDING_KEY]?.[SITE]);
  assert.equal(posts('/v1/crawl-requests').length, 1);
  assert.equal(p.$('crawl-note').textContent, "Indexing all of docs.example.com's docs in the background. The icon shows ✓ when it's ready.");
  assert.equal(p.badge.text, '…');
}));

test('(c) instant: the page plus /quick sources (a .md twin on docs.<domain> replaces the converted HTML), and background indexing', () => withMock({
  sites: { [SITE]: { hold: true, quick: [
    { kind: 'page-md', url: `https://${SUB}/guide.md`, label: 'This page: Guide', bytes: 80 },
    { kind: 'llms', url: `https://${SUB}/llms.txt`, label: 'Site documentation index (llms.txt)', bytes: 120 },
  ] } },
}, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  assert.deepEqual(stages(), ['loading', 'copied', 'content'], 'no waiting view');
  assert.match(p.clipboard.text, /The Markdown version of the guide, from the docs subdomain\./);
  assert.match(p.clipboard.text, /The llms\.txt index of the example docs\./);
  assert.ok(!p.clipboard.text.includes('Get started with Widgets'), 'the .md twin replaced the converted HTML');
  assert.match(p.$('summary').textContent, /2 sources on docs\.example\.com$/);
  assert.deepEqual(gets('/v1/quick')[0].query, { url: PAGE });
  await waitFor(() => posts('/v1/crawl-requests').length === 1);
  assert.equal(p.$('crawl-note').textContent, "Indexing all of docs.example.com's docs in the background. The icon shows ✓ when it's ready.");
  // Only the local build is shared (sources on another host would not match the site).
  const shared = posts('/v1/skills')[0]?.body;
  assert.ok(shared && shared.sections.every((s) => new URL(s.url).hostname === SITE));
}));

test('(c) the library is down: the local build alone, quietly', () => withMock({ sites: { [SITE]: {} } }, async () => {
  const p = await openPopup(PAGE, { local: { devLibraryUrl: 'http://localhost:9/v1' } });
  await p.ready;
  assert.match(p.clipboard.text, /# Get started with Widgets/);
  assert.equal(p.$('crawl-note').textContent, '');
}));

test('not developer docs (status not_devtool): instant copy, no crawl request', () => withMock({ sites: { [SITE]: { status: 'not_devtool' } } }, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  assert.match(p.clipboard.text, /# Get started with Widgets/);
  await sleep(30);
  assert.equal(posts('/v1/crawl-requests').length, 0);
  assert.equal(p.$('crawl-note').textContent, '');
}));

test('the background crawl completes while the popup is open: "Upgrade to full docs" copies the index', () => withMock({ sites: { [SITE]: {} } }, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  assert.match(p.clipboard.text, /# Get started with Widgets/);
  await waitFor(() => !p.$('upgrade').hidden);
  assert.equal(p.$('crawl-note').textContent, 'The full docs for docs.example.com are ready.');
  stageLog.length = 0;
  await p.$('upgrade').onclick();
  assert.equal(p.clipboard.text, packageFor(SITE, PAGE));
  assert.deepEqual(stages(), ['loading', 'copied', 'content']);
  assert.equal(p.$('crawl-note').textContent, 'Upgraded to the full docs for docs.example.com.');
  assert.equal(p.local[PENDING_KEY][SITE], undefined);
}));

test('reopening after the crawl finished in the background: the full docs, and the ✓ clears', () => withMock({ sites: { [SITE]: { indexed: true } } }, async () => {
  const local = { [PENDING_KEY]: { [SITE]: { requestId: 'cr_9', site: SITE, url: PAGE, state: 'complete', startedAt: Date.now() - 60_000, updatedAt: Date.now() } } };
  const p = await openPopup(PAGE, { local });
  await p.ready;
  assert.equal(p.clipboard.text, packageFor(SITE, PAGE));
  assert.equal(p.$('crawl-note').textContent, 'Upgraded to the full docs for docs.example.com.');
  assert.equal(p.local[PENDING_KEY][SITE], undefined);
  assert.notEqual(p.badge.text, '✓');
}));

test('reopening while the crawl still runs: instant copy, no new request, the quiet line', () => withMock({ sites: { [SITE]: { hold: true } } }, async () => {
  const r = mock.newRequest(SITE, PAGE);
  r.advance();
  const local = { [PENDING_KEY]: { [SITE]: { requestId: r.view().id, site: SITE, url: PAGE, state: 'running', startedAt: Date.now() } } };
  const p = await openPopup(PAGE, { local });
  await p.ready;
  assert.match(p.clipboard.text, /# Get started with Widgets/);
  assert.equal(posts('/v1/crawl-requests').length, 0);
  assert.ok(!stages().includes('waiting'));
  assert.match(p.$('crawl-note').textContent, /in the background/);
}));

test('reopening while the crawl runs on an already-indexed site: the index, marked delivered (no ✓ later)', () => withMock({ sites: { [SITE]: { indexed: true } } }, async () => {
  const r = mock.newRequest(SITE, PAGE);
  r.advance();
  const local = { [PENDING_KEY]: { [SITE]: { requestId: r.view().id, site: SITE, url: PAGE, state: 'indexing', startedAt: Date.now() } } };
  const p = await openPopup(PAGE, { local });
  await p.ready;
  assert.equal(p.clipboard.text, packageFor(SITE, PAGE));
  assert.equal(p.local[PENDING_KEY][SITE].delivered, true);
  const lib = createLibrary({ baseUrl: mock.url, installId: 'x', client: 't' });
  for (let i = 0; i < 6 && p.local[PENDING_KEY][SITE]; i++) await pollPending(globalThis.chrome, lib);
  assert.equal(p.local[PENDING_KEY][SITE], undefined);
  assert.ok(!p.badge.history.includes('✓'), 'never ✓ for a crawl already delivered');
}));

test('a completed crawl whose package the index cannot answer yet is retried, then built here', () => withMock({ sites: { [SITE]: { indexed: true, packages404Times: 2 } } }, async () => {
  const local = { [PENDING_KEY]: { [SITE]: { requestId: 'cr_9', site: SITE, url: PAGE, state: 'complete', startedAt: Date.now(), updatedAt: Date.now() } } };
  const p = await openPopup(PAGE, { local });
  await p.ready;
  assert.equal(p.clipboard.text, packageFor(SITE, PAGE));
  assert.equal(gets('/v1/packages').length, 3, 'two 404s, then the package');
}));

test('an unreachable library is retried once, with a short timeout, after a crawl completes', () => withMock({ sites: { [SITE]: { indexed: true } } }, async () => {
  failPackages = true;
  const local = { [PENDING_KEY]: { [SITE]: { requestId: 'cr_9', site: SITE, url: PAGE, state: 'complete', startedAt: Date.now(), updatedAt: Date.now() } } };
  const started = Date.now();
  const p = await openPopup(PAGE, { local, }); 
  await p.ready;
  assert.match(p.clipboard.text, /Get started with Widgets|Markdown twin/);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(packageAttempts, 2, 'the first try and one retry');
}));

test('package retries use a 4 s timeout; the first try keeps the normal one', async () => {
  const realTimeout = AbortSignal.timeout;
  const timeouts = [];
  AbortSignal.timeout = (ms) => { timeouts.push(ms); return realTimeout.call(AbortSignal, ms); };
  try {
    const lib = createLibrary({ baseUrl: 'https://api.scoop.md/v1', installId: 'i', client: 't', fetchImpl: async () => new Response('# p', { status: 200 }) });
    await lib.pagePackage(SITE, PAGE);
    await lib.pagePackage(SITE, PAGE, { timeoutMs: timing.packageRetryTimeoutMs });
  } finally {
    AbortSignal.timeout = realTimeout;
  }
  assert.deepEqual(timeouts, [10_000, 4_000]);
});

test('background crawl request rejected or rate-limited: nothing to say, the page is already copied', () => withMock({ sites: { [SITE]: { crawl: 'rejected' } } }, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  await waitFor(() => queued(p.local, 'crawl_request').length);
  assert.deepEqual(queued(p.local, 'crawl_request'), [{ site: SITE, state: 'rejected' }]);
  assert.equal(p.local[PENDING_KEY], undefined);
  assert.match(p.clipboard.text, /# Get started with Widgets/);
}));

test('no library request at all for pages on private hosts (store install)', () => withMock({ sites: {} }, async () => {
  const p = await openPopup(`${docsUrl}/docs/guide`, { installType: 'normal' });
  await p.ready;
  assert.match(p.clipboard.text, /# Get started with Widgets/);
  await sleep(30);
  assert.equal(mock.log.length, 0, `nothing reached the library: ${JSON.stringify(mock.log.map((e) => e.path))}`);
}));

test('a page that only renders signed in: no crawl, package or instant lookup', () => withMock({ sites: { [SITE]: {} } }, async () => {
  const p = await openPopup(`https://${SITE}/docs/missing`);
  await p.ready;
  assert.match(p.clipboard.text, /# Private/);
  await sleep(30);
  assert.equal(posts('/v1/crawl-requests').length, 0);
  assert.equal(gets('/v1/packages').length, 0);
  assert.equal(gets('/v1/quick').length, 0);
}));

test('sharing off: no crawl request; the instant lookup still runs', () => withMock({ sites: { [SITE]: {} } }, async () => {
  const p = await openPopup(PAGE, { share: false });
  await p.ready;
  await sleep(30);
  assert.equal(posts('/v1/crawl-requests').length, 0);
  assert.equal(gets('/v1/quick').length, 1);
}));

test('two popups on one site: one crawl request, one tracked entry', () => withMock({ sites: { [SITE]: { hold: true } } }, async () => {
  const first = await openPopup(PAGE);
  await first.ready;
  await waitFor(() => first.local[PENDING_KEY]?.[SITE]);
  const second = await openPopup(PAGE, { local: first.local });
  await second.ready;
  assert.equal(posts('/v1/crawl-requests').length, 1);
  assert.deepEqual(Object.keys(second.local[PENDING_KEY]), [SITE]);
}));

// Tabs

const TOPICS = [
  { name: 'guides', path: 'guides', count: 40, children: [{ name: 'webhooks', path: 'guides/webhooks', count: 12, children: [] }] },
  { name: 'api', path: 'api', count: 20, children: [] },
];
const HITS = [
  { url: `https://${SITE}/docs/webhooks`, title: 'Webhooks', heading_path: 'Webhooks > Verify signatures', snippet: 'Verify the signature header…', text: 'Full chunk text about verifying signatures.' },
  { url: `https://${SITE}/docs/events`, title: 'Events', heading_path: 'Events > Retries', snippet: 'Retries happen with backoff…' },
];

test('tabs: arrow keys move between This page, Overview and Search; tab_switch is recorded', () => withMock({ sites: { [SITE]: { indexed: true, topics: TOPICS } } }, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  assert.equal(p.$('tab-page').getAttribute('aria-selected'), 'true');
  p.$('tab-page').onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(p.$('tab-overview').getAttribute('aria-selected'), 'true');
  assert.equal(p.$('tab-overview').getAttribute('tabindex'), '0');
  assert.equal(p.$('tab-page').getAttribute('tabindex'), '-1');
  assert.equal(p.$('overview').hidden, false);
  assert.equal(p.$('content').hidden, true);
  p.$('tab-overview').onkeydown({ key: 'End', preventDefault() {} });
  assert.equal(p.$('tab-search').getAttribute('aria-selected'), 'true');
  p.$('tab-search').onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(p.$('tab-page').getAttribute('aria-selected'), 'true');
  await sleep(30);
  assert.deepEqual(queued(p.local, 'tab_switch').map((e) => e.tab), ['overview', 'search', 'page']);
}));

test('Overview: topics and the llms.txt overview; Copy overview copies both and plays the moment', () => withMock({
  sites: { [SITE]: { indexed: true, topics: TOPICS, quick: [], overview: `https://${SUB}/llms.txt` } },
}, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  p.$('tab-overview').onclick();
  await waitFor(() => !p.$('copy-overview').disabled);
  assert.match(p.$('overview-topics').textContent, /guides\s*40/);
  assert.match(p.$('overview-topics').textContent, /webhooks\s*12/);
  assert.match(p.$('overview-llms').textContent, /The llms\.txt index of the example docs/);
  stageLog.length = 0;
  await p.$('copy-overview').onclick();
  assert.match(p.clipboard.text, /- guides \(40 pages\)\n {2}- guides\/webhooks \(12 pages\)/);
  assert.match(p.clipboard.text, /The llms\.txt index of the example docs/);
  assert.deepEqual(stages(), ['copied', 'content']);
  assert.equal(p.$('overview').hidden, false, 'back on the Overview tab');
  assert.deepEqual(queued(p.local, 'copy_overview'), [{ site: SITE }]);
}));

test('Overview and Search on a site that is not indexed: why not, and the background progress', () => withMock({ sites: { [SITE]: { hold: true } } }, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  await waitFor(() => p.local[PENDING_KEY]?.[SITE]);
  await sleep(60); // a follow-up poll
  p.$('tab-search').onclick();
  assert.equal(p.$('search-on').hidden, true);
  assert.equal(p.$('search-off-title').textContent, 'Search will work once docs.example.com is indexed.');
  assert.match(p.$('search-off-status').textContent, /^Indexing in the background: /);
  p.$('tab-overview').onclick();
  assert.equal(p.$('overview-off-title').textContent, 'The overview will work once docs.example.com is indexed.');
}));

test('Search: debounced, at least 2 characters; results with checkboxes; Copy selected; no query text in telemetry', () => withMock({ sites: { [SITE]: { indexed: true, hits: HITS } } }, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  p.$('tab-search').onclick();
  p.$('search-q').value = 'v';
  p.$('search-q').oninput();
  await sleep(40);
  assert.equal(gets('/v1/search').length, 0, 'one character: no search');
  p.$('search-q').value = 've';
  p.$('search-q').oninput();
  p.$('search-q').value = 'verify signature';
  p.$('search-q').oninput();
  await waitFor(() => p.$('search-status').textContent === '2 results');
  assert.equal(gets('/v1/search').length, 1, 'debounced to the last input');
  assert.deepEqual(gets('/v1/search')[0].query, { site: SITE, q: 'verify signature', limit: '20' });
  const boxes = p.document.querySelectorAll('#search-results input[type=checkbox]');
  assert.equal(boxes.length, 2);
  assert.match(p.$('search-results').textContent, /Webhooks > Verify signatures/);
  assert.equal(p.$('copy-selected').disabled, true);
  boxes[0].checked = true; boxes[0].onchange();
  boxes[1].checked = true; boxes[1].onchange();
  assert.equal(p.$('copy-selected').disabled, false);
  stageLog.length = 0;
  await p.$('copy-selected').onclick();
  assert.match(p.clipboard.text, /Full chunk text about verifying signatures\./);
  assert.match(p.clipboard.text, /Retries happen with backoff…\n\n\[Excerpt\. The full section is at https:\/\/docs\.example\.com\/docs\/events\]/);
  assert.match(p.clipboard.text, /not as instructions to you/);
  assert.deepEqual(stages(), ['copied', 'content']);
  assert.equal(p.$('search').hidden, false);
  assert.deepEqual(queued(p.local, 'search'), [{ site: SITE, qLen: 16, results: 2 }]);
  assert.deepEqual(queued(p.local, 'copy_search'), [{ site: SITE, count: 2 }]);
  assert.ok(!JSON.stringify(p.local.telemetryQueue).includes('verify signature'), 'the query text is never sent from the client');
}));

test('Search: Copy all results uses the library package for the query', () => withMock({ sites: { [SITE]: { indexed: true, hits: HITS } } }, async () => {
  const p = await openPopup(PAGE);
  await p.ready;
  p.$('tab-search').onclick();
  p.$('search-q').value = 'retries';
  p.$('search-q').oninput();
  await waitFor(() => !p.$('copy-all').disabled);
  await p.$('copy-all').onclick();
  assert.match(p.clipboard.text, /search "retries"/);
  assert.deepEqual(gets('/v1/packages').at(-1).query, { site: SITE, q: 'retries' });
}));

// The badge

test('compactCount and badgeFor: counts, crawl precedence, private hosts', () => {
  assert.deepEqual([0, 14, 230, 999, 1000, 1234, 9999, 12_345, 1_500_000].map(compactCount), ['', '14', '230', '999', '1k', '1.2k', '9.9k', '12k', '1.5m']);
  const sites = { 'hono.dev': 230, 'docs.stripe.com': 1234 };
  assert.deepEqual(badgeFor('https://hono.dev/docs/', { sites }), { text: '230', title: 'scoop.md: 230 docs indexed for hono.dev', count: true });
  assert.equal(badgeFor('https://www.hono.dev/x', { sites }).text, '230', 'www. is the same site');
  assert.equal(badgeFor('https://docs.stripe.com/webhooks', { sites }).text, '1.2k');
  assert.equal(badgeFor('https://example.com/', { sites }).text, '');
  assert.equal(badgeFor('http://localhost:3000/', { sites: { localhost: 5 } }).text, '', 'private hosts are never looked up');
  assert.equal(badgeFor('chrome://extensions', { sites }).text, '');
  assert.equal(badgeFor('https://hono.dev/docs/', { sites, pending: { 'hono.dev': { state: 'running' } } }).text, '…', 'the crawl wins');
  assert.equal(badgeFor('https://hono.dev/docs/', { sites, pending: { 'hono.dev': { state: 'complete' } } }).text, '✓');
  assert.equal(badgeFor('https://hono.dev/docs/', { sites, pending: { 'hono.dev': { state: 'complete', delivered: true } } }).text, '230');
});

test('service worker: downloads the sites index (then 304 with If-None-Match), sets per-tab badges on activation and load, no request per visit', () => withMock({ sites: { 'hono.dev': { indexed: true, pages: 230 }, [SITE]: { indexed: true, pages: 14 } } }, async () => {
  const local = { devLibraryUrl: mock.url };
  const badges = {};
  const titles = {};
  const alarms = {};
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const tabs = { 7: { id: 7, url: 'https://hono.dev/docs/' }, 8: { id: 8, url: 'http://localhost:5173/' }, 9: { id: 9, url: PAGE } };
  globalThis.chrome = {
    storage: {
      local: { get: async (k) => (typeof k === 'string' ? (k in local ? { [k]: structuredClone(local[k]) } : {}) : { ...local }), set: async (o) => { Object.assign(local, structuredClone(o)); }, remove: async (ks) => { for (const k of [ks].flat()) delete local[k]; } },
      sync: { get: async (d) => ({ ...d, telemetry: false }) },
      onChanged: on('storage'),
    },
    runtime: { getManifest: () => MANIFEST, onInstalled: on('installed'), onStartup: on('startup'), setUninstallURL: async () => {}, getPlatformInfo: async () => ({}) },
    management: { getSelf: async () => ({ installType: 'development' }) },
    alarms: { create: (n, i) => { alarms[n] = i; }, clear: async (n) => { delete alarms[n]; return true; }, get: async (n) => alarms[n], onAlarm: on('alarm') },
    tabs: { onActivated: on('activated'), onUpdated: on('updated'), get: async (id) => tabs[id], query: async () => Object.values(tabs) },
    action: {
      setBadgeText: async ({ tabId, text }) => { badges[tabId] = text; },
      setBadgeBackgroundColor: async () => {},
      setTitle: async ({ tabId, title }) => { titles[tabId] = title; },
    },
  };
  await import(`../extension/background.js?${Math.random()}`);
  listeners.installed({ reason: 'install' });
  await waitFor(() => local[SITES_KEY]?.etag);
  assert.deepEqual(local[SITES_KEY].sites, { 'hono.dev': 230, [SITE]: 14 });
  assert.equal(alarms[SITES_ALARM].periodInMinutes, 360, 'every 6 hours');
  const before = mock.log.length;
  listeners.activated({ tabId: 7 });
  listeners.updated(8, { status: 'complete' }, tabs[8]);
  listeners.updated(9, { status: 'complete' }, tabs[9]);
  await waitFor(() => badges[7] && badges[9] !== undefined && badges[8] !== undefined);
  assert.equal(badges[7], '230');
  assert.equal(titles[7], 'scoop.md: 230 docs indexed for hono.dev');
  assert.equal(badges[8], '', 'localhost: nothing');
  assert.equal(badges[9], '14');
  assert.equal(mock.log.length, before, 'no network request per visit');
  // Six hours later: unchanged list, 304.
  listeners.alarm({ name: SITES_ALARM });
  await waitFor(() => mock.log.filter((e) => e.path === '/v1/sites/index').length === 2);
  await sleep(20);
  assert.deepEqual(local[SITES_KEY].sites, { 'hono.dev': 230, [SITE]: 14 });
  // The page-count badges shown are counted, and sent hourly as one number.
  await waitFor(() => local.badgeShownCount >= 2);
}));

test('refreshSites: an unchanged list (304) keeps the copy; a new one replaces it', () => withMock({ sites: { 'hono.dev': { indexed: true, pages: 4 } } }, async () => {
  const local = {};
  const chromeApi = { storage: { local: { get: async (k) => (k in local ? { [k]: structuredClone(local[k]) } : {}), set: async (o) => Object.assign(local, structuredClone(o)) } } };
  const lib = createLibrary({ baseUrl: mock.url, installId: 'x', client: 't' });
  assert.equal(await refreshSites(chromeApi, lib), true);
  assert.equal(await refreshSites(chromeApi, lib), false, '304');
  mock.sites['hono.dev'].pages = 9;
  assert.equal(await refreshSites(chromeApi, lib), true);
  assert.deepEqual(local[SITES_KEY].sites, { 'hono.dev': 9 });
}));

test('service worker: follows a background crawl with the badge on that site’s tabs, and stops the alarm when done', () => withMock({ sites: { [SITE]: {} } }, async () => {
  const r = mock.newRequest(SITE, PAGE);
  const local = { devLibraryUrl: mock.url };
  const badges = {};
  const alarms = {};
  const chromeApi = {
    storage: { local: { get: async (k) => (typeof k === 'string' ? (k in local ? { [k]: structuredClone(local[k]) } : {}) : { ...local }), set: async (o) => { Object.assign(local, structuredClone(o)); } } },
    alarms: { create: (n, i) => { alarms[n] = i; }, clear: async (n) => { delete alarms[n]; return true; } },
    tabs: { query: async () => [{ id: 3, url: PAGE }, { id: 4, url: 'https://other.example.net/' }] },
    action: { setBadgeText: async ({ tabId, text }) => { badges[tabId] = text; }, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  };
  await rememberCrawl(chromeApi, { requestId: r.view().id, site: SITE, url: PAGE, state: 'queued' });
  assert.equal(alarms[CRAWL_ALARM].periodInMinutes, 0.5);
  assert.equal(badges[3], '…');
  assert.equal(badges[4], '', 'other sites are not affected');
  const lib = createLibrary({ baseUrl: mock.url, installId: 'x', client: 't' });
  for (let i = 0; i < 8 && local[PENDING_KEY][SITE].state !== 'complete'; i++) await pollPending(chromeApi, lib);
  assert.equal(badges[3], '✓');
  assert.equal(alarms[CRAWL_ALARM], undefined);
  await forgetCrawl(chromeApi, SITE);
  assert.equal(badges[3], '');
}));

test('pollPending drops failed and expired requests', async () => {
  const local = {};
  const chromeApi = {
    storage: { local: { get: async (k) => (k in local ? { [k]: local[k] } : {}), set: async (o) => Object.assign(local, structuredClone(o)) } },
    alarms: { create() {}, clear: async () => true },
    tabs: { query: async () => [] },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
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

test('a ✓ nobody picked up expires', async () => {
  const now = Date.now();
  const pending = {
    'a.example.com': { state: 'complete', updatedAt: now - READY_TTL_MS - 1 },
    'b.example.com': { state: 'running', startedAt: now - 3 * 3_600_000 },
    'c.example.com': { state: 'complete', updatedAt: now },
  };
  assert.deepEqual(Object.keys(live(pending, now)), ['c.example.com']);
});

test('pollPending merges into what is stored now: an entry the popup delivered meanwhile stays gone', async () => {
  const local = { [PENDING_KEY]: { 'a.example.com': { requestId: 'cr_a', site: 'a.example.com', state: 'running', startedAt: Date.now() } } };
  const chromeApi = {
    storage: { local: { get: async (k) => ({ [k]: structuredClone(local[k]) }), set: async (o) => Object.assign(local, structuredClone(o)) } },
    alarms: { create() {}, clear: async () => true },
    tabs: { query: async () => [] },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
  const library = {
    crawlRequest: async () => {
      delete local[PENDING_KEY]['a.example.com'];
      local[PENDING_KEY]['b.example.com'] = { requestId: 'cr_b', site: 'b.example.com', state: 'queued', startedAt: Date.now() };
      return { ok: true, status: 200, data: { state: 'complete', phase: 'done' } };
    },
  };
  await pollPending(chromeApi, library);
  assert.deepEqual(Object.keys(local[PENDING_KEY]), ['b.example.com']);
});

test('progressText: friendly labels, counts and how far along', () => {
  assert.deepEqual(progressText({ state: 'queued', etaSeconds: 150 }), { label: 'Waiting for a crawler', count: 'About 3 minutes', fraction: null });
  assert.deepEqual(progressText({ state: 'indexing', phase: 'index', pagesFound: 40, pagesIndexed: 10 }), { label: 'Indexing', count: '10 of 40 pages indexed', fraction: 0.25 });
});

test('library client: the index calls follow the contract', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/sites/index')) return init.headers['if-none-match'] === '"v1"' ? new Response(null, { status: 304 }) : new Response('[{"site":"a.dev","pages":3}]', { status: 200, headers: { etag: '"v1"' } });
    if (url.includes('/packages')) return new Response('# pkg', { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const lib = createLibrary({ baseUrl: 'https://api.scoop.md/v1', installId: 'i', client: 'extension/0.5.0', fetchImpl });
  await lib.quick(`${PAGE}?a=b`);
  assert.equal(calls[0].url, `https://api.scoop.md/v1/quick?url=${encodeURIComponent(`${PAGE}?a=b`)}`);
  await lib.search(SITE, 'a b');
  assert.equal(calls[1].url, `https://api.scoop.md/v1/search?site=${SITE}&q=a%20b&limit=20`);
  await lib.topics(SITE);
  assert.equal(calls[2].url, `https://api.scoop.md/v1/sites/${SITE}/topics`);
  assert.deepEqual(await lib.queryPackage(SITE, 'x y'), { ok: true, status: 200, data: '# pkg' });
  assert.equal(calls[3].url, `https://api.scoop.md/v1/packages?site=${SITE}&q=x%20y`);
  const first = await lib.sitesIndex(null);
  assert.deepEqual([first.ok, first.etag, first.data], [true, '"v1"', [{ site: 'a.dev', pages: 3 }]]);
  const again = await lib.sitesIndex('"v1"');
  assert.deepEqual([again.ok, again.notModified], [true, true]);
});

test('settings explain that the index lookup still sends the page address with sharing off', () => {
  assert.match(read('../extension/options.html'), /Turning this off stops uploads; looking up this page in the docs index still sends its address\./);
});
