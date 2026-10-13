// https://scoop.md/<docsHost>/llms.txt: the llms.txt scoop.md prepared for a
// docs site that publishes none, served from the API
// (GET /v1/llms/<host>/llms.txt). A site's own llms.txt is a redirect to it.
import type { APIRoute } from 'astro';
import { apiBase, isHostname, normalizeSite } from '../../lib/api';

// Served text never runs as anything: no sniffing, no subresources.
const SAFE = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" };

// The registrable domain, roughly (the API decides with the full list; this
// only guards the redirect): example.co.uk, example.com.
const registrable = (h: string) => h.split('.').slice(/\.(co|com|org|net|ac|gov|edu)\.[a-z]{2}$/.test(h) ? -3 : -2).join('.');

// A site's own llms.txt is followed only to http(s) on that site's own domain.
function sameSiteUrl(location: string, host: string): string | null {
  try {
    const u = new URL(location);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return registrable(normalizeSite(u.hostname)) === registrable(host) ? u.href : null;
  } catch {
    return null;
  }
}

export const prerender = false;

const text = (body: string, status: number, cache: string) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': cache, ...SAFE } });

export const GET: APIRoute = async ({ params }) => {
  let host = '';
  try {
    host = normalizeSite(decodeURIComponent(params.site ?? ''));
  } catch {
    // Malformed escape: not a hostname.
  }
  if (!isHostname(host)) return text('Not found\n', 404, 'public, max-age=60');
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/v1/llms/${encodeURIComponent(host)}/llms.txt`, {
      headers: { 'x-scoop-client': 'site' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    } as RequestInit);
  } catch {
    return text('This llms.txt is unavailable right now; try again in a moment.\n', 503, 'public, max-age=0, s-maxage=5');
  }
  if (res.status === 302 || res.status === 301) {
    const location = sameSiteUrl(res.headers.get('location') ?? '', host);
    if (location) return new Response(null, { status: 302, headers: { location, 'cache-control': 'public, max-age=300' } });
    return text(`scoop.md has no llms.txt for ${host}.\n`, 404, 'public, max-age=60, s-maxage=60');
  }
  if (res.status === 404) return text(`scoop.md has no llms.txt for ${host}.\n`, 404, 'public, max-age=60, s-maxage=60');
  if (!res.ok) {
    return text('This llms.txt is still being prepared; try again in a few seconds.\n', 503, 'public, max-age=0, s-maxage=5');
  }
  return new Response(await res.text(), {
    headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=300, s-maxage=300', ...SAFE },
  });
};
