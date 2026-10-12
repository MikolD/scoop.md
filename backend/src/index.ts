// api.scoop.md Worker entry: CORS, read rate limiting, error mapping and the
// one-line request log (docs/BACKEND.md §5, §8, §11); the index-pages queue
// consumer; and the CrawlSite Workflow class.

import { errorResponse, json, withCors } from './api/http.ts';
import { match } from './api/v1.ts';
import { ipSubject } from './db/ratelimit.ts';
import type { IndexMessage } from './db/crawl.ts';
import { indexPages } from './index/consumer.ts';
import { ApiError, notFound } from './lib/errors.ts';
import type { Env } from './env.ts';

export { CrawlSite } from './crawl/workflow.ts';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const started = Date.now();
    const url = new URL(req.url);
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
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

  async queue(batch: MessageBatch<IndexMessage>): Promise<void> {
    await indexPages(batch);
  },
} satisfies ExportedHandler<Env, IndexMessage>;
