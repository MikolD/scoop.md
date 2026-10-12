// admin.scoop.md: every request on an admin host lands here (src/index.ts).
// Basic auth first, for static files too; then the same-origin check on
// anything that changes state; then the JSON API (/api/*) or the static UI
// (backend/admin/, the ASSETS binding). Every response gets the security
// headers and no-store. No CORS: the console only talks to itself.

import { errorResponse, json } from '../api/http.ts';
import { ApiError } from '../lib/errors.ts';
import type { Env } from '../env.ts';
import { adminApi } from './api.ts';
import { authenticate, REALM, sameOrigin, secure } from './auth.ts';

const SAFE = new Set(['GET', 'HEAD']);

export async function handleAdmin(req: Request, env: Env, url: URL, ip: string): Promise<Response> {
  let res: Response;
  try {
    const auth = await authenticate(req, env, ip);
    if (!auth.ok) {
      res =
        auth.status === 429
          ? json(429, { error: { code: 'rate_limited', message: 'Too many failed sign-in attempts; try again later' } }, { 'retry-after': String(auth.retryAfter ?? 60) })
          : new Response('Authentication required\n', { status: 401, headers: { 'www-authenticate': REALM, 'content-type': 'text/plain; charset=utf-8' } });
    } else if (!SAFE.has(req.method) && !sameOrigin(req, url)) {
      res = json(403, { error: { code: 'forbidden', message: 'Cross-origin request refused' } });
    } else if (url.pathname.startsWith('/api/')) {
      res = await adminApi(req, env, url);
    } else if (SAFE.has(req.method)) {
      // Only the method and path reach the assets; never the credentials.
      res = await env.ASSETS.fetch(new Request(url.toString(), { method: req.method }));
    } else {
      res = json(405, { error: { code: 'invalid_request', message: 'Method not allowed' } });
    }
  } catch (e) {
    if (e instanceof ApiError) {
      res = errorResponse(e);
    } else {
      // Never leak internals; log the message, never request content.
      console.error(JSON.stringify({ route: 'admin', error: e instanceof Error ? e.message : String(e) }));
      res = json(500, { error: { code: 'internal', message: 'Internal error' } });
    }
  }
  return secure(res);
}
