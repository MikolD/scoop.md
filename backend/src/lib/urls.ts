// One spelling per page URL, shared by the queue consumer and the admin route.
// Plain anchors (#intro) are dropped. A client-side route (#/cdn on
// docsify-style sites) names its own page, so it stays: cut at a '?' or a
// second '#', trailing slashes trimmed, and a bare '#/' (the root route)
// dropped like an anchor.

export function pageHash(hash: string): string {
  if (!hash.startsWith('#/')) return '';
  const route = hash.slice(1).split(/[?#]/)[0].replace(/\/+$/, '');
  return route ? `#${route}` : '';
}

// Mutates and returns the URL's href with the fragment normalised.
export function normalizePageUrl(u: URL): string {
  u.hash = pageHash(u.hash);
  return u.href;
}
