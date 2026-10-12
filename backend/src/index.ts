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
import { indexDeps } from './index/deps.ts';
import { reclassify } from './index/reclassify.ts';
import { ApiError, notFound } from './lib/errors.ts';
import type { Env } from './env.ts';

export { CrawlSite } from './crawl/workflow.ts';
export { CrawlBatch } from './admin/batch-workflow.ts';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const started = Date.now();
    const url = new URL(req.url);
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';

    // admin.scoop.md (and admin-staging): the console, behind Basic auth. Nothing below applies to it.
    if (isAdminHost(url.hostname)) {
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
    return withCors(res, req, env);
  },

  // index-pages: one message per changed page from the crawler (src/index/consumer.ts).
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await handleIndexBatch(batch, indexDeps(env));
  },

  // Daily: re-enqueue a bounded batch of pages still waiting for a classification.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (!env.OPENROUTER_API_KEY) return;
    const { totalCapUsd, dailyCapUsd } = indexDeps(env);
    const queued = await reclassify(env.DB, env.INDEX_QUEUE, { totalCapUsd, dailyCapUsd });
    console.log(JSON.stringify({ cron: 'reclassify', queued }));
  },
} satisfies ExportedHandler<Env>;
