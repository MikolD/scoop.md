// The admin console's JSON endpoints (admin.scoop.md/api/*). Basic auth and
// the same-origin check have already passed (app.ts). Same logic as the v1
// admin routes, called in-process: the browser never holds ADMIN_TOKEN.

import seedList from '../../seeds/devtools.json' with { type: 'json' };
import { buildPackage, withCurrentPage } from '../../../extension/lib/package.js';
import { json, readJson } from '../api/http.ts';
import { profileJson, renderPackage, requestsDailyMax, runJson, searchDeps } from '../api/v1.ts';
import { viewOf } from '../crawl/requests.ts';
import { runCosts } from '../db/crawl.ts';
import { runPrefix } from '../crawl/collect.ts';
import { E2BCrawler, e2bDailyCap } from '../crawl/e2b.ts';
import { startCrawl } from '../crawl/start.ts';
import { CrawlStore } from '../db/crawl.ts';
import type { SiteProfileRow } from '../db/crawl.ts';
import { Store, summary } from '../db/store.ts';
import { SLOTS } from '../index/classify.ts';
import { indexDeps } from '../index/deps.ts';
import { pageKey } from '../index/indexer.ts';
import { purgeSiteIndex } from '../index/purge.ts';
import { ApiError, bad, notFound } from '../lib/errors.ts';
import { normalizeSite, siteOf } from '../lib/ssrf.ts';
import { MAX_CRAWL_PAGES, validateCrawl } from '../lib/validate.ts';
import { DEFAULT_PACKAGE_BUDGET, MAX_PACKAGE_BUDGET, MIN_PACKAGE_BUDGET } from '../search/package.ts';
import { siteTopics, topicChunks } from '../search/queries.ts';
import { search } from '../search/search.ts';
import { topicTree } from '../search/topics.ts';
import type { Env } from '../env.ts';
import { batchInstanceId, cancelBatch, createBatch, getBatch, listBatches, MAX_CONCURRENCY, newBatchId } from './batch.ts';
import * as q from './queries.ts';
import { telemetryRoutes } from './telemetry.ts';

interface Seed {
  name: string;
  site: string;
  startUrl: string;
  maxPages?: number;
}
export const SEEDS = seedList as Seed[];
const DEFAULT_SEED_PAGES = 200;
const PAGE = 50;
// Stored page Markdown is at most 2 MB; the console shows it whole.
const MAX_MARKDOWN = 2_100_000;
const TOPIC = /^[\p{L}\p{N}._-]+(\/[\p{L}\p{N}._-]+){0,3}$/u;

interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  params: string[];
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (c: Ctx) => Promise<Response>;
}

// Only ever honoured in local dev (same rule as the v1 API).
const allowLocalhost = (env: Env) => env.ENVIRONMENT === 'dev' && env.ALLOW_LOCALHOST === '1';
const crawlStore = (env: Env) => new CrawlStore(env.DB, env.SKILLS);

function page(url: URL) {
  const offset = Math.max(0, Math.trunc(Number(url.searchParams.get('cursor'))) || 0);
  return { limit: PAGE, offset, next: (more: boolean) => (more ? String(offset + PAGE) : null) };
}

function siteArg(raw: string | null): string {
  let site: string;
  try { site = normalizeSite(decodeURIComponent(raw ?? '')); } catch { throw bad('Invalid site'); }
  if (!/^[a-z0-9.-]{1,253}$/.test(site)) throw bad('Invalid site');
  return site;
}

function text(url: URL, name: string, max = 200): string | undefined {
  const v = (url.searchParams.get(name) ?? '').replace(/\s+/g, ' ').trim();
  if (v.length > max) throw bad(`${name} is over ${max} characters`);
  return v || undefined;
}

const parse = <T>(s: unknown, fallback: T): T => {
  try { return typeof s === 'string' ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
};

// Every site profile field, for the console (the public profile hides some for not_devtool sites).
function profileFull(r: SiteProfileRow) {
  return {
    ...profileJson({ ...r, status: r.status === 'not_devtool' ? 'ready' : r.status }),
    status: r.status,
    crawlState: r.crawl_state,
    source: r.source,
    approved: Boolean(r.approved),
    lastRunId: r.last_run_id,
    gate: r.gate_method
      ? { category: r.gate_category, method: r.gate_method, reason: r.gate_reason, confidence: r.gate_confidence, checkedAt: r.gate_checked_at }
      : null,
  };
}

// Stops a crawl: terminates its Workflow, kills its tagged E2B sandboxes and
// clears its working files. The run is marked failed (and the site's crawl
// ended, keeping its last outcome) only once its Workflow is certainly
// stopped: terminate() succeeded or the instance was already final. If not
// (the instance can't be reached), the run is left as it is: ok is false.
export async function cancelRun(env: Env, runId: string): Promise<{ ok: boolean; terminated: boolean; sandboxes: number; marked: boolean; notes: string[] }> {
  const crawls = crawlStore(env);
  const run = await crawls.getRun(runId);
  if (!run) throw notFound('No such crawl run');
  const notes: string[] = [];
  let terminated = false;
  let stopped = false;
  try {
    const instance = await env.CRAWL_SITE.get(runId);
    const { status } = await instance.status();
    if (['complete', 'errored', 'terminated'].includes(status)) {
      stopped = true;
    } else {
      await instance.terminate();
      terminated = stopped = true;
    }
  } catch (e) {
    notes.push(`workflow: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
  }
  let sandboxes = 0;
  if (env.E2B_API_KEY) {
    try {
      sandboxes = await new E2BCrawler({ apiKey: env.E2B_API_KEY, templateId: env.E2B_TEMPLATE_ID ?? '' }).stopTagged(runId);
    } catch (e) {
      notes.push(`e2b: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }
  }
  const active = run.status === 'queued' || run.status === 'running';
  if (active && !stopped) return { ok: false, terminated, sandboxes, marked: false, notes };
  if (active) {
    await crawls.updateRun(runId, { status: 'failed', finished_at: new Date().toISOString(), error: 'cancelled by an admin' });
    await crawls.endCrawl(run.site);
  }
  let cursor: string | undefined;
  do {
    const list = await env.CRAWL.list({ prefix: runPrefix(runId), cursor });
    if (list.objects.length) await env.CRAWL.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return { ok: true, terminated, sandboxes, marked: active, notes };
}

async function profilesFor(db: D1Database, sites: string[]): Promise<Map<string, SiteProfileRow>> {
  const out = new Map<string, SiteProfileRow>();
  const unique = [...new Set(sites)];
  for (let i = 0; i < unique.length; i += 90) {
    const chunk = unique.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT * FROM site_profiles WHERE site IN (${chunk.map(() => '?').join(', ')})`)
      .bind(...chunk)
      .all<SiteProfileRow>();
    for (const r of results) out.set(r.site, r);
  }
  return out;
}

// The Markdown package the extension copies for a shared skill when the user
// is on the skill's own page: extension/lib/package.js itself, not a port.
export function skillPackage(skill: { site: string; pageUrl: string; sections: { label: string; url: string; content: string | null; bytes?: number | null }[]; relatedLinks?: { url: string; text?: string }[] }, now = new Date()) {
  return buildPackage({
    site: skill.site,
    pageUrl: skill.pageUrl,
    sections: withCurrentPage(skill.sections, null, skill.pageUrl),
    relatedLinks: skill.relatedLinks ?? [],
    now,
  });
}

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/overview$/,
    handler: async ({ env }) => {
      const { dailyCapUsd, totalCapUsd } = indexDeps(env);
      return json(200, {
        environment: env.ENVIRONMENT ?? 'dev',
        secrets: { openrouter: Boolean(env.OPENROUTER_API_KEY), e2b: Boolean(env.E2B_API_KEY) },
        ...(await q.overview(env.DB, { dailyCapUsd, totalCapUsd })),
        e2bCapUsd: e2bDailyCap(env),
        // Today's crawl requests from the extension; `started` is what the cap counts.
        crawlRequests: { ...(await q.requestCounts(env.DB)), capPerDay: requestsDailyMax(env) },
        // Requested sites waiting for an admin's approval (left out of cross-site search).
        pendingApproval: await q.pendingApproval(env.DB),
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/runs$/,
    handler: async ({ env, url }) => {
      const p = page(url);
      const status = text(url, 'status', 20);
      const site = url.searchParams.get('site') ? siteArg(url.searchParams.get('site')) : undefined;
      const { rows, more } = await q.listRuns(env.DB, { status, site, limit: p.limit, offset: p.offset });
      return json(200, { runs: rows.map(runJson), next: p.next(more) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/runs\/(cr_[0-9A-Z]{26})$/,
    handler: async ({ env, params }) => {
      const crawls = crawlStore(env);
      const run = await crawls.getRun(params[0]);
      if (!run) throw notFound('No such crawl run');
      let workflow: InstanceStatus | null = null;
      try {
        workflow = await (await env.CRAWL_SITE.get(run.id)).status();
      } catch {
        // expired from Workflow retention; the run row is the record
      }
      const pages = await crawls.pagesForRun(run.id, 50);
      return json(200, {
        run: runJson(run),
        workflow: workflow && { status: workflow.status, error: workflow.error ? String(workflow.error.message ?? workflow.error) : null },
        pages,
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/runs\/(cr_[0-9A-Z]{26})\/cancel$/,
    handler: async ({ env, params }) => {
      const r = await cancelRun(env, params[0]);
      if (r.ok) return json(200, r);
      return json(502, { error: { code: 'internal', message: 'Could not stop the crawl\'s Workflow; the run was left as it is. Try again.' }, ...r });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/crawl$/,
    handler: async ({ env, req }) => {
      const body = (await readJson(req)) as { url?: unknown; maxPages?: unknown; force?: unknown };
      if (typeof body.url !== 'string') throw bad('url is required');
      let site: string;
      try { site = siteOf(body.url); } catch { throw bad('url is not a valid URL'); }
      const crawl = validateCrawl({ site, startUrl: body.url, maxPages: body.maxPages, force: body.force }, allowLocalhost(env));
      const runId = await startCrawl({ db: env.DB, bucket: env.SKILLS, workflow: env.CRAWL_SITE }, crawl);
      if (!runId) throw new ApiError('conflict', `A crawl of ${crawl.site} is already queued or running`, 409);
      return json(202, { runId, site: crawl.site, startUrl: crawl.startUrl, maxPages: crawl.maxPages, forced: crawl.force });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/seeds$/,
    handler: async ({ env }) => {
      const profiles = await profilesFor(env.DB, SEEDS.map((s) => normalizeSite(s.site)));
      return json(200, {
        seeds: SEEDS.map((s) => {
          const p = profiles.get(normalizeSite(s.site));
          return {
            name: s.name,
            site: normalizeSite(s.site),
            startUrl: s.startUrl,
            maxPages: s.maxPages ?? DEFAULT_SEED_PAGES,
            status: p?.status ?? null,
            crawling: p?.crawl_state === 'crawling',
            pagesFetched: p?.pages_fetched ?? 0,
            lastCrawledAt: p?.last_crawled_at ?? null,
            gate: p?.gate_method ? { category: p.gate_category, method: p.gate_method, reason: p.gate_reason } : null,
          };
        }),
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/batches$/,
    handler: async ({ env }) => json(200, { batches: await listBatches(env.DB, 20) }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/batches$/,
    // { startUrls?: string[] (seeds by start URL; omitted = every seed), concurrency 1-8, maxPages?, force? }
    handler: async ({ env, req }) => {
      const body = (await readJson(req)) as { startUrls?: unknown; concurrency?: unknown; maxPages?: unknown; force?: unknown };
      const concurrency = body.concurrency === undefined ? 4 : body.concurrency;
      if (!Number.isInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > MAX_CONCURRENCY) {
        throw bad(`concurrency must be an integer 1–${MAX_CONCURRENCY}`);
      }
      const maxPages = body.maxPages ?? null;
      if (maxPages !== null && (!Number.isInteger(maxPages) || (maxPages as number) < 1 || (maxPages as number) > MAX_CRAWL_PAGES)) {
        throw bad(`maxPages must be an integer 1–${MAX_CRAWL_PAGES}`);
      }
      if (body.force !== undefined && typeof body.force !== 'boolean') throw bad('force must be a boolean');
      let seeds = SEEDS;
      if (body.startUrls !== undefined) {
        if (!Array.isArray(body.startUrls) || !body.startUrls.length || body.startUrls.some((u) => typeof u !== 'string')) {
          throw bad('startUrls must be a non-empty array of seed start URLs');
        }
        const wanted = new Set(body.startUrls as string[]);
        seeds = SEEDS.filter((s) => wanted.has(s.startUrl));
        if (seeds.length !== wanted.size) throw bad('startUrls has URLs that are not in the seed list');
      }
      // Validated now, so a bad seed fails here rather than in the Workflow.
      const jobs = seeds.map((s) => {
        const c = validateCrawl({ site: s.site, startUrl: s.startUrl, maxPages: (maxPages as number | null) ?? s.maxPages ?? DEFAULT_SEED_PAGES }, allowLocalhost(env));
        return { name: s.name, site: c.site, startUrl: c.startUrl, maxPages: c.maxPages };
      });
      // One batch at a time: two would compete for the same sites and budget.
      if (await env.DB.prepare(`SELECT 1 FROM crawl_batches WHERE status = 'running' LIMIT 1`).first()) {
        throw new ApiError('conflict', 'A batch is already running; cancel it or wait for it to finish', 409);
      }
      const id = newBatchId();
      await createBatch(env.DB, { id, concurrency: concurrency as number, maxPages: maxPages as number | null, force: body.force === true, jobs });
      try {
        await env.CRAWL_BATCH.create({ id: batchInstanceId(id), params: { batchId: id } });
      } catch (e) {
        await cancelBatch(env.DB, id);
        throw e;
      }
      return json(202, { batchId: id, jobs: jobs.length });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/batches\/(cb_[0-9A-Z]{26})$/,
    handler: async ({ env, params }) => {
      const b = await getBatch(env.DB, params[0]);
      if (!b) throw notFound('No such batch');
      return json(200, b);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/batches\/(cb_[0-9A-Z]{26})\/cancel$/,
    // { stopRuns?: true } also cancels the crawls already running.
    handler: async ({ env, req, params }) => {
      const body = (await readJson(req)) as { stopRuns?: unknown };
      if (!(await getBatch(env.DB, params[0]))) throw notFound('No such batch');
      const inFlight = await cancelBatch(env.DB, params[0]);
      if (inFlight === null) throw new ApiError('conflict', 'This batch is not running', 409);
      let stopped = 0;
      const notStopped: string[] = [];
      if (body.stopRuns === true) {
        for (const runId of inFlight) {
          const r = await cancelRun(env, runId);
          if (r.marked) stopped++;
          if (!r.ok) notStopped.push(runId);
        }
      }
      return json(200, { cancelled: true, inFlight: inFlight.length, stopped, notStopped });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/sites$/,
    handler: async ({ env, url }) => {
      const p = page(url);
      const { rows, more } = await q.listSites(env.DB, { status: text(url, 'status', 20), q: text(url, 'q', 100)?.toLowerCase(), limit: p.limit, offset: p.offset });
      const broken = await q.brokenLinkCounts(env.DB, rows.map((r) => r.site));
      return json(200, {
        sites: rows.map((r) => ({
          site: r.site,
          status: r.status,
          crawling: r.crawl_state === 'crawling',
          pages: r.pages,
          indexed: r.indexed,
          docsRoot: r.docs_root,
          hasLlms: Boolean(r.has_llms),
          needsBrowser: Boolean(r.needs_browser),
          gate: r.gate_method ? { category: r.gate_category, method: r.gate_method, reason: r.gate_reason } : null,
          source: r.source,
          approved: Boolean(r.approved),
          brokenLinks: broken.get(r.site) ?? 0,
          lastCrawledAt: r.last_crawled_at,
          lastRun: r.last_run_id ? { id: r.last_run_id, status: r.last_run_status, startedAt: r.last_run_started_at } : null,
          updatedAt: r.updated_at,
        })),
        next: p.next(more),
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/sites\/([^/]+)$/,
    handler: async ({ env, params }) => {
      const site = siteArg(params[0]);
      const [profile, counts, topics, runs, broken] = await Promise.all([
        crawlStore(env).getProfile(site),
        q.siteCounts(env.DB, site),
        siteTopics(env.DB, site),
        q.siteRuns(env.DB, site),
        q.brokenLinkCounts(env.DB, [site]),
      ]);
      if (!profile && !counts.pages && !counts.indexed && !runs.length) throw notFound('Nothing known about this site');
      return json(200, {
        site, profile: profile && profileFull(profile), counts: { ...counts, brokenLinks: broken.get(site) ?? 0 }, topics: topicTree(topics.rows), runs: runs.map(runJson),
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/sites\/([^/]+)\/broken-links$/,
    // Links in the site's pages whose targets are bad (unlinked in everything served).
    handler: async ({ env, params }) => {
      const site = siteArg(params[0]);
      return json(200, { site, links: await q.brokenLinks(env.DB, site) });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/sites\/([^/]+)\/approve$/,
    // A requested site joins cross-site search.
    handler: async ({ env, params }) => {
      const site = siteArg(params[0]);
      if (!(await crawlStore(env).approveSite(site))) throw notFound('No profile for this site');
      return json(200, { site, approved: true });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/sites\/([^/]+)\/reject$/,
    // Not a devtool site after all: mark it not_devtool and purge its index.
    handler: async ({ env, params }) => {
      const site = siteArg(params[0]);
      const active = await env.DB.prepare(`SELECT id FROM crawl_runs WHERE site = ? AND status IN ('queued', 'running')`).bind(site).first<{ id: string }>();
      if (active) throw new ApiError('conflict', `Cancel the running crawl first (${active.id})`, 409);
      // Pages still on their way to the index (the outbox, or a crawl that
      // finished in the last 30 minutes with pages not yet indexed) would land
      // after the purge; the indexer skips them, but wait for them anyway.
      const since = new Date(Date.now() - 30 * 60_000).toISOString();
      const indexing = await env.DB
        .prepare(
          `SELECT (SELECT COUNT(*) FROM pages WHERE site = ?1 AND index_pending = 1) AS pending,
                  (SELECT COUNT(*) FROM crawl_runs WHERE site = ?1 AND status = 'complete' AND costs_tracked = 1
                     AND pages_indexed < pages_new + pages_changed AND finished_at > ?2) AS indexing`,
        )
        .bind(site, since)
        .first<{ pending: number; indexing: number }>();
      if (indexing && (indexing.pending > 0 || indexing.indexing > 0)) {
        throw new ApiError('conflict', 'Pages of this site are still being indexed; try again in a few minutes', 409);
      }
      if (!(await crawlStore(env).rejectSite(site))) throw notFound('No profile for this site');
      const purged = await purgeSiteIndex(env.DB, env.VECTORS, site);
      return json(200, { site, status: 'not_devtool', purged });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/sites\/([^/]+)\/pages$/,
    handler: async ({ env, url, params }) => {
      const site = siteArg(params[0]);
      const topic = text(url, 'topic', 200)?.toLowerCase();
      if (topic && !TOPIC.test(topic)) throw bad('topic must be a path like webhooks/signatures');
      const p = page(url);
      const { rows, more } = await q.sitePages(env.DB, site, { topic, limit: p.limit, offset: p.offset });
      return json(200, {
        pages: rows.map((r) => ({
          url: r.url,
          title: r.title,
          kind: r.source_kind,
          contentHash: r.content_hash,
          bytes: r.bytes,
          changedAt: r.changed_at,
          indexPending: Boolean(r.index_pending),
          // Indexed, and the index matches the stored content.
          indexed: r.indexed_hash !== null,
          current: r.indexed_hash !== null && r.indexed_hash === r.content_hash,
          slot: r.slot,
          topic: r.topic,
          summary: r.summary,
          model: r.model,
          costUsd: r.cost_usd,
        })),
        next: p.next(more),
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/page$/,
    handler: async ({ env, url }) => {
      const pageUrl = url.searchParams.get('url') ?? '';
      if (!pageUrl || pageUrl.length > 2048) throw bad('url is required');
      const d = await q.pageDetail(env.DB, pageUrl);
      if (!d.page && !d.index) throw notFound('No such page');
      const hash = (d.page?.content_hash ?? d.index?.content_hash) as string;
      const obj = await env.SKILLS.get(pageKey(hash));
      let markdown: string | null = null;
      let truncated = false;
      if (obj) {
        markdown = await obj.text();
        if (markdown.length > MAX_MARKDOWN) (markdown = markdown.slice(0, MAX_MARKDOWN)), (truncated = true);
      }
      const ix = d.index;
      return json(200, {
        url: pageUrl,
        page: d.page,
        labels: ix && {
          contentHash: ix.content_hash,
          current: !d.page || ix.content_hash === d.page.content_hash,
          title: ix.title,
          slot: ix.slot,
          topicPath: parse<string[]>(ix.topic_path, []),
          summary: ix.summary,
          tasks: parse<string[]>(ix.tasks, []),
          entities: parse<{ kind: string; name: string }[]>(ix.entities, []),
          model: ix.model,
          costUsd: ix.cost_usd,
          attempts: ix.attempts,
          indexedAt: ix.indexed_at,
        },
        chunks: d.chunks,
        markdown,
        markdownKey: pageKey(hash),
        truncated,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/search$/,
    // What GET /v1/search answers, with each hit's full chunk text.
    handler: async ({ env, url }) => {
      const query = text(url, 'q');
      if (!query) throw bad('q is required');
      const site = url.searchParams.get('site') ? siteArg(url.searchParams.get('site')) : undefined;
      const slot = url.searchParams.get('slot') || undefined;
      if (slot && !SLOTS.includes(slot as never)) throw bad(`slot must be one of ${SLOTS.join(', ')}`);
      const limit = Math.min(50, Math.max(1, Math.trunc(Number(url.searchParams.get('limit'))) || 10));
      const hits = await search(searchDeps(env), { q: query, site, slot, limit });
      return json(200, {
        query,
        site: site ?? null,
        hits: hits.map((h) => ({ url: h.url, title: h.title, heading_path: h.heading_path, snippet: h.snippet, text: h.text, slot: h.slot, topic_path: h.topic_path, score: h.score })),
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/package$/,
    // Exactly what GET /v1/packages returns, as JSON { markdown }.
    handler: async ({ env, url }) => {
      const site = siteArg(url.searchParams.get('site'));
      const budgetRaw = Math.trunc(Number(url.searchParams.get('budget')));
      const budget = Number.isFinite(budgetRaw) && budgetRaw > 0 ? Math.min(MAX_PACKAGE_BUDGET, Math.max(MIN_PACKAGE_BUDGET, budgetRaw)) : DEFAULT_PACKAGE_BUDGET;
      const topic = text(url, 'topic');
      let label: string;
      let chunks;
      if (topic) {
        label = topic.toLowerCase();
        if (!TOPIC.test(label)) throw bad('topic must be a path like webhooks/signatures');
        chunks = await topicChunks(env.DB, site, label);
      } else {
        const query = text(url, 'q');
        if (!query) throw bad('q or topic is required');
        label = query;
        chunks = await search(searchDeps(env), { q: label, site, limit: 40 });
      }
      if (!chunks.length) throw notFound('Nothing indexed matches');
      const markdown = await renderPackage(env.DB, { site, label, chunks, budget });
      return json(200, { site, label, budget, chunks: chunks.length, markdown });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/library$/,
    handler: async ({ env, url }) => {
      const p = page(url);
      const { rows, more } = await q.librarySites(env.DB, p);
      const store = new Store(env.DB, env.SKILLS);
      const best = await Promise.all(rows.map((r) => store.bestRow(r.site)));
      return json(200, {
        sites: rows.map((r, i) => ({
          site: r.site,
          total: r.total,
          live: r.live,
          worked: r.worked,
          failed: r.failed,
          lastSharedAt: r.last_shared_at,
          best: best[i] && summary(best[i]),
        })),
        reports: await q.reports(env.DB, { open: true, limit: 50 }),
        next: p.next(more),
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/library\/([^/]+)$/,
    handler: async ({ env, params }) => {
      const site = siteArg(params[0]);
      const store = new Store(env.DB, env.SKILLS);
      const [best, recent, removed] = await Promise.all([store.bestRow(site), store.recent(site, 50), q.removedSkills(env.DB, site)]);
      if (!best && !recent.length && !removed.length) throw notFound('No skills for this site');
      return json(200, { site, best: best && summary(best), recent: recent.map(summary), removed });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/skills\/([\w-]+)$/,
    handler: async ({ env, params }) => {
      const store = new Store(env.DB, env.SKILLS);
      const row = await store.getRow(params[0]);
      if (!row) throw notFound('No such skill');
      const skill = row.removed_at ? null : await store.load(row);
      return json(200, {
        skill: { ...summary(row), removedAt: row.removed_at, sections: skill?.sections ?? null, relatedLinks: skill?.relatedLinks ?? null },
        package: skill ? skillPackage(skill) : null,
        reports: await q.reports(env.DB, { open: false, skillId: row.id, limit: 50 }),
      });
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/skills\/([\w-]+)$/,
    // Takedown, as DELETE /v1/admin/skills/:id: the row stays for audit, the content goes.
    handler: async ({ env, params }) => {
      const store = new Store(env.DB, env.SKILLS);
      if (!(await store.getRow(params[0]))) throw notFound('No such skill');
      await store.remove(params[0]);
      return json(200, { ok: true });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/crawl-requests$/,
    handler: async ({ env, url }) => {
      const p = page(url);
      const site = url.searchParams.get('site') ? siteArg(url.searchParams.get('site')) : undefined;
      const { rows, more } = await q.crawlRequests(env.DB, { site, limit: p.limit, offset: p.offset });
      const approvals = await q.siteApprovals(env.DB, [...new Set(rows.map((r) => r.row.site))]);
      return json(200, {
        requests: rows.map(({ row, run }) => {
          const live = viewOf(row, run);
          return {
            id: row.id,
            site: row.site,
            url: row.url,
            install: row.install_hash.slice(0, 8),
            outcome: row.state,
            siteApproved: approvals.get(row.site) ?? null,
            state: live.state,
            phase: live.phase,
            pagesFound: live.pagesFound,
            pagesIndexed: live.pagesIndexed,
            reason: live.reason,
            // The run's own error, for admins only (users see live.reason).
            error: run?.error ?? null,
            runId: row.run_id,
            costs: run ? runCosts(run) : null,
            createdAt: row.created_at,
          };
        }),
        next: p.next(more),
        capPerDay: requestsDailyMax(env),
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/reports$/,
    handler: async ({ env, url }) => json(200, { reports: await q.reports(env.DB, { open: url.searchParams.get('all') !== '1', limit: 200 }) }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/costs$/,
    handler: async ({ env, url }) => {
      const days = Math.min(60, Math.max(1, Math.trunc(Number(url.searchParams.get('days'))) || 14));
      const { dailyCapUsd, totalCapUsd } = indexDeps(env);
      const [byDay, crawls] = await Promise.all([q.costs(env.DB, days), q.crawlCosts(env.DB, days)]);
      return json(200, { days: byDay, crawls, siteCapUsd: dailyCapUsd, totalCapUsd });
    },
  },
  // Usage telemetry (src/admin/telemetry.ts).
  ...telemetryRoutes,
];

export async function adminApi(req: Request, env: Env, url: URL): Promise<Response> {
  let wrongMethod = false;
  for (const r of routes) {
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    if (r.method !== req.method) {
      wrongMethod = true;
      continue;
    }
    return r.handler({ req, env, url, params: m.slice(1) });
  }
  if (wrongMethod) throw new ApiError('invalid_request', 'Method not allowed', 405);
  throw notFound();
}
