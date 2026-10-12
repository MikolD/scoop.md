// The v1 API (docs/BACKEND.md §5). Each route names its pattern for the request log.

import { checkHourly, ipSubject } from '../db/ratelimit.ts';
import { CrawlStore, STALE_RUN_HOURS } from '../db/crawl.ts';
import type { CrawlRunRow, SiteProfileRow } from '../db/crawl.ts';
import { Store, summary } from '../db/store.ts';
import type { SkillRow } from '../db/store.ts';
import { SLOTS } from '../index/classify.ts';
import type { Slot } from '../index/classify.ts';
import { indexDeps } from '../index/deps.ts';
import { workersAiEmbed } from '../index/embed.ts';
import { indexPage, pageKey } from '../index/indexer.ts';
import { ApiError, bad, notFound } from '../lib/errors.ts';
import { newId, safeEqual, sha256Hex } from '../lib/ids.ts';
import { assertFetchable, normalizeSite, siteOf } from '../lib/ssrf.ts';
import { normalizePageUrl } from '../lib/urls.ts';
import { installId, validateCrawl, validateFeedback, validateReport, validateSkill } from '../lib/validate.ts';
import { withServerText } from '../lib/skilltext.ts';
import { fetchSource, verifyAll } from '../lib/verify.ts';
import { buildIndexPackage, DEFAULT_PACKAGE_BUDGET, MAX_PACKAGE_BUDGET, MIN_PACKAGE_BUDGET } from '../search/package.ts';
import { siteTopics, topicChunks } from '../search/queries.ts';
import { cachedQueryEmbed } from '../search/embedcache.ts';
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
};

interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  params: string[];
  store: Store;
  ip: string;
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
  if (skill) return skill;
  if ((await store.getRow(row.id))?.removed_at) throw new ApiError('removed', 'This skill was removed', 410);
  throw new Error(`R2 object missing for ${row.id}`);
}

const searchDeps = (env: Env): SearchDeps => ({
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

const FINAL_PROFILE = new Set(['ready', 'empty', 'blocked', 'failed']);

function profileJson(r: SiteProfileRow) {
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
    updatedAt: r.updated_at,
  };
}

function runJson(r: CrawlRunRow) {
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
  };
}

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/health$/,
    name: '/v1/health',
    // Whether the secrets are set (never their values), so a deploy smoke test can catch a missing one.
    handler: async ({ env }) =>
      json(200, { ok: true, version: env.VERSION || VERSION, secrets: { admin: Boolean(env.ADMIN_TOKEN), rateKey: Boolean(env.RATE_KEY), openrouter: Boolean(env.OPENROUTER_API_KEY) } }),
  },
  {
    method: 'GET',
    pattern: /^\/v1\/skills\/best$/,
    name: '/v1/skills/best',
    handler: async ({ url, store }) => {
      const row = await store.bestRow(normalizeSite(url.searchParams.get('site')));
      let skill = null;
      try {
        skill = row && (await loadLive(store, row));
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'removed')) throw e;
      }
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
      const titles = await verifyAll(skill.sections, skill.site, { allowLocalhost: allowLocalhost(env) });
      // Labels, title and link text are written by the server, never taken from the client.
      const { id, duplicate } = await store.add(withServerText(skill, titles), install);
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
    handler: async ({ url, store }) => {
      const limit = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get('limit'))) || 50));
      const offset = Math.max(0, Math.trunc(Number(url.searchParams.get('cursor'))) || 0);
      const { rows, more } = await store.sites(limit, offset);
      return json(
        200,
        { sites: rows.map((r) => ({ site: r.site, best: summary(r) })), next: more ? String(offset + limit) : null },
        { 'cache-control': CACHE_LIST },
      );
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/sites\/([^/]+)$/,
    name: '/v1/sites/:site',
    handler: async ({ params, store }) => {
      let raw: string;
      try { raw = decodeURIComponent(params[0]); } catch { throw notFound('No skills for this site'); }
      const site = normalizeSite(raw);
      if (!(await store.hasSite(site))) throw notFound('No skills for this site');
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
      const runId = newId('cr');
      const crawls = new CrawlStore(c.env.DB, c.env.SKILLS);
      // One queued or running crawl per site.
      if (!(await crawls.createRun(runId, crawl.site, crawl.startUrl))) {
        throw new ApiError('conflict', `A crawl of ${crawl.site} is already queued or running`, 409);
      }
      try {
        await c.env.CRAWL_SITE.create({ id: runId, params: { runId, ...crawl } });
      } catch (e) {
        // No Workflow will ever finish this run; don't leave it blocking the site.
        await crawls.updateRun(runId, { status: 'failed', finished_at: new Date().toISOString(), error: 'Workflow could not be created' });
        throw e;
      }
      return json(202, { runId, site: crawl.site, startUrl: crawl.startUrl });
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
    handler: async ({ params, env }) => {
      let raw: string;
      try { raw = decodeURIComponent(params[0]); } catch { throw notFound('No profile for this site'); }
      const row = await new CrawlStore(env.DB, env.SKILLS).getProfile(normalizeSite(raw));
      // Only profiles of finished crawls are public.
      if (!row || !FINAL_PROFILE.has(row.status)) throw notFound('No profile for this site');
      return json(200, { profile: profileJson(row) }, { 'cache-control': CACHE_LIST });
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
    handler: async ({ env, url, ip }) => {
      const q = queryParam(url);
      await limitSearch(env, ip);
      const site = url.searchParams.get('site') ? siteParam(url.searchParams.get('site')!) : undefined;
      const slot = slotParam(url);
      const limit = intParam(url, 'limit', 10, 1, 50);
      const hits = await search(searchDeps(env), { q, site, slot, limit });
      return json(
        200,
        {
          query: q,
          site: site ?? null,
          slot: slot ?? null,
          hits: hits.map((h) => ({
            url: h.url, title: h.title, heading_path: h.heading_path, snippet: h.snippet, slot: h.slot, topic_path: h.topic_path, score: h.score,
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
    handler: async ({ env, params }) => {
      const site = siteParam(params[0]);
      const { pages, rows } = await siteTopics(env.DB, site);
      if (!pages) throw notFound('No indexed pages for this site');
      return json(200, { site, pages, topics: topicTree(rows) }, { 'cache-control': CACHE_LIST });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/packages$/,
    name: '/v1/packages',
    handler: async ({ env, url, ip }) => {
      const site = siteParam(url.searchParams.get('site') ?? '');
      const topic = url.searchParams.get('topic');
      const budget = intParam(url, 'budget', DEFAULT_PACKAGE_BUDGET, MIN_PACKAGE_BUDGET, MAX_PACKAGE_BUDGET);
      let label: string;
      let chunks;
      if (topic !== null) {
        if (url.searchParams.has('q')) throw bad('Pass q or topic, not both');
        label = topic.trim().toLowerCase();
        if (!TOPIC.test(label)) throw bad('topic must be a path like webhooks/signatures');
        chunks = await topicChunks(env.DB, site, label);
      } else {
        label = queryParam(url);
        await limitSearch(env, ip);
        chunks = await search(searchDeps(env), { q: label, site, limit: 40 });
      }
      if (!chunks.length) throw notFound('Nothing indexed matches');
      return new Response(buildIndexPackage({ site, label, chunks, budget }), {
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
}

// Finds the route for a request. Unknown routes (including admin routes hit with
// the wrong method) are a plain 404.
export function match(req: Request, env: Env, url: URL, ip: string): Matched | null {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    const store = new Store(env.DB, env.SKILLS);
    return { name: r.name, run: () => r.handler({ req, env, url, params: m.slice(1), store, ip }) };
  }
  return null;
}
