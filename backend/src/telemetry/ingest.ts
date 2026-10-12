// POST /v1/events and server-side API usage (docs/TELEMETRY.md). Ingestion
// validates, rate limits, enriches (coarse geo from request.cf, a parsed
// user-agent family, a daily-rotating salted hash of the IP subject) and
// enqueues; the consumer (consumer.ts) does the D1 and R2 writes, so a slow
// D1 never slows ingestion. The IP itself is never stored or enqueued.

import { readJson, json } from '../api/http.ts';
import { hmacHex, ipSubject } from '../db/ratelimit.ts';
import { ApiError } from '../lib/errors.ts';
import { sha256Hex, ulid } from '../lib/ids.ts';
import type { Env } from '../env.ts';
import { cleanText, MAX_EVENTS_BODY, publicHost, validateEvents } from './schema.ts';
import type { CleanBatch, CleanEvent } from './schema.ts';

// One D1 row (src/telemetry/consumer.ts, migrations/0008_telemetry.sql).
export interface TelemetryRow {
  id: string;
  source: 'extension' | 'site' | 'api';
  name: string;
  ts: string;
  day: string;
  received_at: string;
  install_id: string | null;
  session_id: string | null;
  visitor_id: string | null;
  seq: number | null;
  site: string | null;
  path: string | null;
  outcome: string | null;
  props: string;
  ext_version: string | null;
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  arch: string | null;
  locale: string | null;
  timezone: string | null;
  ua_browser: string | null;
  ua_os: string | null;
  country: string | null;
  region: string | null;
  continent: string | null;
  as_org: string | null;
  ip_hash: string | null;
}

export interface TelemetryMessage {
  v: 1;
  rows: TelemetryRow[];
}

// API routes whose requests are recorded, and the event name for each.
export const API_ROUTES: Record<string, string> = {
  '/v1/search': 'api_search',
  '/v1/packages': 'api_packages',
  '/v1/skills/best': 'api_best',
  '/v1/sites': 'api_sites',
  '/v1/sites/:site': 'api_site',
  '/v1/sites/:site/profile': 'api_profile',
  '/v1/sites/:site/topics': 'api_topics',
};

// What an API handler learned about the request, for usage telemetry.
export interface ApiUsage {
  site?: string;
  q?: string;
  topic?: string;
  hit?: boolean;
  results?: number;
}

const allowLocalhost = (env: Env) => env.ENVIRONMENT === 'dev' && env.ALLOW_LOCALHOST === '1';

// A web page may only post from scoop.md (or localhost in local dev); the
// extension and server-side callers (no Origin) always may.
function originAllowed(origin: string | null, env: Env): boolean {
  if (!origin || origin.startsWith('chrome-extension://') || origin === 'https://scoop.md') return true;
  return allowLocalhost(env) && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function parseUa(ua: string | null): { browser: string | null; os: string | null } {
  const s = ua ?? '';
  const v = (re: RegExp, name: string) => {
    const m = re.exec(s);
    return m ? `${name} ${m[1]}` : null;
  };
  const browser = /bot|crawl|spider|slurp|headless/i.test(s)
    ? 'Bot'
    : v(/Edg(?:A|iOS)?\/(\d+)/, 'Edge') ?? v(/OPR\/(\d+)/, 'Opera') ?? v(/SamsungBrowser\/(\d+)/, 'Samsung Internet') ??
      v(/(?:Firefox|FxiOS)\/(\d+)/, 'Firefox') ?? v(/(?:Chrome|CriOS)\/(\d+)/, 'Chrome') ?? v(/Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari/, 'Safari') ??
      v(/^curl\/(\d+)/, 'curl') ?? (s ? 'Other' : null);
  const os = /Windows NT/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'ChromeOS' : /Android/.test(s) ? 'Android'
    : /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : s ? 'Other' : null;
  return { browser, os };
}

interface Geo {
  country: string | null;
  region: string | null;
  continent: string | null;
  as_org: string | null;
}

export function geoOf(req: Request): Geo {
  const cf = ((req as unknown as { cf?: Record<string, unknown> }).cf ?? {}) as Record<string, unknown>;
  const s = (v: unknown, max: number) => (typeof v === 'string' && v ? cleanText(v, max) : null);
  return { country: s(cf.country, 2), region: s(cf.region, 80), continent: s(cf.continent, 2), as_org: s(cf.asOrganization, 120) };
}

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

// Same input, same row ID: a resent or redelivered event is stored once.
const eventId = async (...parts: (string | number | null)[]) => (await sha256Hex(parts.join(':'))).slice(0, 32);

// The event's result, kept in its own column so the rollups can count by it.
export function outcomeOf(name: string, props: Record<string, unknown>): string | null {
  if (typeof props.outcome === 'string') return props.outcome;
  if (typeof props.hit === 'boolean') return props.hit ? 'hit' : 'miss';
  if (name === 'vote' && typeof props.worked === 'boolean') return props.worked ? 'worked' : 'failed';
  if (name === 'settings_change' && props.key) return `${props.key}=${props.value ?? ''}`;
  if (typeof props.reason === 'string') return props.reason;
  if (name === 'error' && typeof props.code === 'string') return props.code;
  if (name === 'copy' && typeof props.trigger === 'string') return props.trigger;
  return null;
}

// Requests per minute, per install ID and per IP subject (EVENTS_LIMITER).
async function limit(env: Env, key: string): Promise<void> {
  if (!env.EVENTS_LIMITER || (await env.EVENTS_LIMITER.limit({ key })).success) return;
  const err = new ApiError('rate_limited', 'Too many events; try again later', 429);
  err.retryAfter = 60;
  throw err;
}

export async function eventRows(batch: CleanBatch, req: Request, env: Env, ip: string, now: Date): Promise<TelemetryRow[]> {
  const day = isoDay(now.getTime());
  const subject = ipSubject(ip);
  const salt = env.TELEMETRY_SALT;
  const ua = req.headers.get('user-agent');
  const ipHash = salt ? (await hmacHex(salt, `ip:${day}:${subject}`)).slice(0, 32) : null;
  // The website's cookieless visitor: same IP subject and user agent on the same UTC day.
  const visitorId = batch.source === 'site' && salt ? (await hmacHex(salt, `visitor:${day}:${subject}:${ua ?? ''}`)).slice(0, 32) : null;
  const geo = geoOf(req);
  const parsed = parseUa(ua);
  const c = batch.client;
  const receivedAt = now.toISOString();
  return Promise.all(batch.events.map(async (e: CleanEvent): Promise<TelemetryRow> => {
    const props = { ...e.props };
    // The website's uninstall events are about an install: they carry its ID.
    let installId = batch.installId;
    if (batch.source === 'site' && typeof props.installId === 'string') {
      installId = props.installId;
      delete props.installId;
    }
    return {
      id: await eventId(batch.source, installId ?? visitorId, batch.sessionId, e.seq, e.name),
      source: batch.source,
      name: e.name,
      ts: new Date(e.ts).toISOString(),
      day: isoDay(e.ts),
      received_at: receivedAt,
      install_id: installId,
      session_id: batch.sessionId,
      visitor_id: visitorId,
      seq: e.seq,
      site: e.site,
      path: e.path,
      outcome: outcomeOf(e.name, e.props),
      props: JSON.stringify(props),
      ext_version: batch.source === 'site' && typeof props.version === 'string' ? props.version : c.extVersion,
      browser: c.browser,
      browser_version: c.browserVersion,
      os: c.os,
      arch: c.platformArch,
      locale: c.locale,
      timezone: c.timezone,
      ua_browser: parsed.browser,
      ua_os: parsed.os,
      ...geo,
      ip_hash: ipHash,
    };
  }));
}

export async function ingestEvents(req: Request, env: Env, ip: string, now = new Date()): Promise<Response> {
  if (!originAllowed(req.headers.get('origin'), env)) throw new ApiError('forbidden', 'Events are accepted from the extension and scoop.md only', 403);
  await limit(env, `ip:${ipSubject(ip)}`);
  const batch = validateEvents(await readJson(req, MAX_EVENTS_BODY), now.getTime());
  if (batch.installId) await limit(env, `install:${batch.installId}`);
  const rows = await eventRows(batch, req, env, ip, now);
  if (rows.length) await env.TELEMETRY_QUEUE.send({ v: 1, rows } satisfies TelemetryMessage, { contentType: 'json' });
  return json(202, { accepted: rows.length, dropped: batch.dropped });
}

// One API request as a usage event: route, site, query text, hit or miss,
// result count, latency, X-Scoop-Client and country. No IP hash, install ID
// or session: API callers aren't tracked. TELEMETRY_API_SAMPLE (0–1, default 1)
// is the share of requests recorded.
export async function recordApiUsage(
  env: Env,
  req: Request,
  route: string,
  o: { status: number; latencyMs: number; usage: ApiUsage },
  now = new Date(),
  random = Math.random,
): Promise<void> {
  const name = API_ROUTES[route];
  if (!name || !env.TELEMETRY_QUEUE) return;
  const sample = env.TELEMETRY_API_SAMPLE === undefined ? 1 : Number(env.TELEMETRY_API_SAMPLE);
  if (!(sample > 0) || random() >= sample) return;
  const u = o.usage;
  const site = u.site ? publicHost(u.site) : null;
  if (u.site && !site) return; // private host: nothing recorded
  const client = cleanText(req.headers.get('x-scoop-client') ?? '', 60) || null;
  const hit = u.hit ?? (o.status === 404 ? false : undefined);
  const props: Record<string, unknown> = { route, status: o.status, latencyMs: Math.max(0, Math.round(o.latencyMs)) };
  if (u.q) props.q = cleanText(u.q, 200);
  if (u.topic) props.topic = cleanText(u.topic, 200);
  if (u.results !== undefined) props.results = u.results;
  if (hit !== undefined) props.hit = hit;
  if (client) props.client = client;
  const parsed = parseUa(req.headers.get('user-agent'));
  const at = now.toISOString();
  const row: TelemetryRow = {
    id: `api_${ulid(now.getTime())}`,
    source: 'api',
    name,
    ts: at,
    day: at.slice(0, 10),
    received_at: at,
    install_id: null,
    session_id: null,
    visitor_id: null,
    seq: null,
    site,
    path: null,
    outcome: outcomeOf(name, props),
    props: JSON.stringify(props),
    ext_version: /^extension\/([\w.-]{1,32})$/.exec(client ?? '')?.[1] ?? null,
    browser: null,
    browser_version: null,
    os: null,
    arch: null,
    locale: null,
    timezone: null,
    ua_browser: parsed.browser,
    ua_os: parsed.os,
    ...geoOf(req),
    ip_hash: null,
  };
  await env.TELEMETRY_QUEUE.send({ v: 1, rows: [row] } satisfies TelemetryMessage, { contentType: 'json' });
}
