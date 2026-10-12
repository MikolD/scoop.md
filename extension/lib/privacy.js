// What telemetry may say about a page or an error, shared by the extension and
// the backend (docs/TELEMETRY.md): path segments that look like secrets are
// replaced with :id, and error text loses emails, URLs, hostnames and tokens.
// Plain JS with no imports.

// Long mixed letters-and-digits, long hex, or a UUID: capability URLs
// (/document/d/<id>, /reset/<token>, secret gists) put their secret here.
export const SECRETISH = /^(?=.*\d)(?=.*[a-z])[A-Za-z0-9_-]{16,}$|^[0-9a-f]{12,}$|^[0-9a-f-]{36}$/i;
const HEX_OR_UUID = /^[0-9a-f]{12,}$|^[0-9a-f-]{36}$/i;
// Readable slugs (getting-started-with-v2-api, 2024-01-15-release-notes) are
// short parts with at least one real word; tokens aren't.
const SLUG_PARTS = /^[a-z0-9]{1,12}(?:[-_.][a-z0-9]{1,12})+$/i;
const isSlug = (s) => SLUG_PARTS.test(s) && s.split(/[-_.]/).some((p) => /^[a-z]{3,}$/i.test(p));

export function secretish(segment) {
  let s = segment;
  try { s = decodeURIComponent(segment); } catch {}
  if (!SECRETISH.test(s)) return false;
  return HEX_OR_UUID.test(s) || !isSlug(s);
}

export const redactPath = (path) => path.split('/').map((s) => (secretish(s) ? ':id' : s)).join('/');

// Error text: no emails, URLs, hostnames or long tokens.
export function scrubText(text) {
  return String(text)
    .replace(/[^\s@<>()"']+@[^\s@<>()"']+/g, '<email>')
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi, '<url>')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:\/\S*)?/gi, '<host>')
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, '<token>');
}
