// Page-anchored packages (GET /v1/packages?site=&url=): the page the user is
// on, then the chunks most related to it from the same site. The page is found
// by its normalised URL or its Markdown twin; related chunks come from hybrid
// search on the page's title and headings.

import { normalizePageUrl } from '../lib/urls.ts';
import type { PackageChunk } from './package.ts';
import { search } from './search.ts';
import type { SearchDeps } from './search.ts';

// Related chunks searched for, before the budget trims them.
const RELATED = 40;
const MAX_QUERY = 200;

// URLs the page could be indexed under, most likely first: as given, without a
// trailing slash, and its .md / index.md twins (or the HTML page of a .md URL).
export function anchorCandidates(pageUrl: string): string[] {
  const u = new URL(pageUrl);
  const base = normalizePageUrl(u);
  if (u.hash) return [base]; // a client-side route (#/page) is its own page
  const out = [base];
  const bare = base.replace(/\/+$/, '');
  if (bare !== base && new URL(bare).pathname) out.push(bare);
  if (/\.md$/i.test(u.pathname)) {
    out.push(bare.replace(/\/index\.md$/i, '/').replace(/\.md$/i, ''));
  } else if (!/\.[a-z0-9]{1,5}$/i.test(u.pathname)) {
    const path = u.pathname.replace(/\/+$/, '');
    if (path) out.push(`${u.origin}${path}.md`);
    out.push(`${u.origin}${path}/index.md`);
  }
  return [...new Set(out)];
}

export interface Anchor {
  url: string;
  title: string;
  chunks: PackageChunk[];
}

export async function findAnchor(db: D1Database, site: string, pageUrl: string): Promise<Anchor | null> {
  const candidates = anchorCandidates(pageUrl);
  const { results } = await db
    .prepare(`SELECT url, title FROM page_index WHERE site = ? AND url IN (${candidates.map(() => '?').join(', ')})`)
    .bind(site, ...candidates)
    .all<{ url: string; title: string }>();
  const hit = candidates.map((c) => results.find((r) => r.url === c)).find(Boolean);
  if (!hit) return null;
  const { results: chunks } = await db
    .prepare('SELECT url, title, ord, heading_path, text FROM chunks WHERE url = ? ORDER BY ord')
    .bind(hit.url)
    .all<PackageChunk>();
  return chunks.length ? { url: hit.url, title: hit.title || chunks[0].title, chunks } : null;
}

// The search for related pages: the title, then the page's own headings
// (last part of each trail), up to 200 characters.
export function anchorQuery(a: Anchor): string {
  const parts = [a.title];
  for (const c of a.chunks) {
    const last = c.heading_path.split(' > ').pop()?.trim();
    if (last && !parts.includes(last)) parts.push(last);
  }
  let q = '';
  for (const p of parts) {
    if ((q + ' ' + p).trim().length > MAX_QUERY) break;
    q = (q + ' ' + p).trim();
  }
  return q || a.title.slice(0, MAX_QUERY);
}

// Words from a URL's path, for when the page itself isn't indexed.
export function pathQuery(pageUrl: string): string {
  const u = new URL(pageUrl);
  const path = (u.hash.startsWith('#/') ? u.hash.slice(1) : u.pathname).replace(/\.[a-z0-9]{1,5}$/i, '');
  return (path.match(/[\p{L}\p{N}]+/gu) ?? []).join(' ').slice(0, MAX_QUERY);
}

// The page's chunks first, then related chunks from other pages of the site.
// `label` names the package. Null when nothing matches.
export async function anchoredChunks(deps: SearchDeps, site: string, pageUrl: string): Promise<{ label: string; anchored: boolean; chunks: PackageChunk[] } | null> {
  const anchor = await findAnchor(deps.db, site, pageUrl);
  const q = anchor ? anchorQuery(anchor) : pathQuery(pageUrl);
  const related = q ? (await search(deps, { q, site, limit: RELATED })).filter((h) => h.url !== anchor?.url) : [];
  const chunks = [...(anchor?.chunks ?? []), ...related];
  if (!chunks.length) return null;
  return { label: anchor ? anchor.title : q, anchored: Boolean(anchor), chunks };
}
