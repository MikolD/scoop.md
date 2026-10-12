// Pure helpers for the browser crawler: which links to follow, which requests
// the browser may make, budgets and the result upload. No Playwright here, so
// the repo's tests can import it.

import { lookup as dnsLookup } from 'node:dns/promises';
import { lowValue } from './vendor/skip.ts';
import { pageHash } from './vendor/urls.ts';

// Longest URL followed or returned (the backend's limit too).
export const MAX_URL = 1024;

// Pages are untrusted, and a malicious one could try to reach the sandbox's own
// services or the cloud metadata endpoint. These are the hostname/IP-literal
// rules; hostAllowed() below also checks what a name resolves to. The sandbox
// holds no credentials either way.
export function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (h === 'localhost' || /\.(local|internal|localhost|test)$/.test(h)) return true;
  if (h.includes(':')) return h === '::1' || /^f[cd]/.test(h) || /^fe80/.test(h) || h === '::' || h.startsWith('::ffff:');
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // this network, private, loopback, multicast/reserved
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0)
  );
}

// May the browser make this request? http(s) to public hosts on the default
// ports only (an explicit :8080 could reach the sandbox's own job server).
export function requestAllowed(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return true;
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.port && u.port !== '80' && u.port !== '443') return false;
  return !isPrivateHost(u.hostname);
}

// Does `hostname` resolve only to public addresses? Checked once per host per
// crawl (cached), so a public name pointing at 127.0.0.1 or 10.x is blocked.
// Chromium resolves names itself, so a DNS answer that changes between our
// lookup and Chromium's (rebinding) is not covered; the sandbox has no
// credentials to steal and the job server needs a bearer token.
export function hostChecker(lookup = (h) => dnsLookup(h, { all: true })) {
  const cache = new Map();
  return (hostname) => {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!cache.has(h)) {
      cache.set(
        h,
        isPrivateHost(h)
          ? Promise.resolve(false)
          : lookup(h).then((addrs) => addrs.length > 0 && addrs.every((a) => !isPrivateHost(a.address)), () => false),
      );
    }
    return cache.get(h);
  };
}

export const siteOf = (url) => new URL(url).hostname.toLowerCase().replace(/^www\./, '');

// The key a page is known by: origin + path, plus the hash when it is a
// client-side route (docsify-style #/page), normalised exactly as the indexer
// does (vendor/urls.ts). Queries and plain anchors are dropped.
export function pageKey(url) {
  const u = new URL(url);
  return u.origin + u.pathname + pageHash(u.hash);
}

// Links worth following: same site, under the docs root, not a file download.
export function followable(url, site, root = '/') {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.href.length > MAX_URL || !requestAllowed(u.href) || lowValue(u.href)) return false;
  if (siteOf(u.href) !== site || isPrivateHost(u.hostname)) return false;
  if (/\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|tgz|mp4|webm|mp3|woff2?|ttf|css|js|json|xml|txt)$/i.test(u.pathname)) return false;
  const r = root.replace(/\/+$/, '');
  return !r || u.pathname === r || u.pathname.startsWith(r + '/');
}

// Per-page and per-result caps, so one hostile page can't blow up the upload.
export const MAX_PAGE_CHARS = 300_000;
export const MAX_RESULT_BYTES = 20_000_000;

export function clipPage(page) {
  return {
    url: String(page.url).slice(0, MAX_URL),
    title: String(page.title || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    markdown: String(page.markdown || '').slice(0, MAX_PAGE_CHARS),
  };
}

// PUT the result to the presigned URL. The URL is the only credential the
// sandbox ever sees, and it allows exactly this one object.
export async function upload(result, uploadUrl, fetchImpl = fetch) {
  const body = JSON.stringify(result);
  const res = await fetchImpl(uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
  return Buffer.byteLength(body);
}
