// Re-checks what the browser crawler uploaded before anything is stored. The
// sandbox renders untrusted pages, so its output is untrusted too: only
// same-site http(s) URLs that robots.txt allows, bounded sizes, no duplicates,
// at most the page budget.

import { normalizeSite } from '../lib/ssrf.ts';
import type { Robots } from './robots.ts';
import type { FetchedSource } from './site.ts';

export const MAX_BROWSER_PAGE_CHARS = 300_000;

export function browserPages(raw: string, site: string, robots: Robots, maxPages: number): FetchedSource[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const pages = (parsed as { pages?: unknown })?.pages;
  if (!Array.isArray(pages)) return [];
  const out: FetchedSource[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    if (out.length >= maxPages) break;
    if (typeof p !== 'object' || p === null) continue;
    const { url, title, markdown } = p as Record<string, unknown>;
    if (typeof url !== 'string' || typeof markdown !== 'string' || url.length > 2048) continue;
    let u: URL;
    try { u = new URL(url); } catch { continue; }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || normalizeSite(u.hostname) !== site) continue;
    if (!robots.allowed(u.pathname + u.search)) continue;
    const text = markdown.slice(0, MAX_BROWSER_PAGE_CHARS);
    if (text.trim().length < 50 || seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({
      url: u.href,
      sourceUrl: u.href,
      kind: 'browser',
      title: typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 300) || null : null,
      markdown: text,
      etag: null,
      lastModified: null,
    });
  }
  return out;
}
