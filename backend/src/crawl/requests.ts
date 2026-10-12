// On-demand crawls asked for by the extension (docs/BACKEND.md §5,
// "Crawl requests"): when a user opens the popup on a docs site the library
// hasn't crawled, POST /v1/crawl-requests starts a small crawl (or joins the
// one already running), and the popup polls GET /v1/crawl-requests/:id until
// the pages are indexed. Requests are recorded in crawl_requests
// (migrations/0008_crawl_requests.sql); their live state comes from the run.

import { CrawlStore, STALE_RUN_HOURS } from '../db/crawl.ts';
import { normalizeSite } from '../lib/ssrf.ts';
import type { CrawlRunRow, SiteProfileRow } from '../db/crawl.ts';
import { adjustDaily, checkDaily, hmacHex, ipSubject } from '../db/ratelimit.ts';
import { ApiError } from '../lib/errors.ts';
import { ulid } from '../lib/ids.ts';
import { ALL_SITES } from '../index/indexer.ts';
import { listVerdict } from './gate.ts';
import { startCrawl } from './start.ts';
import type { StartDeps } from './start.ts';

// A requested crawl is small: enough pages to answer the user's question soon.
export const REQUEST_MAX_PAGES = 100;
export const REQUEST_MAX_MINUTES = 10;
// A site crawled this recently is served as it is: no new crawl.
export const COOLDOWN_DAYS = 7;
// Requests that start (or queue) a crawl, per UTC day: per install, per IP
// subject (IPv6 by /48), and for everyone (CRAWL_REQUESTS_DAILY_MAX). Joins,
// recent answers and rejections are free.
export const REQUEST_LIMITS = { install: 5, ip: 15 };
export const DEFAULT_REQUESTS_DAILY_MAX = 300;
// Share of the daily E2B and index caps that requested crawls may use
// (ONDEMAND_E2B_SHARE, ONDEMAND_INDEX_SHARE); the rest is headroom for admins.
export const DEFAULT_ONDEMAND_SHARE = 0.5;
export function ondemandShare(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_ONDEMAND_SHARE;
}
// Public reasons for a failed request; the run's own error is admin-only.
export const PUBLIC_REASONS = {
  failed: 'crawl failed',
  browser: "this site needs a browser and that's unavailable right now",
  busy: 'busy, try again later',
} as const;
export const LIMIT_BUCKETS = { install: 'crawlreq:install', ip: 'crawlreq:ip', global: 'crawlreq:all' } as const;
// A finished run whose pages haven't all been indexed after this long (a
// message went to the dead-letter queue) is reported complete anyway.
// (A page whose indexing was skipped or failed for good counts as done; this
// only covers what wasn't recorded at all.) Measured from the crawl's end or
// its last index progress, whichever is later.
const INDEXING_GRACE_MS = 5 * 60_000;

export type RequestState = 'queued' | 'running' | 'indexing' | 'complete' | 'rejected' | 'failed';
export type Phase = 'gate' | 'discover' | 'fetch' | 'browser' | 'index' | 'done';
// What the request did when it was made (crawl_requests.state). 'waiting':
// another scope of the site was crawling; the crawl starts after it, and the
// row becomes 'started'.
export type Outcome = 'started' | 'joined' | 'recent' | 'rejected' | 'waiting';

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
  start_url: string | null; // the scope its crawl covers
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

// A rough wait, for a progress message; never a promise. Fetching runs at
// about 1 page/s and indexing at about 8 s a page (classification dominates;
// measured locally at 10-12 s with one consumer). Before the page count is
// known, a requested crawl is assumed to find EXPECTED_PAGES (the D1 docs
// gave 55).
const FETCH_S = 1.2;
const INDEX_S = 8;
const EXPECTED_PAGES = 60;
export function etaSeconds(state: RequestState, phase: Phase, found: number, stored: number, indexed: number): number {
  if (state === 'complete' || state === 'rejected' || state === 'failed') return 0;
  const discover = 30 + Math.round(EXPECTED_PAGES * (FETCH_S + INDEX_S));
  switch (phase) {
    case 'gate': return 30 + discover;
    case 'discover': return discover;
    case 'fetch': return Math.round(Math.max(0, EXPECTED_PAGES - found) * FETCH_S + Math.max(0, Math.max(EXPECTED_PAGES, stored) - indexed) * INDEX_S);
    case 'browser': return REQUEST_MAX_MINUTES * 60 + EXPECTED_PAGES * INDEX_S;
    case 'index': return Math.max(10, Math.max(0, stored - indexed) * INDEX_S);
    default: return 0;
  }
}

// What a user is told about a failed run: one of PUBLIC_REASONS. The raw
// error (internal names, caps, stack-ish text) is for the admin console only.
export function publicReason(error: string | null): string {
  const e = error ?? '';
  if (/E2B|browser|sandbox/i.test(e)) return PUBLIC_REASONS.browser;
  if (/cap\b|cap reached|budget|busy|undecided|devtool gate|OpenRouter|\brate[_ -]?limit/i.test(e)) return PUBLIC_REASONS.busy;
  return PUBLIC_REASONS.failed;
}

// A request's live state, from its run. `now` decides when an unfinished run
// counts as abandoned and when an indexing tail is given up on.
export function viewOf(req: Pick<RequestRow, 'id' | 'site' | 'state' | 'reason' | 'created_at'>, run: CrawlRunRow | null, now = new Date()): RequestView {
  const view = (state: RequestState, phase: Phase, extra: Partial<RequestView> = {}): RequestView => {
    const found = run ? run.pages_new + run.pages_changed + run.pages_unchanged : 0;
    const stored = run ? run.pages_new + run.pages_changed : 0;
    // Unchanged pages were indexed by an earlier crawl.
    // Pages that reached an outcome: indexed, or skipped/failed for good.
    const indexed = run ? Math.min(found, run.pages_indexed + run.pages_index_failed + run.pages_unchanged) : 0;
    return {
      id: req.id,
      site: req.site,
      state,
      phase,
      pagesFound: found,
      pagesIndexed: state === 'complete' ? found : indexed,
      path: run?.path ?? null,
      reason: null,
      etaSeconds: etaSeconds(state, phase, found, stored, run ? run.pages_indexed + run.pages_index_failed : 0),
      ...extra,
    };
  };
  if (!run) {
    if (req.state === 'rejected') return view('rejected', 'done', { reason: req.reason ?? 'not a developer documentation site' });
    // Waiting for another scope of the site to finish crawling.
    if (req.state === 'waiting' && Date.parse(req.created_at) > now.getTime() - STALE_RUN_HOURS * 3_600_000) return view('queued', 'gate');
    return view('failed', 'done', { reason: req.state === 'waiting' ? PUBLIC_REASONS.busy : PUBLIC_REASONS.failed });
  }
  const phase = (run.phase ?? 'gate') as Phase;
  switch (run.status) {
    case 'queued':
    case 'running': {
      if (Date.parse(run.started_at) < now.getTime() - STALE_RUN_HOURS * 3_600_000) return view('failed', phase, { reason: PUBLIC_REASONS.failed });
      return view(run.status === 'queued' ? 'queued' : 'running', run.status === 'queued' ? 'gate' : phase);
    }
    case 'rejected':
      return view('rejected', 'done', { reason: run.gate_reason ?? run.error ?? 'not a developer documentation site' });
    case 'failed':
      return view('failed', phase === 'done' ? 'done' : phase, { reason: publicReason(run.error) });
    default: {
      // complete: indexing until every stored page is indexed (or the grace period passed).
      const stored = run.pages_new + run.pages_changed;
      const finished = Date.parse(run.finished_at ?? run.started_at);
      const progress = Math.max(finished, run.index_progress_at ? Date.parse(run.index_progress_at) : 0);
      const waiting = Boolean(run.costs_tracked) && run.pages_indexed + run.pages_index_failed < stored && now.getTime() - progress < INDEXING_GRACE_MS;
      return waiting ? view('indexing', 'index') : view('complete', 'done');
    }
  }
}

export interface RequestDeps extends StartDeps {
  rateKey: string | undefined;
  dailyMax: number;
  // The daily caps and the share of them requested crawls may use.
  e2bCapUsd: number;
  indexTotalCapUsd: number;
  e2bShare: number;
  indexShare: number;
  now?: Date;
}

export interface RequestInput {
  pageUrl: string; // normalised, already checked by the SSRF guard
  site: string;
  install: string;
  ip: string;
}

export const installHash = (rateKey: string, install: string) => hmacHex(rateKey, `crawl-request:${install}`);

// The IP subject for crawl-request limits: IPv4 as is, IPv6 by its /48 (a
// site's usual allocation, wider than the /64 the other limits use).
export function requestIpSubject(ip: string): string {
  const s = ipSubject(ip);
  return s.endsWith('::/64') ? `${s.slice(0, -5).split(':').slice(0, 3).join(':')}::/48` : s;
}

async function activeRun(db: D1Database, site: string, now: Date): Promise<CrawlRunRow | null> {
  const since = new Date(now.getTime() - STALE_RUN_HOURS * 3_600_000).toISOString();
  return db
    .prepare(`SELECT * FROM crawl_runs WHERE site = ? AND status IN ('queued', 'running') AND started_at > ? ORDER BY started_at DESC LIMIT 1`)
    .bind(site, since)
    .first<CrawlRunRow>();
}

// A scope compared by site and path: www.docs.example.dev/ and
// docs.example.dev/ are the same scope.
export function scopeKey(startUrl: string): string {
  const u = new URL(startUrl);
  return `${normalizeSite(u.hostname)}${u.pathname.replace(/\/+$/, '') || '/'}`;
}

// The last complete crawl of this scope (or, without a scope, of the site).
async function lastComplete(db: D1Database, site: string, scope?: string): Promise<CrawlRunRow | null> {
  const { results } = await db
    .prepare(`SELECT * FROM crawl_runs WHERE site = ? AND status = 'complete' ORDER BY finished_at DESC LIMIT 50`)
    .bind(site)
    .all<CrawlRunRow>();
  return results.find((r) => !scope || scopeKey(r.start_url) === scopeKey(scope)) ?? null;
}

const ACTIVE_STATES = new Set<RequestState>(['queued', 'running', 'indexing']);
const DAY_MS = 86_400_000;
const nextMidnight = (now: Date) => Math.max(1, Math.ceil((Math.floor(now.getTime() / DAY_MS + 1) * DAY_MS - now.getTime()) / 1000));

function busy(now: Date): ApiError {
  const err = new ApiError('rate_limited', PUBLIC_REASONS.busy, 429);
  err.retryAfter = nextMidnight(now);
  return err;
}

// What requested crawls spent today: sandbox time (reservations included) and
// AI (classification of their pages, and their gate checks).
export async function ondemandSpentToday(db: D1Database, now = new Date()): Promise<{ e2bUsd: number; indexUsd: number }> {
  const day = now.toISOString().slice(0, 10);
  const [runs, index] = await db.batch([
    db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS e2b, COALESCE(SUM(gate_cost_usd), 0) AS gate FROM crawl_runs WHERE requested = 1 AND started_at >= ?`).bind(day),
    db.prepare(
      `SELECT COALESCE(SUM(c.classify_cost_usd), 0) AS usd FROM index_run_costs c JOIN crawl_runs r ON r.id = c.run_id
       WHERE r.requested = 1 AND c.updated_at >= ?`,
    ).bind(day),
  ]);
  const r = runs.results[0] as { e2b: number; gate: number };
  return { e2bUsd: r.e2b, indexUsd: r.gate + (index.results[0] as { usd: number }).usd };
}

// Handles POST /v1/crawl-requests after validation, cheapest checks first:
// 1. the gate's lists (a denylisted site is rejected at no cost);
// 2. a not_devtool site is rejected;
// 3. a crawl of the same scope already queued/running is joined, and a
//    scope crawled completely in the last COOLDOWN_DAYS is answered as it is;
// 4. requested crawls' share of today's E2B and AI spend (429 'busy' past it);
// 5. the per-install and per-IP daily limits (429), then the global one,
//    counted only for a crawl that really starts or waits to start, and given
//    back if none does.
// A crawl of another scope of the site running means this scope waits
// (state 'waiting'), started by startWaiting() once the site is free.
export async function requestCrawl(d: RequestDeps, input: RequestInput): Promise<{ status: 200 | 202; body: RequestView; outcome: Outcome }> {
  const now = d.now ?? new Date();
  if (!d.rateKey) throw new Error('RATE_KEY is not set');
  const hash = await installHash(d.rateKey, input.install);
  const scope = startUrlFor(input.pageUrl);
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
      start_url: scope,
    };
    await d.db
      .prepare('INSERT INTO crawl_requests (id, site, url, install_hash, run_id, state, reason, created_at, day, start_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(row.id, row.site, row.url, row.install_hash, row.run_id, row.state, row.reason, row.created_at, row.day, row.start_url)
      .run();
    return row;
  };
  const answer = async (outcome: Exclude<Outcome, 'started' | 'waiting'>, run: CrawlRunRow | null, reason: string | null = null) => {
    const row = await record(outcome, run, reason);
    return { status: 200 as const, body: viewOf(row, run, now), outcome };
  };
  const queued = async (outcome: 'started' | 'waiting', run: CrawlRunRow | null) => {
    const row = await record(outcome, run);
    return { status: 202 as const, body: viewOf(row, run, now), outcome };
  };

  // 1-2. Known non-devtool sites cost nothing.
  const listed = listVerdict(scope);
  if (listed?.decision === 'reject') return answer('rejected', null, listed.reason);
  const profile: SiteProfileRow | null = await store.getProfile(input.site);
  if (profile?.status === 'not_devtool') {
    const run = profile.last_run_id ? await store.getRun(profile.last_run_id) : null;
    return answer('rejected', run?.status === 'rejected' ? run : null, profile.gate_reason ?? 'not a developer documentation site');
  }

  // 3. Join or answer from this scope's crawls.
  const running = await activeRun(d.db, input.site, now);
  if (running && scopeKey(running.start_url) === scopeKey(scope)) return answer('joined', running);
  const recent = await lastComplete(d.db, input.site, scope);
  if (recent?.finished_at && Date.parse(recent.finished_at) > now.getTime() - COOLDOWN_DAYS * DAY_MS) return answer('recent', recent);
  // Another request already waits for this scope: wait with it, at no cost.
  const { results: waitingRows } = await d.db
    .prepare(`SELECT start_url FROM crawl_requests WHERE site = ? AND state = 'waiting' AND created_at > ? LIMIT 50`)
    .bind(input.site, new Date(now.getTime() - STALE_RUN_HOURS * 3_600_000).toISOString())
    .all<{ start_url: string | null }>();
  if (waitingRows.some((w) => w.start_url && scopeKey(w.start_url) === scopeKey(scope))) {
    const row = await record('waiting', null);
    return { status: 200 as const, body: viewOf(row, null, now), outcome: 'waiting' as const };
  }

  // 4. Headroom for admin crawls.
  const spent = await ondemandSpentToday(d.db, now);
  if ((d.e2bCapUsd > 0 && spent.e2bUsd >= d.e2bCapUsd * d.e2bShare) || (d.indexTotalCapUsd > 0 && spent.indexUsd >= d.indexTotalCapUsd * d.indexShare)) throw busy(now);

  // 5. Per install and per IP subject, then globally only for a real start.
  const ipKey = requestIpSubject(input.ip);
  await checkDaily(d.db, d.rateKey, [
    { bucket: LIMIT_BUCKETS.install, subject: input.install, limit: REQUEST_LIMITS.install },
    { bucket: LIMIT_BUCKETS.ip, subject: ipKey, limit: REQUEST_LIMITS.ip },
  ], now.getTime());
  const giveBack = async (global: boolean) => {
    await adjustDaily(d.db, d.rateKey, LIMIT_BUCKETS.install, input.install, -1, now.getTime());
    await adjustDaily(d.db, d.rateKey, LIMIT_BUCKETS.ip, ipKey, -1, now.getTime());
    if (global) await adjustDaily(d.db, d.rateKey, LIMIT_BUCKETS.global, '', -1, now.getTime());
  };
  if ((await adjustDaily(d.db, d.rateKey, LIMIT_BUCKETS.global, '', 1, now.getTime())) > d.dailyMax) {
    await giveBack(true);
    throw busy(now);
  }

  // Another scope of the site is crawling: this one starts after it.
  if (running) return queued('waiting', null);
  let runId: string | null;
  try {
    runId = await startCrawl(d, requestedCrawl(input.site, scope, input.pageUrl));
  } catch (e) {
    // The Workflow couldn't be created: nothing started, so nothing is counted.
    await giveBack(true);
    throw e;
  }
  if (runId) return queued('started', await store.getRun(runId));

  // Lost a race: another crawl of the site started in between.
  const now2 = await activeRun(d.db, input.site, now);
  if (now2 && scopeKey(now2.start_url) !== scopeKey(scope)) return queued('waiting', null);
  await giveBack(true);
  return answer('joined', now2 ?? (await lastComplete(d.db, input.site, scope)) ?? (await lastComplete(d.db, input.site)));
}

const requestedCrawl = (site: string, scope: string, pageUrl: string) => ({
  site,
  startUrl: scope,
  maxPages: REQUEST_MAX_PAGES,
  maxMinutes: REQUEST_MAX_MINUTES,
  force: false,
  requested: true,
  // The page the user is on is always crawled, first, so it anchors their package.
  priorityUrl: pageUrl,
});

// Starts the oldest waiting scope of a site once no crawl of it is running,
// and points every request waiting for that scope at the new run. Called when
// a waiting request is polled; harmless to call any time.
export async function startWaiting(d: StartDeps, site: string, now = new Date()): Promise<void> {
  if (await activeRun(d.db, site, now)) return;
  const since = new Date(now.getTime() - STALE_RUN_HOURS * 3_600_000).toISOString();
  const next = await d.db
    .prepare(`SELECT * FROM crawl_requests WHERE site = ? AND state = 'waiting' AND created_at > ? ORDER BY created_at, id LIMIT 1`)
    .bind(site, since)
    .first<RequestRow>();
  if (!next?.start_url) return;
  const runId = await startCrawl(d, requestedCrawl(site, next.start_url, next.url));
  if (!runId) return; // someone else started a crawl; the next poll tries again
  const { results: waiting } = await d.db
    .prepare(`SELECT id, start_url FROM crawl_requests WHERE site = ? AND state = 'waiting'`)
    .bind(site)
    .all<{ id: string; start_url: string | null }>();
  const same = waiting.filter((w) => w.start_url && scopeKey(w.start_url) === scopeKey(next.start_url!)).map((w) => w.id);
  if (same.length) {
    await d.db
      .prepare(`UPDATE crawl_requests SET run_id = ?, state = 'started' WHERE id IN (${same.map(() => '?').join(', ')})`)
      .bind(runId, ...same)
      .run();
  }
}

export async function getRequest(db: D1Database, id: string): Promise<RequestRow | null> {
  return db.prepare('SELECT * FROM crawl_requests WHERE id = ?').bind(id).first<RequestRow>();
}

// GET /v1/crawl-requests/:id. A waiting request whose site is free starts
// its crawl first (when `start` is given).
export async function requestView(db: D1Database, id: string, now = new Date(), start?: StartDeps): Promise<RequestView | null> {
  let req = await getRequest(db, id);
  if (!req) return null;
  if (req.state === 'waiting' && start) {
    await startWaiting(start, req.site, now);
    req = (await getRequest(db, id)) ?? req;
  }
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
  // A finished crawl whose pages aren't indexed yet hasn't produced anything
  // usable: a site's first crawl stays 'new' until a page is indexed (a
  // re-crawl of a ready site has pages, so it stays 'ready').
  const status = profile?.status === 'ready' && pages === 0 ? 'new' : (profile?.status ?? 'new');
  const fresh = profile ? Date.parse(profile.updated_at) > now.getTime() - STALE_RUN_HOURS * 3_600_000 : false;
  // Crawling until the latest request is complete, indexing included (the
  // run itself is over by then and crawl_state is already idle).
  const requestActive = request !== null && ACTIVE_STATES.has(request.state);
  return {
    site,
    indexed: status === 'ready' && pages > 0,
    status,
    crawling: (profile?.crawl_state === 'crawling' && fresh) || requestActive,
    pages,
    lastCrawledAt: profile?.last_crawled_at ?? null,
    request,
  };
}

// Crawl requests are kept REQUEST_RETENTION_DAYS (the privacy policy says so):
// a page address is browsing interest, even with the install ID hashed.
export const REQUEST_RETENTION_DAYS = 90;

export async function pruneCrawlRequests(db: D1Database, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - REQUEST_RETENTION_DAYS * DAY_MS).toISOString();
  const r = await db.prepare('DELETE FROM crawl_requests WHERE created_at < ?').bind(before).run();
  return r.meta.changes ?? 0;
}

// The hourly cron's sweep: every site with a fresh waiting request gets
// startWaiting (a Workflow that ended without reaching its own call, or a
// waiting request nobody polls).
export async function startAllWaiting(d: StartDeps, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - STALE_RUN_HOURS * 3_600_000).toISOString();
  const { results } = await d.db
    .prepare(`SELECT DISTINCT site FROM crawl_requests WHERE state = 'waiting' AND created_at > ? LIMIT 100`)
    .bind(since)
    .all<{ site: string }>();
  for (const { site } of results) await startWaiting(d, site, now).catch(() => {});
  return results.length;
}
