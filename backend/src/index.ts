// api.scoop.md Worker entry: CORS, read rate limiting, error mapping and the
// one-line request log (docs/BACKEND.md §5, §8, §11), plus the index-pages
// queue consumer, the daily reclassify cron and the CrawlSite Workflow class.
// Admin hosts (admin.scoop.md) go to the console instead (src/admin/).

import { handleAdmin } from './admin/app.ts';
import { isAdminHost } from './admin/auth.ts';
import { errorResponse, json, withCors } from './api/http.ts';
import { match } from './api/v1.ts';
import { ipSubject } from './db/ratelimit.ts';
import { handleIndexBatch } from './index/consumer.ts';
import { pruneCrawlRequests, startAllWaiting } from './crawl/requests.ts';
import { indexDeps } from './index/deps.ts';
import { reclassify } from './index/reclassify.ts';
import { processLinkQueue } from './links/links.ts';
import { ApiError, notFound } from './lib/errors.ts';
import { handleTelemetryBatch, pruneTelemetry } from './telemetry/consumer.ts';
import { API_ROUTES, recordApiUsage } from './telemetry/ingest.ts';
import type { Env } from './env.ts';

// The telemetry pruning cron in wrangler.jsonc.
const HOURLY = '23 * * * *';

export { CrawlSite } from './crawl/workflow.ts';
export { CrawlBatch } from './admin/batch-workflow.ts';

export default {
  async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const started = Date.now();
    const url = new URL(req.url);
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';

    // admin.scoop.md (and admin-staging): the console, behind Basic auth. Nothing below applies to it.
    if (isAdminHost(url.hostname, env)) {
      const res = await handleAdmin(req, env, url, ip);
      console.log(JSON.stringify({ method: req.method, route: 'admin', status: res.status, ms: Date.now() - started }));
      return res;
    }

    const preflight = req.method === 'OPTIONS';
    const matched = preflight ? null : match(req, env, url, ip);
    const route = preflight ? 'preflight' : (matched?.name ?? 'unmatched');

    let res: Response;
    try {
      if (preflight) {
        res = new Response(null, { status: 204 });
      } else if (!matched) {
        throw notFound();
      } else {
        // Admin routes answer 404 on bad auth before any limiting.
        const limited = req.method === 'GET' && !matched.name.startsWith('/v1/admin/');
        if (limited && !(await env.READ_LIMITER.limit({ key: ipSubject(ip) })).success) {
          const err = new ApiError('rate_limited', 'Too many requests; try again later', 429);
          err.retryAfter = 60;
          throw err;
        }
        res = await matched.run();
      }
    } catch (e) {
      if (e instanceof ApiError) {
        res = errorResponse(e);
      } else {
        // Never leak internals; log the error message, never request content.
        console.error(JSON.stringify({ route, error: e instanceof Error ? e.message : String(e) }));
        res = json(500, { error: { code: 'internal', message: 'Internal error' } });
      }
    }

    // Only the read endpoints that set their own cache-control are cacheable.
    if (!res.headers.has('cache-control')) res.headers.set('cache-control', 'no-store');

    console.log(JSON.stringify({
      method: req.method,
      route,
      status: res.status,
      ms: Date.now() - started,
      client: req.headers.get('x-scoop-client'),
    }));
    // API usage telemetry, after the response (ctx.waitUntil); awaited without a ctx (tests).
    if (matched && API_ROUTES[matched.name]) {
      const recorded = recordApiUsage(env, req, matched.name, { status: res.status, latencyMs: Date.now() - started, usage: matched.usage })
        .catch((e) => console.error(JSON.stringify({ route, telemetry: e instanceof Error ? e.message : String(e) })));
      if (ctx) ctx.waitUntil(recorded);
      else await recorded;
    }
    return withCors(res, req, env);
  },

  // index-pages: one message per changed page from the crawler (src/index/consumer.ts).
  // telemetry-events: usage events from POST /v1/events and API usage (src/telemetry/consumer.ts).
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue.startsWith('telemetry-events')) await handleTelemetryBatch(batch, env);
    else await handleIndexBatch(batch, indexDeps(env));
  },

  // Hourly: prune telemetry (raw events past 180 days, ip_hash past 30, old day
  // keys and quota counters). Daily (17 4 * * *): re-enqueue a bounded batch of
  // pages still waiting for a classification.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === HOURLY) {
      console.log(JSON.stringify({ cron: 'telemetry-prune', ...(await pruneTelemetry(env.TELEMETRY_DB)) }));
      console.log(JSON.stringify({ cron: 'crawl-requests-prune', deleted: await pruneCrawlRequests(env.DB) }));
      console.log(JSON.stringify({ cron: 'crawl-requests-waiting', sites: await startAllWaiting({ db: env.DB, bucket: env.SKILLS, workflow: env.CRAWL_SITE }) }));
      // Links met while serving, and bad links due for their second check (src/links/links.ts).
      const allowLocalhost = env.ENVIRONMENT === 'dev' && env.ALLOW_LOCALHOST === '1';
      console.log(JSON.stringify({ cron: 'link-check', checked: await processLinkQueue(env.DB, { limit: 200, allowLocalhost, deadline: Date.now() + 5 * 60_000 }) }));
      return;
    }
    const { totalCapUsd, dailyCapUsd, classify } = indexDeps(env);
    if (!classify) return;
    const queued = await reclassify(env.DB, env.INDEX_QUEUE, { totalCapUsd, dailyCapUsd });
    console.log(JSON.stringify({ cron: 'reclassify', queued }));
  },
} satisfies ExportedHandler<Env>;
