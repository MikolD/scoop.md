// The admin console's front door (admin.scoop.md): HTTP Basic auth on every
// request, a lockout after too many failed attempts, a same-origin check on
// every state-changing request, and security headers on every response.

import { hmacHex, ipSubject } from '../db/ratelimit.ts';
import { safeEqual } from '../lib/ids.ts';
import type { Env } from '../env.ts';

export const REALM = 'Basic realm="scoop.md admin", charset="UTF-8"';
// Failed attempts past ADMIN_AUTH_LIMITER's limit lock the IP subject out this long.
export const LOCKOUT_SECONDS = 60;

// admin.scoop.md, admin-staging.scoop.md, and admin.localhost for wrangler dev.
export const isAdminHost = (hostname: string) => /^admin(-staging)?\./.test(hostname);

export function parseBasic(header: string | null): { user: string; pass: string } | null {
  const m = /^Basic +([A-Za-z0-9+/=]+)$/i.exec(header?.trim() ?? '');
  if (!m) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  return i < 0 ? null : { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

// Both parts are always compared (digests, constant time), so timing doesn't
// say which one was wrong. Unset secrets let no one in.
export async function credentialsValid(header: string | null, env: Pick<Env, 'ADMIN_UI_USER' | 'ADMIN_UI_PASSCODE'>): Promise<boolean> {
  const given = parseBasic(header);
  const [user, pass] = await Promise.all([
    safeEqual(given?.user ?? '', env.ADMIN_UI_USER ?? ''),
    safeEqual(given?.pass ?? '', env.ADMIN_UI_PASSCODE ?? ''),
  ]);
  return Boolean(env.ADMIN_UI_USER && env.ADMIN_UI_PASSCODE && given) && user && pass;
}

export type AuthResult = { ok: true } | { ok: false; status: 401 | 429; retryAfter?: number };

// A locked-out subject gets 429 whatever it sends, so the limit can't be
// sidestepped by guessing right on the 11th try. Only requests that carry
// credentials count as attempts: a browser's first, bare request just gets
// the prompt. Without RATE_KEY there is no way to key the limit: no one gets in.
export async function authenticate(req: Request, env: Env, ip: string, now = new Date()): Promise<AuthResult> {
  if (!env.RATE_KEY) return { ok: false, status: 401 };
  const key = await hmacHex(env.RATE_KEY, `admin-auth:${ipSubject(ip)}`);
  const at = now.toISOString();
  const lock = await env.DB.prepare('SELECT until FROM admin_auth_lockouts WHERE key = ?').bind(key).first<{ until: string }>();
  if (lock && lock.until > at) return { ok: false, status: 429, retryAfter: Math.max(1, Math.ceil((Date.parse(lock.until) - now.getTime()) / 1000)) };
  const header = req.headers.get('authorization');
  if (await credentialsValid(header, env)) return { ok: true };
  if (!header) return { ok: false, status: 401 };
  if ((await env.ADMIN_AUTH_LIMITER.limit({ key })).success) return { ok: false, status: 401 };
  const until = new Date(now.getTime() + LOCKOUT_SECONDS * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_auth_lockouts WHERE until <= ?').bind(at),
    env.DB.prepare('INSERT INTO admin_auth_lockouts (key, until) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET until = ?2').bind(key, until),
  ]);
  return { ok: false, status: 429, retryAfter: LOCKOUT_SECONDS };
}

// CSRF: a state-changing request must come from the console's own pages.
// Browsers send Sec-Fetch-Site on every fetch; older ones at least Origin.
// Neither (curl, a form from nowhere) is refused.
export function sameOrigin(req: Request, url: URL): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  return req.headers.get('origin') === url.origin;
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Every admin response, static files included: nothing framed, cached, indexed or sniffed.
export function secure(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('content-security-policy', CSP);
  h.set('x-frame-options', 'DENY');
  h.set('referrer-policy', 'no-referrer');
  h.set('x-content-type-options', 'nosniff');
  h.set('cache-control', 'no-store');
  h.set('x-robots-tag', 'noindex, nofollow');
  h.set('strict-transport-security', 'max-age=31536000');
  h.set('cross-origin-opener-policy', 'same-origin');
  h.set('cross-origin-resource-policy', 'same-origin');
  h.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  h.delete('etag');
  h.delete('last-modified');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
