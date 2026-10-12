// Polite, SSRF-checked fetching for the crawler: at most `concurrency` requests
// (including their body reads) in flight per host and at least `intervalMs`
// between request starts,
// conditional requests (ETag / Last-Modified), manual same-site redirects with
// the SSRF guard on every hop, a timeout and a read cap. Plain fetch, so it
// runs in a Worker, a Workflow step or Node.

import { assertFetchable, normalizeSite } from '../lib/ssrf.ts';
import { CRAWLER_UA } from './robots.ts';
import { gunzipText } from './sitemap.ts';

export const PAGE_CAP = 2_000_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// Per-host politeness. Start times are reserved in order, so callers are
// spaced `intervalMs` apart even when they arrive together.
export class HostLimiter {
  concurrency: number;
  intervalMs: number;
  clock: Clock;
  // When the next request may start (ms). Carry it across Workflow steps so
  // a new step doesn't fire right after the last one's final request.
  nextStart: number;
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor({ concurrency = 2, intervalMs = 1000, clock = realClock, nextStart = 0 } = {}) {
    this.concurrency = concurrency;
    this.intervalMs = intervalMs;
    this.clock = clock;
    this.nextStart = nextStart;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.concurrency) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      const now = this.clock.now();
      const start = Math.max(now, this.nextStart);
      this.nextStart = start + this.intervalMs;
      if (start > now) await this.clock.sleep(start - now);
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

// Crawl-delay is honoured above our 1 s default, up to 10 s; a site asking for
// more gets 10 s and, in practice, fewer pages per run.
export function intervalFor(crawlDelay: number | null, defaultMs = 1000): number {
  if (crawlDelay === null) return defaultMs;
  return Math.min(10_000, Math.max(defaultMs, Math.round(crawlDelay * 1000)));
}

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export interface CrawlFetchOptions {
  limiter: HostLimiter;
  fetchImpl?: FetchImpl;
  allowLocalhost?: boolean;
  etag?: string | null;
  lastModified?: string | null;
  cap?: number;
  // robots.txt check for each redirect hop (the caller checks the first URL).
  allowed?: (pathAndQuery: string) => boolean;
  timeoutMs?: number;
}

export type CrawlFetch =
  | { ok: true; notModified: true; url: string; status: 304; etag: string | null; lastModified: string | null }
  | {
      ok: true;
      notModified: false;
      url: string;
      status: number;
      contentType: string;
      text: string;
      over: boolean;
      etag: string | null;
      lastModified: string | null;
    }
  | { ok: false; url: string; status: number | null; reason: string; skipped?: boolean };

// Reads a body up to `cap` bytes; `over` when it is longer (the rest is never read).
export async function readBytes(res: Response, cap: number): Promise<{ bytes: Uint8Array; over: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), over: false };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return { bytes: concat(parts), over: true };
    }
    parts.push(value);
  }
  return { bytes: concat(parts), over: false };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

// Longest URL the crawler fetches or stores (plans, pages, queue messages).
export const MAX_URL = 1024;

type Hop =
  | { redirect: string; status: number }
  | { redirect: null; result: CrawlFetch };

// GET `url` politely. Never throws: failures come back as { ok: false }; those
// the site's own rules cause (robots.txt, a redirect off the site) are marked
// `skipped` rather than failed.
export async function crawlFetch(url: string, o: CrawlFetchOptions): Promise<CrawlFetch> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const cap = o.cap ?? PAGE_CAP;
  if (url.length > MAX_URL) return { ok: false, url, status: null, reason: `URL longer than ${MAX_URL}`, skipped: true };
  let current: URL;
  try {
    current = assertFetchable(url, { allowLocalhost: o.allowLocalhost });
  } catch (e) {
    return { ok: false, url, status: null, reason: (e as Error).message };
  }
  const site = normalizeSite(current.hostname);
  const headers: Record<string, string> = { 'user-agent': CRAWLER_UA, accept: 'text/markdown, text/plain;q=0.9, */*;q=0.5' };
  if (o.etag) headers['if-none-match'] = o.etag;
  if (o.lastModified) headers['if-modified-since'] = o.lastModified;

  // One hop: request and body read both happen inside the limiter (so a slow
  // body still holds its concurrency slot), under a timeout that starts after
  // the politeness wait, not before it.
  const hop = (target: URL) =>
    o.limiter.run(async (): Promise<Hop> => {
      const signal = AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchImpl(target.href, { redirect: 'manual', headers, signal });
      } catch (e) {
        return { redirect: null, result: { ok: false, url, status: null, reason: `fetch failed: ${(e as Error).message}` } };
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && res.status !== 304 && location) {
        await res.body?.cancel();
        return { redirect: location, status: res.status };
      }
      const etag = res.headers.get('etag');
      const lastModified = res.headers.get('last-modified');
      if (res.status === 304) {
        return { redirect: null, result: { ok: true, notModified: true, url: target.href, status: 304, etag: etag ?? o.etag ?? null, lastModified: lastModified ?? o.lastModified ?? null } };
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { redirect: null, result: { ok: false, url, status: res.status, reason: `HTTP ${res.status}` } };
      }
      const contentType = res.headers.get('content-type') || '';
      if (Number(res.headers.get('content-length')) > cap) {
        await res.body?.cancel();
        return { redirect: null, result: { ok: true, notModified: false, url: target.href, status: res.status, contentType, text: '', over: true, etag, lastModified } };
      }
      try {
        const { bytes, over } = await readBytes(res, cap);
        // sitemap.xml.gz and friends: gzip bytes, not a gzip transfer encoding.
        if (!over && bytes[0] === 0x1f && bytes[1] === 0x8b) {
          const unzipped = await gunzipText(bytes, cap);
          return { redirect: null, result: { ok: true, notModified: false, url: target.href, status: res.status, contentType, ...unzipped, etag, lastModified } };
        }
        return { redirect: null, result: { ok: true, notModified: false, url: target.href, status: res.status, contentType, text: new TextDecoder().decode(bytes), over, etag, lastModified } };
      } catch (e) {
        return { redirect: null, result: { ok: false, url, status: res.status, reason: `read failed: ${(e as Error).message}` } };
      }
    });

  for (let n = 0; n <= MAX_REDIRECTS; n++) {
    const h = await hop(current);
    if (h.redirect === null) return h.result;
    let next: URL;
    try {
      next = assertFetchable(new URL(h.redirect, current).href, { allowLocalhost: o.allowLocalhost });
    } catch {
      return { ok: false, url, status: h.status, reason: 'redirect to a URL that may not be fetched' };
    }
    if (next.href.length > MAX_URL) return { ok: false, url, status: h.status, reason: `redirect URL longer than ${MAX_URL}`, skipped: true };
    if (normalizeSite(next.hostname) !== site) return { ok: false, url, status: h.status, reason: `redirects off site (${next.origin})`, skipped: true };
    if (o.allowed && !o.allowed(next.pathname + next.search)) return { ok: false, url, status: h.status, reason: 'redirect target disallowed by robots.txt', skipped: true };
    current = next;
  }
  return { ok: false, url, status: null, reason: 'too many redirects' };
}
