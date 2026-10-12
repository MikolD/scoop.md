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

// Content of the first <tag>…</tag> inside xml[from, to), or null.
function inner(xml: string, tag: string, from: number, to: number): string | null {
  const open = xml.indexOf(`<${tag}>`, from);
  if (open === -1 || open >= to) return null;
  const start = open + tag.length + 2;
  const close = xml.indexOf(`</${tag}>`, start);
  if (close === -1 || close > to) return null;
  return xml.slice(start, close);
}

export function parseSitemap(xml: string): Sitemap {
  const head = xml.slice(0, 2000).toLowerCase();
  const kind = head.includes('<sitemapindex') ? 'index' : 'urlset';
  const item = kind === 'index' ? 'sitemap' : 'url';
  const entries: SitemapEntry[] = [];
  let i = 0;
  while (entries.length < MAX_SITEMAP_URLS) {
    // `<url>` or `<url ` (attributes), not `<urlset`.
    let open = xml.indexOf(`<${item}`, i);
    while (open !== -1 && !/[\s>]/.test(xml[open + item.length + 1] ?? '')) open = xml.indexOf(`<${item}`, open + 1);
    if (open === -1) break;
    const close = xml.indexOf(`</${item}>`, open);
    if (close === -1) break;
    const loc = inner(xml, 'loc', open, close);
    if (loc !== null) {
      const lastmod = inner(xml, 'lastmod', open, close);
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
