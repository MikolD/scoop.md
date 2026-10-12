// JSON responses, CORS and body reading (docs/BACKEND.md §5).

import { ApiError, bad } from '../lib/errors.ts';
import { MAX_BODY } from '../lib/validate.ts';
import type { Env } from '../env.ts';

export const CACHE_BEST = 'public, max-age=30, s-maxage=60';
export const CACHE_LIST = 'public, max-age=60, s-maxage=60';

const ALLOW_HEADERS = 'content-type, x-scoop-install, x-scoop-client, x-scoop-telemetry, authorization';
const ALLOW_METHODS = 'GET, POST, DELETE, OPTIONS';

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function errorResponse(e: ApiError): Response {
  return json(e.status, { error: { code: e.code, message: e.message } }, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {});
}

// Writes are open to the listed extensions and the website; reads to anyone.
// No Origin header (curl, servers) means no CORS to apply.
function writeOriginAllowed(origin: string, env: Env): boolean {
  if (origin === 'https://scoop.md') return true;
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  if (!m) return false;
  if (env.ALLOW_ANY_EXTENSION === '1') return true;
  const ids = (env.EXTENSION_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.includes(m[1]);
}

export function withCors(res: Response, req: Request, env: Env): Response {
  const origin = req.headers.get('origin');
  const h = new Headers(res.headers);
  h.set('access-control-allow-methods', ALLOW_METHODS);
  h.set('access-control-allow-headers', ALLOW_HEADERS);
  h.set('access-control-max-age', '86400');
  // Preflights carry the real method in access-control-request-method.
  const method = req.method === 'OPTIONS' ? (req.headers.get('access-control-request-method') ?? 'GET').toUpperCase() : req.method;
  if (method === 'GET' || method === 'HEAD') {
    h.set('access-control-allow-origin', '*');
  } else if (origin && writeOriginAllowed(origin, env)) {
    h.set('access-control-allow-origin', origin);
    h.append('vary', 'origin');
  }
  return new Response(res.body, { status: res.status, headers: h });
}

export async function readJson(req: Request, max = MAX_BODY): Promise<unknown> {
  const tooLarge = () => new ApiError('too_large', `Request body is over ${max >= 1_000_000 ? `${max / 1_000_000} MB` : `${max / 1024} KB`}`, 413);
  if (Number(req.headers.get('content-length')) > max) throw tooLarge();
  let text = '';
  if (req.body) {
    const reader = req.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw tooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw bad('Body is not valid JSON');
  }
}
