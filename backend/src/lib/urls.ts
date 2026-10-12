// One spelling per page URL, shared by the queue consumer, the admin route and
// skill validation. Plain anchors (#intro) are dropped. A client-side route
// (#/cdn on docsify-style sites) names its own page, so it stays: cut at a '?'
// or a second '#', trailing slashes trimmed, and a bare '#/' (the root route)
// dropped like an anchor. Routes are slugs only: at most MAX_ROUTE characters
// of [A-Za-z0-9/_.-], else dropped. (Shared skills also drop a route that no
// verified source links to; see skilltext.ts.)

export const MAX_ROUTE = 100;
const ROUTE = /^\/[A-Za-z0-9/_.-]*$/;

export function pageHash(hash: string): string {
  if (!hash.startsWith('#/')) return '';
  const route = hash.slice(1).split(/[?#]/)[0].replace(/\/+$/, '');
  return route && route.length <= MAX_ROUTE && ROUTE.test(route) ? `#${route}` : '';
}

// Mutates and returns the URL's href with the fragment normalised.
export function normalizePageUrl(u: URL): string {
  u.hash = pageHash(u.hash);
  return u.href;
}
