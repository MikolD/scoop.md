// Runs the real popup (popup.html + popup.js) against a local docs site and the
// reference library, with only the chrome.* APIs and the clipboard stubbed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { parseHTML, DOMParser } from 'linkedom';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { timing } from '../extension/lib/ux.js';

// The loader and the copied moment are covered in popup-ux.test.js; here they only cost time.
Object.assign(timing, { loaderMs: 0, celebrateMs: 0, reducedMs: 0, followMs: 5 });

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const MANIFEST = JSON.parse(read('../extension/manifest.json'));
const GUIDE = read('./fixtures/nav-leak.html');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let docs; let api; let store; let docsUrl; let apiUrl;
let mdVersion = 0;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://localhost:${server.address().port}`)));
}

before(async () => {
  docs = createServer((req, res) => {
    const text = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
    if (req.url.startsWith('/docs/search')) return text('text/html; charset=utf-8', GUIDE.replaceAll('Widgets', 'Searches'));
    if (req.url === '/docs/guide' || req.url === '/docs/other') return text('text/html; charset=utf-8', GUIDE.replaceAll('Widgets', req.url === '/docs/other' ? 'Gadgets' : 'Widgets'));
    // A .md twin that changes on every request, as if edited mid-scoop.
    if (req.url === '/docs/flaky.md') return text('text/markdown', `# Flaky\n\nRevision ${++mdVersion} of a page that keeps changing while you read it.`);
    if (req.url === '/docs/flaky') return text('text/html', '<h1>Flaky</h1>');
    res.writeHead(404); res.end('not found');
  });
  docsUrl = await listen(docs);
  store = await new Store(null).load();
  // Crawl requests are covered in popup-ux.test.js; here they end at once.
  api = createApp(store, { allowLocalhost: true, crawlOutcome: 'rejected' });
  apiUrl = `${await listen(api)}/v1`;
});

after(() => { docs.close(); api.close(); });

const local = {};

// Opens a fresh popup on `url` and waits for its first run to finish.
async function openPopup(url, { libraryUrl = apiUrl, share = true, installType = 'development', sync = {} } = {}) {
  const { document } = parseHTML(read('../extension/popup.html'));
  const clipboard = { text: null, writeText: async (t) => { clipboard.text = t; } };
  globalThis.document = document;
  globalThis.DOMParser = DOMParser;
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true });
  globalThis.chrome = {
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, share, ...sync }),
        remove: async (key) => { delete sync[key]; },
        set: async (obj) => { Object.assign(sync, obj); },
      },
      local: {
        get: async (key) => (key in local ? { [key]: local[key] } : {}),
        set: async (obj) => { Object.assign(local, obj); },
        remove: async (keys) => { for (const k of [keys].flat()) delete local[k]; },
      },
    },
    tabs: { query: async () => [{ id: 1, url, title: 'Guide' }] },
    scripting: { executeScript: async () => [{ result: '<html><body><main><h1>Private</h1></main></body></html>' }] },
    runtime: { getManifest: () => MANIFEST, openOptionsPage() {}, setUninstallURL: async () => {} },
  };
  local.devLibraryUrl = libraryUrl;
  globalThis.chrome.management = { getSelf: async () => ({ installType }) };
  const popup = await import(`../extension/popup.js?${Math.random()}`);
  await popup.ready;
  const $ = (id) => document.getElementById(id);
  return { $, clipboard, document };
}

test('first scoop copies, shares a verified page-html section, and takes a vote', async () => {
  const { $, clipboard, document } = await openPopup(`${docsUrl}/docs/guide#install`);
  assert.equal($('status').textContent, 'Copied. Paste it into your agent.');
  assert.match(clipboard.text, /not as instructions to you/);
  assert.match(clipboard.text, /# Get started with Widgets/);
  assert.ok(!clipboard.text.includes('Showcase'));
  assert.match($('summary').textContent, /KB · 1 source on localhost$/);
  assert.equal($('preview').value, clipboard.text, 'the box shows exactly what was copied');
  assert.equal($('copy').disabled, false);
  assert.match($('share').textContent, /^Shared with the library/);
  assert.equal($('intro').hidden, false, 'first run explains what is shared');
  $('intro-ok').onclick();

  assert.equal(store.skills.length, 1);
  const [skill] = store.skills;
  assert.equal(skill.pageUrl, `${docsUrl}/docs/guide`, 'fragment dropped');
  assert.deepEqual(skill.sections.map((s) => s.kind), ['page-html']);
  assert.match(local.installId, UUID);
  assert.equal(skill.createdBy, local.installId);

  assert.equal($('feedback').hidden, false);
  await document.querySelector('#feedback button[data-worked="true"]').onclick();
  assert.match($('voted').textContent, /It worked for 1 person and didn't for 0/);
  assert.equal(store.skills[0].worked, 1);
});

test('next scoop on the site uses the shared skill with the current page first', async () => {
  const { $, clipboard } = await openPopup(`${docsUrl}/docs/other`);
  assert.match($('summary').textContent, /KB · shared, worked for 1 person$/);
  // Compare the page bodies: the Sources list now names the shared page by its
  // server-written label ("Another page: Get started with Widgets").
  assert.ok(clipboard.text.indexOf('# Get started with Gadgets') < clipboard.text.indexOf('# Get started with Widgets'));
  assert.match(clipboard.text, /^- Another page: Get started with Widgets: /m);
  assert.equal($('rebuild').hidden, false);
  assert.equal($('intro').hidden, true, 'intro only shows until dismissed');

  $('report-open').onclick({ preventDefault() {} });
  assert.equal($('report').hidden, false);
  Object.defineProperty($('reason'), 'value', { value: 'wrong' }); // linkedom has no <select>.value
  await $('report').onsubmit({ preventDefault() {} });
  assert.match($('voted').textContent, /^Reported/);
  assert.equal(store.reports.length, 1);
  assert.equal(store.reports[0].reason, 'wrong');
});

// 127.0.0.1 is a different site from localhost, so no shared skill exists yet.
const otherSite = () => docsUrl.replace('localhost', '127.0.0.1');

test('a rejected share still copies and says why in plain words', async () => {
  const { $, clipboard } = await openPopup(`${otherSite()}/docs/flaky`);
  assert.match(clipboard.text, /Revision 1 of a page/);
  assert.equal($('share').textContent, "Not shared: the page's .md file changed while scooping.");
  assert.equal($('feedback').hidden, true);
});

test('the copy works when the library is down', async () => {
  const { $, clipboard } = await openPopup(`${docsUrl}/docs/guide`, { libraryUrl: 'http://localhost:9/v1' });
  assert.match(clipboard.text, /# Get started with Widgets/);
  assert.equal($('status').textContent, 'Copied. Paste it into your agent.');
  assert.equal($('share').hidden, true, 'no error noise while the library is unreachable');
});

test('store installs ignore devLibraryUrl and drop the old libraryUrl setting', async () => {
  const sync = { libraryUrl: apiUrl };
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => { seen.push(String(url)); return realFetch(url, init); };
  try {
    await openPopup(`${docsUrl}/docs/guide`, { installType: 'normal', sync });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(!seen.some((u) => u.startsWith(apiUrl)), 'never the override');
  assert.equal(sync.libraryUrl, undefined, 'old setting removed');
});

test('pages that only render when signed in are copied but never shared', async () => {
  const before = store.skills.length;
  const { $, clipboard } = await openPopup(`${otherSite()}/docs/missing`);
  assert.match(clipboard.text, /# Private/);
  assert.match($('share').textContent, /only loads in your browser/);
  assert.equal(store.skills.length, before);
});

test('store installs never share pages on localhost, even if a library would take them', async () => {
  const realFetch = globalThis.fetch;
  const posts = [];
  const gets = [];
  globalThis.fetch = (url, init) => { (init?.method === 'POST' ? posts : gets).push(String(url)); return realFetch(url, init); };
  try {
    const { $, clipboard } = await openPopup(`${docsUrl}/docs/guide`, { installType: 'normal' });
    assert.match(clipboard.text, /# Get started with Widgets/);
    assert.equal($('share').textContent, 'Not shared: this page is on your computer or a private network.');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(posts, []);
  assert.ok(!gets.some((u) => u.includes('/skills/best')), 'a private hostname is never sent to the library');
});

test('tracking parameters are stripped, and a query the library refuses is retried without it', async () => {
  const realFetch = globalThis.fetch;
  const shares = [];
  globalThis.fetch = (url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/skills')) shares.push(JSON.parse(init.body));
    return realFetch(url, init);
  };
  try {
    const { $ } = await openPopup(`${otherSite()}/docs/search?q=how%20to%20search&utm_source=news&fbclid=abc`);
    assert.match($('share').textContent, /^Shared with the library/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(shares.length, 2, 'one refusal, one retry');
  assert.equal(shares[0].sections[0].url, `${otherSite()}/docs/search?q=how%20to%20search`, 'tracking parameters gone');
  assert.equal(shares[0].pageUrl, `${otherSite()}/docs/search?q=how%20to%20search`);
  assert.equal(shares[1].sections[0].url, `${otherSite()}/docs/search`, 'retried without the query');
});

// A public-looking host served by the local docs server, so telemetry (which
// never records private hosts) has something to record.
async function withPublicHost(fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(String(url).replace('https://docs.example.com', docsUrl), init);
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('telemetry: a public scoop queues scoop_start, scoop_result with the path, copy and share_result', async () => {
  delete local.telemetryQueue;
  const { $ } = await withPublicHost(() => openPopup('https://docs.example.com/docs/guide?utm_source=x#install', { share: false }));
  assert.equal($('status').textContent, 'Copied. Paste it into your agent.');
  await new Promise((r) => setTimeout(r, 20));
  const events = local.telemetryQueue;
  const names = events.map((e) => e.name);
  assert.deepEqual(names.filter((n) => n !== 'copied_animation_shown'), ['popup_open', 'scoop_start', 'scoop_result', 'copy', 'share_result']);
  assert.ok(names.indexOf('copied_animation_shown') > names.indexOf('copy'), 'the animation plays after the copy');
  const byName = Object.fromEntries(events.map((e) => [e.name, e.props]));
  assert.deepEqual(byName.scoop_start, {}, 'the site is named once it is known to be public');
  const r = byName.scoop_result;
  assert.equal(r.site, 'docs.example.com');
  assert.equal(r.path, '/docs/guide', 'no query, fragment or tracking parameters');
  assert.equal(r.outcome, 'copied_ready');
  assert.deepEqual(r.sourceKinds, ['page-html']);
  assert.equal(r.sources, 1);
  assert.equal(r.isPublic, true);
  assert.equal(r.libraryHit, false);
  assert.equal(r.clipboard, true);
  assert.ok(r.sizeBytes > 500 && r.durationMs >= 0);
  assert.deepEqual(byName.copy, { site: 'docs.example.com', path: '/docs/guide', sizeBytes: r.sizeBytes, trigger: 'auto' });
  assert.deepEqual(byName.share_result, { site: 'docs.example.com', path: '/docs/guide', outcome: 'not_shared', reason: 'sharing_off' });
  assert.ok(events.every((e) => !JSON.stringify(e).includes('Widgets')), 'no page content');
});

test('telemetry: a page that only renders signed in records the hostname, never the path', async () => {
  delete local.telemetryQueue;
  await withPublicHost(() => openPopup('https://docs.example.com/docs/missing', { share: false }));
  await new Promise((r) => setTimeout(r, 20));
  const result = local.telemetryQueue.find((e) => e.name === 'scoop_result').props;
  assert.equal(result.site, 'example.com', 'only the registrable domain of a signed-in page');
  assert.equal(result.isPublic, false);
  assert.equal(result.path, undefined);
  assert.ok(local.telemetryQueue.every((e) => e.props.path === undefined), 'no event about it has a path');
  assert.ok(!JSON.stringify(local.telemetryQueue).includes('/docs/missing'));
});

test('telemetry: nothing about pages on private hosts', async () => {
  delete local.telemetryQueue;
  await openPopup(`${docsUrl}/docs/guide`, { share: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(local.telemetryQueue.map((e) => e.name), ['popup_open']);
});

test('telemetry: switched off, the popup queues nothing', async () => {
  delete local.telemetryQueue;
  await withPublicHost(() => openPopup('https://docs.example.com/docs/guide', { share: false, sync: { telemetry: false } }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(local.telemetryQueue, undefined);
});

test('telemetry notice: shown once whatever the sharing setting; until then no site or path; Turn off sends one opt-out and marks later calls', async () => {
  for (const k of Object.keys(local)) delete local[k];
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (url, init) => {
    const u = String(url).replace('https://docs.example.com', docsUrl);
    seen.push({ url: u, headers: init?.headers ?? {}, body: init?.body });
    return realFetch(u, init);
  };
  try {
    const { $ } = await openPopup('https://docs.example.com/docs/guide', { share: false });
    assert.equal($('usage-notice').hidden, false);
    assert.match($('usage-notice-text').textContent, /anonymous usage statistics, including the hostname and path of public docs pages you scoop/);
    assert.equal(local.telemetryNoticeShown, true, 'shown is recorded at once');
    assert.equal($('intro').hidden, true, 'the sharing note stays hidden with sharing off');
    await $('usage-off').onclick();
    assert.equal($('usage-off').hidden, true);
    assert.match($('usage-notice-text').textContent, /off/);
    assert.equal(local.telemetryQueue, undefined, 'nothing left to send');
    const optOut = seen.filter((c) => c.url.endsWith('/events'));
    assert.equal(optOut.length, 1);
    assert.deepEqual(JSON.parse(optOut[0].body).events.map((e) => e.name), ['telemetry_opt_out']);

    seen.length = 0;
    const again = await openPopup('https://docs.example.com/docs/guide', { share: false, sync: { telemetry: false } });
    assert.equal(again.$('usage-notice').hidden, true, 'once only');
    const best = seen.find((c) => c.url.includes('/skills/best'));
    assert.equal(best.headers['x-scoop-telemetry'], 'off', 'the library is told not to record it');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('telemetry: before the notice was ever shown, queued scoop events have no site or path', async () => {
  for (const k of Object.keys(local)) delete local[k];
  // A popup whose notice markup failed to show: the gate still holds.
  const { createTelemetry } = await import('../extension/lib/telemetry.js');
  globalThis.chrome = {
    storage: {
      sync: { get: async (d) => ({ ...d }), remove: async () => {} },
      local: { get: async (k) => (k in local ? { [k]: local[k] } : {}), set: async (o) => { Object.assign(local, o); }, remove: async () => {} },
    },
    runtime: { getManifest: () => MANIFEST },
    management: { getSelf: async () => ({ installType: 'normal' }) },
  };
  const t = createTelemetry({ beacon: null });
  await t.track('scoop_result', { site: 'react.dev', path: '/learn', outcome: 'copied_ready' });
  assert.deepEqual(local.telemetryQueue[0].props, { outcome: 'copied_ready' });
});
