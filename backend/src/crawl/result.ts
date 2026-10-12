// Re-checks what the browser crawler returned before anything is stored. The
// sandbox renders untrusted pages, so its output is untrusted too: only
// same-site http(s) URLs (<= 1024 chars, in the indexer's canonical form) that
// robots.txt and the skip list allow, bounded sizes, no duplicates, at most the
// page budget.

import { normalizeSite } from '../lib/ssrf.ts';
import { normalizePageUrl } from '../lib/urls.ts';
import { MAX_URL } from './polite.ts';
import type { Robots } from './robots.ts';
import type { FetchedSource } from './site.ts';
import { skipLowValue } from './skip.ts';

export const MAX_BROWSER_PAGE_CHARS = 300_000;

export function browserPages(raw: string, site: string, robots: Robots, maxPages: number): { pages: FetchedSource[]; skipped: number } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { pages: [], skipped: 0 }; }
  const items = (parsed as { pages?: unknown })?.pages;
  if (!Array.isArray(items)) return { pages: [], skipped: 0 };
  const candidates: FetchedSource[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const p of items) {
    if (typeof p !== 'object' || p === null) continue;
    const { url, title, markdown } = p as Record<string, unknown>;
    if (typeof url !== 'string' || typeof markdown !== 'string') continue;
    let u: URL;
    try { u = new URL(url); } catch { continue; }
    const href = normalizePageUrl(u);
    // The site's own boundaries: off-site, robots-disallowed and over-long URLs are skipped.
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || normalizeSite(u.hostname) !== site || href.length > MAX_URL || !robots.allowed(u.pathname + u.search)) {
      skipped++;
      continue;
    }
    const text = markdown.slice(0, MAX_BROWSER_PAGE_CHARS);
    if (text.trim().length < 50 || seen.has(href)) continue;
    seen.add(href);
    candidates.push({
      url: href,
      sourceUrl: href,
      kind: 'browser',
      title: typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 300) || null : null,
      markdown: text,
      etag: null,
      lastModified: null,
    });
  }
  const keep = new Set(skipLowValue(candidates.map((c) => c.url)).kept);
  const pages = candidates.filter((c) => keep.has(c.url));
  skipped += candidates.length - pages.length;
  return { pages: pages.slice(0, maxPages), skipped };
}
