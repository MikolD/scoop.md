// Deterministic discovery helpers: where a site's agent-ready files live, how
// a page maps to its Markdown twin, and whether its HTML is a client-rendered
// shell. Server-side port of extension/lib/discover.js; no I/O here.

import { htmlToText } from '../lib/verify.ts';
import { normalizeSite } from '../lib/ssrf.ts';

// Docs prefixes worth probing for llms.txt when the start URL doesn't name one.
const DOCS_PREFIXES = ['/docs', '/documentation', '/developers', '/api', '/guides', '/reference'];

// Bases to probe for llms.txt / llms-full.txt, most specific first: the start
// URL's first path segment, a few common docs prefixes, then the root. At most
// `max` bases, so discovery stays a handful of requests.
export function llmsBases(origin: string, docsRoot: string, max = 3): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    const base = origin + p.replace(/\/+$/, '');
    if (!out.includes(base)) out.push(base);
  };
  const first = docsRoot.split('/').filter(Boolean)[0];
  if (first) add(`/${first}`);
  for (const p of DOCS_PREFIXES) if (out.length < max - 1) add(p);
  add('');
  return out.slice(0, max);
}

// SPA hosts often answer any path with 200 + their HTML shell, so status alone
// is not evidence the file exists (same rule as extension/lib/discover.js).
export function looksLikeText(contentType: string, body: string): boolean {
  if (/text\/html/i.test(contentType)) return false;
  if (/^\s*<(!doctype|html|head|body)/i.test(body)) return false;
  return body.trim().length > 50;
}

// Same-site links in an llms.txt: `[title](url)` entries, resolved against the
// file's URL. Bounded quantifiers keep the scan linear on hostile input.
export function llmsLinks(text: string, fileUrl: string): string[] {
  const site = normalizeSite(new URL(fileUrl).hostname);
  const seen = new Set<string>();
  for (const m of text.matchAll(/\[[^\]\n]{0,500}\]\(\s*<?([^)\s>]{1,2048})>?(?:\s+"[^"\n]{0,300}")?\s*\)/g)) {
    let u: URL;
    try { u = new URL(m[1], fileUrl); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    if (normalizeSite(u.hostname) !== site) continue;
    u.hash = '';
    seen.add(u.href);
  }
  return [...seen];
}

// A URL that already points at Markdown or plain text (llms.txt entries often do).
export function isMarkdownUrl(url: string): boolean {
  return /\.(md|mdx|markdown|txt)$/i.test(new URL(url).pathname);
}

export type TwinPattern = 'suffix' | 'index';

// Where a page's Markdown twin would be: <path>.md (Mintlify, Fern, GitBook,
// Docusaurus plugins, Stripe) or <path>/index.md (Starlight, Cloudflare).
export function twinUrl(pageUrl: string, pattern: TwinPattern): string | null {
  const u = new URL(pageUrl);
  const segs = u.pathname.split('/').filter(Boolean);
  if (/\.[a-z0-9]{1,5}$/i.test(u.pathname)) return null; // .html, .pdf, ...
  if (!segs.length) return pattern === 'index' ? `${u.origin}/index.md` : null;
  return pattern === 'suffix' ? `${u.origin}/${segs.join('/')}.md` : `${u.origin}/${segs.join('/')}/index.md`;
}

// Page URLs to sample for twins: spread across the list rather than the first
// few, which are often the same section.
export function sample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items.slice();
  const out: T[] = [];
  const step = items.length / n;
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

// The path prefix the docs live under: the start URL's path when given,
// otherwise the most common first segment among sitemap URLs if it looks like
// docs and covers a fair share of them, otherwise the root.
export function docsRoot(startPath: string, urls: string[]): string {
  const given = startPath.replace(/\/+$/, '');
  if (given) return given;
  const counts = new Map<string, number>();
  for (const u of urls) {
    const first = new URL(u).pathname.split('/').filter(Boolean)[0];
    if (first) counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [seg, n] of counts) {
    if (n > bestCount && /^(docs?|documentation|developers?|guides?|reference|api|learn|manual)$/i.test(seg)) {
      best = seg;
      bestCount = n;
    }
  }
  return best && bestCount >= urls.length * 0.2 ? `/${best}` : '/';
}

export function underRoot(url: string, root: string): boolean {
  if (root === '/' || root === '') return true;
  const p = new URL(url).pathname;
  return p === root || p.startsWith(root + '/') || p.startsWith(root + '.');
}

// OpenAPI/Swagger documents linked from what we already fetched (no extra requests).
export function openApiLinks(urls: string[]): string[] {
  return [...new Set(urls.filter((u) => /(openapi|swagger)[^/]*\.(json|ya?ml)$/i.test(new URL(u).pathname)))].slice(0, 20);
}

// A client-rendered shell: little readable text once scripts and styles are
// dropped, plus an empty app mount point or a "needs JavaScript" notice. Such
// pages need a browser to read.
export function looksLikeClientShell(html: string): boolean {
  const words = htmlToText(html).split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  if (words >= 150) return false;
  const emptyMount = /<div[^>]{0,200}\bid=["']?(root|app|__next|__nuxt|svelte|main-app|q-app)["']?[^>]{0,200}>\s*<\/div>/i.test(html);
  const needsJs = /(enable|requires?|need)\s+javascript/i.test(htmlToText(html.replace(/<\/?noscript[^>]{0,100}>/gi, '')));
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  return ((emptyMount || needsJs) && scripts > 0) || (words < 30 && scripts >= 3);
}
