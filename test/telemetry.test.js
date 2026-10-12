// Usage statistics in the extension (extension/lib/telemetry.js and the
// service worker), with chrome.* and fetch stubbed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTelemetry, envelopes, errorText, pagePath, setTelemetry, uninstallUrl,
  MAX_QUEUE, MAX_BATCH, QUEUE_KEY, RETRY_KEY, FLUSH_ALARM, HOURLY_ALARM, NOTICE_KEY, docsLike,
} from '../extension/lib/telemetry.js';

const ID = '3b241101-e2bb-4255-8caf-4136c566a962';

// notice: the popup's usage notice has been shown (otherwise events carry no site or path).
function fakeChrome({ telemetry, installType = 'normal', local = {}, notice = true } = {}) {
  if (notice) local[NOTICE_KEY] = true;
  const sync = telemetry === undefined ? {} : { telemetry };
  const alarms = [];
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const chrome = {
    storage: {
      sync: { get: async (d) => ({ ...d, ...sync }), set: async (o) => Object.assign(sync, o), remove: async () => {} },
      local: {
        get: async (k) => (k in local ? { [k]: structuredClone(local[k]) } : {}),
        set: async (o) => Object.assign(local, structuredClone(o)),
        remove: async (k) => { for (const x of [k].flat()) delete local[x]; },
      },
      onChanged: on('storage.onChanged'),
    },
    runtime: {
      getManifest: () => ({ version: '0.3.0' }),
      getPlatformInfo: async () => ({ os: 'mac', arch: 'arm' }),
      setUninstallURL: async (u) => { chrome.uninstallUrl = u; },
      onInstalled: on('runtime.onInstalled'),
      onStartup: on('runtime.onStartup'),
    },
    i18n: { getUILanguage: () => 'en-GB' },
    management: { getSelf: async () => ({ installType }) },
    alarms: {
      create: (name, info) => alarms.push({ name, ...info }),
      get: async (name) => alarms.find((a) => a.name === name),
      onAlarm: on('alarms.onAlarm'),
    },
  };
  return { chrome, sync, local, alarms, listeners };
}

function fakeFetch(status = 202) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    const s = typeof status === 'function' ? status(calls.length) : status;
    if (s === 0) throw new TypeError('Failed to fetch');
    return new Response(null, { status: s });
  };
  return { impl, calls };
}

test('events are queued in chrome.storage.local and flushed as one batch with the envelope', async () => {
  const { chrome, local } = fakeChrome({ local: { installId: ID } });
  const f = fakeFetch();
  const t = createTelemetry({ chromeApi: chrome, fetchImpl: f.impl, beacon: null, sessionId: 's1', now: () => 1_700_000_000_000 });
  t.track('popup_open');
  t.track('scoop_start', { site: 'docs.stripe.com' });
  await t.track('copy', { site: 'docs.stripe.com', sizeBytes: 1200, trigger: 'auto', ignored: undefined });
  assert.equal(local[QUEUE_KEY].length, 3);

  const r = await t.flush();
  assert.deepEqual(r, { sent: 3, failed: false });
  assert.equal(f.calls.length, 1);
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'https://api.scoop.md/v1/events');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers['x-scoop-client'], 'extension/0.3.0');
  assert.equal(body.installId, ID);
  assert.equal(body.sessionId, 's1');
  assert.deepEqual(body.client, { extVersion: '0.3.0', browser: '', browserVersion: '', os: 'mac', platformArch: 'arm', locale: 'en-GB', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  assert.deepEqual(body.events.map((e) => [e.name, e.seq]), [['popup_open', 1], ['scoop_start', 2], ['copy', 3]]);
  assert.deepEqual(body.events[2].props, { site: 'docs.stripe.com', sizeBytes: 1200, trigger: 'auto' });
  assert.equal(body.events[0].ts, 1_700_000_000_000);
  assert.deepEqual(local[QUEUE_KEY], [], 'sent events leave the queue');
});

test('no events for private hosts', async () => {
  const { chrome, local } = fakeChrome({ local: { installId: ID } });
  const t = createTelemetry({ chromeApi: chrome, fetchImpl: fakeFetch().impl, beacon: null });
  for (const site of ['localhost', '127.0.0.1', '192.168.1.20', 'wiki.internal', 'printer.local', 'intranet', '10.0.0.1', '[::1]']) {
    t.track('scoop_start', { site });
    t.track('scoop_result', { site, path: '/secret', outcome: 'copied_ready' });
  }
  t.track('scoop_start', { site: '' });
  await t.track('scoop_start', { site: 'react.dev' });
  assert.deepEqual(local[QUEUE_KEY].map((e) => e.props.site), ['react.dev']);
});

test('opted out: nothing is queued or sent, not even pings', async () => {
  const { chrome, local } = fakeChrome({ telemetry: false, local: { installId: ID } });
  const f = fakeFetch();
  const beacons = [];
  const t = createTelemetry({ chromeApi: chrome, fetchImpl: f.impl, beacon: (...a) => beacons.push(a) });
  t.track('popup_open');
  await t.track('active_daily');
  assert.equal(local[QUEUE_KEY], undefined);
  await t.flush();
  assert.equal(t.flushOnClose(), false);
  assert.equal(f.calls.length, 0);
  assert.equal(beacons.length, 0);
});

test('switching off sends exactly one telemetry_opt_out; switching on sends telemetry_opt_in', async () => {
  const { chrome, sync, local } = fakeChrome({ local: { installId: ID, [QUEUE_KEY]: [{ sid: 'x', seq: 1, name: 'popup_open', ts: 1, props: {} }], [RETRY_KEY]: 3 } });
  const f = fakeFetch();
  await setTelemetry(chrome, false, { fetchImpl: f.impl });
  assert.equal(sync.telemetry, false);
  assert.equal(local[QUEUE_KEY], undefined, 'queued events are never sent');
  assert.equal(local[RETRY_KEY], undefined);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body.events.map((e) => e.name), ['telemetry_opt_out']);
  assert.equal(f.calls[0].init.keepalive, true);
  assert.equal(chrome.uninstallUrl, 'https://scoop.md/bye');

  await setTelemetry(chrome, true, { fetchImpl: f.impl });
  assert.equal(sync.telemetry, true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].body.events.map((e) => e.name), ['telemetry_opt_in', 'settings_change']);
  assert.equal(chrome.uninstallUrl, `https://scoop.md/bye#i=${ID}&v=0.3.0`);
});

test('the queue is capped at 500 and drops the oldest', async () => {
  const { chrome, local } = fakeChrome({ local: { installId: ID } });
  const t = createTelemetry({ chromeApi: chrome, fetchImpl: fakeFetch().impl, beacon: null, sessionId: 's' });
  let last;
  for (let i = 0; i < MAX_QUEUE + 25; i++) last = t.track('copy', { site: 'react.dev', sizeBytes: i });
  await last;
  assert.equal(local[QUEUE_KEY].length, MAX_QUEUE);
  assert.equal(local[QUEUE_KEY][0].props.sizeBytes, 25, 'oldest 25 dropped');
  assert.equal(local[QUEUE_KEY].at(-1).props.sizeBytes, MAX_QUEUE + 24);
});

test('batches: at most 100 events per request, one session per request', async () => {
  const events = [];
  for (let i = 1; i <= 230; i++) events.push({ sid: i <= 150 ? 'a' : 'b', seq: i, name: 'copy', ts: i, props: { site: 'react.dev' } });
  const out = envelopes(events, ID, {});
  assert.deepEqual(out.map((e) => [e.body.sessionId, e.body.events.length]), [['a', 100], ['a', 50], ['b', 80]]);
  assert.ok(out.every((e) => e.body.events.length <= MAX_BATCH));
  // Large events split by size too.
  const big = Array.from({ length: 40 }, (_, i) => ({ sid: 'a', seq: i, name: 'error', ts: i, props: { message: 'x'.repeat(3000) } }));
  for (const e of envelopes(big, ID, {})) assert.ok(JSON.stringify(e.body).length < 64_000);
});

test('flush: 5xx and network errors keep the queue and back off; 4xx drops the refused batch', async () => {
  const { chrome, local, alarms } = fakeChrome({ local: { installId: ID } });
  const t = createTelemetry({ chromeApi: chrome, fetchImpl: fakeFetch(503).impl, beacon: null });
  await t.track('popup_open');
  assert.deepEqual(await t.flush(), { sent: 0, failed: true });
  assert.equal(local[QUEUE_KEY].length, 1);
  assert.deepEqual(alarms.at(-1), { name: FLUSH_ALARM, delayInMinutes: 1 });
  await t.flush();
  assert.deepEqual(alarms.at(-1), { name: FLUSH_ALARM, delayInMinutes: 2 });
  await t.flush();
  assert.deepEqual(alarms.at(-1), { name: FLUSH_ALARM, delayInMinutes: 4 });

  const offline = createTelemetry({ chromeApi: chrome, fetchImpl: fakeFetch(0).impl, beacon: null });
  assert.deepEqual(await offline.flush(), { sent: 0, failed: true });
  assert.equal(local[QUEUE_KEY].length, 1);

  const ok = createTelemetry({ chromeApi: chrome, fetchImpl: fakeFetch(202).impl, beacon: null });
  assert.deepEqual(await ok.flush(), { sent: 1, failed: false });
  assert.equal(local[RETRY_KEY], undefined, 'backoff reset');

  const refused = createTelemetry({ chromeApi: chrome, fetchImpl: fakeFetch(400).impl, beacon: null });
  await refused.track('popup_open');
  assert.deepEqual(await refused.flush(), { sent: 0, failed: false });
  assert.deepEqual(local[QUEUE_KEY], [], 'a batch the server refuses is not retried forever');
});

test('popup close: sendBeacon with a text/plain body, and the sent events leave the queue', async () => {
  const { chrome, local } = fakeChrome({ local: { installId: ID } });
  const beacons = [];
  const f = fakeFetch();
  const t = createTelemetry({ chromeApi: chrome, fetchImpl: f.impl, beacon: (url, blob) => { beacons.push({ url, blob }); return true; }, sessionId: 's' });
  t.track('popup_open');
  await t.track('popup_close', { durationMs: 900 });
  assert.equal(t.flushOnClose(), true);
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0].url, 'https://api.scoop.md/v1/events');
  assert.match(beacons[0].blob.type, /^text\/plain/);
  const body = JSON.parse(await beacons[0].blob.text());
  assert.deepEqual(body.events.map((e) => e.name), ['popup_open', 'popup_close']);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(local[QUEUE_KEY], []);
  assert.equal(f.calls.length, 0);
  assert.equal(t.flushOnClose(), false, 'nothing left to send');
});

test('popup close without sendBeacon (or refused): fetch keepalive, events stay queued for the service worker', async () => {
  for (const beacon of [null, () => false]) {
    const { chrome, local, alarms } = fakeChrome({ local: { installId: ID } });
    const f = fakeFetch();
    const t = createTelemetry({ chromeApi: chrome, fetchImpl: f.impl, beacon });
    await t.track('popup_open');
    assert.equal(t.flushOnClose(), false);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.keepalive, true);
    assert.equal(local[QUEUE_KEY].length, 1, 'kept until a flush confirms it');
    assert.equal(alarms.at(-1).name, FLUSH_ALARM);
  }
});

test('devLibraryUrl redirects events only on unpacked installs', async () => {
  const dev = fakeChrome({ installType: 'development', local: { installId: ID, devLibraryUrl: 'http://localhost:8799/v1/' } });
  const f = fakeFetch();
  const t = createTelemetry({ chromeApi: dev.chrome, fetchImpl: f.impl, beacon: null });
  await t.track('popup_open');
  await t.flush();
  assert.equal(f.calls[0].url, 'http://localhost:8799/v1/events');

  const store = fakeChrome({ installType: 'normal', local: { installId: ID, devLibraryUrl: 'http://localhost:8799/v1' } });
  const g = fakeFetch();
  const s = createTelemetry({ chromeApi: store.chrome, fetchImpl: g.impl, beacon: null });
  await s.track('popup_open');
  await s.flush();
  assert.equal(g.calls[0].url, 'https://api.scoop.md/v1/events');
});

test('paths drop the query, fragment and tracking parameters, cut hash routes and redact secrets; error text loses URLs, hosts, emails and tokens', () => {
  assert.equal(pagePath('https://docs.stripe.com/webhooks?utm_source=x&lang=node#verify'), '/webhooks');
  assert.equal(pagePath('https://site.dev/#/guide/intro?x=1'), '/#/guide/intro');
  assert.equal(pagePath('https://site.dev/#/guide&x=1#y'), '/#/guide');
  assert.equal(pagePath('https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit'), '/document/d/:id/edit');
  assert.equal(pagePath('https://x.dev/reset/3b241101-e2bb-4255-8caf-4136c566a962'), '/reset/:id');
  assert.equal(pagePath('https://react.dev/learn/react-18-upgrade-guide'), '/learn/react-18-upgrade-guide');
  assert.equal(pagePath('not a url'), undefined);
  assert.equal(errorText(new Error('Failed to fetch https://docs.example.com/a?b=c from www.x.io')), 'Failed to fetch <url> from <url>');
  assert.equal(errorText('could not reach docs.example.com:8443/x today'), 'could not reach <host> today');
  assert.equal(errorText('denied for jane.doe@acme.com with ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234'), 'denied for <email> with <token>');
  assert.equal(errorText('word '.repeat(100)).length, 200);
  assert.equal(errorText('x'.repeat(500)), '<token>');
  assert.ok(docsLike('https://docs.stripe.com/payments') && docsLike('https://vitest.dev/guide/') && docsLike('https://example.com/docs'));
  assert.ok(!docsLike('https://www.notion.so/My-Page-abc') && !docsLike('https://gist.github.com/u/abc'));
});

test('until the popup notice has been shown, events carry no site or path; afterwards they do', async () => {
  const { chrome, local } = fakeChrome({ notice: false, local: { installId: ID } });
  const f = fakeFetch();
  const t = createTelemetry({ chromeApi: chrome, fetchImpl: f.impl, beacon: null, sessionId: 's' });
  await t.track('scoop_result', { site: 'react.dev', path: '/learn', outcome: 'copied_ready' });
  assert.deepEqual(local[QUEUE_KEY][0].props, { outcome: 'copied_ready' });
  t.markNoticeShown();
  await t.track('scoop_result', { site: 'react.dev', path: '/learn', outcome: 'copied_ready' });
  assert.deepEqual(local[QUEUE_KEY][1].props, { site: 'react.dev', path: '/learn', outcome: 'copied_ready' });
  assert.equal(local[NOTICE_KEY], true);
  // Lifecycle events go either way.
  const u = fakeChrome({ notice: false, local: { installId: ID } });
  const w = createTelemetry({ chromeApi: u.chrome, fetchImpl: f.impl, beacon: null });
  await w.track('install', { reason: 'install' });
  await w.flush();
  assert.deepEqual(f.calls.at(-1).body.events.map((e) => [e.name, e.props]), [['install', { reason: 'install' }]]);
});

test('the uninstall page gets the install ID and version only while telemetry is on', async () => {
  const { chrome } = fakeChrome({ local: { installId: ID } });
  assert.equal(await uninstallUrl(chrome), `https://scoop.md/bye#i=${ID}&v=0.3.0`);
  const off = fakeChrome({ telemetry: false, local: { installId: ID } });
  assert.equal(await uninstallUrl(off.chrome), 'https://scoop.md/bye');
});

// ---- Service worker ------------------------------------------------------------

async function loadWorker(opts) {
  const fake = fakeChrome(opts);
  globalThis.chrome = fake.chrome;
  const f = fakeFetch();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.impl;
  await import(`../extension/background.js?${Math.random()}`);
  const fire = async (name, ...args) => {
    fake.listeners[name](...args);
    await new Promise((r) => setTimeout(r, 30));
  };
  return { ...fake, fetch: f, fire, restore: () => { globalThis.fetch = realFetch; } };
}

test('service worker: install creates the ID, sets the uninstall URL, schedules the hourly alarm and sends install + active_daily', async () => {
  const w = await loadWorker();
  try {
    await w.fire('runtime.onInstalled', { reason: 'install' });
    // Nothing goes out at once: a synced opt-out may still be arriving. The flush alarm sends it.
    assert.equal(w.fetch.calls.length, 0);
    assert.ok(w.alarms.some((a) => a.name === FLUSH_ALARM && a.delayInMinutes === 0.5));
    await w.fire('alarms.onAlarm', { name: FLUSH_ALARM });
    assert.match(w.local.installId, /^[0-9a-f-]{36}$/);
    assert.equal(w.chrome.uninstallUrl, `https://scoop.md/bye#i=${w.local.installId}&v=0.3.0`);
    assert.ok(w.alarms.some((a) => a.name === HOURLY_ALARM && a.periodInMinutes === 60));
    const names = w.fetch.calls.flatMap((c) => c.body.events.map((e) => e.name));
    assert.deepEqual(names, ['install', 'active_daily']);
    assert.deepEqual(w.fetch.calls[0].body.events[0].props, { reason: 'install' });

    // Same UTC day: no second active_daily.
    await w.fire('alarms.onAlarm', { name: HOURLY_ALARM });
    assert.equal(w.fetch.calls.flatMap((c) => c.body.events).filter((e) => e.name === 'active_daily').length, 1);
  } finally {
    w.restore();
  }
});

test('service worker: update and browser_update carry from/to; opted out sends nothing', async () => {
  const w = await loadWorker({ local: { installId: ID, telemetryBrowserVersion: '129', telemetryLastActiveDay: new Date().toISOString().slice(0, 10) } });
  try {
    await w.fire('runtime.onInstalled', { reason: 'update', previousVersion: '0.2.0' });
    await w.fire('runtime.onInstalled', { reason: 'chrome_update' });
    await w.fire('alarms.onAlarm', { name: FLUSH_ALARM });
    const events = w.fetch.calls.flatMap((c) => c.body.events);
    assert.deepEqual(events.map((e) => [e.name, e.props]), [['update', { from: '0.2.0', to: '0.3.0' }], ['browser_update', { from: '129' }]]);
  } finally {
    w.restore();
  }
  const off = await loadWorker({ telemetry: false, local: { installId: ID } });
  try {
    await off.fire('runtime.onInstalled', { reason: 'install' });
    await off.fire('runtime.onStartup');
    await off.fire('alarms.onAlarm', { name: HOURLY_ALARM });
    assert.equal(off.fetch.calls.length, 0);
    assert.equal(off.chrome.uninstallUrl, 'https://scoop.md/bye');
  } finally {
    off.restore();
  }
});

test('service worker: a synced opt-out landing after install drops the queue before anything is sent', async () => {
  const w = await loadWorker();
  try {
    await w.fire('runtime.onInstalled', { reason: 'install' });
    assert.ok(w.local[QUEUE_KEY].length >= 1);
    w.sync.telemetry = false;
    await w.fire('storage.onChanged', { telemetry: { newValue: false } }, 'sync');
    await w.fire('alarms.onAlarm', { name: FLUSH_ALARM });
    assert.equal(w.fetch.calls.length, 0);
    assert.equal(w.local[QUEUE_KEY], undefined);
    assert.equal(w.chrome.uninstallUrl, 'https://scoop.md/bye');
  } finally {
    w.restore();
  }
});

test('slugs: readable ones are kept, word-plus-token ones redacted; IPs scrubbed; home.arpa stays private', async () => {
  const { secretish, scrubText } = await import('../extension/lib/privacy.js');
  const { registrableDomain, isPrivateHost } = await import('../extension/lib/hosts.js');
  for (const s of ['getting-started-with-v2-api', '2024-01-15-release-notes', 'oauth2-client-credentials-flow', 'python3-asyncio-tutorial', 'es6-modules-in-node-v18']) {
    assert.equal(secretish(s), false, s);
  }
  for (const s of ['reset-k8Jd2-Lq9z7-xPw3m-token', 'inv-7Gh2kLp9-q8Rt3vWx', 'share_Ab3dE9fG2hJ_k4LmN', 'team-acme-x7k2p9q4r8', 'x9-y8-z7-w6-v5-u4-tok']) {
    assert.equal(secretish(s), true, s);
  }
  assert.equal(scrubText('from 203.0.113.7 and 2001:db8::1 and ::1; 2001:0db8:85a3:0000:0000:8a2e:0370:7334 at 10:30:00 in Foo::bar v1.2.3'),
    'from <ip> and <ip> and <ip>; <ip> at 10:30:00 in Foo::bar v1.2.3');
  assert.equal(registrableDomain('printer.home.arpa'), 'printer.home.arpa');
  assert.ok(isPrivateHost('home.arpa') && isPrivateHost(registrableDomain('nas.home.arpa')));
  assert.equal(registrableDomain('acme.atlassian.net'), 'atlassian.net');
});
