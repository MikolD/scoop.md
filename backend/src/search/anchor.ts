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

// One D1 round trip: the site's index version (indexed page count and last
// index time, for cache keys and the not_indexed check) and the chunks of the
// first candidate URL that is indexed.
export async function anchorLookup(db: D1Database, site: string, pageUrl: string): Promise<{ pages: number; version: string; anchor: Anchor | null }> {
  const candidates = anchorCandidates(pageUrl);
  const [ver, rows] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n, MAX(indexed_at) AS v FROM page_index WHERE site = ?').bind(site),
    db
      .prepare(
        `SELECT pi.url AS url, pi.title AS page_title, c.title AS title, c.ord AS ord, c.heading_path AS heading_path, c.text AS text
         FROM page_index pi JOIN chunks c ON c.url = pi.url
         WHERE pi.site = ? AND pi.url IN (${candidates.map(() => '?').join(', ')}) ORDER BY c.ord`,
      )
      .bind(site, ...candidates),
  ]);
  const v = ver.results[0] as { n: number; v: string | null } | undefined;
  const found = rows.results as (PackageChunk & { page_title: string })[];
  const url = candidates.find((c) => found.some((r) => r.url === c));
  const chunks = url ? found.filter((r) => r.url === url) : [];
  return {
    pages: Number(v?.n ?? 0),
    version: `${v?.n ?? 0}:${v?.v ?? ''}`,
    anchor: url && chunks.length
      ? { url, title: chunks[0].page_title || chunks[0].title, chunks: chunks.map(({ url: u, title, ord, heading_path, text }) => ({ url: u, title, ord, heading_path, text })) }
      : null,
  };
}

export async function findAnchor(db: D1Database, site: string, pageUrl: string): Promise<Anchor | null> {
  return (await anchorLookup(db, site, pageUrl)).anchor;
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

// When full-text search alone finds this many related chunks, the query isn't
// embedded and Vectorize isn't asked (both slow: on staging the vector side
// cost a 4-page site 3-6 s per package, and new vectors may not be queryable
// yet). On a small site (SMALL_SITE_PAGES indexed pages or fewer) any FTS hit
// is enough: vectors add little over full-text search across a few pages.
export const FTS_ENOUGH = 12;
export const SMALL_SITE_PAGES = 30;

// The page's chunks first, then related chunks from other pages of the site.
// `label` names the package. Null when nothing matches. `anchor` skips the
// lookup when the caller already did it (anchorLookup). Works from D1 alone:
// the anchor comes from chunks, related chunks from FTS when the vector side
// has nothing yet.
export async function anchoredChunks(
  deps: SearchDeps,
  site: string,
  pageUrl: string,
  known?: { anchor: Anchor | null; pages?: number },
): Promise<{ label: string; anchored: boolean; chunks: PackageChunk[] } | null> {
  const anchor = known ? known.anchor : await findAnchor(deps.db, site, pageUrl);
  const q = anchor ? anchorQuery(anchor) : pathQuery(pageUrl);
  const ftsEnough = known?.pages !== undefined && known.pages <= SMALL_SITE_PAGES ? 1 : FTS_ENOUGH;
  const related = q ? (await search(deps, { q, site, limit: RELATED, ftsEnough })).filter((h) => h.url !== anchor?.url) : [];
  const chunks = [...(anchor?.chunks ?? []), ...related];
  if (!chunks.length) return null;
  return { label: anchor ? anchor.title : q, anchored: Boolean(anchor), chunks };
}
