// Link health: the agent must never get a link that 404s (docs/BACKEND-DECISIONS.md,
// "No broken links"). Every URL the crawler fetches and every link found in
// crawled pages gets a status in link_status (migration 0012); whatever is
// served (packages, search snippets, shared skills) keeps a link only when its
// target is known to be ok. Anything else is unlinked: the link text stays,
// the URL goes, and the URL is queued for a check.
//
// Checks: same-site links through crawlFetch (the crawl's politeness and
// robots rules); external ones through assertFetchable on every redirect hop,
// HEAD first and a small ranged GET when HEAD isn't answered, no cookies, two
// at a time per host.

import { assertFetchable, normalizeSite } from '../lib/ssrf.ts';
import { normalizePageUrl } from '../lib/urls.ts';
import { crawlFetch, HostLimiter } from '../crawl/polite.ts';
import type { CrawlFetch, FetchImpl } from '../crawl/polite.ts';
import { CRAWLER_UA } from '../crawl/robots.ts';

export type LinkState = 'ok' | 'bad';

export interface LinkRecord {
  url: string;
  ok: boolean;
  status: number | null;
  finalUrl: string | null;
}

export const MAX_LINK = 1024;
// A status older than this is checked again when a crawl meets the link.
export const STALE_DAYS = 14;
// A bad link is checked once more this long after, before it counts as permanently bad.
export const RECHECK_BAD_HOURS = 24;
export const CRAWL_CHECK_BUDGET = 500;
const CHECK_TIMEOUT_MS = 8000;
const MAX_HOPS = 5;
const RANGE_BYTES = 1024;
const SAME_SITE_CAP = 4096;
const WORKERS = 8;
const IN_BATCH = 90;

// The URL a link points at, absolute and normalised, or null when it isn't
// an http(s) link (mailto:, javascript:, a malformed URL).
export function normalizeLink(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const href = normalizePageUrl(u);
  return href.length <= MAX_LINK ? href : null;
}

// ---- Finding and rewriting links in Markdown -------------------------------------

// [text](url "title") and ![alt](src); <https://autolink>; a bare https://url.
// Bounded quantifiers only: nothing here can backtrack quadratically.
const LINKS =
  /(!?)\[([^\]\n]{0,500})\]\(\s*<?([^\s<>()]{1,2048})>?(?:\s+(?:"[^"\n]{0,300}"|'[^'\n]{0,300}'))?\s*\)|<(https?:\/\/[^\s<>]{1,2048})>|(https?:\/\/[^\s<>()[\]"'`]{1,2048})/g;
const TRAILING = /[.,;:!?*_]+$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

type Visit = (m: { kind: 'link' | 'image' | 'auto' | 'bare'; text: string; target: string; raw: string }) => string;

// Calls `visit` for every link outside code (fences and inline code spans)
// and replaces it with what visit returns.
function eachLink(md: string, visit: Visit): string {
  let fence = '';
  return md
    .split('\n')
    .map((line) => {
      const f = FENCE.exec(line);
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = '';
        return line;
      }
      if (f) {
        fence = f[1];
        return line;
      }
      if (!line.includes('http') && !line.includes('](')) return line;
      // Odd parts are inline code spans, kept as they are.
      return line
        .split(/(`[^`\n]*`)/)
        .map((part, i) =>
          i % 2
            ? part
            : part.replace(LINKS, (raw, bang: string, text: string, target: string, auto: string, bare: string) => {
                if (auto) return visit({ kind: 'auto', text: auto, target: auto, raw });
                if (bare) {
                  const tail = TRAILING.exec(bare)?.[0] ?? '';
                  const url = tail ? bare.slice(0, -tail.length) : bare;
                  return visit({ kind: 'bare', text: url, target: url, raw: url }) + tail;
                }
                return visit({ kind: bang ? 'image' : 'link', text, target, raw });
              }))
        .join('');
    })
    .join('\n');
}

// Every http(s) link target outside code, absolute and normalised, in order.
export function extractLinks(md: string, base: string): string[] {
  const out = new Set<string>();
  eachLink(md, (m) => {
    const u = normalizeLink(m.target, base);
    if (u) out.add(u);
    return m.raw;
  });
  return [...out];
}

// Keeps a link only when its target is known ok (made absolute); otherwise
// the link text stays and the URL goes: [text](url) → text, an image → its
// alt text, an autolink or bare URL disappears. Links that aren't http(s)
// (mailto:) are left alone. `unknown` lists targets with no status yet.
export function rewriteLinks(md: string, base: string, states: Map<string, LinkState>): { text: string; unknown: string[] } {
  const unknown = new Set<string>();
  const text = eachLink(md, (m) => {
    const u = normalizeLink(m.target, base);
    if (!u) return m.kind === 'link' || m.kind === 'image' ? m.raw : '';
    const state = states.get(u);
    if (state === undefined) unknown.add(u);
    if (state === 'ok') {
      // Absolute, keeping an anchor (#section) the status key drops.
      const abs = new URL(m.target.trim(), base).href;
      if (m.kind === 'link') return `[${m.text}](${abs})`;
      if (m.kind === 'image') return `![${m.text}](${abs})`;
      return m.kind === 'auto' ? `<${abs}>` : abs;
    }
    return m.kind === 'link' || m.kind === 'image' ? m.text : '';
  });
  return { text, unknown: [...unknown] };
}

// ---- The store ---------------------------------------------------------------------------

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

export async function linkStates(db: D1Database, urls: string[]): Promise<Map<string, LinkState>> {
  const out = new Map<string, LinkState>();
  const unique = [...new Set(urls)];
  if (!unique.length) return out;
  const res = await db.batch(
    chunks(unique, IN_BATCH).map((part) =>
      db.prepare(`SELECT url, ok FROM link_status WHERE url IN (${part.map(() => '?').join(', ')})`).bind(...part)),
  );
  for (const r of res) for (const row of r.results as { url: string; ok: number }[]) out.set(row.url, row.ok ? 'ok' : 'bad');
  return out;
}

// Upserts results. A bad result counts up bad_checks (1: re-checked a day
// later; 2 or more: permanently bad); an ok one resets it.
export async function saveLinks(db: D1Database, records: LinkRecord[], source: 'crawl' | 'check' | 'live', now = new Date()): Promise<void> {
  const seen = new Map(records.map((r) => [r.url, r]));
  if (!seen.size) return;
  const at = now.toISOString();
  const stmts = [...seen.values()].flatMap((r) => [
    db
      .prepare(
        `INSERT INTO link_status (url, ok, status, final_url, checked_at, source, bad_checks) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET ok = excluded.ok, status = excluded.status, final_url = excluded.final_url,
           checked_at = excluded.checked_at, source = excluded.source,
           bad_checks = CASE WHEN excluded.ok = 1 THEN 0 ELSE link_status.bad_checks + 1 END`,
      )
      .bind(r.url, r.ok ? 1 : 0, r.status, r.finalUrl, at, source, r.ok ? 0 : 1),
    db.prepare('DELETE FROM link_check_queue WHERE url = ?').bind(r.url),
  ]);
  for (const part of chunks(stmts, 100)) await db.batch(part);
}

// Links met while serving with no status yet, for the hourly check.
export async function queueLinks(db: D1Database, urls: string[], site: string | null, now = new Date()): Promise<void> {
  const unique = [...new Set(urls)].slice(0, 500);
  if (!unique.length) return;
  const stmts = unique.map((u) => db.prepare('INSERT OR IGNORE INTO link_check_queue (url, site, queued_at) VALUES (?, ?, ?)').bind(u, site, now.toISOString()));
  for (const part of chunks(stmts, 100)) await db.batch(part);
}

// What a crawlFetch told about every URL of its redirect chain: ok when it
// ended in a 2xx (or 304), bad on a 4xx or 5xx; nothing when the answer
// says nothing about the link (a timeout, 429, robots.txt, a redirect off
// the site).
export function recordsFromFetch(chain: string[], r: CrawlFetch): LinkRecord[] {
  let rec: Omit<LinkRecord, 'url'> | null = null;
  if (r.ok) rec = { ok: true, status: r.notModified ? 304 : r.status, finalUrl: r.url };
  else if (!r.skipped && r.status !== null && r.status >= 400 && r.status !== 429) rec = { ok: false, status: r.status, finalUrl: chain[chain.length - 1] ?? null };
  if (!rec) return [];
  return chain.flatMap((c) => {
    const url = normalizeLink(c);
    return url ? [{ url, ...rec! }] : [];
  });
}

// Link states for everything a response is about to contain: the links in
// `texts` (resolved against their base) and the `urls` it lists itself.
// Unknown ones are queued for the hourly check.
export async function statesFor(
  db: D1Database, site: string | null, texts: { text: string; base: string }[], urls: (string | null | undefined)[],
): Promise<Map<string, LinkState>> {
  const all = new Set<string>();
  for (const t of texts) for (const u of extractLinks(t.text, t.base)) all.add(u);
  for (const u of urls) {
    const n = u ? normalizeLink(u) : null;
    if (n) all.add(n);
  }
  const states = await linkStates(db, [...all]);
  const unknown = [...all].filter((u) => !states.has(u));
  if (unknown.length) await queueLinks(db, unknown, site).catch(() => {});
  // Listed URLs are looked up as written, too.
  for (const u of urls) if (u) { const n = normalizeLink(u); if (n && states.has(n)) states.set(u, states.get(n)!); }
  return states;
}

// ---- Checking ------------------------------------------------------------------------------------

export interface CheckOptions {
  fetchImpl?: FetchImpl;
  allowLocalhost?: boolean;
  // Links on this site go through crawlFetch with `limiter` and `allowed` (robots.txt).
  site?: string;
  limiter?: HostLimiter;
  allowed?: (pathAndQuery: string) => boolean;
  // At most this many checks; the rest stay unknown.
  budget?: number;
  // No check starts after this time (ms since epoch), and none runs past it.
  deadline?: number;
  timeoutMs?: number;
  // Per external host.
  perHost?: number;
  hostIntervalMs?: number;
}

const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError' || /timed? ?out|abort/i.test(e.message));

// One external link: HEAD, then a ranged GET when HEAD fails or is refused;
// redirects followed by hand, each hop through the SSRF guard. Null when the
// answer says nothing (timeout, 429).
export async function checkExternal(url: string, o: CheckOptions & { limiter: HostLimiter }): Promise<LinkRecord | null> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeout = () => Math.max(50, Math.min(o.timeoutMs ?? CHECK_TIMEOUT_MS, o.deadline ? o.deadline - Date.now() : Infinity));
  const outOfTime = () => {
    const e = new Error('link check budget used up');
    e.name = 'TimeoutError';
    return e;
  };
  const request = async (target: string, method: 'HEAD' | 'GET') => {
    // The host's next turn comes after the deadline: undecided, without waiting for it.
    if (o.deadline && Math.max(Date.now(), o.limiter.nextStart) >= o.deadline) throw outOfTime();
    return o.limiter.run(async () => {
      if (o.deadline && Date.now() >= o.deadline) throw outOfTime();
      const headers: Record<string, string> = { 'user-agent': CRAWLER_UA };
      if (method === 'GET') headers.range = `bytes=0-${RANGE_BYTES - 1}`;
      // No cookies: none are ever set on these requests (a Worker has no cookie jar).
      const res = await fetchImpl(target, { method, redirect: 'manual', headers, signal: AbortSignal.timeout(timeout()) });
      await res.body?.cancel().catch(() => {});
      return res;
    }, o.deadline);
  };
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    try {
      assertFetchable(current, { allowLocalhost: o.allowLocalhost });
    } catch {
      // A private address is never a link worth giving an agent.
      return { url, ok: false, status: null, finalUrl: current };
    }
    let res: Response;
    try {
      res = await request(current, 'HEAD');
      if (res.status >= 400) res = await request(current, 'GET');
    } catch (e) {
      if (isTimeout(e)) return null;
      try {
        res = await request(current, 'GET');
      } catch (e2) {
        // The host doesn't resolve or refuses connections.
        return isTimeout(e2) ? null : { url, ok: false, status: null, finalUrl: current };
      }
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      try {
        current = new URL(location, current).href;
      } catch {
        return { url, ok: false, status: res.status, finalUrl: current };
      }
      continue;
    }
    if (res.status === 429) return null;
    return { url, ok: res.status >= 200 && res.status < 300, status: res.status, finalUrl: current };
  }
  return { url, ok: false, status: null, finalUrl: current };
}

// Checks links, same-site ones politely through crawlFetch and external
// ones two at a time per host, within the budget and the deadline. Returns
// only the links it could decide.
export async function checkLinks(urls: string[], o: CheckOptions = {}): Promise<LinkRecord[]> {
  const todo = [...new Set(urls)].slice(0, o.budget ?? CRAWL_CHECK_BUDGET);
  const sameLimiter = o.limiter ?? new HostLimiter();
  const hosts = new Map<string, HostLimiter>();
  const hostLimiter = (host: string) => {
    let l = hosts.get(host);
    if (!l) hosts.set(host, (l = new HostLimiter({ concurrency: o.perHost ?? 2, intervalMs: o.hostIntervalMs ?? 250 })));
    return l;
  };
  const out: LinkRecord[] = [];
  let next = 0;
  const one = async (url: string): Promise<LinkRecord | null> => {
    const u = new URL(url);
    if (o.site && normalizeSite(u.hostname) === o.site) {
      if (o.allowed && !o.allowed(u.pathname + u.search)) return null;
      let records: LinkRecord[] = [];
      await crawlFetch(url, {
        fetchImpl: o.fetchImpl,
        allowLocalhost: o.allowLocalhost,
        limiter: sameLimiter,
        allowed: o.allowed,
        cap: SAME_SITE_CAP,
        timeoutMs: o.deadline ? Math.max(50, o.deadline - Date.now()) : o.timeoutMs,
        onFetch: (chain, r) => { records = recordsFromFetch(chain, r); },
      });
      return records.find((r) => r.url === url) ?? null;
    }
    return checkExternal(url, { ...o, limiter: hostLimiter(u.hostname) });
  };
  const worker = async () => {
    while (next < todo.length) {
      if (o.deadline && Date.now() >= o.deadline) return;
      const url = todo[next++];
      try {
        const r = await one(url);
        if (r) out.push(r);
      } catch {
        // undecided: stays unknown
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, todo.length) }, worker));
  return out;
}

// The hourly job: links queued while serving, and bad links due for their
// second check. Returns how many were checked.
export async function processLinkQueue(db: D1Database, o: CheckOptions & { limit?: number; now?: Date } = {}): Promise<number> {
  const now = o.now ?? new Date();
  const limit = o.limit ?? 100;
  const recheckBefore = new Date(now.getTime() - RECHECK_BAD_HOURS * 3_600_000).toISOString();
  const [queued, bad] = await db.batch([
    db.prepare('SELECT url FROM link_check_queue ORDER BY queued_at LIMIT ?').bind(limit),
    db.prepare('SELECT url FROM link_status WHERE ok = 0 AND bad_checks = 1 AND checked_at < ? ORDER BY checked_at LIMIT ?').bind(recheckBefore, limit),
  ]);
  const urls = [...(queued.results as { url: string }[]), ...(bad.results as { url: string }[])].map((r) => r.url).slice(0, limit);
  if (!urls.length) return 0;
  const results = await checkLinks(urls, { ...o, budget: limit });
  await saveLinks(db, results, 'check', now);
  // Undecided ones leave the queue too; serving queues them again if they are still met.
  const decided = new Set(results.map((r) => r.url));
  const left = urls.filter((u) => !decided.has(u));
  for (const part of chunks(left, 100)) await db.batch(part.map((u) => db.prepare('DELETE FROM link_check_queue WHERE url = ?').bind(u)));
  return urls.length;
}

// After a crawl: every link in the run's stored pages is recorded against
// the site (link_refs), and those with no status, a stale one, or a bad one
// due for its second check are checked, within the budget.
export async function checkRunLinks(
  deps: { db: D1Database; bucket: R2Bucket },
  runId: string,
  site: string,
  o: CheckOptions & { now?: Date } = {},
): Promise<{ pages: number; links: number; checked: number; bad: number }> {
  const { db, bucket } = deps;
  const now = o.now ?? new Date();
  const { results: pages } = await db
    .prepare('SELECT url, content_hash FROM pages WHERE run_id = ?')
    .bind(runId)
    .all<{ url: string; content_hash: string }>();
  const refs = new Map<string, string>();
  for (const p of pages) {
    const obj = await bucket.get(`pages/${p.content_hash}.md`);
    if (!obj) continue;
    for (const link of extractLinks(await obj.text(), p.url)) if (!refs.has(link)) refs.set(link, p.url);
  }
  const at = now.toISOString();
  const refStmts = [...refs].map(([url, page]) =>
    db.prepare('INSERT INTO link_refs (site, url, page_url, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (site, url) DO UPDATE SET page_url = excluded.page_url, seen_at = excluded.seen_at')
      .bind(site, url, page, at));
  for (const part of chunks(refStmts, 100)) await db.batch(part);

  const staleBefore = new Date(now.getTime() - STALE_DAYS * 86_400_000).toISOString();
  const recheckBefore = new Date(now.getTime() - RECHECK_BAD_HOURS * 3_600_000).toISOString();
  const urls = [...refs.keys()];
  const known = new Map<string, { ok: number; checked_at: string; bad_checks: number }>();
  for (const part of chunks(urls, IN_BATCH)) {
    const { results } = await db
      .prepare(`SELECT url, ok, checked_at, bad_checks FROM link_status WHERE url IN (${part.map(() => '?').join(', ')})`)
      .bind(...part)
      .all<{ url: string; ok: number; checked_at: string; bad_checks: number }>();
    for (const r of results) known.set(r.url, r);
  }
  const due = urls.filter((u) => {
    const k = known.get(u);
    if (!k || k.checked_at < staleBefore) return true;
    return !k.ok && k.bad_checks === 1 && k.checked_at < recheckBefore;
  });
  // Same-site first: they are what the agent most often follows.
  const same = (u: string) => normalizeSite(new URL(u).hostname) === site;
  due.sort((a, b) => Number(same(b)) - Number(same(a)));
  const results = await checkLinks(due, { ...o, site, budget: o.budget ?? CRAWL_CHECK_BUDGET });
  await saveLinks(db, results, 'check', now);
  return { pages: pages.length, links: urls.length, checked: results.length, bad: results.filter((r) => !r.ok).length };
}
