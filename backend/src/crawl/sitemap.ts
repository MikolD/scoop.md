// sitemap.xml and sitemap indexes (sitemaps.org protocol). A linear scan for
// <loc>/<lastmod> rather than an XML parser: Workers have no DOM, and these
// files only need two elements read.

import { decodeXML } from 'entities/decode';

// The protocol's own cap per file.
export const MAX_SITEMAP_URLS = 50_000;

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export interface Sitemap {
  // 'index' lists other sitemaps; 'urlset' lists pages.
  kind: 'index' | 'urlset';
  entries: SitemapEntry[];
}

function text(s: string): string {
  const t = s.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(t);
  return (cdata ? cdata[1] : decodeXML(t)).trim();
}

// Content of the first <tag>…</tag> in one entry's block, or null. Searching
// the block (not the whole document) keeps parsing linear: an entry without
// <lastmod> must not scan to the end of the file.
function inner(block: string, tag: string): string | null {
  const open = block.indexOf(`<${tag}>`);
  if (open === -1) return null;
  const start = open + tag.length + 2;
  const close = block.indexOf(`</${tag}>`, start);
  return close === -1 ? null : block.slice(start, close);
}

// Parses at most `max` entries (the caller's own cap can be lower than the
// protocol's 50,000) and stops there.
export function parseSitemap(xml: string, max = MAX_SITEMAP_URLS): Sitemap {
  const head = xml.slice(0, 2000).toLowerCase();
  const kind = head.includes('<sitemapindex') ? 'index' : 'urlset';
  const item = kind === 'index' ? 'sitemap' : 'url';
  const entries: SitemapEntry[] = [];
  let i = 0;
  while (entries.length < Math.min(max, MAX_SITEMAP_URLS)) {
    // `<url>` or `<url ` (attributes), not `<urlset`.
    let open = xml.indexOf(`<${item}`, i);
    while (open !== -1 && !/[\s>]/.test(xml[open + item.length + 1] ?? '')) open = xml.indexOf(`<${item}`, open + 1);
    if (open === -1) break;
    const close = xml.indexOf(`</${item}>`, open);
    if (close === -1) break;
    const block = xml.slice(open, close);
    const loc = inner(block, 'loc');
    if (loc !== null) {
      const lastmod = inner(block, 'lastmod');
      const value = text(loc);
      if (value) entries.push({ loc: value, lastmod: lastmod === null ? null : text(lastmod) || null });
    }
    i = close + item.length + 3;
  }
  return { kind, entries };
}

// Gzipped sitemaps (sitemap.xml.gz) are common in indexes. Workers and Node
// both have DecompressionStream; the output is capped like any other body.
export async function gunzipText(bytes: Uint8Array, cap: number): Promise<{ text: string; over: boolean }> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: out + decoder.decode(), over: false };
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return { text: out, over: true };
    }
    out += decoder.decode(value, { stream: true });
  }
}
