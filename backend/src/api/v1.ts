// The v1 API (docs/BACKEND.md §5). Each route names its pattern for the request log.

import { checkHourly, ipSubject } from '../db/ratelimit.ts';
import { CrawlStore, runCosts, STALE_RUN_HOURS } from '../db/crawl.ts';
import type { CrawlRunRow, SiteProfileRow } from '../db/crawl.ts';
import { Store, summary } from '../db/store.ts';
import type { SkillRow } from '../db/store.ts';
import type { Skill } from '../lib/types.ts';
import { SLOTS } from '../index/classify.ts';
import type { Slot } from '../index/classify.ts';
import { indexDeps, jevTokenCap } from '../index/deps.ts';
import { workersAiEmbed } from '../index/embed.ts';
import { addCost, indexPage, jevAllowance, pageKey } from '../index/indexer.ts';
import { usdPerMTok, jevCostUsd } from '../lib/jev.ts';
import { ApiError, bad, notFound } from '../lib/errors.ts';
import { safeEqual, sha256Hex } from '../lib/ids.ts';
import { assertFetchable, normalizeSite, siteOf } from '../lib/ssrf.ts';
import { startCrawl } from '../crawl/start.ts';
import { DEFAULT_REQUESTS_DAILY_MAX, ondemandShare, requestCrawl, requestView, siteStatus } from '../crawl/requests.ts';
import { e2bDailyCap } from '../crawl/e2b.ts';
import { anchoredChunks, anchorLookup } from '../search/anchor.ts';
import { normalizePageUrl } from '../lib/urls.ts';
import { installId, validateCrawl, validateFeedback, validateReport, validateSkill } from '../lib/validate.ts';
import { withServerText } from '../lib/skilltext.ts';
import { fetchSource, verifyAll } from '../lib/verify.ts';
import { ingestEvents } from '../telemetry/ingest.ts';
import type { ApiUsage } from '../telemetry/ingest.ts';
import { buildIndexPackage, DEFAULT_PACKAGE_BUDGET, MAX_PACKAGE_BUDGET, MIN_PACKAGE_BUDGET } from '../search/package.ts';
import type { PackageInput } from '../search/package.ts';
import { instructionsAllowed, siteInstructions } from '../agents/instructions.ts';
import { addRefs, checkLinks, extractLinks, linkStates, normalizeLink, queueLinks, rewriteLinks, saveLinks, statesFor } from '../links/links.ts';
import { siteTopics, topicChunks } from '../search/queries.ts';
import { cachedQueryEmbed } from '../search/embedcache.ts';
import { quickDiscover } from '../search/quick.ts';
import type { QuickDiscovery } from '../search/quick.ts';
import { search } from '../search/search.ts';
import type { SearchDeps } from '../search/search.ts';
import { topicTree } from '../search/topics.ts';
import type { Env } from '../env.ts';
import { CACHE_BEST, CACHE_LIST, json, readJson } from './http.ts';

export const VERSION = '0.1.0';

// Limits from docs/BACKEND.md §8. Every write is limited by install ID and by IP.
const LIMITS = {
  shareInstall: 20,
  shareIp: 60,
  voteInstall: 120,
  voteIp: 600,
  // POST /v1/crawl-requests, any outcome: each one writes a row. Starting a
  // crawl has its own daily limits (src/crawl/requests.ts).
  crawlRequestInstall: 60,
  crawlRequestIp: 300,
};

interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  params: string[];
  store: Store;
  ip: string;
  // Filled in by the handler for usage telemetry (src/telemetry/ingest.ts).
  usage: ApiUsage;
}

type Handler = (c: Ctx) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  name: string;
  handler: Handler;
}

// Only ever honoured in local dev, whatever else is set.
const allowLocalhost = (env: Env) => env.ENVIRONMENT === 'dev' && env.ALLOW_LOCALHOST === '1';

async function liveRow(store: Store, id: string) {
  const row = await store.getRow(id);
  if (!row) throw notFound('No such skill');
  if (row.removed_at) throw new ApiError('removed', 'This skill was removed', 410);
  return row;
}

// Content for a row that was live when read. If the R2 object has gone since,
// a takedown won the race: 410 for that skill rather than a 500.
async function loadLive(store: Store, row: SkillRow) {
  const skill = await store.load(row);
  if (skill) return cleanLinks(store.db, skill);
  if ((await store.getRow(row.id))?.removed_at) throw new ApiError('removed', 'This skill was removed', 410);
  throw new Error(`R2 object missing for ${row.id}`);
}

// A shared skill as served: links in its sections to targets not known to be
// ok lose their URL, and related links not known to be ok are left out.
async function cleanLinks(db: D1Database, skill: Skill): Promise<Skill> {
  const states = await statesFor(
    db,
    skill.site,
    skill.sections.flatMap((sec) => (sec.content ? [{ text: sec.content, base: sec.url }] : [])),
    skill.relatedLinks.map((l) => l.url),
  );
  return {
    ...skill,
    sections: skill.sections.map((sec) => (sec.content ? { ...sec, content: rewriteLinks(sec.content, sec.url, states).text } : sec)),
    relatedLinks: skill.relatedLinks.filter((l) => states.get(l.url) === 'ok'),
  };
}

export const searchDeps = (env: Env): SearchDeps => ({
  db: env.DB,
  vectors: env.VECTORS,
  embed: cachedQueryEmbed(workersAiEmbed(env.AI), typeof caches === 'undefined' ? undefined : caches.default),
});

// Queries that embed text get a stricter per-IP limit than other reads.
async function limitSearch(env: Env, ip: string): Promise<void> {
  if (env.SEARCH_LIMITER && !(await env.SEARCH_LIMITER.limit({ key: ipSubject(ip) })).success) {
    const err = new ApiError('rate_limited', 'Too many searches; try again later', 429);
    err.retryAfter = 60;
    throw err;
  }
}

const MAX_QUERY = 200;
// Anchored packages (?url=) kept in the Cache API per index version.
const PACKAGE_CACHE_SECONDS = 600;

// D1 occasionally answers "D1_ERROR: internal error" (seen on staging under
// a slow /packages); one retry after a short pause covers it.
async function retryD1<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!/D1_ERROR: internal error/i.test(e instanceof Error ? e.message : String(e))) throw e;
    await new Promise((r) => setTimeout(r, 150));
    return fn();
  }
}

// GET /v1/sites/:site/status: the popup asks on every open, so a short cache.
const CACHE_STATUS = 'public, max-age=15, s-maxage=15';
// GET /v1/sites/index: the extension downloads it now and then and checks hosts locally.
const SITES_INDEX_SECONDS = 3600;
// GET /v1/quick: what a site publishes for agents (llms.txt) is probed once an hour per site and scope.
const QUICK_CACHE_SECONDS = 3600;
// GET /v1/packages?chunks=: chunk IDs (src/index/indexer.ts: 32 hex of the URL's hash, then the ordinal).
const CHUNK_ID = /^[0-9a-f]{32}-\d{1,5}$/;
const MAX_PACKAGE_CHUNKS = 30;
// POST /v1/links/check: URLs per request, and live checks within the time budget.
const MAX_LINK_CHECK = 200;
const LIVE_CHECKS = 20;
const LIVE_CHECK_MS = 1500;

// A package with everything around it: the site's verified docs index, its
// instructions for agents, and the state of every link it would contain
// (unknown ones are queued for a check and left unlinked).
export async function renderPackage(db: D1Database, input: Omit<PackageInput, 'links' | 'docsIndex' | 'instructions'>): Promise<string> {
  const [profile, instructions] = await Promise.all([
    db.prepare('SELECT llms_url, llms_full_url, has_llms_verified, has_llms_full_verified FROM site_profiles WHERE site = ?').bind(input.site)
      .first<{ llms_url: string | null; llms_full_url: string | null; has_llms_verified: number; has_llms_full_verified: number }>(),
    siteInstructions(db, input.site),
  ]);
  const docsIndex = profile?.has_llms_verified && profile.llms_url
    ? { url: profile.llms_url, fullUrl: profile.has_llms_full_verified ? profile.llms_full_url : null }
    : null;
  const links = await statesFor(
    db,
    input.site,
    input.chunks.map((c) => ({ text: c.text, base: c.url })),
    [...input.chunks.map((c) => c.url), docsIndex?.url, docsIndex?.fullUrl, ...instructions.map((i) => i.url), ...(input.related ?? []).map((r) => r.url)],
  );
  return buildIndexPackage({ ...input, links, docsIndex, instructions });
}

// Live checks per target host per minute (LINKCHECK_HOST_LIMITER), so callers can't aim them at one site.
const hostAllowance = (env: Env) =>
  env.LINKCHECK_HOST_LIMITER ? async (host: string) => (await env.LINKCHECK_HOST_LIMITER!.limit({ key: host })).success : undefined;

// Which of these URLs the library links to somewhere (link_refs).
async function referenced(db: D1Database, urls: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < urls.length; i += 90) {
    const part = urls.slice(i, i + 90);
    const { results } = await db.prepare(`SELECT DISTINCT url FROM link_refs WHERE url IN (${part.map(() => '?').join(', ')})`).bind(...part).all<{ url: string }>();
    out.push(...results.map((r) => r.url));
  }
  return out;
}

// The Cache API (absent outside Workers, e.g. in the node tests).
const edgeCache = () => (typeof caches === 'undefined' ? null : caches.default);

// A site the API may talk about: a public hostname (400 for IP literals,
// localhost, .local, .internal and the like, as for any fetch).
function publicSite(raw: string, env: Env): string {
  const site = siteParam(raw);
  assertFetchable(`https://${site}/`, { allowLocalhost: allowLocalhost(env) });
  return site;
}

export function requestsDailyMax(env: Env): number {
  const n = Math.trunc(Number(env.CRAWL_REQUESTS_DAILY_MAX));
  return env.CRAWL_REQUESTS_DAILY_MAX !== undefined && Number.isFinite(n) && n >= 0 ? n : DEFAULT_REQUESTS_DAILY_MAX;
}
const TOPIC = /^[\p{L}\p{N}._-]+(\/[\p{L}\p{N}._-]+){0,3}$/u;

function queryParam(url: URL): string {
  const q = (url.searchParams.get('q') ?? '').replace(/\s+/g, ' ').trim();
  if (!q) throw bad('q is required');
  if (q.length > MAX_QUERY) throw bad(`q is over ${MAX_QUERY} characters`);
  return q;
}

function slotParam(url: URL): Slot | undefined {
  const slot = url.searchParams.get('slot');
  if (!slot) return undefined;
  if (!SLOTS.includes(slot as Slot)) throw bad(`slot must be one of ${SLOTS.join(', ')}`);
  return slot as Slot;
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  const n = raw === null ? fallback : Math.trunc(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function siteParam(raw: string): string {
  let site: string;
  try { site = normalizeSite(decodeURIComponent(raw)); } catch { throw bad('Invalid site'); }
  if (!/^[a-z0-9.-]{1,253}$/.test(site)) throw bad('Invalid site');
  return site;
}

async function requireAdmin(c: Ctx): Promise<void> {
  const token = c.env.ADMIN_TOKEN;
  const given = c.req.headers.get('authorization') ?? '';
  // Wrong or missing token looks exactly like an unknown route.
  if (!token || !(await safeEqual(given, `Bearer ${token}`))) throw notFound();
}

const FINAL_PROFILE = new Set(['ready', 'empty', 'blocked', 'failed', 'not_devtool']);

function gateJson(r: { gate_category: string | null; gate_method: string | null; gate_reason: string | null }) {
  return r.gate_method ? { category: r.gate_category, method: r.gate_method, reason: r.gate_reason } : null;
}

export function profileJson(r: SiteProfileRow) {
  // The devtool gate turned the site away: nothing else about it is known.
  if (r.status === 'not_devtool') {
    return {
      site: r.site,
      status: r.status,
      category: r.gate_category,
      reason: r.gate_reason,
      confidence: r.gate_confidence,
      method: r.gate_method,
      crawling: r.crawl_state === 'crawling' && Date.parse(r.updated_at) > Date.now() - STALE_RUN_HOURS * 3_600_000,
      checkedAt: r.gate_checked_at,
      updatedAt: r.updated_at,
    };
  }
  return {
    site: r.site,
    status: r.status,
    docsRoot: r.docs_root,
    hasLlms: Boolean(r.has_llms),
    hasLlmsFull: Boolean(r.has_llms_full),
    llmsUrl: r.llms_url,
    llmsFullUrl: r.llms_full_url,
    mdTwinsRatio: r.md_twins_ratio,
    twinPattern: r.twin_pattern,
    sitemapUrlsCount: r.sitemap_urls_count,
    openapi: JSON.parse(r.openapi_json) as string[],
    pagesFetched: r.pages_fetched,
    needsBrowser: Boolean(r.needs_browser),
    crawlDelay: r.crawl_delay,
    // A re-crawl in progress; status is still the last finished crawl's outcome.
    // A terminated Workflow never resets crawl_state; past the stale-run
    // window it is not reported as crawling.
    crawling: r.crawl_state === 'crawling' && Date.parse(r.updated_at) > Date.now() - STALE_RUN_HOURS * 3_600_000,
    lastCrawledAt: r.last_crawled_at,
    gate: r.gate_method ? { ...gateJson(r), confidence: r.gate_confidence, checkedAt: r.gate_checked_at } : null,
    updatedAt: r.updated_at,
  };
}

export function runJson(r: CrawlRunRow) {
  return {
    id: r.id,
    site: r.site,
    startUrl: r.start_url,
    status: r.status,
    path: r.path,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    pagesNew: r.pages_new,
    pagesChanged: r.pages_changed,
    pagesUnchanged: r.pages_unchanged,
    pagesFailed: r.pages_failed,
    pagesSkipped: r.pages_skipped,
    browserSeconds: r.browser_seconds,
    costUsd: r.cost_usd,
    error: r.error,
    forced: Boolean(r.forced),
    gate: r.gate_decision ? { decision: r.gate_decision, ...gateJson(r), costUsd: r.gate_cost_usd } : null,
    // costUsd above is the browser sandbox alone; this is everything.
    costs: runCosts(r),
  };
}

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/health$/,
    name: '/v1/health',
    // Whether the secrets are set (never their values), so a deploy smoke test can catch a missing one.
    handler: async ({ env }) =>
      json(200, {
        ok: true,
        version: env.VERSION || VERSION,
        secrets: { admin: Boolean(env.ADMIN_TOKEN), rateKey: Boolean(env.RATE_KEY), openrouter: Boolean(env.OPENROUTER_API_KEY), jev: Boolean(env.JEV_API_KEY) },
        telemetry: env.TELEMETRY_INGEST || 'on',
      }),
  },
  {
    method: 'GET',
    pattern: /^\/v1\/skills\/best$/,
    name: '/v1/skills/best',
    handler: async ({ url, store, usage }) => {
      usage.site = normalizeSite(url.searchParams.get('site'));
      const row = await store.bestRow(usage.site);
      let skill = null;
      try {
        skill = row && (await loadLive(store, row));
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'removed')) throw e;
      }
      usage.hit = Boolean(skill);
      return json(200, { skill }, { 'cache-control': CACHE_BEST });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/skills\/([\w-]+)$/,
    name: '/v1/skills/:id',
    handler: async ({ params, store }) => json(200, { skill: await loadLive(store, await liveRow(store, params[0])) }),
  },
  {
    method: 'POST',
    pattern: /^\/v1\/skills$/,
    name: '/v1/skills',
    handler: async ({ req, env, store, ip }) => {
      const install = installId(req.headers.get('x-scoop-install'));
      const skill = validateSkill(await readJson(req), allowLocalhost(env));
      // Limit before the expensive part: outbound verification fetches.
      await checkHourly(env.DB, env.RATE_KEY, [
        { bucket: 'share:install', subject: install, limit: LIMITS.shareInstall },
        { bucket: 'share:ip', subject: ipSubject(ip), limit: LIMITS.shareIp },
      ]);
      const verified = await verifyAll(skill.sections, skill.site, { allowLocalhost: allowLocalhost(env) });
      // Labels, title, related links and pageUrl come from the verified sources, never the client.
      const served = withServerText(skill, verified);
      const { id, duplicate } = await store.add(served, install);
      // Served links must be known ok (src/links/links.ts): its sources were
      // just fetched; its related links and the links in its text get a live
      // check now (up to 20, 1.5 s), the rest are queued.
      const started = Date.now();
      await saveLinks(env.DB, served.sections.flatMap((sec) => {
        const u = normalizeLink(sec.url);
        return u ? [{ url: u, ok: true, status: 200, finalUrl: u }] : [];
      }), 'live');
      const texts = served.sections.flatMap((sec) => (sec.content ? [{ text: sec.content, base: sec.url }] : []));
      const states = await statesFor(env.DB, served.site, texts, served.relatedLinks.map((l) => l.url));
      // The skill's links are served content: referenced, so kept and re-checked like a crawled page's.
      await addRefs(env.DB, served.site, served.pageUrl, [...texts.flatMap((t) => extractLinks(t.text, t.base)), ...served.relatedLinks.map((l) => l.url)]);
      const related = new Set(served.relatedLinks.map((l) => normalizeLink(l.url)));
      const unknown = await env.DB.prepare('SELECT url FROM link_check_queue WHERE site = ? LIMIT 200').bind(served.site).all<{ url: string }>();
      const todo = unknown.results.map((r) => r.url).filter((u) => !states.has(u)).sort((a, b) => Number(related.has(b)) - Number(related.has(a)));
      if (todo.length) {
        const live = await checkLinks(todo.slice(0, LIVE_CHECKS), {
          allowLocalhost: allowLocalhost(env), site: served.site, deadline: started + LIVE_CHECK_MS, timeoutMs: LIVE_CHECK_MS, allowHost: hostAllowance(env),
        });
        await saveLinks(env.DB, live, 'live');
      }
      return json(duplicate ? 200 : 201, { id, status: 'verified', duplicate });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/skills\/([\w-]+)\/feedback$/,
    name: '/v1/skills/:id/feedback',
    handler: async ({ req, env, params, store, ip }) => {
      const install = installId(req.headers.get('x-scoop-install'));
      const worked = validateFeedback(await readJson(req));
      await checkHourly(env.DB, env.RATE_KEY, [
        { bucket: 'vote:install', subject: install, limit: LIMITS.voteInstall },
        { bucket: 'vote:ip', subject: ipSubject(ip), limit: LIMITS.voteIp },
      ]);
      await liveRow(store, params[0]);
      return json(200, await store.vote(params[0], install, worked));
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/sites$/,
    name: '/v1/sites',
    handler: async ({ url, store, usage }) => {
      const limit = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get('limit'))) || 50));
      const offset = Math.max(0, Math.trunc(Number(url.searchParams.get('cursor'))) || 0);
      const { rows, more } = await store.sites(limit, offset);
      usage.results = rows.length;
      return json(
        200,
        { sites: rows.map((r) => ({ site: r.site, best: summary(r) })), next: more ? String(offset + limit) : null },
        { 'cache-control': CACHE_LIST },
      );
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/sites\/index$/,
    name: '/v1/sites/index',
    // Every approved site with indexed pages, for the extension's toolbar badge:
    // downloaded now and then and checked locally, so visits stay in the browser.
    handler: async ({ req, env }) => {
      const cache = edgeCache();
      const key = new Request('https://sites-index.scoop.md/v1');
      const cached = await cache?.match(key).catch(() => undefined);
      let body: string;
      let etag: string;
      if (cached) {
        body = await cached.text();
        etag = cached.headers.get('etag') ?? `"${(await sha256Hex(body)).slice(0, 32)}"`;
      } else {
        // Requested sites stay out until an admin approves them; rejected ones always.
        const { results } = await retryD1(() =>
          env.DB.prepare(
            `SELECT p.site AS site, COUNT(*) AS pages FROM page_index p LEFT JOIN site_profiles s ON s.site = p.site
             WHERE COALESCE(s.approved, 1) = 1 AND COALESCE(s.status, '') != 'not_devtool'
             GROUP BY p.site ORDER BY p.site`,
          ).all<{ site: string; pages: number }>());
        body = JSON.stringify({ sites: results.map((r) => ({ site: r.site, pages: r.pages })) });
        etag = `"${(await sha256Hex(body)).slice(0, 32)}"`;
        await cache?.put(key, new Response(body, { headers: { etag, 'cache-control': `public, max-age=${SITES_INDEX_SECONDS}` } })).catch(() => {});
      }
      const headers = { 'content-type': 'application/json; charset=utf-8', etag, 'cache-control': `public, max-age=${SITES_INDEX_SECONDS}` };
      const sent = (req.headers.get('if-none-match') ?? '').split(',').map((t) => t.trim().replace(/^W\//, ''));
      if (sent.includes(etag)) return new Response(null, { status: 304, headers });
      return new Response(body, { headers });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/links\/check$/,
    name: '/v1/links/check',
    // For packages the extension builds itself: which links are known ok or
    // bad. Unknown ones are queued for the hourly check; up to 20 are checked
    // live within 1.5 s.
    handler: async ({ req, env, ip }) => {
      await limitSearch(env, ip);
      const body = (await readJson(req, 300_000)) as { urls?: unknown };
      const urls = body?.urls;
      if (!Array.isArray(urls) || urls.length > MAX_LINK_CHECK || !urls.every((u) => typeof u === 'string' && u.length <= 2048)) {
        throw bad(`urls must be an array of at most ${MAX_LINK_CHECK} strings`);
      }
      const started = Date.now();
      const asked = [...new Set(urls as string[])];
      const norm = new Map(asked.map((u) => [u, normalizeLink(u)]));
      const states = await linkStates(env.DB, [...norm.values()].filter((u): u is string => u !== null));
      // Neither http(s) nor public: never a link to give an agent.
      for (const [raw, n] of norm) {
        if (!n) continue;
        try { assertFetchable(n, { allowLocalhost: allowLocalhost(env) }); } catch { states.set(n, 'bad'); norm.set(raw, n); }
      }
      const unknown = [...new Set([...norm.values()].filter((n): n is string => n !== null && !states.has(n)))];
      if (unknown.length) {
        const live = await checkLinks(unknown.slice(0, LIVE_CHECKS), {
          allowLocalhost: allowLocalhost(env),
          deadline: started + LIVE_CHECK_MS,
          timeoutMs: LIVE_CHECK_MS,
          allowHost: hostAllowance(env),
        });
        await saveLinks(env.DB, live, 'live');
        for (const r of live) states.set(r.url, r.ok ? 'ok' : 'bad');
        // Only links the library itself serves are queued, never arbitrary URLs from callers.
        const left = unknown.filter((u) => !states.has(u));
        if (left.length) await queueLinks(env.DB, await referenced(env.DB, left), null);
      }
      const out: { ok: string[]; bad: string[]; unknown: string[] } = { ok: [], bad: [], unknown: [] };
      for (const [raw, n] of norm) {
        const st = n ? states.get(n) : 'bad';
        out[st ?? 'unknown'].push(raw);
      }
      return json(200, out);
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/quick$/,
    name: '/v1/quick',
    // Instant first answer for a page (src/search/quick.ts): the Markdown its
    // site publishes for agents, and whether the scoop.md index has the site.
    handler: async ({ env, url, usage, ip }) => {
      // Its probes fetch other sites and may ask Jev: its own, stricter limit.
      if (env.QUICK_LIMITER && !(await env.QUICK_LIMITER.limit({ key: ipSubject(ip) })).success) {
        const err = new ApiError('rate_limited', 'Too many requests; try again later', 429);
        err.retryAfter = 60;
        throw err;
      }
      const raw = url.searchParams.get('url');
      if (!raw || raw.length > 1024) throw bad('url must be a string of 1–1024 characters');
      const pageUrl = normalizePageUrl(assertFetchable(raw, { allowLocalhost: allowLocalhost(env) }));
      const site = siteOf(pageUrl);
      usage.site = site;
      const cache = edgeCache();
      const key = new Request(`https://quick-cache.scoop.md/v1?url=${encodeURIComponent(pageUrl)}`);
      // The first miss per target host per hour probes it; later misses answer from the site cache only.
      const hostKey = new Request(`https://quick-cache.scoop.md/host?h=${encodeURIComponent(new URL(pageUrl).host)}`);
      const [cached, status, probed, allowed] = await Promise.all([
        cache?.match(key).catch(() => undefined),
        retryD1(() => siteStatus(env.DB, site)),
        cache?.match(hostKey).catch(() => undefined),
        instructionsAllowed(env.DB, site, pageUrl).catch(() => false),
      ]);
      // Instructions for agents: only for an indexed, approved (or allowlisted) site.
      const withInstructions = status.indexed && allowed;
      let found: Omit<QuickDiscovery, 'jevTokens'>;
      if (cached) {
        found = await cached.json();
      } else {
        if (!probed) {
          await cache?.put(hostKey, new Response('1', { headers: { 'cache-control': `public, max-age=${QUICK_CACHE_SECONDS}` } })).catch(() => {});
        }
        const d = await quickDiscover(pageUrl, {
          allowLocalhost: allowLocalhost(env),
          probe: !probed,
          instructions: withInstructions,
          jev: env.JEV_API_KEY ? { apiKey: env.JEV_API_KEY, allow: jevAllowance(env.DB, jevTokenCap(env)) } : null,
          siteCache: cache && {
            get: async (k) => (await cache.match(new Request(`https://quick-cache.scoop.md/site?k=${encodeURIComponent(k)}`)).catch(() => undefined))?.json() ?? null,
            put: (k, v) =>
              cache.put(new Request(`https://quick-cache.scoop.md/site?k=${encodeURIComponent(k)}`), new Response(JSON.stringify(v), {
                headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${QUICK_CACHE_SECONDS}` },
              })).catch(() => {}),
          },
        });
        const { jevTokens: _, ...rest } = d;
        found = rest;
        if (d.jevTokens) await addCost(env.DB, site, new Date(), jevCostUsd(d.jevTokens, usdPerMTok(env.JEV_USD_PER_MTOK)), d.jevTokens).catch(() => {});
        await cache?.put(key, new Response(JSON.stringify(found), {
          headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${QUICK_CACHE_SECONDS}` },
        })).catch(() => {});
      }
      Object.assign(usage, { results: found.sources.length, hit: found.overview !== null });
      return json(
        200,
        {
          site, sources: found.sources, overview: found.overview, indexed: status.indexed, pages: status.pages,
          isDevDocs: found.isDevDocs, llms: found.llms, agentInstructions: withInstructions ? found.agentInstructions : [],
        },
        { 'cache-control': CACHE_LIST, 'x-scoop-cache': cached ? 'hit' : 'miss' },
      );
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/sites\/([^/]+)$/,
    name: '/v1/sites/:site',
    handler: async ({ params, store, usage }) => {
      let raw: string;
      try { raw = decodeURIComponent(params[0]); } catch { throw notFound('No skills for this site'); }
      const site = normalizeSite(raw);
      usage.site = site;
      usage.hit = await store.hasSite(site);
      if (!usage.hit) throw notFound('No skills for this site');
      const [best, recent] = await Promise.all([store.bestRow(site), store.recent(site)]);
      return json(200, { site, best: best && summary(best), recent: recent.map(summary) }, { 'cache-control': CACHE_LIST });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/reports$/,
    name: '/v1/reports',
    handler: async ({ req, env, store, ip }) => {
      const install = installId(req.headers.get('x-scoop-install'));
      const report = validateReport(await readJson(req));
      await checkHourly(env.DB, env.RATE_KEY, [
        { bucket: 'vote:install', subject: install, limit: LIMITS.voteInstall },
        { bucket: 'vote:ip', subject: ipSubject(ip), limit: LIMITS.voteIp },
      ]);
      if (!(await store.getRow(report.skillId))) throw notFound('No such skill');
      await store.report(report, install);
      return json(202, { ok: true });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/events$/,
    name: '/v1/events',
    // Usage telemetry from the extension and scoop.md (docs/TELEMETRY.md): 202 once queued.
    handler: async ({ req, env, ip }) => ingestEvents(req, env, ip),
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/admin\/skills\/([\w-]+)$/,
    name: '/v1/admin/skills/:id',
    handler: async (c) => {
      await requireAdmin(c);
      if (!(await c.store.getRow(c.params[0]))) throw notFound('No such skill');
      await c.store.remove(c.params[0]);
      return json(200, { ok: true });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/admin\/crawl$/,
    name: '/v1/admin/crawl',
    handler: async (c) => {
      await requireAdmin(c);
      const crawl = validateCrawl(await readJson(c.req), allowLocalhost(c.env));
      // One queued or running crawl per site.
      const runId = await startCrawl({ db: c.env.DB, bucket: c.env.SKILLS, workflow: c.env.CRAWL_SITE }, crawl);
      if (!runId) throw new ApiError('conflict', `A crawl of ${crawl.site} is already queued or running`, 409);
      return json(202, { runId, site: crawl.site, startUrl: crawl.startUrl, forced: crawl.force });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/admin\/crawl\/(cr_[0-9A-Z]{26})$/,
    name: '/v1/admin/crawl/:runId',
    handler: async (c) => {
      await requireAdmin(c);
      const crawls = new CrawlStore(c.env.DB, c.env.SKILLS);
      const run = await crawls.getRun(c.params[0]);
      if (!run) throw notFound('No such crawl run');
      let workflow: InstanceStatus | null = null;
      try {
        workflow = await (await c.env.CRAWL_SITE.get(run.id)).status();
      } catch {
        // instance expired from Workflow retention; the run row is the record
      }
      const pages = await crawls.pagesForRun(run.id, 10);
      return json(200, { run: runJson(run), workflow: workflow && { status: workflow.status, error: workflow.error ?? null }, pages });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/sites\/([^/]+)\/profile$/,
    name: '/v1/sites/:site/profile',
    handler: async ({ params, env, usage }) => {
      let raw: string;
      try { raw = decodeURIComponent(params[0]); } catch { throw notFound('No profile for this site'); }
      usage.site = normalizeSite(raw);
      const row = await new CrawlStore(env.DB, env.SKILLS).getProfile(usage.site);
      usage.hit = Boolean(row && FINAL_PROFILE.has(row.status));
      // Only profiles of finished crawls are public.
      if (!row || !FINAL_PROFILE.has(row.status)) throw notFound('No profile for this site');
      return json(200, { profile: profileJson(row) }, { 'cache-control': CACHE_LIST });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/sites\/([^/]+)\/status$/,
    name: '/v1/sites/:site/status',
    // Never a 404: an unknown site is { indexed: false, status: 'new' }.
    handler: async ({ params, env }) => json(200, await siteStatus(env.DB, publicSite(params[0], env)), { 'cache-control': CACHE_STATUS }),
  },
  {
    method: 'POST',
    pattern: /^\/v1\/crawl-requests$/,
    name: '/v1/crawl-requests',
    // The extension asks for a site the library hasn't crawled (src/crawl/requests.ts).
    handler: async ({ req, env, ip, usage }) => {
      const install = installId(req.headers.get('x-scoop-install'));
      const body = await readJson(req);
      const raw = (body as { url?: unknown } | null)?.url;
      if (typeof raw !== 'string' || !raw || raw.length > 1024) throw bad('url must be a string of 1–1024 characters');
      const pageUrl = normalizePageUrl(assertFetchable(raw, { allowLocalhost: allowLocalhost(env) }));
      const site = siteOf(pageUrl);
      if (site === 'scoop.md' || site.endsWith('.scoop.md')) throw bad('scoop.md itself cannot be crawled');
      usage.site = site;
      try {
        await checkHourly(env.DB, env.RATE_KEY, [
          { bucket: 'crawlreq-any:install', subject: install, limit: LIMITS.crawlRequestInstall },
          { bucket: 'crawlreq-any:ip', subject: ipSubject(ip), limit: LIMITS.crawlRequestIp },
        ]);
        const r = await requestCrawl(
          {
            db: env.DB, bucket: env.SKILLS, workflow: env.CRAWL_SITE, rateKey: env.RATE_KEY, dailyMax: requestsDailyMax(env),
            e2bCapUsd: e2bDailyCap(env), indexTotalCapUsd: indexDeps(env).totalCapUsd,
            e2bShare: ondemandShare(env.ONDEMAND_E2B_SHARE), indexShare: ondemandShare(env.ONDEMAND_INDEX_SHARE),
          },
          { pageUrl, site, install, ip },
        );
        usage.state = r.body.state;
        if (r.status === 202) return json(202, { id: r.body.id, site, state: 'queued', etaSeconds: r.body.etaSeconds });
        return json(200, r.body);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'rate_limited') usage.state = 'rate_limited';
        throw e;
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/crawl-requests\/(rq_[0-9A-Z]{26})$/,
    name: '/v1/crawl-requests/:id',
    // Public, no auth: a request ID is a ULID, a 48-bit timestamp plus 80
    // random bits, so IDs can't practically be enumerated; anyone holding one
    // can read that request's progress (site, counts, state), nothing more.
    handler: async ({ params, env }) => {
      // A request waiting for another scope of its site starts its crawl here once the site is free.
      const view = await requestView(env.DB, params[0], new Date(), { db: env.DB, bucket: env.SKILLS, workflow: env.CRAWL_SITE });
      if (!view) throw notFound('No such crawl request');
      return json(200, view);
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/admin\/reports$/,
    name: '/v1/admin/reports',
    handler: async (c) => {
      await requireAdmin(c);
      return json(200, { reports: await c.store.openReports() });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/search$/,
    name: '/v1/search',
    handler: async ({ env, url, ip, usage }) => {
      const q = queryParam(url);
      await limitSearch(env, ip);
      const site = url.searchParams.get('site') ? siteParam(url.searchParams.get('site')!) : undefined;
      Object.assign(usage, { q, site });
      const slot = slotParam(url);
      const limit = intParam(url, 'limit', 10, 1, 50);
      const hits = await search(searchDeps(env), { q, site, slot, limit });
      Object.assign(usage, { results: hits.length, hit: hits.length > 0 });
      // Snippets keep only links known to be ok.
      const states = await statesFor(env.DB, site ?? null, hits.map((h) => ({ text: h.snippet, base: h.url })), []);
      return json(
        200,
        {
          query: q,
          site: site ?? null,
          slot: slot ?? null,
          hits: hits.map((h) => ({
            id: h.id, url: h.url, title: h.title, heading_path: h.heading_path, snippet: rewriteLinks(h.snippet, h.url, states).text, slot: h.slot, topic_path: h.topic_path, score: h.score,
          })),
        },
        { 'cache-control': CACHE_LIST },
      );
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/sites\/([^/]+)\/topics$/,
    name: '/v1/sites/:site/topics',
    handler: async ({ env, params, usage }) => {
      const site = siteParam(params[0]);
      const { pages, rows } = await siteTopics(env.DB, site);
      Object.assign(usage, { site, results: pages, hit: pages > 0 });
      if (!pages) throw notFound('No indexed pages for this site');
      return json(200, { site, pages, topics: topicTree(rows) }, { 'cache-control': CACHE_LIST });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/packages$/,
    name: '/v1/packages',
    handler: async ({ env, url, ip, usage }) => {
      const site = siteParam(url.searchParams.get('site') ?? '');
      usage.site = site;
      const topic = url.searchParams.get('topic');
      const pageParam = url.searchParams.get('url');
      const budget = intParam(url, 'budget', DEFAULT_PACKAGE_BUDGET, MIN_PACKAGE_BUDGET, MAX_PACKAGE_BUDGET);
      let label: string;
      let chunks;
      const chunkParam = url.searchParams.get('chunks');
      if (chunkParam !== null) {
        // Chunks the client picked (search hits' ids), in its order: the
        // server assembles the Markdown, with the same fencing, budget and note.
        if (pageParam !== null || topic !== null || url.searchParams.has('q')) throw bad('Pass chunks, url, q or topic, not more than one');
        const ids = [...new Set(chunkParam.split(',').map((id) => id.trim()).filter(Boolean))];
        if (!ids.length || ids.length > MAX_PACKAGE_CHUNKS || !ids.every((id) => CHUNK_ID.test(id))) {
          throw bad(`chunks must be 1 to ${MAX_PACKAGE_CHUNKS} chunk ids, comma-separated`);
        }
        const { results } = await retryD1(() =>
          env.DB.prepare(`SELECT id, url, site, title, ord, heading_path, text FROM chunks WHERE id IN (${ids.map(() => '?').join(', ')})`)
            .bind(...ids)
            .all<{ id: string; url: string; site: string; title: string; ord: number; heading_path: string; text: string }>());
        if (results.some((r) => r.site !== site)) throw new ApiError('site_mismatch', `chunks must all be from ${site}`, 400);
        const rows = new Map(results.map((r) => [r.id, r]));
        const picked = ids.flatMap((id) => rows.get(id) ?? []);
        Object.assign(usage, { results: picked.length, hit: picked.length > 0 });
        if (!picked.length) throw notFound('No such chunks');
        return new Response(await renderPackage(env.DB, { site, label: 'selected sections', chunks: picked, budget, inOrder: true }), {
          headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': CACHE_LIST, 'x-content-type-options': 'nosniff' },
        });
      }
      if (pageParam !== null) {
        // Anchored on the page the user is on: that page first, then related chunks.
        if (topic !== null || url.searchParams.has('q')) throw bad('Pass url, q or topic, not more than one');
        if (pageParam.length > 1024) throw bad('url is over 1024 characters');
        const pageUrl = normalizePageUrl(assertFetchable(pageParam, { allowLocalhost: allowLocalhost(env) }));
        if (siteOf(pageUrl) !== site) throw new ApiError('site_mismatch', `url is not on ${site}`, 400);
        // One D1 round trip for the not_indexed check, the cache version and the anchor page.
        const look = await retryD1(() => anchorLookup(env.DB, site, pageUrl));
        if (!look.pages) {
          Object.assign(usage, { results: 0, hit: false });
          // Never cached: the site may be indexed a moment from now.
          throw new ApiError('not_indexed', `${site} has no index yet`, 404);
        }
        const headers = { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': CACHE_LIST, 'x-content-type-options': 'nosniff' };
        // Cached per site, page, budget and index version (any page indexed changes it).
        const cache = edgeCache();
        const key = new Request(
          `https://package-cache.scoop.md/v1?site=${encodeURIComponent(site)}&url=${encodeURIComponent(pageUrl)}&budget=${budget}&v=${encodeURIComponent(look.version)}`,
        );
        const cached = await cache?.match(key).catch(() => undefined);
        if (cached) {
          Object.assign(usage, { hit: Boolean(look.anchor) });
          return new Response(cached.body, { headers: { ...headers, 'x-scoop-cache': 'hit' } });
        }
        await limitSearch(env, ip);
        const anchored = await retryD1(() => anchoredChunks(searchDeps(env), site, pageUrl, { anchor: look.anchor, pages: look.pages }));
        Object.assign(usage, { results: anchored?.chunks.length ?? 0, hit: Boolean(anchored?.anchored) });
        if (!anchored) throw notFound('Nothing indexed matches');
        // The page itself is the content; other pages are offered as related links.
        const anchorUrl = anchored.anchored ? look.anchor?.url : undefined;
        const related: { title: string; url: string }[] = [];
        if (anchorUrl) {
          for (const c of anchored.chunks) if (c.url !== anchorUrl && !related.some((r) => r.url === c.url)) related.push({ title: c.title, url: c.url });
        }
        const body = await renderPackage(env.DB, {
          site,
          label: anchored.label,
          chunks: anchorUrl ? anchored.chunks.filter((c) => c.url === anchorUrl) : anchored.chunks,
          budget,
          related: related.slice(0, 10),
        });
        await cache?.put(key, new Response(body, { headers: { 'content-type': headers['content-type'], 'cache-control': `public, max-age=${PACKAGE_CACHE_SECONDS}` } })).catch(() => {});
        return new Response(body, { headers: { ...headers, 'x-scoop-cache': 'miss' } });
      }
      if (topic !== null) {
        if (url.searchParams.has('q')) throw bad('Pass q or topic, not both');
        label = topic.trim().toLowerCase();
        if (!TOPIC.test(label)) throw bad('topic must be a path like webhooks/signatures');
        usage.topic = label;
        chunks = await topicChunks(env.DB, site, label);
      } else {
        label = queryParam(url);
        usage.q = label;
        await limitSearch(env, ip);
        chunks = await search(searchDeps(env), { q: label, site, limit: 40 });
      }
      Object.assign(usage, { results: chunks.length, hit: chunks.length > 0 });
      if (!chunks.length) throw notFound('Nothing indexed matches');
      return new Response(await renderPackage(env.DB, { site, label, chunks, budget }), {
        headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': CACHE_LIST, 'x-content-type-options': 'nosniff' },
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/admin\/index$/,
    name: '/v1/admin/index',
    // Fetches one Markdown page, stores it at pages/<sha256>.md and indexes it
    // (inline, or through the queue with {"queue": true}).
    handler: async (c) => {
      await requireAdmin(c);
      const body = (await readJson(c.req)) as { url?: unknown; queue?: unknown };
      if (typeof body.url !== 'string') throw bad('url is required');
      const target = assertFetchable(body.url, { allowLocalhost: allowLocalhost(c.env) });
      const pageUrl = normalizePageUrl(target);
      const site = siteOf(pageUrl);
      const fetched = await fetchSource(pageUrl, site, { allowLocalhost: allowLocalhost(c.env) });
      if (fetched.over) throw new ApiError('too_large', 'Page is over 2 MB', 413);
      if (/html/i.test(fetched.contentType)) throw new ApiError('source_unreachable', `${pageUrl} served HTML; index its Markdown (.md) URL`);
      if (!fetched.text.trim()) throw new ApiError('source_unreachable', `${pageUrl} is empty`);
      const contentHash = await sha256Hex(fetched.text);
      await c.env.SKILLS.put(pageKey(contentHash), fetched.text, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
      const msg = { site, url: pageUrl, contentHash };
      if (body.queue === true) {
        await c.env.INDEX_QUEUE.send(msg);
        return json(202, { queued: true, ...msg });
      }
      return json(200, { ...msg, ...(await indexPage(indexDeps(c.env), msg)) });
    },
  },
];

export interface Matched {
  name: string;
  run: () => Promise<Response>;
  usage: ApiUsage;
}

// Finds the route for a request. Unknown routes (including admin routes hit with
// the wrong method) are a plain 404.
export function match(req: Request, env: Env, url: URL, ip: string): Matched | null {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    const store = new Store(env.DB, env.SKILLS);
    const usage: ApiUsage = {};
    return { name: r.name, usage, run: () => r.handler({ req, env, url, params: m.slice(1), store, ip, usage }) };
  }
  return null;
}
