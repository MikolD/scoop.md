// Site normalisation and the SSRF guard (docs/BACKEND.md §3, §6). Runs before
// any outbound fetch, on pageUrl, every section URL and every redirect hop.

import { ApiError } from './errors.ts';

export function normalizeSite(host: string | null | undefined): string {
  // A fully qualified name (amazon.com.) is the same site.
  return String(host || '').trim().toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}

export function siteOf(url: string): string {
  return normalizeSite(new URL(url).hostname);
}

const reject = (message: string) => new ApiError('invalid_request', message, 400);

// Returns the parsed URL or throws 400 invalid_request.
export function assertFetchable(raw: string, { allowLocalhost = false } = {}): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw reject(`Not a URL: ${raw}`); }
  // A trailing dot names the same host ("localhost." is localhost).
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  if (allowLocalhost && isLocal) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw reject(`Unsupported scheme: ${raw}`);
    return u;
  }
  if (u.protocol !== 'https:') throw reject(`Only https URLs are accepted: ${raw}`);
  if (u.port && u.port !== '443') throw reject(`Non-standard port: ${raw}`);
  if (u.username || u.password) throw reject(`URLs with credentials are not accepted: ${u.origin}`);
  // WHATWG URL parsing already turns decimal/hex/octal IPv4 forms into dotted quads.
  const ipLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':');
  if (ipLiteral || host === 'localhost' || /\.(local|internal|localhost|test)$/.test(host)) {
    throw reject(`Host not allowed: ${host}`);
  }
  return u;
}
