// The event catalog and the request schema for POST /v1/events
// (docs/TELEMETRY.md). Strict: unknown events are dropped, unknown properties
// are dropped, strings are capped, a `site` must be a public hostname (an
// event about a private host is dropped whole) and a `path` loses any query
// or fragment. A malformed envelope is a 400.

import { isPrivateHost } from '../../../extension/lib/hosts.js';
import { redactPath, scrubText } from '../../../extension/lib/privacy.js';
import { bad } from '../lib/errors.ts';
import { normalizeSite } from '../lib/ssrf.ts';

export const MAX_EVENTS_BODY = 64 * 1024;
export const MAX_EVENTS = 100;
export const MAX_SKEW_MS = 7 * 86_400_000;

export type Source = 'extension' | 'site';

type Spec =
  | { t: 'site' | 'host' | 'path' | 'bool' | 'int' | 'uuid' | 'skill' }
  | { t: 'str'; max: number }
  | { t: 'enum'; values: string[] }
  | { t: 'list'; values: string[] };

const site: Spec = { t: 'site' };
const path: Spec = { t: 'path' };
const bool: Spec = { t: 'bool' };
const int: Spec = { t: 'int' };
const str = (max: number): Spec => ({ t: 'str', max });
const oneOf = (...values: string[]): Spec => ({ t: 'enum', values });
const version = str(32);

const SOURCE_KINDS = ['page-md', 'llms', 'llms-full', 'page-html', 'index'];

// name → [source, props]. Everything the extension and the website may send.
export const CATALOG: Record<string, [Source, Record<string, Spec>]> = {
  // Lifecycle (service worker)
  install: ['extension', { reason: oneOf('install') }],
  update: ['extension', { from: version, to: version }],
  browser_update: ['extension', { from: version, to: version }],
  active_daily: ['extension', {}],
  telemetry_opt_out: ['extension', {}],
  telemetry_opt_in: ['extension', {}],
  // Popup
  popup_open: ['extension', { trigger: oneOf('toolbar', 'shortcut') }],
  popup_close: ['extension', { durationMs: int }],
  // Scoops
  // Names no site: whether the page is public is known only at scoop_result.
  scoop_start: ['extension', {}],
  scoop_result: ['extension', {
    site, path,
    outcome: oneOf('copied_ready', 'empty', 'error', 'unsupported_page'),
    sourceKinds: { t: 'list', values: SOURCE_KINDS },
    sources: int, sizeBytes: int, truncated: bool, durationMs: int,
    libraryHit: bool, libraryWorked: int, indexHit: bool, isPublic: bool, relatedLinks: int, clipboard: bool,
  }],
  copy: ['extension', { site, path, sizeBytes: int, trigger: oneOf('auto', 'button') }],
  rebuild: ['extension', { site, path }],
  copied_animation_shown: ['extension', { reducedMotion: bool }],
  // The docs index: asking for a crawl and waiting for it
  crawl_request: ['extension', { site, state: oneOf('queued', 'running', 'indexing', 'complete', 'rejected', 'failed', 'rate_limited', 'error') }],
  crawl_wait: ['extension', { durationMs: int, outcome: oneOf('complete', 'rejected', 'failed', 'copied_page', 'closed', 'timeout') }],
  // Library
  share_result: ['extension', { site, path, outcome: oneOf('shared', 'duplicate', 'not_shared'), reason: str(40) }],
  vote: ['extension', { site, path, skillId: { t: 'skill' }, worked: bool, ok: bool }],
  report: ['extension', { site, path, skillId: { t: 'skill' }, reason: oneOf('wrong', 'malicious', 'copyright', 'other'), ok: bool }],
  // Settings
  settings_change: ['extension', { key: oneOf('share', 'theme', 'telemetry'), value: oneOf('true', 'false', 'light', 'dark', 'system') }],
  options_open: ['extension', {}],
  // Errors (message: no URLs, capped; the server strips them again)
  error: ['extension', { where: str(40), code: str(60), message: str(200) }],
  // Website (scoop.md)
  page_view: ['site', { path, referrerHost: { t: 'host' }, utmSource: str(100), utmMedium: str(100), utmCampaign: str(100) }],
  cta_click: ['site', { target: str(60), path }],
  uninstall: ['site', { installId: { t: 'uuid' }, version }],
  uninstall_reason: ['site', { installId: { t: 'uuid' }, reason: oneOf('too_noisy', 'didnt_work', 'privacy', 'other') }],
};

// Events with no browsing data: still accepted under TELEMETRY_INGEST=lifecycle
// and above the daily ceiling.
export const LIFECYCLE = new Set(['install', 'update', 'browser_update', 'active_daily', 'telemetry_opt_out', 'telemetry_opt_in', 'uninstall', 'uninstall_reason']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION = /^[\w-]{1,64}$/;
const SKILL = /^[\w-]{1,64}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

// Control characters out, whitespace collapsed, capped.
export const cleanText = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// No emails, URLs, hostnames or tokens in error text, whatever the client sent (extension/lib/privacy.js).
export const scrubUrls = (s: string) => scrubText(s);

// A public hostname, normalized like the library's site key; null otherwise.
export function publicHost(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 253) return null;
  const h = normalizeSite(v);
  if (!HOST.test(h) || isPrivateHost(h)) return null;
  return h;
}

// /path or /#/hash-route, without a query, fragment or control characters.
export function cleanPath(v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith('/')) return null;
  let p = v;
  const hashRoute = p.indexOf('#/');
  const head = hashRoute >= 0 ? p.slice(0, hashRoute) : p;
  const tail = hashRoute >= 0 ? p.slice(hashRoute) : '';
  // A hash route is cut at its own ?, & or second #; secret-looking segments become :id.
  p = head.split(/[?#]/)[0] + (tail ? `#${tail.slice(1).split(/[?&#]/)[0]}` : '');
  return cleanText(redactPath(p), 300) || null;
}

export interface Client {
  extVersion: string | null;
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  platformArch: string | null;
  locale: string | null;
  timezone: string | null;
}

export interface CleanEvent {
  name: string;
  ts: number;
  seq: number;
  site: string | null;
  path: string | null;
  props: Record<string, unknown>;
}

export interface CleanBatch {
  source: Source;
  installId: string | null;
  sessionId: string;
  client: Client;
  events: CleanEvent[];
  dropped: number;
}

const clientField = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? cleanText(v, max) : null);

function cleanClient(c: unknown): Client {
  const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
  return {
    extVersion: clientField(o.extVersion, 32),
    browser: clientField(o.browser, 40),
    browserVersion: clientField(o.browserVersion, 32),
    os: clientField(o.os, 20),
    platformArch: clientField(o.platformArch, 20),
    locale: clientField(o.locale, 35),
    timezone: clientField(o.timezone, 64),
  };
}

function timestamp(v: unknown, now: number): number | null {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t) || Math.abs(t - now) > MAX_SKEW_MS) return null;
  return Math.trunc(t);
}

// One property against its spec: the clean value, or undefined to drop it.
// `drop` means the whole event goes (a site that isn't a public hostname).
function prop(spec: Spec, v: unknown): unknown | undefined | typeof DROP {
  switch (spec.t) {
    case 'site': return publicHost(v) ?? DROP;
    case 'host': return publicHost(v) ?? undefined;
    case 'path': return cleanPath(v) ?? undefined;
    case 'bool': return typeof v === 'boolean' ? v : undefined;
    case 'int': return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.trunc(v), 2 ** 31 - 1) : undefined;
    case 'uuid': return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : undefined;
    case 'skill': return typeof v === 'string' && SKILL.test(v) ? v : undefined;
    case 'str': return typeof v === 'string' && v.trim() ? cleanText(v, spec.max) : undefined;
    case 'enum': return typeof v === 'string' && spec.values.includes(v) ? v : undefined;
    case 'list': return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && spec.values.includes(x)))] : undefined;
  }
}
const DROP = Symbol('drop');

export function cleanEvent(raw: unknown, source: Source, index: number, now: number): CleanEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const entry = typeof e.name === 'string' ? CATALOG[e.name] : undefined;
  if (!entry || entry[0] !== source) return null;
  const ts = timestamp(e.ts, now);
  if (ts === null) return null;
  const seq = Number.isInteger(e.seq) && (e.seq as number) >= 0 && (e.seq as number) < 2 ** 31 ? (e.seq as number) : index;
  const given = (e.props && typeof e.props === 'object' && !Array.isArray(e.props) ? e.props : {}) as Record<string, unknown>;
  const props: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(entry[1])) {
    if (!(key in given)) {
      if (spec.t === 'site') return null; // every event that names a site must have a public one
      continue;
    }
    const v = prop(spec, given[key]);
    if (v === DROP) return null;
    if (v !== undefined) props[key] = v;
  }
  if (typeof props.message === 'string') props.message = scrubUrls(props.message).slice(0, 200);
  const { site = null, path = null, ...rest } = props as { site?: string; path?: string };
  return { name: e.name as string, ts, seq, site, path: site || source === 'site' ? path : null, props: rest };
}

export function validateEvents(body: unknown, now = Date.now()): CleanBatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Body must be a JSON object');
  const b = body as Record<string, unknown>;
  const source: Source = b.source === undefined || b.source === 'extension' ? 'extension' : b.source === 'site' ? 'site' : (() => { throw bad('source must be extension or site'); })();
  let installId: string | null = null;
  if (source === 'extension') {
    if (typeof b.installId !== 'string' || !UUID.test(b.installId)) throw bad('installId must be a UUID v4');
    installId = b.installId.toLowerCase();
  }
  if (typeof b.sessionId !== 'string' || !SESSION.test(b.sessionId)) throw bad('sessionId must be 1–64 letters, digits, - or _');
  if (!Array.isArray(b.events) || !b.events.length) throw bad('events must be a non-empty array');
  if (b.events.length > MAX_EVENTS) throw bad(`events has over ${MAX_EVENTS} items`);
  const events: CleanEvent[] = [];
  b.events.forEach((raw, i) => {
    const e = cleanEvent(raw, source, i, now);
    if (e) events.push(e);
  });
  return { source, installId, sessionId: b.sessionId, client: source === 'extension' ? cleanClient(b.client) : cleanClient({}), events, dropped: b.events.length - events.length };
}
