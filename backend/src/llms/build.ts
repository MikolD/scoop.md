// scoop-built llms.txt for docs sites that publish none (0.6.0 "llms.txt
// first"; docs/BACKEND.md, "llms.txt"). Two stages:
//   - instant (seconds): the docs root's sitemap(s) and the links in its
//     navigation and sidebar, titled by their link text, grouped by path
//     section;
//   - full (after a crawl): the indexed pages, with their one-line summaries,
//     grouped Getting started → Guides → Reference by their slots.
// Every link is checked (src/links/links.ts) and only links known to exist
// are written; a page's .md twin is used where the site serves them.

import { DOMParser } from 'linkedom';
import { normalizeSite } from '../lib/ssrf.ts';
import { crawlFetch, HostLimiter } from '../crawl/polite.ts';
import type { FetchImpl } from '../crawl/polite.ts';
import { looksLikeText, twinUrl, underRoot } from '../crawl/discover.ts';
import { parseSitemap } from '../crawl/sitemap.ts';
import { robotsFrom } from '../crawl/site.ts';
import { ALLOW_ALL, DISALLOW_ALL } from '../crawl/robots.ts';
import { skipLowValue } from '../crawl/skip.ts';
import { checkLinks, linkStates, normalizeLink, saveLinks } from '../links/links.ts';
import { decodeHTML } from 'entities';
import { firstParagraph } from '../index/jevclassify.ts';

export interface LlmsLink {
  title: string;
  url: string;
  description?: string;
}

export interface LlmsSection {
  name: string;
  links: LlmsLink[];
}

export interface BuiltLlms {
  title: string;
  root: string;
  host: string;
  sections: LlmsSection[];
  text: string;
  pages: number;
  stage: 'instant' | 'full';
}

export interface BuildOptions {
  fetchImpl?: FetchImpl;
  allowLocalhost?: boolean;
  db?: D1Database;
  // Stored page Markdown (pages/<hash>.md), for the full stage's descriptions.
  bucket?: R2Bucket;
  // Wall-clock budget for the whole build, ms.
  budgetMs?: number;
  maxLinks?: number;
  now?: Date;
}

export const INSTANT_BUDGET_MS = 8000;
export const MAX_LINKS = 300;
const MAX_SITEMAPS = 6;
const SITEMAP_CAP = 5_000_000;
const PAGE_CAP = 1_000_000;
const TWIN_SAMPLE = 3;
// Fewer links than this under a docs path: the whole host is used.
const MIN_SCOPED = 5;

// ---- Rendering ----------------------------------------------------------------------------

const oneLine = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

export function renderLlms(b: { title: string; host: string; root: string; sections: LlmsSection[] }): string {
  const out = [`# ${oneLine(b.title, 120) || b.host}`, `> Documentation index for ${b.host}, prepared by scoop.md. Source: ${b.root}`];
  for (const s of b.sections) {
    if (!s.links.length) continue;
    out.push('', `## ${oneLine(s.name, 80)}`);
    for (const l of s.links) out.push(`- [${oneLine(l.title, 120) || l.url}](${l.url})${l.description ? `: ${oneLine(l.description, 200)}` : ''}`);
  }
  return out.join('\n') + '\n';
}

// "getting-started" → "Getting started".
export const humanize = (slug: string) => {
  const s = decodeURIComponent(slug).replace(/\.(html?|mdx?)$/i, '').replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
};

// Path segments that name a version of the docs, not a section: 29.7, v2, next, latest, stable.
export const VERSION_SEGMENT = /^(v?\d+(\.\d+)*(\.x)?|next|latest|stable|current|dev|main|master)$/i;

// A locale first below the root (Read the Docs' /en/stable/…).
const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2,4})?$/i;

// The path segments of a URL below the docs root, without version and locale segments.
const below = (url: string, root: string) => {
  const rootPath = new URL(root).pathname.replace(/\/+$/, '');
  return new URL(url).pathname.slice(rootPath.length).split('/').filter(Boolean)
    .filter((seg, i) => !VERSION_SEGMENT.test(seg) && !(i === 0 && LOCALE_SEGMENT.test(seg)));
};

// The section a URL belongs to: its first path segment below the docs root.
export function sectionOf(url: string, root: string): string {
  const path = below(url, root);
  return path.length > 1 ? humanize(path[0]) : 'Overview';
}

// The version a URL is in (its first version segment below the root), or null.
export function versionOf(url: string, root: string): string | null {
  const rootPath = new URL(root).pathname.replace(/\/+$/, '');
  return new URL(url).pathname.slice(rootPath.length).split('/').filter(Boolean).find((seg) => VERSION_SEGMENT.test(seg)) ?? null;
}

// One version of versioned docs: pages outside any version, else the
// unversioned alias (latest, stable, current), else the highest number.
export function oneVersion<T extends { url: string }>(links: T[], root: string): T[] {
  const versions = new Map<string | null, T[]>();
  for (const l of links) {
    const v = versionOf(l.url, root);
    versions.set(v, [...(versions.get(v) ?? []), l]);
  }
  if (versions.size <= 1) return links;
  const keys = [...versions.keys()];
  const alias = keys.find((k) => k && /^(latest|stable|current)$/i.test(k));
  const numbered = keys.filter((k): k is string => k !== null && /\d/.test(k)).sort((a, b) => {
    const pa = a.replace(/^v/i, '').split('.').map(Number);
    const pb = b.replace(/^v/i, '').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
    return 0;
  });
  const keep = versions.has(null) && (versions.get(null)!.length >= links.length / 3) ? null : alias ?? numbered[0] ?? null;
  return links.filter((l) => versionOf(l.url, root) === keep);
}

// Link text that says nothing about the page ("next", "index", "¶", "v2").
const GENERIC_TEXT = /^(next|previous|prev|index|modules|home|back|more|read more|here|link|edit|edit this page|top|stable|latest|docs|documentation|\W*|v?\d+(\.\d+)*)$/i;
export const linkTitle = (text: string, url: string) => {
  const t = decodeHTML(text).replace(/\s+/g, ' ').replace(/[¶#§]+$/, '').trim();
  return t && t.length <= 120 && !GENERIC_TEXT.test(t) ? t : humanize(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
};

// A site name from a page title: "Hono - Web framework" → "Hono", "Stripe Documentation" → "Stripe".
export function siteName(title: string | null, host: string): string {
  const parts = decodeHTML(title ?? '').split(/\s+[|·–—~-]\s+|\s*::\s*/).map((p) => p.replace(/[<>/~]+/g, ' ').trim()).filter(Boolean);
  const pick = parts.length > 1 ? parts.sort((a, b) => a.length - b.length)[0] : parts[0] ?? '';
  const name = pick.replace(/\b(developer\s+)?(documentation|docs|developer docs|api reference|reference|developers|guides?)\b/gi, '').replace(/\s+/g, ' ').trim();
  if (name && name.length <= 40) return name;
  const label = normalizeSite(host).replace(/^(docs|developers?|dev|api)\./, '').split('.')[0];
  return label ? label[0].toUpperCase() + label.slice(1) : host;
}

// ---- Instant stage ----------------------------------------------------------------------------

// Links in the page's navigation and sidebar, in document order, with their text.
export function navLinks(html: string, pageUrl: string): LlmsLink[] {
  let doc: { querySelectorAll(s: string): Iterable<{ getAttribute(n: string): string | null; textContent: string | null }> };
  try {
    doc = new DOMParser().parseFromString(/<html[\s>]/i.test(html) ? html : `<!doctype html><html><body>${html}</body></html>`, 'text/html') as never;
  } catch {
    return [];
  }
  const sel = 'nav a[href], aside a[href], [class*="sidebar" i] a[href], [id*="sidebar" i] a[href], [class*="menu" i] a[href], [role="navigation"] a[href], [class*="toc" i] a[href]';
  const out = new Map<string, LlmsLink>();
  for (const a of doc.querySelectorAll(sel)) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || /^(mailto|javascript|tel):/i.test(href)) continue;
    let u: URL;
    try { u = new URL(href, pageUrl); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    u.hash = '';
    const title = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!out.has(u.href)) out.set(u.href, { title, url: u.href });
  }
  return [...out.values()];
}

export async function buildInstant(root: string, o: BuildOptions = {}): Promise<BuiltLlms> {
  const started = Date.now();
  const budget = o.budgetMs ?? INSTANT_BUDGET_MS;
  const left = () => Math.max(200, budget - (Date.now() - started));
  const r0 = new URL(root);
  const host = normalizeSite(r0.hostname);
  const limiter = new HostLimiter({ concurrency: 6, intervalMs: 0 });
  const get = (url: string, cap: number, accept?: string) =>
    crawlFetch(url, { fetchImpl: o.fetchImpl, allowLocalhost: o.allowLocalhost, limiter, cap, accept, truncate: true, timeoutMs: Math.min(4000, left()) });

  const robotsRes = await get(`${r0.origin}/robots.txt`, 500_000);
  const robots = robotsRes.ok && !robotsRes.notModified
    ? robotsFrom({ state: 'ok', text: robotsRes.text })
    : !robotsRes.ok && robotsRes.status !== null && robotsRes.status >= 400 && robotsRes.status < 500 ? ALLOW_ALL : robotsRes.ok ? ALLOW_ALL : DISALLOW_ALL;
  const allowed = (u: string) => {
    const x = new URL(u);
    return robots.allowed(x.pathname + x.search);
  };
  let scope = r0.pathname.replace(/\/+$/, '');
  const inScope = (u: string) => {
    try {
      const x = new URL(u);
      return normalizeSite(x.hostname) === host && underRoot(x.href, scope || '/') && allowed(x.href) && !/\.(png|jpe?g|gif|svg|webp|pdf|zip|xml|json|css|js)$/i.test(x.pathname);
    } catch {
      return false;
    }
  };

  // The docs root's page: its title and its navigation.
  const [page, maps] = await Promise.all([
    allowed(root) ? get(root, PAGE_CAP, 'text/html, application/xhtml+xml;q=0.9, */*;q=0.5') : null,
    (async () => {
      const queue = [...robots.sitemaps.filter((s) => { try { return normalizeSite(new URL(s).hostname) === host; } catch { return false; } })];
      if (!queue.length) queue.push(`${r0.origin}/sitemap.xml`, `${r0.origin}/sitemap-index.xml`, `${r0.origin}/sitemap_index.xml`);
      const urls: string[] = [];
      const seen = new Set<string>();
      for (let n = 0; queue.length && n < MAX_SITEMAPS && Date.now() - started < budget / 2; n++) {
        const s = queue.shift()!;
        if (seen.has(s)) { n--; continue; }
        seen.add(s);
        const r = await get(s, SITEMAP_CAP);
        if (!r.ok || r.notModified) continue;
        const map = parseSitemap(r.text, 5000);
        if (map.kind === 'index') {
          // Docs-looking child maps first.
          const kids = map.entries.map((e) => e.loc).sort((a, b) => Number(/doc/i.test(b)) - Number(/doc/i.test(a)));
          queue.unshift(...kids);
        } else {
          for (const e of map.entries) urls.push(e.loc);
        }
      }
      return urls;
    })(),
  ]);
  const html = page && page.ok && !page.notModified && !looksLikeText(page.contentType, page.text) ? page.text : '';
  const titleMatch = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html)?.[1] ?? null;
  const ogSite = /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{1,100})["']/i.exec(html)?.[1] ?? null;
  const title = siteName(ogSite ?? titleMatch, host);

  // Navigation first (its order and titles are the site's own), then the
  // sitemap. A docs path with almost nothing under it (htmx.org/docs is one
  // page; its reference lives at /reference) widens to the whole host.
  const allNav = html ? navLinks(html, page && page.ok ? page.url : root) : [];
  if (scope && [...allNav.map((l) => l.url), ...maps].filter(inScope).length < MIN_SCOPED) scope = '';
  const nav = allNav.filter((l) => inScope(l.url));
  const byUrl = new Map<string, LlmsLink>();
  const keep = new Set(skipLowValue([...nav.map((l) => l.url), ...maps.filter(inScope)]).kept);
  for (const l of nav) if (keep.has(l.url) && !byUrl.has(l.url)) byUrl.set(l.url, { title: linkTitle(l.title, l.url) || host, url: l.url });
  for (const u of maps) {
    if (!inScope(u) || !keep.has(u)) continue;
    const x = new URL(u);
    x.hash = '';
    if (!byUrl.has(x.href)) byUrl.set(x.href, { title: linkTitle('', x.href) || host, url: x.href });
  }
  const scopeRoot = `${r0.origin}${scope}`;
  let links = oneVersion([...byUrl.values()], scopeRoot).slice(0, o.maxLinks ?? MAX_LINKS);

  // .md twins, when a sample of pages has them.
  links = await withTwins(links, get, left);
  links = await onlyExisting(links, o, left);

  const sections = groupBySection(links, scopeRoot);
  const text = renderLlms({ title, host, root, sections });
  return { title, root, host, sections, text, pages: links.length, stage: 'instant' };
}

type Get = (url: string, cap: number, accept?: string) => ReturnType<typeof crawlFetch>;

// A link with the page it stands for, when `url` is that page's .md twin.
type Candidate = LlmsLink & { page?: string };

async function withTwins(links: LlmsLink[], get: Get, left: () => number): Promise<Candidate[]> {
  const sample = links.filter((l) => !/\.md$/i.test(new URL(l.url).pathname)).slice(0, TWIN_SAMPLE);
  if (!sample.length || left() < 1500) return links;
  for (const pattern of ['suffix', 'index'] as const) {
    const hits = await Promise.all(sample.map(async (l) => {
      const t = twinUrl(l.url, pattern);
      if (!t) return false;
      const r = await get(t, 64_000);
      // Markdown at a .md path (not a page that answers every path with HTML).
      return r.ok && !r.notModified && !/html/i.test(r.contentType) && !/^\s*<(!doctype|html)/i.test(r.text) && r.text.trim().length > 0 && /\.md$/i.test(new URL(r.url).pathname);
    }));
    if (hits.filter(Boolean).length >= Math.ceil((sample.length * 2) / 3)) {
      return links.map((l) => {
        const t = /\.md$/i.test(new URL(l.url).pathname) ? null : twinUrl(l.url, pattern);
        return t ? { ...l, url: t, page: l.url } : l;
      });
    }
  }
  return links;
}

// Keeps only links known to exist, in their order: statuses on record, the
// rest checked now (within the budget); a .md twin that fails falls back to its page.
async function onlyExisting(links: Candidate[], o: BuildOptions, left: () => number): Promise<LlmsLink[]> {
  const key = (u: string) => normalizeLink(u) ?? u;
  const check = async (urls: string[], timeoutMs: number) => {
    const known = o.db ? await linkStates(o.db, urls.map(key)) : new Map<string, 'ok' | 'bad'>();
    const unknown = urls.filter((u) => !known.has(key(u)));
    const checked = await checkLinks(unknown, {
      fetchImpl: o.fetchImpl, allowLocalhost: o.allowLocalhost, perHost: 8, hostIntervalMs: 0, budget: MAX_LINKS * 2,
      deadline: Date.now() + left() - 300, timeoutMs,
    });
    if (o.db) await saveLinks(o.db, checked, 'check', o.now).catch(() => {});
    for (const r of checked) known.set(r.url, r.ok ? 'ok' : 'bad');
    return known;
  };
  const first = await check(links.map((l) => l.url), 4000);
  const result: (LlmsLink | null)[] = links.map((l) => (first.get(key(l.url)) === 'ok' ? { title: l.title, url: l.url, ...(l.description ? { description: l.description } : {}) } : null));
  const retry = links.map((l, i) => ({ l, i })).filter(({ l, i }) => !result[i] && l.page);
  if (retry.length && left() > 800) {
    const second = await check(retry.map(({ l }) => l.page!), 3000);
    for (const { l, i } of retry) if (second.get(key(l.page!)) === 'ok') result[i] = { title: l.title, url: l.page!, ...(l.description ? { description: l.description } : {}) };
  }
  return result.filter((l): l is LlmsLink => l !== null);
}

export function groupBySection(links: LlmsLink[], root: string): LlmsSection[] {
  const sections = new Map<string, LlmsLink[]>();
  for (const l of links) {
    const name = sectionOf(l.url.replace(/(\/index)?\.md$/i, ''), root);
    if (!sections.has(name)) sections.set(name, []);
    sections.get(name)!.push(l);
  }
  // Quick start first (getting started, install, introduction; then the
  // overview), the rest in the order they first appear.
  const rank = (n: string) => (/^(getting started|get started|quick ?start|install(ation)?|intro(duction)?|basics|tutorials?|start)/i.test(n) ? 0 : n === 'Overview' ? 1 : 2);
  const names = [...sections.keys()].sort((a, b) => rank(a) - rank(b));
  return names.map((name) => ({ name, links: sections.get(name)! }));
}

// ---- Full stage -------------------------------------------------------------------------------

// A one-line description in the page's own words: its first sentence,
// trimmed to about 100 characters. Never a summary about the page ("This
// page serves as…").
export function shortDescription(text: string | null | undefined): string | null {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!s || /^(this|the) (page|document|section|article|guide|index)\b/i.test(s)) return null;
  const first = /^(.{20,}?[.!?])(\s|$)/.exec(s)?.[1] ?? s;
  return first.length <= 100 ? first : `${first.slice(0, 99).replace(/\s+\S*$/, '')}…`;
}

const SLOT_SECTION: Record<string, string> = {
  install: 'Getting started', quickstart: 'Getting started', auth: 'Getting started',
  concepts: 'Guides', guide: 'Guides', examples: 'Guides', migration: 'Guides',
  'api-reference': 'Reference', 'sdk-reference': 'Reference', errors: 'Reference', limits: 'Reference',
  'webhooks-events': 'Reference', 'versioning-changelog': 'Reference',
};
const SECTION_ORDER = ['Getting started', 'Guides', 'Reference', 'Other'];

// From the indexed pages under the docs root: title, summary, slot, and the
// .md source when the crawl fetched one. Only links known to exist.
export async function buildFull(db: D1Database, root: string, title: string, o: BuildOptions = {}): Promise<BuiltLlms | null> {
  const r0 = new URL(root);
  const host = normalizeSite(r0.hostname);
  const rootPath = r0.pathname.replace(/\/+$/, '');
  const { results } = await db
    .prepare(
      `SELECT pi.url AS url, pi.title AS title, pi.summary AS summary, pi.slot AS slot, pi.content_hash AS content_hash,
              p.source_url AS source_url, p.source_kind AS source_kind
       FROM page_index pi LEFT JOIN pages p ON p.url = pi.url
       WHERE pi.site = ? ORDER BY pi.url LIMIT 2000`,
    )
    .bind(host)
    .all<{ url: string; title: string | null; summary: string | null; slot: string | null; content_hash: string; source_url: string | null; source_kind: string | null }>();
  const rows = results.filter((r) => underRoot(r.url, rootPath || '/') && !/\/llms(-full)?\.txt$/i.test(r.url));
  if (!rows.length) return null;
  // Descriptions from the stored page itself (its first paragraph's first
  // sentence); a stored summary only when it reads like the page's own words.
  const described = await Promise.all(rows.slice(0, o.maxLinks ?? 1000).map(async (r) => {
    let description: string | null = null;
    if (o.bucket) {
      const obj = await o.bucket.get(`pages/${r.content_hash}.md`).catch(() => null);
      if (obj) description = shortDescription(firstParagraph(await obj.text()));
    }
    return description ?? shortDescription(r.summary);
  }));
  let links: (LlmsLink & { slot: string })[] = rows.slice(0, o.maxLinks ?? 1000).map((r, i) => ({
    title: r.title || humanize(new URL(r.url).pathname.split('/').filter(Boolean).pop() ?? '') || r.url,
    url: r.source_kind === 'page-md' && r.source_url && /\.md$/i.test(new URL(r.source_url).pathname) ? r.source_url : r.url,
    description: described[i] ?? undefined,
    slot: r.slot ?? 'other',
  }));
  links = links.slice(0, o.maxLinks ?? 1000);
  const states = await linkStates(db, links.map((l) => normalizeLink(l.url) ?? l.url));
  const unknown = links.filter((l) => !states.has(normalizeLink(l.url) ?? l.url)).map((l) => l.url);
  if (unknown.length) {
    const checked = await checkLinks(unknown, { fetchImpl: o.fetchImpl, allowLocalhost: o.allowLocalhost, perHost: 8, hostIntervalMs: 0, budget: 400, deadline: Date.now() + (o.budgetMs ?? 60_000), timeoutMs: 5000 });
    await saveLinks(db, checked, 'check', o.now).catch(() => {});
    for (const c of checked) states.set(c.url, c.ok ? 'ok' : 'bad');
  }
  const ok = links.filter((l) => states.get(normalizeLink(l.url) ?? l.url) === 'ok');
  const sections = SECTION_ORDER.map((name) => ({
    name,
    links: ok.filter((l) => (SLOT_SECTION[l.slot] ?? 'Other') === name).map(({ title: t, url, description }) => ({ title: t, url, ...(description ? { description } : {}) })),
  })).filter((s) => s.links.length);
  const text = renderLlms({ title, host, root, sections });
  return { title, root, host, sections, text, pages: ok.length, stage: 'full' };
}

// What a llms.txt says about itself: its H1, its number of links, its size in tokens.
export function describeLlms(text: string): { title: string | null; pages: number; tokens: number } {
  const title = /^#[ \t]+(.+)$/m.exec(text.slice(0, 20_000))?.[1]?.trim() ?? null;
  const pages = (text.match(/\]\(\s*[^)\s]+\)/g) ?? []).length;
  return { title, pages, tokens: Math.ceil(text.length / 4) };
}
