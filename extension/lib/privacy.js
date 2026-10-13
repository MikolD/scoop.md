// What telemetry may say about a page or an error, shared by the extension and
// the backend (docs/TELEMETRY.md): path segments that look like secrets are
// replaced with :id, and error text loses emails, URLs, hostnames and tokens.
// Plain JS with no imports.

// Long mixed letters-and-digits, long hex, or a UUID: capability URLs
// (/document/d/<id>, /reset/<token>, secret gists) put their secret here.
export const SECRETISH = /^(?=.*\d)(?=.*[a-z])[A-Za-z0-9_-]{16,}$|^[0-9a-f]{12,}$|^[0-9a-f-]{36}$/i;
const HEX_OR_UUID = /^[0-9a-f]{12,}$|^[0-9a-f-]{36}$/i;
// Readable slugs (getting-started-with-v2-api, 2024-01-15-release-notes) are
// short parts that all look like words or numbers, with at least one real
// word; a word plus random parts (inv-7Gh2kLp9-q8Rt3vWx) is a token.
const SLUG_PARTS = /^[a-z0-9]{1,12}(?:[-_.][a-z0-9]{1,12})+$/i;
const WORDISH = /^(?:[a-z]+|[A-Z][a-z]+|[A-Z]{2,6}\d{0,2}|\d+|v\d+|[a-z]{2,}\d{1,2})$/;
const isSlug = (s) => {
  const parts = s.split(/[-_.]/);
  return SLUG_PARTS.test(s) && parts.every((p) => WORDISH.test(p)) && parts.some((p) => /^[a-z]{3,}$/i.test(p));
};

export function secretish(segment) {
  let s = segment;
  try { s = decodeURIComponent(segment); } catch {}
  if (!SECRETISH.test(s)) return false;
  return HEX_OR_UUID.test(s) || !isSlug(s);
}

export const redactPath = (path) => path.split('/').map((s) => (secretish(s) ? ':id' : s)).join('/');

// IP literals: IPv4, and IPv6 with 3+ colons or a :: (not C++-style Foo::bar or a 10:30:00 time).
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /(?<![\w:.])(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?![\w:])/gi;

// Error text: no emails, URLs, IP addresses, hostnames or long tokens.
export function scrubText(text) {
  return String(text)
    .replace(/[^\s@<>()"']+@[^\s@<>()"']+/g, '<email>')
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi, '<url>')
    .replace(IPV6, '<ip>')
    .replace(IPV4, '<ip>')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:\/\S*)?/gi, '<host>')
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, '<token>');
}

// Tracking parameters (utm_*, click IDs, ref) dropped from a URL; the rest of
// the query kept byte for byte. The same as shared/extract.js's, which the
// crawler vendors on its own.
const TRACKING = /^(utm_.*|_gl|_ga|gclid|dclid|gbraid|wbraid|fbclid|msclkid|yclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|ref_src|ref_url)$/i;
export function stripTracking(url) {
  const u = new URL(url);
  const kept = u.search.slice(1).split('&').filter((pair) => {
    const key = pair.split('=')[0];
    try { return pair && !TRACKING.test(decodeURIComponent(key)); } catch { return true; }
  });
  u.search = kept.length ? `?${kept.join('&')}` : '';
  return u.href;
}
