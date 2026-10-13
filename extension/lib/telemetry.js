// Usage statistics (POST /v1/events, docs/TELEMETRY.md). Events are queued in
// chrome.storage.local and sent in batches: when the popup closes (sendBeacon,
// else fetch keepalive) and from the service worker (alarms). Nothing is sent
// while "Send usage statistics" is off, except the one telemetry_opt_out event
// at the moment it is switched off. Pages on private hosts are never recorded,
// and a page's path is recorded only for public docs pages, with secret-looking
// segments redacted. Until the popup has shown its one-time notice, events
// carry no site or path.
//
// Calls never throw: telemetry must never get in the way of a scoop.

import { libraryUrl } from './library.js';
import { isPrivateHost } from './hosts.js';
import { redactPath, scrubText, stripTracking } from './privacy.js';

export const QUEUE_KEY = 'telemetryQueue';
export const RETRY_KEY = 'telemetryRetry';
export const MAX_QUEUE = 500;
// The server takes at most 100 events and 64 KB per request; beacons have the same 64 KB budget.
export const MAX_BATCH = 100;
export const MAX_BATCH_BYTES = 60_000;
export const FLUSH_ALARM = 'telemetry-flush';
export const HOURLY_ALARM = 'telemetry-hourly';
export const MAX_BACKOFF_MINUTES = 360;
export const SEND_TIMEOUT_MS = 10_000;
export const BYE_URL = 'https://scoop.md/bye';
export const NOTICE_KEY = 'telemetryNoticeShown';

// Same storage as the sharing setting; on unless switched off.
export async function telemetryEnabled(chromeApi) {
  try {
    const { telemetry } = await chromeApi.storage.sync.get({ telemetry: true });
    return telemetry !== false;
  } catch {
    return false;
  }
}

// The random install ID shared, votes and reports already carry.
export async function getInstallId(chromeApi) {
  let { installId: id } = await chromeApi.storage.local.get('installId');
  if (!id) {
    id = crypto.randomUUID();
    await chromeApi.storage.local.set({ installId: id });
  }
  return id;
}

// POST <library>/events: the library's base URL, so devLibraryUrl works on unpacked installs.
export async function eventsUrl(chromeApi) {
  return `${(await libraryUrl(chromeApi)).replace(/\/+$/, '')}/events`;
}

// What the uninstall page is told: the install ID and version, in the
// fragment (never sent to a server or in a Referer), or nothing when telemetry is off.
export async function uninstallUrl(chromeApi) {
  if (!(await telemetryEnabled(chromeApi))) return BYE_URL;
  const id = await getInstallId(chromeApi);
  return `${BYE_URL}#i=${encodeURIComponent(id)}&v=${encodeURIComponent(chromeApi.runtime.getManifest().version)}`;
}

// The page's path without query or fragment, after dropping tracking
// parameters. A hash route like #/guide is the page, so it stays, cut at its
// own ?, & or a second #. Secret-looking segments become :id.
export function pagePath(url) {
  try {
    const u = new URL(stripTracking(url));
    const route = u.hash.startsWith('#/') ? `#${u.hash.slice(1).split(/[?&#]/)[0]}` : '';
    return redactPath(u.pathname + route).slice(0, 300);
  } catch {
    return undefined;
  }
}

// Docs-like: a docs host (docs., developer., …) or a docs path (/docs/, /guide/, …).
const DOCS_HOST = /^(docs?|developers?|dev|devdocs|learn|api|apidocs|help|support|guide|guides|manual|reference|wiki|kb)\./i;
const DOCS_PATH = /^\/(docs?|documentation|guides?|reference|api|apis|learn|manual|tutorials?|handbook|developers?|sdk|sdks|help|kb|wiki|getting-started|quickstart|book)(\/|$)/i;
export function docsLike(url) {
  try {
    const u = new URL(url);
    return DOCS_HOST.test(u.hostname) || DOCS_PATH.test(u.pathname);
  } catch {
    return false;
  }
}

// Error text without emails, URLs, hostnames or tokens, capped.
export function errorText(e) {
  return scrubText(e?.message ?? e ?? '').slice(0, 200);
}

export async function clientInfo(chromeApi, nav = globalThis.navigator) {
  const brands = nav?.userAgentData?.brands ?? [];
  const brand = brands.find((b) => !/not.?a.?brand|chromium/i.test(b.brand)) ?? brands.find((b) => /chromium/i.test(b.brand));
  let platform = {};
  try { platform = (await chromeApi.runtime.getPlatformInfo()) ?? {}; } catch {}
  let locale = '';
  try { locale = chromeApi.i18n?.getUILanguage?.() || nav?.language || ''; } catch {}
  let timezone = '';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
  return {
    extVersion: chromeApi.runtime.getManifest().version,
    browser: brand?.brand ?? '',
    browserVersion: brand?.version ?? '',
    os: platform.os ?? '',
    platformArch: platform.arch ?? '',
    locale,
    timezone,
  };
}

const keyOf = (e) => `${e.sid}:${e.seq}`;

async function loadQueue(chromeApi) {
  try {
    const { [QUEUE_KEY]: queue } = await chromeApi.storage.local.get(QUEUE_KEY);
    return Array.isArray(queue) ? queue : [];
  } catch {
    return [];
  }
}

async function saveQueue(chromeApi, queue) {
  await chromeApi.storage.local.set({ [QUEUE_KEY]: queue.slice(-MAX_QUEUE) });
}

async function dropFromQueue(chromeApi, sent) {
  const keys = new Set(sent.map(keyOf));
  await saveQueue(chromeApi, (await loadQueue(chromeApi)).filter((e) => !keys.has(keyOf(e))));
}

// Splits events into request bodies: one session each, at most MAX_BATCH
// events and about MAX_BATCH_BYTES of JSON.
export function envelopes(events, installId, client) {
  const out = [];
  let cur = null;
  let size = 0;
  for (const e of events) {
    const item = { name: e.name, ts: e.ts, seq: e.seq, props: e.props };
    const bytes = JSON.stringify(item).length + 1;
    if (!cur || cur.body.sessionId !== e.sid || cur.body.events.length >= MAX_BATCH || size + bytes > MAX_BATCH_BYTES) {
      cur = { body: { installId, sessionId: e.sid, client, events: [] }, sent: [] };
      size = 400;
      out.push(cur);
    }
    cur.body.events.push(item);
    cur.sent.push(e);
    size += bytes;
  }
  return out;
}

// Retry with exponential backoff: 1, 2, 4 … minutes, capped at 6 hours.
async function scheduleRetry(chromeApi, failed) {
  try {
    if (!failed) {
      await chromeApi.storage.local.remove(RETRY_KEY);
      return;
    }
    const { [RETRY_KEY]: attempt = 0 } = await chromeApi.storage.local.get(RETRY_KEY);
    await chromeApi.storage.local.set({ [RETRY_KEY]: attempt + 1 });
    chromeApi.alarms?.create(FLUSH_ALARM, { delayInMinutes: Math.min(MAX_BACKOFF_MINUTES, 2 ** attempt) });
  } catch {}
}

export function createTelemetry({
  chromeApi = globalThis.chrome,
  fetchImpl = (...a) => fetch(...a),
  beacon = globalThis.navigator?.sendBeacon ? (url, data) => globalThis.navigator.sendBeacon(url, data) : null,
  sessionId = crypto.randomUUID(),
  now = () => Date.now(),
} = {}) {
  let seq = 0;
  let enabled = null;
  let url = null;
  let installId = null;
  let client = null;
  // This session's events not yet known to be sent: what the close beacon sends.
  let mine = [];
  let writes = Promise.resolve();

  let stopped = false;
  // Until the popup's notice has been shown, no event carries a site or path.
  let noticeShown = false;
  const ready = (async () => {
    const on = await telemetryEnabled(chromeApi);
    if (stopped) return;
    enabled = on;
    if (!enabled) return;
    try { noticeShown = Boolean((await chromeApi.storage.local.get(NOTICE_KEY))[NOTICE_KEY]) || noticeShown; } catch {}
    try {
      [url, installId, client] = await Promise.all([eventsUrl(chromeApi), getInstallId(chromeApi), clientInfo(chromeApi)]);
    } catch {
      enabled = false;
    }
    if (stopped) enabled = false;
  })();

  function browsingDataGate(event) {
    if (noticeShown) return;
    delete event.props.site;
    delete event.props.path;
  }

  function track(name, props = {}) {
    if (enabled === false) return writes;
    const site = props.site;
    if (site !== undefined && (typeof site !== 'string' || !site || isPrivateHost(site))) return writes;
    const clean = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined && v !== null));
    const event = { sid: sessionId, seq: ++seq, name, ts: now(), props: clean };
    mine.push(event);
    writes = writes.then(async () => {
      await ready;
      if (!enabled) {
        mine = [];
        return;
      }
      browsingDataGate(event);
      await saveQueue(chromeApi, [...(await loadQueue(chromeApi)), event]);
    }).catch(() => {});
    return writes;
  }

  async function post(body, keepalive) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-scoop-client': `extension/${client.extVersion}` },
        credentials: 'omit',
        keepalive,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      return res.status;
    } catch {
      return 0;
    }
  }

  // Sends everything queued (every session, not only this one). Events the
  // server refused as invalid are dropped; on a network error, 429 or 5xx the
  // rest stay queued and a retry is scheduled.
  async function flush({ keepalive = false } = {}) {
    await writes;
    await ready;
    if (!enabled) {
      // Switched off: anything still queued is never sent.
      if (!(await telemetryEnabled(chromeApi))) await chromeApi.storage.local.remove([QUEUE_KEY, RETRY_KEY]).catch(() => {});
      return { sent: 0, failed: false };
    }
    const queue = await loadQueue(chromeApi);
    let sent = 0;
    let failed = false;
    const done = [];
    for (const { body, sent: events } of envelopes(queue, installId, client)) {
      const status = await post(body, keepalive);
      if (status === 0 || status === 429 || status >= 500) {
        failed = true;
        break;
      }
      if (status < 300) sent += events.length;
      done.push(...events);
    }
    if (done.length) {
      const keys = new Set(done.map(keyOf));
      mine = mine.filter((e) => !keys.has(keyOf(e)));
      await dropFromQueue(chromeApi, done).catch(() => {});
    }
    if (queue.length) await scheduleRetry(chromeApi, failed);
    return { sent, failed };
  }

  // For pagehide: synchronous, so it works while the popup is closing. Sends
  // this session's unsent events with sendBeacon, or fetch keepalive when
  // there is no beacon or it refused. What the beacon accepted is dropped from
  // the queue (best effort; the server ignores a resent event by its ID).
  function flushOnClose() {
    if (!enabled || !mine.length || !url) return false;
    const events = mine;
    mine = [];
    events.forEach(browsingDataGate);
    let beaconed = true;
    for (const { body, sent } of envelopes(events, installId, client)) {
      const text = JSON.stringify(body);
      let ok = false;
      try { ok = Boolean(beacon?.(url, new Blob([text], { type: 'text/plain;charset=UTF-8' }))); } catch {}
      if (ok) {
        dropFromQueue(chromeApi, sent).catch(() => {});
      } else {
        beaconed = false;
        post(body, true);
      }
    }
    // Whatever a keepalive fetch can't confirm stays queued for the service worker.
    if (!beaconed) chromeApi.alarms?.create(FLUSH_ALARM, { delayInMinutes: 1 });
    return beaconed;
  }

  // Stops this instance at once (usage statistics were just switched off).
  function disable() {
    stopped = true;
    enabled = false;
    mine = [];
  }

  // The popup showed the notice: site and path may be recorded from now on.
  function markNoticeShown() {
    noticeShown = true;
    chromeApi.storage.local.set({ [NOTICE_KEY]: true }).catch?.(() => {});
  }

  return { track, flush, flushOnClose, disable, markNoticeShown, ready, sessionId, get enabled() { return enabled; } };
}

// Turns usage statistics on or off. Off: the queue is dropped and one
// telemetry_opt_out event is sent, then nothing more. On: telemetry_opt_in.
// The uninstall page stops (or starts) getting the install ID.
export async function setTelemetry(chromeApi, on, { fetchImpl = (...a) => fetch(...a) } = {}) {
  if (on) {
    await chromeApi.storage.sync.set({ telemetry: true });
    const t = createTelemetry({ chromeApi, fetchImpl, beacon: null });
    t.track('telemetry_opt_in');
    t.track('settings_change', { key: 'telemetry', value: 'true' });
    await t.flush();
  } else {
    await chromeApi.storage.sync.set({ telemetry: false });
    await chromeApi.storage.local.remove([QUEUE_KEY, RETRY_KEY]);
    try {
      const [url, installId, client] = await Promise.all([eventsUrl(chromeApi), getInstallId(chromeApi), clientInfo(chromeApi)]);
      await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-scoop-client': `extension/${client.extVersion}` },
        credentials: 'omit',
        keepalive: true,
        body: JSON.stringify({ installId, sessionId: crypto.randomUUID(), client, events: [{ name: 'telemetry_opt_out', ts: Date.now(), seq: 1, props: {} }] }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {}
  }
  try { await chromeApi.runtime.setUninstallURL(await uninstallUrl(chromeApi)); } catch {}
}
