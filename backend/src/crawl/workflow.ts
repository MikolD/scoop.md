// Workflow CrawlSite: robots.txt → discovery → SiteProfile → pages in batches
// → (client-rendered sites only) a browser crawl in an E2B sandbox.
// Each step is short and safe to retry; the browser crawl is polled with
// step.sleep, so no step holds a connection while it runs. Step outputs stay
// small: the fetch plan and browser results live in R2 under
// crawl-results/<runId>/ and are deleted when the run ends.
// Index messages go through an outbox (pages.index_pending): a page step
// records pages and flags them in one D1 batch, and a separate index step
// sends and clears the flags, so a retried step never loses a message.
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
import { batchKey, collectResult, planKey, runPrefix, uploadKey } from './collect.ts';
import type { RunHandle } from './runner.ts';
import { discoverSite, fetchPlanned, fetchRobots, robotsFrom } from './site.ts';
import type { Discovery, FetchedSource, PlannedPage, RobotsFile } from './site.ts';

export interface CrawlParams {
  runId: string;
  site: string;
  startUrl: string;
  maxPages: number;
  maxMinutes: number; // browser crawl only
}

const PAGES_PER_STEP = 10;
const POLL_SECONDS = 20;

const NET: WorkflowStepConfig = { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '10 minutes' };
const DB: WorkflowStepConfig = { retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute' };

// Only ever honoured in local dev, whatever else is set (same rule as the API).
const allowLocalhost = (env: Env) => env.ENVIRONMENT === 'dev' && env.ALLOW_LOCALHOST === '1';

// Discovery as a step returns it: the plan itself is in R2.
type DiscoverySummary = Omit<Discovery, 'plan'> & { planSize: number; html: boolean };

export class CrawlSite extends WorkflowEntrypoint<Env, CrawlParams> {
  async run(event: Readonly<WorkflowEvent<CrawlParams>>, step: WorkflowStep): Promise<unknown> {
    const p = event.payload;
    const env = this.env;
    // Page Markdown goes to the skills bucket (pages/), shared with the indexer;
    // the CRAWL bucket only holds this run's working files (crawl-results/).
    const store = () => new CrawlStore(env.DB, env.SKILLS);
    const origin = new URL(p.startUrl).origin;
    const local = allowLocalhost(env);
    const e2b = () => new E2BCrawler({ apiKey: env.E2B_API_KEY ?? '', templateId: env.E2B_TEMPLATE_ID ?? '' });
    // Sends this site's pending index messages; repeating it is harmless.
    const flush = (name: string) =>
      step.do(name, NET, () => store().flushIndex(p.site, (batch) => send(env, batch)));

    try {
      await step.do('start', DB, async () => {
        await store().updateRun(p.runId, { status: 'running' });
        await store().beginCrawl(p.site);
      });

      const robots: RobotsFile = await step.do('robots', NET, () => fetchRobots(origin, { limiter: new HostLimiter(), allowLocalhost: local }));
      const interval = intervalFor(robotsFrom(robots).crawlDelay);

      const d: DiscoverySummary = await step.do('discover', NET, async () => {
        const { plan, ...rest } = await discoverSite(p.startUrl, robots, {
          allowLocalhost: local,
          budget: p.maxPages,
          limiter: new HostLimiter({ intervalMs: interval }),
        });
        await env.CRAWL.put(planKey(p.runId), JSON.stringify(plan), { httpMetadata: { contentType: 'application/json' } });
        return { ...rest, planSize: plan.length, html: plan.some((pl) => pl.kind === 'page-html') };
      });
      const path = d.blocked ? 'blocked' : d.needsBrowser ? 'browser' : d.html ? 'html' : d.planSize ? 'markdown' : 'none';

      await step.do('profile', DB, async () => {
        const now = new Date().toISOString();
        // Discovery facts only: the public status changes in `finish`/`fail`.
        await store().putProfile({
          site: p.site,
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
          last_run_id: p.runId,
          updated_at: now,
        });
        await store().updateRun(p.runId, { path });
        await store().addRunCounts(p.runId, { new: 0, changed: 0, unchanged: 0, failed: 0, skipped: d.skipped });
      });

      // Planned sources, a batch per step, each followed by an index flush.
      // Each page step carries the politeness clock forward so batches don't
      // bunch up at step boundaries.
      let nextStart = 0;
      for (let i = 0; i * PAGES_PER_STEP < d.planSize; i++) {
        nextStart = await step.do(`pages-${i}`, NET, async () => {
          const planObj = await env.CRAWL.get(planKey(p.runId));
          if (!planObj) throw new Error('crawl plan missing');
          const batch = (await planObj.json<PlannedPage[]>()).slice(i * PAGES_PER_STEP, (i + 1) * PAGES_PER_STEP);
          const s = store();
          const prev = await s.prevPages(batch.map((b) => b.url));
          const limiter = new HostLimiter({ intervalMs: interval, nextStart });
          const { pages, failed, skipped } = await fetchPlanned(batch, prev, robots, { limiter, allowLocalhost: local });
          const stats = await s.record(p.runId, p.site, pages);
          await s.addRunCounts(p.runId, { ...stats, failed, skipped });
          return limiter.nextStart;
        });
        await flush(`index-${i}`);
      }

      if (d.needsBrowser) {
        if (!env.E2B_API_KEY || !env.E2B_TEMPLATE_ID) throw new Error('needs a browser, but E2B_API_KEY / E2B_TEMPLATE_ID are not set');
        const crawler = e2b();
        const maxMinutes = Math.min(p.maxMinutes, (MAX_SANDBOX_SECONDS - 300) / 60);

        // Kills any sandbox a failed earlier attempt of this step left behind,
        // then starts one tagged with the run ID. The output holds the
        // sandbox's access tokens: kept out of the Workflow's visible state,
        // and useless once the sandbox is killed.
        const h: RunHandle = await step.do(
          'browser-start',
          { retries: { limit: 1, delay: '15 seconds' }, timeout: '3 minutes', sensitive: 'output' },
          async () => {
            await crawler.stopTagged(p.runId);
            const uploadUrl = await presignResult(env, p.runId, maxMinutes);
            const robotsTxt = robots.state === 'ok' ? robots.text : robots.state === 'missing' ? '' : 'User-agent: *\nDisallow: /';
            return crawler.start(
              { site: p.site, startUrls: d.browserStartUrls, budget: { maxPages: p.maxPages, maxMinutes }, uploadUrl, docsRoot: d.docsRoot, robotsTxt, intervalMs: interval },
              p.runId,
            );
          },
        );

        const maxPolls = Math.ceil((maxMinutes * 60 + 180) / POLL_SECONDS);
        for (let i = 0; i < maxPolls; i++) {
          await step.sleep(`browser-wait-${i}`, `${POLL_SECONDS} seconds`);
          const state = await step.do(`browser-poll-${i}`, NET, () => crawler.poll(h));
          if (state !== 'running') break;
        }

        // The result comes from the sandbox's job server (traffic token + job
        // token, at most 25 MB of application/json), unless the optional
        // presigned upload already delivered it. collectResult validates it
        // once, stores one object per page step and writes a manifest last; a
        // retry returns the manifest without needing the sandbox. Stopping the
        // sandbox is its own step, so a retry here never finds it gone.
        const collected = await step.do('browser-collect', NET, () =>
          collectResult({
            bucket: env.CRAWL,
            crawler,
            handle: h,
            runId: p.runId,
            site: p.site,
            robots: robotsFrom(robots),
            maxPages: p.maxPages,
            perBatch: PAGES_PER_STEP,
          }),
        );
        await step.do('browser-stop', NET, async () => {
          await crawler.stop(h);
          const seconds = Math.round((Date.now() - h.startedAt) / 1000);
          await store().updateRun(p.runId, { browser_seconds: seconds, cost_usd: Number((seconds * E2B_USD_PER_SECOND).toFixed(6)) });
        });
        if (collected.error && !collected.pages) throw new Error(`browser crawl failed: ${collected.error}`);
        await step.do('browser-skipped', DB, () =>
          store().addRunCounts(p.runId, { new: 0, changed: 0, unchanged: 0, failed: 0, skipped: collected.skipped }),
        );

        for (let i = 0; i < collected.batches; i++) {
          await step.do(`browser-pages-${i}`, NET, async () => {
            const obj = await env.CRAWL.get(batchKey(p.runId, i));
            if (!obj) throw new Error(`browser batch ${i} missing`);
            const stats = await store().record(p.runId, p.site, await obj.json<FetchedSource[]>());
            await store().addRunCounts(p.runId, { ...stats, failed: 0, skipped: 0 });
          });
          await flush(`index-browser-${i}`);
        }
      }

      // Anything a failed flush left pending (this run or an earlier one).
      await flush('index-final');
      await step.do('cleanup', NET, () => cleanup(env, p.runId));
      await step.do('finish', DB, async () => {
        const now = new Date().toISOString();
        await store().updateRun(p.runId, { status: 'complete', finished_at: now });
        await store().finishCrawl(p.site, path === 'blocked' ? 'blocked' : path === 'none' ? 'empty' : 'ready');
      });
      return { runId: p.runId, path };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await step.do('fail', DB, async () => {
        // Every sandbox this run started, whether or not its handle survived.
        if (env.E2B_API_KEY) await e2b().stopTagged(p.runId).catch(() => {});
        await store().updateRun(p.runId, { status: 'failed', finished_at: new Date().toISOString(), error: message.slice(0, 500) });
        await store().failCrawl(p.site);
        await cleanup(env, p.runId).catch(() => {});
      });
      throw e;
    }
  }
}

// One message per new or changed page, body exactly { site, url, contentHash }.
async function send(env: Env, batch: IndexMessage[]): Promise<void> {
  await env.INDEX_QUEUE.sendBatch(batch.map(({ site, url, contentHash }) => ({ body: { site, url, contentHash } })));
}

// Deletes this run's working files (plan, upload, batches).
async function cleanup(env: Env, runId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const list = await env.CRAWL.list({ prefix: runPrefix(runId), cursor });
    if (list.objects.length) await env.CRAWL.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

// Optional: a presigned PUT for this run's upload object, valid for the crawl
// plus 10 minutes, when an R2 API token is configured. R2 presigned URLs can be
// used any number of times until they expire, so this one names a key unique
// to the run and the object is deleted once read. Without a token (the
// default) the Workflow reads the result from the sandbox instead, and the
// sandbox holds no credentials at all.
async function presignResult(env: Env, runId: string, maxMinutes: number): Promise<string | null> {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID, CRAWL_BUCKET_NAME } = env;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID || !CRAWL_BUCKET_NAME) return null;
  return presign({
    method: 'PUT',
    url: r2Endpoint(R2_ACCOUNT_ID, CRAWL_BUCKET_NAME, uploadKey(runId)),
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    expiresIn: Math.ceil(maxMinutes * 60) + 600,
    headers: { 'content-type': 'application/json' },
  });
}
