// On-demand crawls asked for by the extension (docs/BACKEND.md §5,
// "Crawl requests"): when a user opens the popup on a docs site the library
// hasn't crawled, POST /v1/crawl-requests starts a small crawl (or joins the
// one already running), and the popup polls GET /v1/crawl-requests/:id until
// the pages are indexed. Requests are recorded in crawl_requests
// (migrations/0008_crawl_requests.sql); their live state comes from the run.

import { CrawlStore, STALE_RUN_HOURS } from '../db/crawl.ts';
import type { CrawlRunRow, SiteProfileRow } from '../db/crawl.ts';
import { checkDaily, hmacHex, ipSubject } from '../db/ratelimit.ts';
import { ulid } from '../lib/ids.ts';
import { startCrawl } from './start.ts';
import type { StartDeps } from './start.ts';

// A requested crawl is small: enough pages to answer the user's question soon.
export const REQUEST_MAX_PAGES = 100;
export const REQUEST_MAX_MINUTES = 10;
// A site crawled this recently is served as it is: no new crawl.
export const COOLDOWN_DAYS = 7;
// Requests that start a crawl, per UTC day: per install, per IP subject, and
// for everyone (CRAWL_REQUESTS_DAILY_MAX).
export const REQUEST_LIMITS = { install: 5, ip: 15 };
export const DEFAULT_REQUESTS_DAILY_MAX = 300;
export const LIMIT_BUCKETS = { install: 'crawlreq:install', ip: 'crawlreq:ip', global: 'crawlreq:all' } as const;
// A finished run whose pages haven't all been indexed after this long (a
// message went to the dead-letter queue) is reported complete anyway.
const INDEXING_GRACE_MS = 30 * 60_000;

export type RequestState = 'queued' | 'running' | 'indexing' | 'complete' | 'rejected' | 'failed';
export type Phase = 'gate' | 'discover' | 'fetch' | 'browser' | 'index' | 'done';
// What the request did when it was made (crawl_requests.state).
export type Outcome = 'started' | 'joined' | 'recent' | 'rejected';

export interface RequestRow {
  id: string;
  site: string;
  url: string;
  install_hash: string;
  run_id: string | null;
  state: Outcome;
  reason: string | null;
  created_at: string;
  day: string;
}

export interface RequestView {
  id: string;
  site: string;
  state: RequestState;
  phase: Phase;
  pagesFound: number;
  pagesIndexed: number;
  path: string | null;
  reason: string | null;
  etaSeconds: number;
}

// Where a crawl for this page starts: the page's first path segment when it
// has a deeper path (developers.cloudflare.com/d1/…, docs.python.org/3/…),
// which scopes the crawl to that product's docs; else the site's root.
export function startUrlFor(pageUrl: string): string {
  const u = new URL(pageUrl);
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length >= 2 && !/\.[a-z0-9]{1,5}$/i.test(segs[0])) return `${u.origin}/${segs[0]}/`;
  return `${u.origin}/`;
}

// A rough wait, for a progress message; never a promise. A requested crawl is
// at most 100 pages at about 1 page/s, then indexing at a few seconds a page.
export function etaSeconds(state: RequestState, phase: Phase, found: number, stored: number, indexed: number): number {
  if (state === 'complete' || state === 'rejected' || state === 'failed') return 0;
  const indexing = Math.max(0, stored - indexed) * 4;
  switch (phase) {
    case 'gate': return state === 'queued' ? 300 : 270;
    case 'discover': return 240;
    case 'fetch': return Math.round(Math.max(0, REQUEST_MAX_PAGES - found) * 1.2) + Math.max(indexing, 60);
    case 'browser': return REQUEST_MAX_MINUTES * 60;
    case 'index': return Math.max(10, indexing);
    default: return 0;
  }
}

// A request's live state, from its run. `now` decides when an unfinished run
// counts as abandoned and when an indexing tail is given up on.
export function viewOf(req: Pick<RequestRow, 'id' | 'site' | 'state' | 'reason'>, run: CrawlRunRow | null, now = new Date()): RequestView {
  const view = (state: RequestState, phase: Phase, extra: Partial<RequestView> = {}): RequestView => {
    const found = run ? run.pages_new + run.pages_changed + run.pages_unchanged : 0;
    const stored = run ? run.pages_new + run.pages_changed : 0;
    // Unchanged pages were indexed by an earlier crawl.
    const indexed = run ? Math.min(found, run.pages_indexed + run.pages_unchanged) : 0;
    return {
      id: req.id,
      site: req.site,
      state,
      phase,
      pagesFound: found,
      pagesIndexed: state === 'complete' ? found : indexed,
      path: run?.path ?? null,
      reason: null,
      etaSeconds: etaSeconds(state, phase, found, stored, run ? run.pages_indexed : 0),
      ...extra,
    };
  };
  if (!run) return view(req.state === 'rejected' ? 'rejected' : 'failed', 'done', { reason: req.reason ?? 'no crawl' });
  const phase = (run.phase ?? 'gate') as Phase;
  switch (run.status) {
    case 'queued':
    case 'running': {
      if (Date.parse(run.started_at) < now.getTime() - STALE_RUN_HOURS * 3_600_000) return view('failed', phase, { reason: 'crawl abandoned' });
      return view(run.status === 'queued' ? 'queued' : 'running', run.status === 'queued' ? 'gate' : phase);
    }
    case 'rejected':
      return view('rejected', 'done', { reason: run.gate_reason ?? run.error ?? 'not a developer documentation site' });
    case 'failed':
      return view('failed', phase === 'done' ? 'done' : phase, { reason: run.error ?? 'crawl failed' });
    default: {
      // complete: indexing until every stored page is indexed (or the grace period passed).
      const stored = run.pages_new + run.pages_changed;
      const finished = Date.parse(run.finished_at ?? run.started_at);
      const waiting = Boolean(run.costs_tracked) && run.pages_indexed < stored && now.getTime() - finished < INDEXING_GRACE_MS;
      return waiting ? view('indexing', 'index') : view('complete', 'done');
    }
  }
}

export interface RequestDeps extends StartDeps {
  rateKey: string | undefined;
  dailyMax: number;
  now?: Date;
}

export interface RequestInput {
  pageUrl: string; // normalised, already checked by the SSRF guard
  site: string;
  install: string;
  ip: string;
}

export const installHash = (rateKey: string, install: string) => hmacHex(rateKey, `crawl-request:${install}`);

async function activeRun(db: D1Database, site: string, now: Date): Promise<CrawlRunRow | null> {
  const since = new Date(now.getTime() - STALE_RUN_HOURS * 3_600_000).toISOString();
  return db
    .prepare(`SELECT * FROM crawl_runs WHERE site = ? AND status IN ('queued', 'running') AND started_at > ? ORDER BY started_at DESC LIMIT 1`)
    .bind(site, since)
    .first<CrawlRunRow>();
}

async function lastComplete(db: D1Database, site: string): Promise<CrawlRunRow | null> {
  return db.prepare(`SELECT * FROM crawl_runs WHERE site = ? AND status = 'complete' ORDER BY finished_at DESC LIMIT 1`).bind(site).first<CrawlRunRow>();
}

const RECENT_STATUSES = new Set(['ready', 'empty', 'blocked']);

// Handles POST /v1/crawl-requests after validation. 202 when it starts a
// crawl; 200 when it joins a queued/running one, when the site was crawled in
// the last COOLDOWN_DAYS, or when the site is not a devtool site. Only a
// request that would start a crawl counts toward the daily limits (429 past
// them, not recorded).
export async function requestCrawl(d: RequestDeps, input: RequestInput): Promise<{ status: 200 | 202; body: RequestView; outcome: Outcome }> {
  const now = d.now ?? new Date();
  if (!d.rateKey) throw new Error('RATE_KEY is not set');
  const hash = await installHash(d.rateKey, input.install);
  const store = new CrawlStore(d.db, d.bucket);
  const record = async (outcome: Outcome, run: CrawlRunRow | null, reason: string | null = null) => {
    const row: RequestRow = {
      id: `rq_${ulid(now.getTime())}`,
      site: input.site,
      url: input.pageUrl,
      install_hash: hash,
      run_id: run?.id ?? null,
      state: outcome,
      reason,
      created_at: now.toISOString(),
      day: now.toISOString().slice(0, 10),
    };
    await d.db
      .prepare('INSERT INTO crawl_requests (id, site, url, install_hash, run_id, state, reason, created_at, day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(row.id, row.site, row.url, row.install_hash, row.run_id, row.state, row.reason, row.created_at, row.day)
      .run();
    return row;
  };
  const answer = async (outcome: Exclude<Outcome, 'started'>, run: CrawlRunRow | null, reason: string | null = null) => {
    const row = await record(outcome, run, reason);
    return { status: 200 as const, body: viewOf(row, run, now), outcome };
  };

  const running = await activeRun(d.db, input.site, now);
  if (running) return answer('joined', running);

  const profile: SiteProfileRow | null = await store.getProfile(input.site);
  if (profile?.status === 'not_devtool') {
    const run = profile.last_run_id ? await store.getRun(profile.last_run_id) : null;
    return answer('rejected', run?.status === 'rejected' ? run : null, profile.gate_reason ?? 'not a developer documentation site');
  }
  const cooldown = now.getTime() - COOLDOWN_DAYS * 86_400_000;
  if (profile && RECENT_STATUSES.has(profile.status) && profile.last_crawled_at && Date.parse(profile.last_crawled_at) > cooldown) {
    const run = await lastComplete(d.db, input.site);
    if (run) return answer('recent', run);
  }

  await checkDaily(d.db, d.rateKey, [
    { bucket: LIMIT_BUCKETS.install, subject: input.install, limit: REQUEST_LIMITS.install },
    { bucket: LIMIT_BUCKETS.ip, subject: ipSubject(input.ip), limit: REQUEST_LIMITS.ip },
    { bucket: LIMIT_BUCKETS.global, subject: '', limit: d.dailyMax },
  ], now.getTime());

  const runId = await startCrawl(d, {
    site: input.site,
    startUrl: startUrlFor(input.pageUrl),
    maxPages: REQUEST_MAX_PAGES,
    maxMinutes: REQUEST_MAX_MINUTES,
    force: false,
  });
  // Another request started one between our check and ours: join it.
  if (!runId) return answer('joined', await activeRun(d.db, input.site, now));
  const run = await store.getRun(runId);
  const row = await record('started', run);
  return { status: 202, body: viewOf(row, run, now), outcome: 'started' };
}

export async function getRequest(db: D1Database, id: string): Promise<RequestRow | null> {
  return db.prepare('SELECT * FROM crawl_requests WHERE id = ?').bind(id).first<RequestRow>();
}

export async function requestView(db: D1Database, id: string, now = new Date()): Promise<RequestView | null> {
  const req = await getRequest(db, id);
  if (!req) return null;
  const run = req.run_id ? await db.prepare('SELECT * FROM crawl_runs WHERE id = ?').bind(req.run_id).first<CrawlRunRow>() : null;
  return viewOf(req, run, now);
}

export interface SiteStatus {
  site: string;
  indexed: boolean;
  status: string;
  crawling: boolean;
  pages: number;
  lastCrawledAt: string | null;
  request: Pick<RequestView, 'id' | 'state' | 'phase' | 'pagesFound' | 'pagesIndexed'> | null;
}

// GET /v1/sites/:site/status: what the library has for a site, and the most
// recent crawl request for it (within the cooldown), for the popup's
// "crawl this site?" decision. Unknown sites are status 'new'.
export async function siteStatus(db: D1Database, site: string, now = new Date()): Promise<SiteStatus> {
  const since = new Date(now.getTime() - COOLDOWN_DAYS * 86_400_000).toISOString();
  const [profileRes, pagesRes, reqRes] = await db.batch([
    db.prepare('SELECT * FROM site_profiles WHERE site = ?').bind(site),
    db.prepare('SELECT COUNT(*) AS n FROM page_index WHERE site = ?').bind(site),
    db.prepare('SELECT * FROM crawl_requests WHERE site = ? AND created_at > ? ORDER BY created_at DESC, id DESC LIMIT 1').bind(site, since),
  ]);
  const profile = (profileRes.results[0] as SiteProfileRow | undefined) ?? null;
  const pages = Number((pagesRes.results[0] as { n: number } | undefined)?.n ?? 0);
  const req = (reqRes.results[0] as RequestRow | undefined) ?? null;
  let request: SiteStatus['request'] = null;
  if (req) {
    const run = req.run_id ? await db.prepare('SELECT * FROM crawl_runs WHERE id = ?').bind(req.run_id).first<CrawlRunRow>() : null;
    const v = viewOf(req, run, now);
    request = { id: v.id, state: v.state, phase: v.phase, pagesFound: v.pagesFound, pagesIndexed: v.pagesIndexed };
  }
  const status = profile?.status ?? 'new';
  const fresh = profile ? Date.parse(profile.updated_at) > now.getTime() - STALE_RUN_HOURS * 3_600_000 : false;
  return {
    site,
    indexed: status === 'ready' && pages > 0,
    status,
    crawling: profile?.crawl_state === 'crawling' && fresh,
    pages,
    lastCrawledAt: profile?.last_crawled_at ?? null,
    request,
  };
}
