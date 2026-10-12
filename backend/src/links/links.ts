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

type LinkKind = 'link' | 'image' | 'auto' | 'bare';
type Visit = (m: { kind: LinkKind; text: string; target: string; raw: string }) => string;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])[ \t]/;
const MAX_TEXT = 500;
const MAX_TARGET = 2048;
// Characters that end a bare URL; parentheses are handled by balance.
const URL_STOP = /[\s<>"'`[\]{}|\\^]/;
const TRAILING = /[.,;:!?*_]+$/;

// A bare URL from `i` (an "http" there): to the first stop character, with
// parentheses kept only while balanced (wiki/Foo_(bar)), and trailing
// punctuation left to the prose.
function bareAt(s: string, i: number): { url: string; end: number } | null {
  if (!/^https?:\/\//.test(s.slice(i, i + 8))) return null;
  let j = i;
  let depth = 0;
  while (j < s.length && j - i < MAX_TARGET && !URL_STOP.test(s[j])) {
    if (s[j] === '(') depth++;
    else if (s[j] === ')') {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  let url = s.slice(i, j);
  const tail = TRAILING.exec(url)?.[0] ?? '';
  if (tail) url = url.slice(0, -tail.length);
  // An unclosed "(" stays out of the URL.
  while (url.split('(').length > url.split(')').length) {
    const k = url.lastIndexOf('(');
    url = url.slice(0, k);
  }
  return url.length > 10 ? { url, end: i + url.length } : null;
}

// [text](target "title") or ![alt](target) starting at `i`; the target may
// hold balanced parentheses. `closes` lists the positions of ']' in s, and
// `ci` is the first one not before i (so the scan stays linear).
function linkAt(s: string, i: number, close: number): { kind: 'link' | 'image'; text: string; target: string; end: number } | null {
  const image = s[i] === '!';
  const open = image ? i + 1 : i;
  if (close < 0 || close - open > MAX_TEXT + 1 || s[close + 1] !== '(') return null;
  let j = close + 2;
  while (s[j] === ' ' || s[j] === '\t') j++;
  let target = '';
  if (s[j] === '<') {
    const k = s.indexOf('>', j);
    if (k < 0 || k - j > MAX_TARGET) return null;
    target = s.slice(j + 1, k);
    j = k + 1;
  } else {
    const t0 = j;
    let depth = 0;
    while (j < s.length && j - t0 <= MAX_TARGET && !/\s/.test(s[j])) {
      if (s[j] === '(') depth++;
      else if (s[j] === ')') {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    target = s.slice(t0, j);
  }
  while (s[j] === ' ' || s[j] === '\t') j++;
  if (s[j] === '"' || s[j] === "'") {
    const k = s.indexOf(s[j], j + 1);
    if (k < 0 || k - j > 300) return null;
    j = k + 1;
    while (s[j] === ' ' || s[j] === '\t') j++;
  }
  if (s[j] !== ')' || !target) return null;
  return { kind: image ? 'image' : 'link', text: s.slice(open + 1, close), target, end: j + 1 };
}

// Links in a run of prose (no code in it).
function proseLinks(s: string, visit: Visit): string {
  if (!s.includes('http') && !s.includes('](')) return s;
  const closes: number[] = [];
  for (let k = s.indexOf(']'); k >= 0; k = s.indexOf(']', k + 1)) closes.push(k);
  let ci = 0;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const open = c === '!' ? i + 1 : i;
      while (ci < closes.length && closes[ci] < open) ci++;
      const m = linkAt(s, i, closes[ci] ?? -1);
      if (m) {
        out += visit({ kind: m.kind, text: m.text, target: m.target, raw: s.slice(i, m.end) });
        i = m.end;
        continue;
      }
    } else if (c === '<' && s.startsWith('http', i + 1)) {
      const k = s.indexOf('>', i);
      const inner = k > 0 && k - i <= MAX_TARGET ? s.slice(i + 1, k) : '';
      if (inner && /^https?:\/\/\S+$/.test(inner)) {
        out += visit({ kind: 'auto', text: inner, target: inner, raw: s.slice(i, k + 1) });
        i = k + 1;
        continue;
      }
    } else if (c === 'h' && (i === 0 || !/[\w/.:@-]/.test(s[i - 1]))) {
      const b = bareAt(s, i);
      if (b) {
        out += visit({ kind: 'bare', text: b.url, target: b.url, raw: b.url });
        i = b.end;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// A line's code spans (`code`, ``co`de``, <code>…</code>) kept as they are,
// links in the rest. A backtick run closes only at the next run of the same
// length (found through per-length queues, so the scan stays linear).
function lineLinks(line: string, visit: Visit): string {
  const runs: { at: number; n: number }[] = [];
  for (let i = 0; i < line.length; ) {
    if (line[i] !== '`') { i++; continue; }
    let n = 0;
    while (line[i + n] === '`') n++;
    runs.push({ at: i, n });
    i += n;
  }
  const byLength = new Map<number, number[]>();
  runs.forEach((run, k) => {
    const q = byLength.get(run.n);
    if (q) q.push(k);
    else byLength.set(run.n, [k]);
  });
  const next = new Map<number, number>(); // per length: position in its queue
  let out = '';
  let prose = '';
  let i = 0;
  let r = 0;
  const flush = () => {
    out += proseLinks(prose, visit);
    prose = '';
  };
  while (i < line.length) {
    while (r < runs.length && runs[r].at < i) r++;
    if (r < runs.length && runs[r].at === i) {
      const { n } = runs[r];
      const queue = byLength.get(n)!;
      let q = next.get(n) ?? 0;
      while (q < queue.length && queue[q] <= r) q++;
      next.set(n, q);
      if (q < queue.length) {
        const close = runs[queue[q]];
        flush();
        out += line.slice(i, close.at + n);
        i = close.at + n;
        continue;
      }
      prose += line.slice(i, i + n);
      i += n;
      continue;
    }
    if (line[i] === '<' && /^<code[\s>]/i.test(line.slice(i, i + 6))) {
      const k = line.toLowerCase().indexOf('</code>', i);
      if (k >= 0) {
        flush();
        out += line.slice(i, k + 7);
        i = k + 7;
        continue;
      }
    }
    prose += line[i];
    i++;
  }
  flush();
  return out;
}

// Calls `visit` for every link outside code and replaces it with what visit
// returns. Code is: fenced blocks, indented blocks (after a blank line, not
// inside a list), <pre> blocks, and inline code spans.
function eachLink(md: string, visit: Visit): string {
  let fence = '';
  let pre = false;
  let indented = false;
  let prevBlank = true;
  let inList = false;
  return md
    .split('\n')
    .map((line) => {
      const blank = !line.trim();
      const f = FENCE.exec(line);
      let out = line;
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = '';
      } else if (pre) {
        if (/<\/pre>/i.test(line)) pre = false;
      } else if (f) {
        fence = f[1];
      } else if (/^\s*<pre[\s>]/i.test(line)) {
        pre = !/<\/pre>/i.test(line);
      } else if (!blank && /^( {4}|\t)/.test(line) && (indented || (prevBlank && !inList))) {
        indented = true;
      } else if (!blank) {
        indented = false;
        if (LIST_ITEM.test(line)) inList = true;
        else if (!/^\s/.test(line)) inList = false;
        out = lineLinks(line, visit);
      }
      if (!blank && !/^( {4}|\t)/.test(line)) indented = false;
      prevBlank = blank;
      return out;
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

// Keeps a link only when its target is known to exist (made absolute).
// Otherwise [text](url) keeps its text and loses the URL, and an image its
// alt text; a bare or <auto> URL is never deleted: it stays as plain text in
// backticks, so it reads as a value rather than a link. Links that aren't
// http(s) (mailto:) are left alone. `unknown` lists targets with no status yet.
export function rewriteLinks(md: string, base: string, states: Map<string, LinkState>): { text: string; unknown: string[] } {
  const unknown = new Set<string>();
  const text = eachLink(md, (m) => {
    const u = normalizeLink(m.target, base);
    if (!u) return m.raw;
    const state = states.get(u);
    if (state === undefined) unknown.add(u);
    if (state === 'ok') {
      // Absolute, keeping an anchor (#section) the status key drops.
      const abs = new URL(m.target.trim(), base).href;
      if (m.kind === 'link') return `[${m.text}](${abs})`;
      if (m.kind === 'image') return `![${m.text}](${abs})`;
      return m.kind === 'auto' ? `<${abs}>` : abs;
    }
    return m.kind === 'link' || m.kind === 'image' ? m.text : `\`${m.text}\``;
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

// Records that `site` links to these URLs (from `pageUrl`).
export async function addRefs(db: D1Database, site: string, pageUrl: string, urls: string[], now = new Date()): Promise<void> {
  const unique = [...new Set(urls.map((u) => normalizeLink(u)).filter((u): u is string => u !== null))].slice(0, 500);
  const stmts = unique.map((u) =>
    db.prepare('INSERT INTO link_refs (site, url, page_url, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (site, url) DO UPDATE SET seen_at = excluded.seen_at')
      .bind(site, u, pageUrl, now.toISOString()));
  for (const part of chunks(stmts, 100)) await db.batch(part);
}

// Statuses from POST /v1/links/check for URLs nothing in the library links
// to: kept a day for repeat lookups, then deleted.
export const LIVE_ROW_HOURS = 24;
export async function pruneLiveLinks(db: D1Database, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - LIVE_ROW_HOURS * 3_600_000).toISOString();
  const r = await db
    .prepare(`DELETE FROM link_status WHERE source = 'live' AND checked_at < ? AND url NOT IN (SELECT url FROM link_refs)`)
    .bind(before)
    .run();
  return r.meta.changes ?? 0;
}

// Links met while serving with no status yet, for the hourly check.
export async function queueLinks(db: D1Database, urls: string[], site: string | null, now = new Date()): Promise<void> {
  const unique = [...new Set(urls)].slice(0, 500);
  if (!unique.length) return;
  const stmts = unique.map((u) => db.prepare('INSERT OR IGNORE INTO link_check_queue (url, site, queued_at) VALUES (?, ?, ?)').bind(u, site, now.toISOString()));
  for (const part of chunks(stmts, 100)) await db.batch(part);
}

// What an HTTP status says about a link: the page exists (2xx; 400, 401,
// 403 and 405, where a server refuses a bot or a method but the page is
// there), is dead (404, 410), or nothing is known (429, 5xx, anything else).
export function linkVerdict(status: number): boolean | null {
  if ((status >= 200 && status < 300) || status === 304 || status === 400 || status === 401 || status === 403 || status === 405) return true;
  if (status === 404 || status === 410) return false;
  return null;
}

// What a crawlFetch told about every URL of its redirect chain, by
// linkVerdict on its final status; nothing when the answer says nothing
// (a timeout, robots.txt, a redirect off the site).
export function recordsFromFetch(chain: string[], r: CrawlFetch): LinkRecord[] {
  let rec: Omit<LinkRecord, 'url'> | null = null;
  if (r.ok) rec = { ok: true, status: r.notModified ? 304 : r.status, finalUrl: r.url };
  else if (!r.skipped && r.status !== null && linkVerdict(r.status) !== null) rec = { ok: linkVerdict(r.status)!, status: r.status, finalUrl: chain[chain.length - 1] ?? null };
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
  // Asked once per link before checking it: false leaves it unknown (a per-host rate limit).
  allowHost?: (host: string) => Promise<boolean>;
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
    const verdict = linkVerdict(res.status);
    return verdict === null ? null : { url, ok: verdict, status: res.status, finalUrl: current };
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
    if (o.allowHost && !(await o.allowHost(u.hostname))) return null;
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
