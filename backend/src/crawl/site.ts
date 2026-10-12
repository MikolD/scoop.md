// Discovery for one site, deterministic and cheap (no browser, no AI):
// robots.txt, llms.txt / llms-full.txt, sitemaps, a sample of .md twins, and
// a look at the HTML when nothing Markdown turns up. Produces the SiteProfile
// facts and the list of Markdown sources to fetch. Plain TS over crawlFetch.

import { normalizeSite } from '../lib/ssrf.ts';
import {
  docsRoot as pickDocsRoot,
  isMarkdownUrl,
  llmsBases,
  llmsLinks,
  looksLikeClientShell,
  looksLikeText,
  openApiLinks,
  sample,
  twinUrl,
  underRoot,
} from './discover.ts';
import type { TwinPattern } from './discover.ts';
import { crawlFetch, HostLimiter } from './polite.ts';
import type { FetchImpl } from './polite.ts';
import { ALLOW_ALL, DISALLOW_ALL, parseRobots } from './robots.ts';
import type { Robots } from './robots.ts';
import { parseSitemap } from './sitemap.ts';
import { extractPage, MIN_WORDS } from './html.ts';

export const DEFAULT_PAGE_BUDGET = 500;
const TWIN_SAMPLE = 10;
// Below this share of sampled pages with a twin, guessing twins for the rest
// would mostly fetch 404s.
export const TWIN_THRESHOLD = 0.3;
const MAX_SITEMAP_FETCHES = 8;
const MAX_URLS_KEPT = 5000;
const SITEMAP_CAP = 10_000_000;

// page-html: a server-rendered page converted to Markdown in the Worker.
export type SourceKind = 'page-md' | 'llms' | 'llms-full' | 'page-html' | 'browser';

// One Markdown source to fetch: `url` is the page it stands for.
export interface PlannedPage {
  url: string;
  sourceUrl: string;
  kind: SourceKind;
}

export interface RobotsFile {
  // ok: parsed; missing: 4xx, no rules; unreachable: 5xx or network, so we stay away.
  state: 'ok' | 'missing' | 'unreachable';
  text: string;
}

export interface Discovery {
  site: string;
  docsRoot: string;
  blocked: boolean;
  crawlDelay: number | null;
  llmsUrl: string | null;
  llmsFullUrl: string | null;
  llmsFullTooLarge: boolean;
  sitemapUrlsCount: number;
  twinRatio: number | null;
  twinPattern: TwinPattern | null;
  openapi: string[];
  // Only meaningful when no Markdown source was found.
  clientShell: boolean | null;
  needsBrowser: boolean;
  plan: PlannedPage[];
  // Where a browser crawl should start (start URL, then docs pages from the sitemap).
  browserStartUrls: string[];
  requests: number;
}

export interface DiscoverOptions {
  fetchImpl?: FetchImpl;
  allowLocalhost?: boolean;
  limiter?: HostLimiter;
  budget?: number;
}

export function robotsFrom(file: RobotsFile): Robots {
  if (file.state === 'missing') return ALLOW_ALL;
  if (file.state === 'unreachable') return DISALLOW_ALL;
  return parseRobots(file.text);
}

export async function fetchRobots(origin: string, o: DiscoverOptions & { limiter: HostLimiter }): Promise<RobotsFile> {
  const r = await crawlFetch(`${origin}/robots.txt`, { ...o, cap: 500_000 });
  if (r.ok && !r.notModified) return { state: 'ok', text: r.text };
  if (!r.ok && r.status !== null && r.status >= 400 && r.status < 500) return { state: 'missing', text: '' };
  return { state: 'unreachable', text: '' };
}

const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

export async function discoverSite(startUrl: string, robotsFile: RobotsFile, o: DiscoverOptions = {}): Promise<Discovery> {
  const start = new URL(startUrl);
  const site = normalizeSite(start.hostname);
  const origin = start.origin;
  const budget = o.budget ?? DEFAULT_PAGE_BUDGET;
  const robots = robotsFrom(robotsFile);
  const limiter = o.limiter ?? new HostLimiter();
  let requests = 0;
  const get = async (url: string, cap?: number) => {
    requests++;
    return crawlFetch(url, { fetchImpl: o.fetchImpl, allowLocalhost: o.allowLocalhost, limiter, cap, allowed: robots.allowed });
  };
  const allowed = (url: string) => robots.allowed(pathOf(url));
  const sameSite = (url: string) => {
    try { return normalizeSite(new URL(url).hostname) === site; } catch { return false; }
  };

  const out: Discovery = {
    site,
    docsRoot: '/',
    blocked: false,
    crawlDelay: robots.crawlDelay,
    llmsUrl: null,
    llmsFullUrl: null,
    llmsFullTooLarge: false,
    sitemapUrlsCount: 0,
    twinRatio: null,
    twinPattern: null,
    openapi: [],
    clientShell: null,
    needsBrowser: false,
    plan: [],
    browserStartUrls: [],
    requests: 0,
  };
  if (!allowed(start.href)) {
    out.blocked = true;
    return out;
  }
  const givenRoot = start.pathname === '/' ? '' : start.pathname;

  // 1. llms.txt and llms-full.txt, most specific base first.
  let links: string[] = [];
  for (const base of llmsBases(origin, givenRoot)) {
    if (!out.llmsUrl && allowed(`${base}/llms.txt`)) {
      const r = await get(`${base}/llms.txt`);
      // Recorded where it ended up: /docs/llms.txt often redirects to /llms.txt.
      if (r.ok && !r.notModified && !r.over && looksLikeText(r.contentType, r.text)) {
        out.llmsUrl = r.url;
        links = llmsLinks(r.text, out.llmsUrl);
      }
    }
    if (!out.llmsFullUrl && allowed(`${base}/llms-full.txt`)) {
      // Only existence matters here; the page fetch reads it in full later.
      const r = await get(`${base}/llms-full.txt`, 64_000);
      if (r.ok && !r.notModified && (r.over || looksLikeText(r.contentType, r.text))) out.llmsFullUrl = r.url;
    }
    if (out.llmsUrl && out.llmsFullUrl) break;
  }

  // 2. Sitemaps: robots.txt Sitemap lines, else /sitemap.xml; indexes are
  // followed breadth-first up to a fixed number of files.
  const queue = robots.sitemaps.filter(sameSite);
  const fallback = !queue.length;
  if (fallback) queue.push(`${origin}/sitemap.xml`);
  const seenMaps = new Set<string>();
  const pageUrls = new Set<string>();
  let fetchedMaps = 0;
  while (queue.length && fetchedMaps < MAX_SITEMAP_FETCHES && pageUrls.size < MAX_URLS_KEPT) {
    const url = queue.shift()!;
    if (seenMaps.has(url) || !allowed(url)) continue;
    seenMaps.add(url);
    fetchedMaps++;
    const r = await get(url, SITEMAP_CAP);
    if (!r.ok || r.notModified || r.over) {
      if (fallback && fetchedMaps === 1) queue.push(`${origin}/sitemap_index.xml`);
      continue;
    }
    const map = parseSitemap(r.text);
    if (map.kind === 'index') {
      // Docs-looking child sitemaps first.
      const children = map.entries.map((e) => e.loc).filter(sameSite);
      children.sort((a, b) => Number(/doc/i.test(b)) - Number(/doc/i.test(a)));
      queue.push(...children);
    } else {
      out.sitemapUrlsCount += map.entries.length;
      for (const e of map.entries) {
        if (pageUrls.size >= MAX_URLS_KEPT) break;
        if (!sameSite(e.loc)) continue;
        const u = new URL(e.loc);
        u.hash = '';
        pageUrls.add(u.href);
      }
    }
  }

  out.docsRoot = pickDocsRoot(givenRoot, [...pageUrls]);
  const inRoot = (u: string) => underRoot(u, out.docsRoot) && allowed(u);
  const sitemapPages = [...pageUrls].filter(inRoot);
  out.openapi = openApiLinks([...links, ...pageUrls]);

  // 3. .md twins for a sample of HTML pages (sitemap first, else llms.txt links).
  const htmlPages = sitemapPages.length ? sitemapPages : links.filter((u) => !isMarkdownUrl(u) && inRoot(u));
  const sampled = sample(htmlPages.filter((u) => twinUrl(u, 'suffix') || twinUrl(u, 'index')), TWIN_SAMPLE);
  const hits: Record<TwinPattern, number> = { suffix: 0, index: 0 };
  for (const page of sampled) {
    for (const pattern of ['suffix', 'index'] as const) {
      // Once one pattern has hit, don't spend requests on the other.
      const other = pattern === 'suffix' ? 'index' : 'suffix';
      if (hits[other] > 0 && hits[pattern] === 0) continue;
      const twin = twinUrl(page, pattern);
      if (!twin || !allowed(twin)) continue;
      const r = await get(twin, 200_000);
      if (r.ok && !r.notModified && (r.over || looksLikeText(r.contentType, r.text))) {
        hits[pattern]++;
        break;
      }
    }
  }
  if (sampled.length) {
    out.twinPattern = hits.suffix >= hits.index ? (hits.suffix ? 'suffix' : null) : 'index';
    out.twinRatio = (hits.suffix + hits.index) / sampled.length;
  }

  // 4. The fetch plan, within budget: llms files, Markdown links from llms.txt,
  // then twins of sitemap pages. Deduplicated by source URL.
  const plan: PlannedPage[] = [];
  const sources = new Set<string>();
  const add = (p: PlannedPage) => {
    if (plan.length >= budget || sources.has(p.sourceUrl) || !allowed(p.sourceUrl)) return;
    sources.add(p.sourceUrl);
    plan.push(p);
  };
  if (out.llmsUrl) add({ url: out.llmsUrl, sourceUrl: out.llmsUrl, kind: 'llms' });
  if (out.llmsFullUrl) add({ url: out.llmsFullUrl, sourceUrl: out.llmsFullUrl, kind: 'llms-full' });
  const useTwins = out.twinPattern !== null && (out.twinRatio ?? 0) >= TWIN_THRESHOLD;
  for (const link of links) {
    if (!underRoot(link, out.docsRoot)) continue;
    if (isMarkdownUrl(link)) add({ url: link, sourceUrl: link, kind: 'page-md' });
    else if (useTwins) {
      const twin = twinUrl(link, out.twinPattern!);
      if (twin) add({ url: link, sourceUrl: twin, kind: 'page-md' });
    }
  }
  if (useTwins) {
    for (const page of sitemapPages) {
      const twin = twinUrl(page, out.twinPattern!);
      if (twin) add({ url: page, sourceUrl: twin, kind: 'page-md' });
    }
  }
  out.plan = plan;

  // 5. No Markdown worth fetching. Server-rendered HTML is converted in the
  // Worker (page-html): the start page, then its same-site links, then sitemap
  // pages. A client-rendered shell, or a start page that converts to too
  // little text, goes to the browser crawler instead.
  const markdownPages = plan.filter((p) => p.kind === 'page-md').length;
  if (!out.llmsUrl && !out.llmsFullUrl && markdownPages === 0) {
    const r = await get(start.href);
    const html = r.ok && !r.notModified && !r.over ? r.text : null;
    out.clientShell = html === null ? null : looksLikeClientShell(html);
    const page = html !== null && !out.clientShell ? extractPage(html, r.url) : null;
    if (page && page.words >= MIN_WORDS) {
      for (const u of [r.url, ...page.links, ...sitemapPages]) {
        if (sameSite(u) && inRoot(u) && !/\.(?!html?$)[a-z0-9]{1,5}$/i.test(new URL(u).pathname)) add({ url: u, sourceUrl: u, kind: 'page-html' });
      }
      out.plan = plan;
    } else if (html !== null) {
      out.needsBrowser = true;
      out.browserStartUrls = [start.href, ...sample(sitemapPages.filter((u) => u !== start.href), 20)];
    }
  }
  out.requests = requests;
  return out;
}

// The page's title: its first Markdown heading, if any.
export function markdownTitle(md: string): string | null {
  const m = /^#{1,2}[ \t]+(.{1,300})$/m.exec(md.slice(0, 20_000));
  return m ? m[1].replace(/[ \t#]+$/, '').trim() || null : null;
}

export interface FetchedSource {
  url: string;
  sourceUrl: string;
  kind: SourceKind;
  title: string | null;
  markdown: string | null; // null: 304 Not Modified
  etag: string | null;
  lastModified: string | null;
}

// Fetches planned Markdown sources politely (the limiter spaces them), with
// conditional headers from the previous fetch. Pages that fail, turn out to be
// HTML, or exceed the cap are counted as failed and not stored.
export async function fetchPlanned(
  plan: PlannedPage[],
  prev: Map<string, { etag: string | null; last_modified: string | null }>,
  robotsFile: RobotsFile,
  o: DiscoverOptions & { limiter: HostLimiter },
): Promise<{ pages: FetchedSource[]; failed: number }> {
  const robots = robotsFrom(robotsFile);
  const results = await Promise.all(
    plan.map(async (p): Promise<FetchedSource | null> => {
      if (!robots.allowed(pathOf(p.sourceUrl))) return null;
      const before = prev.get(p.url);
      const r = await crawlFetch(p.sourceUrl, {
        fetchImpl: o.fetchImpl,
        allowLocalhost: o.allowLocalhost,
        limiter: o.limiter,
        allowed: robots.allowed,
        etag: before?.etag,
        lastModified: before?.last_modified,
      });
      if (!r.ok) return null;
      if (r.notModified) return { ...p, title: null, markdown: null, etag: r.etag, lastModified: r.lastModified };
      if (r.over) return null;
      if (looksLikeText(r.contentType, r.text)) {
        // Markdown, including an HTML page that answered our Accept header with Markdown.
        return { ...p, kind: p.kind === 'page-html' ? 'page-md' : p.kind, title: markdownTitle(r.text), markdown: r.text, etag: r.etag, lastModified: r.lastModified };
      }
      if (p.kind !== 'page-html') return null;
      const page = extractPage(r.text, r.url);
      if (page.words < MIN_WORDS) return null;
      return { ...p, title: page.title, markdown: page.markdown, etag: r.etag, lastModified: r.lastModified };
    }),
  );
  const pages = results.filter((r): r is FetchedSource => r !== null);
  return { pages, failed: results.length - pages.length };
}
