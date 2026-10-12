// Workflow CrawlSite: robots.txt → discovery → SiteProfile → Markdown pages in
// batches → (client-rendered sites only) a browser crawl in an E2B sandbox.
// Each step is short and idempotent enough to retry; the browser crawl is
// polled with step.sleep, so no step holds a connection while it runs.
// The logic lives in the portable modules next to this file; this is the
// Workers-only glue (D1, R2, Queue, Workflow steps).

import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import { CrawlStore } from '../db/crawl.ts';
import type { IndexMessage } from '../index/indexer.ts';
import type { Env } from '../env.ts';
import { E2B_USD_PER_SECOND, E2BCrawler, MAX_SANDBOX_SECONDS } from './e2b.ts';
import { HostLimiter, intervalFor } from './polite.ts';
import { presign, r2Endpoint } from './presign.ts';
import { browserPages } from './result.ts';
import type { RunHandle } from './runner.ts';
import { discoverSite, fetchPlanned, fetchRobots, robotsFrom } from './site.ts';
import type { Discovery, RobotsFile } from './site.ts';

export interface CrawlParams {
  runId: string;
  site: string;
  startUrl: string;
  maxPages: number;
  maxMinutes: number; // browser crawl only
}

const PAGES_PER_STEP = 10;
const POLL_SECONDS = 20;
const resultKey = (runId: string) => `crawl-results/${runId}.json`;

const NET: WorkflowStepConfig = { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '10 minutes' };
const DB: WorkflowStepConfig = { retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute' };

// Only ever honoured in local dev, whatever else is set (same rule as the API).
const allowLocalhost = (env: Env) => env.ENVIRONMENT === 'dev' && env.ALLOW_LOCALHOST === '1';

export class CrawlSite extends WorkflowEntrypoint<Env, CrawlParams> {
  async run(event: Readonly<WorkflowEvent<CrawlParams>>, step: WorkflowStep): Promise<unknown> {
    const p = event.payload;
    const env = this.env;
    // Page Markdown goes to the skills bucket (pages/), shared with the indexer;
    // the CRAWL bucket only holds browser-crawl results (crawl-results/).
    const store = () => new CrawlStore(env.DB, env.SKILLS);
    const origin = new URL(p.startUrl).origin;
    const local = allowLocalhost(env);
    let handle: RunHandle | null = null;

    try {
      await step.do('start', DB, async () => {
        await store().updateRun(p.runId, { status: 'running' });
        await store().setProfileStatus(p.site, 'crawling');
      });

      const robots: RobotsFile = await step.do('robots', NET, () => fetchRobots(origin, { limiter: new HostLimiter(), allowLocalhost: local }));
      const interval = intervalFor(robotsFrom(robots).crawlDelay);

      const d: Discovery = await step.do('discover', NET, () =>
        discoverSite(p.startUrl, robots, { allowLocalhost: local, budget: p.maxPages, limiter: new HostLimiter({ intervalMs: interval }) }),
      );
      const path = d.blocked ? 'blocked' : d.needsBrowser ? 'browser' : d.plan.length ? 'markdown' : 'html_only';
      const status = { blocked: 'blocked', browser: 'needs_browser', markdown: 'ready', html_only: 'html_only' }[path];

      await step.do('profile', DB, async () => {
        const now = new Date().toISOString();
        await store().putProfile({
          site: p.site,
          status,
          docs_root: d.docsRoot,
          has_llms: d.llmsUrl ? 1 : 0,
          has_llms_full: d.llmsFullUrl ? 1 : 0,
          llms_url: d.llmsUrl,
          llms_full_url: d.llmsFullUrl,
          md_twins_ratio: d.twinRatio,
          twin_pattern: d.twinPattern,
          sitemap_urls_count: d.sitemapUrlsCount,
          openapi_json: JSON.stringify(d.openapi),
          needs_browser: d.needsBrowser ? 1 : 0,
          crawl_delay: d.crawlDelay,
          last_crawled_at: now,
          last_run_id: p.runId,
          updated_at: now,
        });
        await store().updateRun(p.runId, { path });
      });

      // Markdown sources, a batch per step. Each step carries the politeness
      // clock forward so batches don't bunch up at step boundaries.
      let nextStart = 0;
      for (let i = 0; i * PAGES_PER_STEP < d.plan.length; i++) {
        const batch = d.plan.slice(i * PAGES_PER_STEP, (i + 1) * PAGES_PER_STEP);
        nextStart = await step.do(`pages-${i}`, NET, async () => {
          const s = store();
          const prev = await s.prevPages(batch.map((b) => b.url));
          const limiter = new HostLimiter({ intervalMs: interval, nextStart });
          const { pages, failed } = await fetchPlanned(batch, prev, robots, { limiter, allowLocalhost: local });
          const stats = await s.record(p.runId, p.site, pages);
          await enqueue(env, stats.toIndex);
          await s.addRunCounts(p.runId, { new: stats.new, changed: stats.changed, unchanged: stats.unchanged, failed });
          return limiter.nextStart;
        });
      }

      if (d.needsBrowser) {
        if (!env.E2B_API_KEY || !env.E2B_TEMPLATE_ID) throw new Error('needs a browser, but E2B_API_KEY / E2B_TEMPLATE_ID are not set');
        const crawler = new E2BCrawler({ apiKey: env.E2B_API_KEY, templateId: env.E2B_TEMPLATE_ID });
        const maxMinutes = Math.min(p.maxMinutes, (MAX_SANDBOX_SECONDS - 300) / 60);

        // The step output holds the sandbox's access tokens: kept out of the
        // Workflow's visible state, and useless once the sandbox is killed.
        handle = await step.do('browser-start', { retries: { limit: 1, delay: '15 seconds' }, timeout: '2 minutes', sensitive: 'output' }, async () => {
          const uploadUrl = await presignResult(env, p.runId, maxMinutes);
          const robotsTxt = robots.state === 'ok' ? robots.text : robots.state === 'missing' ? '' : 'User-agent: *\nDisallow: /';
          return crawler.start({
            site: p.site,
            startUrls: d.browserStartUrls,
            budget: { maxPages: p.maxPages, maxMinutes },
            uploadUrl,
            docsRoot: d.docsRoot,
            robotsTxt,
            intervalMs: interval,
          });
        });
        const h = handle;

        const maxPolls = Math.ceil((maxMinutes * 60 + 180) / POLL_SECONDS);
        for (let i = 0; i < maxPolls; i++) {
          await step.sleep(`browser-wait-${i}`, `${POLL_SECONDS} seconds`);
          const state = await step.do(`browser-poll-${i}`, NET, () => crawler.poll(h));
          if (state !== 'running') break;
        }

        // Without R2 credentials (local dev) the result is read from the
        // sandbox and stored where the upload would have put it.
        const collected = await step.do('browser-collect', NET, async () => {
          if (!(await env.CRAWL.head(resultKey(p.runId)))) {
            const raw = await crawler.result(h);
            if (raw) await env.CRAWL.put(resultKey(p.runId), raw, { httpMetadata: { contentType: 'application/json' } });
          }
          const obj = await env.CRAWL.get(resultKey(p.runId));
          if (!obj) return { pages: 0, error: (await crawler.status(h))?.error ?? 'no result' };
          return { pages: browserPages(await obj.text(), p.site, robotsFrom(robots), p.maxPages).length, error: null };
        });

        await step.do('browser-stop', DB, async () => {
          await crawler.stop(h);
          const seconds = Math.round((Date.now() - h.startedAt) / 1000);
          await store().updateRun(p.runId, { browser_seconds: seconds, cost_usd: Number((seconds * E2B_USD_PER_SECOND).toFixed(6)) });
        });
        handle = null;
        if (collected.error && !collected.pages) throw new Error(`browser crawl failed: ${collected.error}`);

        for (let i = 0; i * PAGES_PER_STEP < collected.pages; i++) {
          await step.do(`browser-pages-${i}`, NET, async () => {
            const obj = await env.CRAWL.get(resultKey(p.runId));
            if (!obj) throw new Error('crawl result disappeared');
            const pages = browserPages(await obj.text(), p.site, robotsFrom(robots), p.maxPages).slice(i * PAGES_PER_STEP, (i + 1) * PAGES_PER_STEP);
            const stats = await store().record(p.runId, p.site, pages);
            await enqueue(env, stats.toIndex);
            await store().addRunCounts(p.runId, { new: stats.new, changed: stats.changed, unchanged: stats.unchanged, failed: 0 });
          });
        }
        await step.do('browser-cleanup', DB, () => env.CRAWL.delete(resultKey(p.runId)));
      }

      await step.do('finish', DB, async () => {
        const now = new Date().toISOString();
        await store().updateRun(p.runId, { status: 'complete', finished_at: now });
        await store().refreshPageCount(p.site);
      });
      return { runId: p.runId, path };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await step.do('fail', DB, async () => {
        if (handle) await new E2BCrawler({ apiKey: env.E2B_API_KEY ?? '', templateId: '' }).stop(handle).catch(() => {});
        await store().updateRun(p.runId, { status: 'failed', finished_at: new Date().toISOString(), error: message.slice(0, 500) });
        await store().setProfileStatus(p.site, 'failed');
        await store().refreshPageCount(p.site);
      });
      throw e;
    }
  }
}

// One message per new or changed page, body exactly { site, url, contentHash };
// sendBatch takes at most 100 messages.
async function enqueue(env: Env, messages: IndexMessage[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 100) {
    await env.INDEX_QUEUE.sendBatch(messages.slice(i, i + 100).map(({ site, url, contentHash }) => ({ body: { site, url, contentHash } })));
  }
}

// A presigned PUT for this run's result object only, valid for the crawl plus
// a margin. Null in local dev without R2 credentials (the Workflow then reads
// the result from the sandbox); anywhere else missing credentials are an error.
async function presignResult(env: Env, runId: string, maxMinutes: number): Promise<string | null> {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID, CRAWL_BUCKET_NAME } = env;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID || !CRAWL_BUCKET_NAME) {
    if (env.ENVIRONMENT === 'dev') return null;
    throw new Error('R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID and CRAWL_BUCKET_NAME are required for browser crawls');
  }
  return presign({
    method: 'PUT',
    url: r2Endpoint(R2_ACCOUNT_ID, CRAWL_BUCKET_NAME, resultKey(runId)),
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    expiresIn: Math.ceil(maxMinutes * 60) + 600,
    headers: { 'content-type': 'application/json' },
  });
}
