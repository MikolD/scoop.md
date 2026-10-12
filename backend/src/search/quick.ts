// Instant first answer (GET /v1/quick?url=): the Markdown a site already
// publishes for agents, found in parallel within about 1.5 s, so the user has
// something while a crawl runs. Candidates: llms.txt and llms-full.txt at the
// page's host, at docs.<registrable domain> and under the page's first path
// segment, plus the page's .md twins. Every fetch goes through crawlFetch (the
// SSRF guard, the size cap, same-site redirects only). Jev picks the best
// overview when there are several. Only URLs come back; the client fetches
// the content itself.

import { askJev } from '../lib/jev.ts';
import type { JevOptions } from '../lib/jev.ts';
import { normalizeSite } from '../lib/ssrf.ts';
import { looksLikeText, twinUrl } from '../crawl/discover.ts';
import { crawlFetch, HostLimiter } from '../crawl/polite.ts';
import type { FetchImpl } from '../crawl/polite.ts';
import { markdownTitle } from '../crawl/site.ts';

export type QuickKind = 'llms-txt' | 'llms-full' | 'page-md';

export interface QuickSource {
  kind: QuickKind;
  url: string;
  label: string;
  // null when the file is over the read cap (llms-full.txt often is).
  bytes: number | null;
}

export interface QuickDiscovery {
  sources: QuickSource[];
  overview: string | null;
  jevTokens: number;
}

// What a site publishes for agents (its llms files) changes rarely: kept per
// site and scope (the Cache API in the Worker), so another page of the site
// only probes its own .md twin.
export interface QuickSiteCache {
  get: (key: string) => Promise<Found[] | null>;
  put: (key: string, found: Found[]) => Promise<void>;
}

export interface Found {
  source: QuickSource;
  rank: number;
  preview: string;
}

export interface QuickOptions {
  siteCache?: QuickSiteCache | null;
  fetchImpl?: FetchImpl;
  allowLocalhost?: boolean;
  // Null without JEV_API_KEY: the overview is then picked by rule.
  jev?: JevOptions | null;
  budgetMs?: number;
}

export const QUICK_BUDGET_MS = 1500;
// Each candidate fetch gets this much of the budget; Jev the rest (at least JEV_MIN_MS).
const FETCH_MS = 1000;
const JEV_MIN_MS = 300;
const LLMS_CAP = 512_000;
const FULL_CAP = 64_000;
const PREVIEW = 300;

// Two-label public suffixes common enough to matter for docs hosts.
const TWO_LABEL = /\.(co|com|org|net|ac|gov|edu)\.[a-z]{2}$/i;

// example.com for docs.example.com, example.co.uk for www.example.co.uk.
export function registrable(host: string): string {
  const labels = host.toLowerCase().split('.');
  return labels.slice(-(TWO_LABEL.test(host) ? 3 : 2)).join('.');
}

interface Candidate {
  kind: QuickKind;
  url: string;
  // Lower is preferred when no model chooses: most specific llms.txt first.
  rank: number;
}

// Every candidate URL for a page, most specific first.
export function quickCandidates(pageUrl: string): Candidate[] {
  const u = new URL(pageUrl);
  const host = normalizeSite(u.hostname);
  const bases: string[] = [];
  const first = u.pathname.split('/').filter(Boolean)[0];
  if (first && !/\.[a-z0-9]{1,5}$/i.test(first)) bases.push(`${u.origin}/${first}`);
  const docsHost = `docs.${registrable(host)}`;
  if (docsHost !== host) bases.push(`https://${docsHost}`);
  bases.push(u.origin);
  const out: Candidate[] = [];
  bases.forEach((b, i) => {
    out.push({ kind: 'llms-txt', url: `${b}/llms.txt`, rank: i });
    out.push({ kind: 'llms-full', url: `${b}/llms-full.txt`, rank: 20 + i });
  });
  if (/\.md$/i.test(u.pathname)) out.push({ kind: 'page-md', url: `${u.origin}${u.pathname}`, rank: 10 });
  else if (!u.hash) {
    for (const pattern of ['suffix', 'index'] as const) {
      const twin = twinUrl(`${u.origin}${u.pathname}`, pattern);
      if (twin) out.push({ kind: 'page-md', url: twin, rank: 10 });
    }
  }
  return [...new Map(out.map((c) => [c.url, c])).values()];
}

function labelFor(c: Candidate, text: string, finalUrl: string): string {
  const title = text ? markdownTitle(text) : null;
  const where = new URL(finalUrl);
  const place = `${where.host}${where.pathname.replace(/\/[^/]*$/, '') || ''}`;
  if (c.kind === 'page-md') return title ? `This page: ${title}` : 'This page (Markdown)';
  const what = c.kind === 'llms-txt' ? 'llms.txt' : 'llms-full.txt';
  return title ? `${title} (${what})` : `${what} at ${place}`;
}

export async function quickDiscover(pageUrl: string, o: QuickOptions = {}): Promise<QuickDiscovery> {
  const started = Date.now();
  const budget = o.budgetMs ?? QUICK_BUDGET_MS;
  // One request per candidate, all at once; no politeness spacing for a handful of well-known files.
  const limiter = new HostLimiter({ concurrency: 16, intervalMs: 0 });
  const probe = (cands: Candidate[]) => Promise.all(
    cands.map(async (c): Promise<Found | null> => {
      const r = await crawlFetch(c.url, {
        fetchImpl: o.fetchImpl,
        allowLocalhost: o.allowLocalhost,
        limiter,
        cap: c.kind === 'llms-full' ? FULL_CAP : LLMS_CAP,
        timeoutMs: Math.min(FETCH_MS, budget),
      });
      if (!r.ok || r.notModified || !(r.over || looksLikeText(r.contentType, r.text))) return null;
      const source: QuickSource = {
        kind: c.kind,
        url: r.url,
        label: labelFor(c, r.text, r.url),
        bytes: r.over ? null : new TextEncoder().encode(r.text).length,
      };
      return { source, rank: c.rank, preview: r.text.slice(0, PREVIEW) };
    }),
  ).then((all) => all.filter((f) => f !== null));
  const cands = quickCandidates(pageUrl);
  const siteKey = cands.filter((c) => c.kind === 'llms-txt').map((c) => c.url).join(' ');
  const siteFound = async () => {
    const cached = await o.siteCache?.get(siteKey).catch(() => null);
    if (cached) return cached;
    const fresh = await probe(cands.filter((c) => c.kind !== 'page-md'));
    await o.siteCache?.put(siteKey, fresh).catch(() => {});
    return fresh;
  };
  const found = (await Promise.all([siteFound(), probe(cands.filter((c) => c.kind === 'page-md'))])).flat();
  // A redirect can land two candidates on one file.
  const seen = new Set<string>();
  const hits = found.sort((a, b) => a.rank - b.rank).filter((f) => !seen.has(f.source.url) && seen.add(f.source.url));
  if (!hits.length) return { sources: [], overview: null, jevTokens: 0 };
  // llms-full.txt (often megabytes) is the overview only when there is nothing else.
  const light = hits.filter((h) => h.source.kind !== 'llms-full');
  const options = light.length ? light : hits;
  let overview = options[0].source.url;
  let jevTokens = 0;
  const left = budget - (Date.now() - started);
  if (o.jev && options.length > 1 && left >= JEV_MIN_MS) {
    try {
      const criteria = Object.fromEntries(options.map((h, i) => [`s${i}`, { kind: h.source.kind, url: h.source.url, label: h.source.label, start: h.preview }]));
      const r = await askJev({ page: pageUrl }, {
        overview: {
          type: 'choice',
          instructions: 'Which source gives a developer reading the page in `state` the best overview of the product it documents, to start from?',
          criteria,
        },
      }, { ...o.jev, timeoutMs: left, retries: 0 });
      jevTokens = r.tokens;
      const a = r.answers.overview;
      if (a.type === 'choice') overview = options[Number(a.choice.slice(1))]?.source.url ?? overview;
    } catch (e) {
      console.warn(JSON.stringify({ quick: 'jev', error: (e as Error).message.slice(0, 200) }));
    }
  }
  return { sources: hits.map((h) => h.source), overview, jevTokens };
}
