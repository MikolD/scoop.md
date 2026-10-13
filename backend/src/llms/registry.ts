// "llms.txt first" (0.6.0): GET /v1/llms answers every scoop with the docs
// site's llms.txt as a short link prompt; the registry (migrations/0013)
// remembers every docs site's llms.txt, the site's own or one scoop.md built
// (src/llms/build.ts) and serves at <publicBase>/<host>/llms.txt.
//
// Order of work for a page: the not-docs lists (nothing is stored), the
// registry (no network), then /v1/quick's discovery (docs root, docs
// elsewhere, verdict). A docs site with its own verified llms.txt is
// registered as is; one without gets a scoop-built file: the instant stage
// right away (its URL works from the first answer), the full stage from the
// site's index, or from a crawl started for it.

import { normalizeSite, siteOf } from '../lib/ssrf.ts';
import { sha256Hex } from '../lib/ids.ts';
import { denylistHosts } from '../crawl/gate.ts';
import { crawlFetch, HostLimiter } from '../crawl/polite.ts';
import type { FetchImpl } from '../crawl/polite.ts';
import { quickDiscover } from '../search/quick.ts';
import type { QuickOptions } from '../search/quick.ts';
import { buildFull, buildInstant, describeLlms, siteName } from './build.ts';
import type { BuiltLlms } from './build.ts';
import { agentExcerpt, scoopExcerpt } from './excerpt.ts';
import type { AgentExcerpt } from './excerpt.ts';

export interface RegistryRow {
  host: string;
  docs_root: string;
  llms_url: string;
  source: 'site' | 'scoop';
  status: 'ready' | 'preparing';
  stage: 'instant' | 'full' | null;
  title: string | null;
  pages: number;
  tokens: number;
  content_hash: string | null;
  full_url: string | null;
  links_ok: number;
  agent_text: string | null;
  agent_source: string | null;
  agent_method: 'section' | 'jev' | null;
  scoops: number;
  checked_at: string | null;
  changed_at: string | null;
  created_at: string;
}

export interface LlmsAnswer {
  site: string;
  docs: { found: boolean; root: string | null; verdict: 'yes' | 'no' | 'unknown' };
  llms: {
    url: string;
    source: 'site' | 'scoop';
    status: 'ready' | 'preparing';
    title: string | null;
    pages: number;
    tokens: number;
    checkedAt: string | null;
    fullUrl: string | null;
  } | null;
  agentInstructions: AgentExcerpt | null;
  prompt: string | null;
  retryAfterMs: number | null;
}

export const PUBLIC_BASE = 'https://scoop.md';
export const RETRY_AFTER_MS = 3000;
// A preparing row whose build hasn't finished in this long is built again.
const STALE_PREPARING_MS = 2 * 60_000;
// The site's index already has this many pages under the docs root: the full stage needs no crawl.
const FULL_FROM_INDEX = 5;
const SITE_LLMS_CAP = 2_000_000;
const KEY = (host: string) => `llms/${host}.txt`;

// The clipboard text: the link line (~30 tokens, the same wording
// everywhere), then the site's instructions for agents when it has any
// (≤ 1,200 characters, ~300 tokens), quoted as the docs' own words.
export function promptFor(name: string, url: string, source: 'site' | 'scoop', excerpt?: AgentExcerpt | null): string {
  const line = source === 'site'
    ? `${name} docs for agents: ${url} — read it first, then fetch only the pages you need.`
    : `${name} docs for agents (llms.txt prepared by scoop.md): ${url} — read it first, then fetch only the pages you need.`;
  return excerpt?.text ? `${line}\n\nFrom the ${name} docs, for agents (${excerpt.source}):\n${excerpt.text}` : line;
}

const excerptOf = (row: RegistryRow): AgentExcerpt | null =>
  row.agent_text ? { text: row.agent_text, source: row.agent_source ?? row.llms_url, method: row.agent_method ?? 'section' } : null;

export const scoopUrl = (base: string, host: string) => `${base.replace(/\/+$/, '')}/${host}/llms.txt`;

export function answerFrom(site: string, row: RegistryRow, verdict: 'yes' | 'unknown' = 'yes'): LlmsAnswer {
  const name = siteName(row.title, row.host);
  return {
    site,
    docs: { found: true, root: row.docs_root, verdict },
    llms: {
      url: row.llms_url,
      source: row.source,
      status: row.status,
      title: row.title,
      pages: row.pages,
      tokens: row.tokens,
      checkedAt: row.checked_at,
      fullUrl: row.full_url,
    },
    agentInstructions: excerptOf(row),
    prompt: promptFor(name, row.llms_url, row.source, excerptOf(row)),
    retryAfterMs: row.status === 'preparing' ? RETRY_AFTER_MS : null,
  };
}

export const notDocsAnswer = (site: string, verdict: 'no' | 'unknown' = 'no'): LlmsAnswer =>
  ({ site, docs: { found: false, root: null, verdict }, llms: null, agentInstructions: null, prompt: null, retryAfterMs: null });

// ---- The store -------------------------------------------------------------------------------

export async function getRow(db: D1Database, host: string): Promise<RegistryRow | null> {
  return db.prepare('SELECT * FROM llms_registry WHERE host = ?').bind(host).first<RegistryRow>();
}

// The registered docs for a page's host: its own row, or the docs host it led to before.
export async function rowForPage(db: D1Database, pageHost: string): Promise<RegistryRow | null> {
  return db
    .prepare(
      `SELECT r.* FROM llms_registry r WHERE r.host = ?1
       UNION ALL SELECT r.* FROM llms_aliases a JOIN llms_registry r ON r.host = a.host WHERE a.page_host = ?1
       LIMIT 1`,
    )
    .bind(pageHost)
    .first<RegistryRow>();
}

export async function upsertRow(db: D1Database, row: Partial<RegistryRow> & Pick<RegistryRow, 'host' | 'docs_root' | 'llms_url' | 'source' | 'status'>, now = new Date()): Promise<void> {
  const at = now.toISOString();
  const full: RegistryRow = {
    stage: null, title: null, pages: 0, tokens: 0, content_hash: null, full_url: null, links_ok: 0,
    agent_text: null, agent_source: null, agent_method: null, scoops: 0,
    checked_at: at, changed_at: at, created_at: at, ...row,
  };
  const cols = Object.keys(full) as (keyof RegistryRow)[];
  await db
    .prepare(
      `INSERT INTO llms_registry (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
       ON CONFLICT (host) DO UPDATE SET ${cols.filter((c) => c !== 'host' && c !== 'created_at' && c !== 'scoops').map((c) => `${c} = excluded.${c}`).join(', ')}`,
    )
    .bind(...cols.map((c) => full[c]))
    .run();
}

export async function setAlias(db: D1Database, pageHost: string, host: string, now = new Date()): Promise<void> {
  if (pageHost === host) return;
  await db
    .prepare('INSERT INTO llms_aliases (page_host, host, updated_at) VALUES (?, ?, ?) ON CONFLICT (page_host) DO UPDATE SET host = excluded.host, updated_at = excluded.updated_at')
    .bind(pageHost, host, now.toISOString())
    .run();
}

// Not docs by the gate's denylist: answered at once, nothing stored. (A
// crawl's not_devtool verdict is about the page it started from: twilio.com
// was rejected for its home page while its docs live at twilio.com/docs, so
// such hosts still go through discovery.)
export async function knownNotDocs(_db: D1Database, host: string): Promise<boolean> {
  const hosts = denylistHosts();
  return hosts.includes(host) || hosts.includes(`www.${host}`);
}

// The public list (the site's Library page): docs sites only.
export async function listRegistry(db: D1Database, limit: number, offset: number): Promise<{ rows: RegistryRow[]; more: boolean }> {
  // Every row is a docs site (only discovery that found docs registers one); the denylist is checked again all the same.
  const deny = new Set(denylistHosts());
  const { results } = await db
    .prepare(`SELECT * FROM llms_registry WHERE status = 'ready' ORDER BY scoops DESC, host LIMIT ? OFFSET ?`)
    .bind(limit + 1, offset)
    .all<RegistryRow>();
  return { rows: results.slice(0, limit).filter((r) => !deny.has(r.host)), more: results.length > limit };
}

// ---- Building and storing ---------------------------------------------------------------------

export interface LlmsDeps {
  db: D1Database;
  bucket: R2Bucket;
  publicBase?: string;
  fetchImpl?: FetchImpl;
  allowLocalhost?: boolean;
  quick?: Omit<QuickOptions, 'fetchImpl' | 'allowLocalhost' | 'instructions' | 'instructionsFor'>;
  // Runs work after the answer (ctx.waitUntil); awaited when absent.
  waitUntil?: (p: Promise<unknown>) => void;
  // Starts a crawl of the docs root, for the full stage (a crawl request).
  startCrawl?: (root: string, host: string) => Promise<void>;
  now?: () => Date;
}

const later = (d: LlmsDeps, p: Promise<unknown>) => {
  const safe = p.catch((e) => console.error(JSON.stringify({ llms: 'background', error: e instanceof Error ? e.message : String(e) })));
  if (d.waitUntil) d.waitUntil(safe);
  return safe;
};

export async function storeBuilt(d: LlmsDeps, row: RegistryRow, b: BuiltLlms): Promise<RegistryRow> {
  const now = d.now?.() ?? new Date();
  const hash = await sha256Hex(b.text);
  // Instructions for agents from the site's install / quick start pages (kept when none are found again).
  const excerpt = await scoopExcerpt(b, excerptDeps(d)).catch(() => null);
  await d.bucket.put(KEY(row.host), b.text, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
  const next: RegistryRow = {
    ...row,
    status: 'ready',
    stage: b.stage,
    title: b.title,
    pages: b.pages,
    tokens: Math.ceil(b.text.length / 4),
    content_hash: hash,
    links_ok: 1,
    agent_text: excerpt?.text ?? row.agent_text,
    agent_source: excerpt?.source ?? row.agent_source,
    agent_method: excerpt?.method ?? row.agent_method,
    checked_at: now.toISOString(),
    changed_at: hash === row.content_hash ? row.changed_at : now.toISOString(),
  };
  await upsertRow(d.db, next, now);
  return next;
}

const excerptDeps = (d: LlmsDeps) => ({ jev: d.quick?.jev ?? null, db: d.db, fetchImpl: d.fetchImpl, allowLocalhost: d.allowLocalhost });

// The instant file, then the full stage: from the site's index when it has
// pages under the root, else from a crawl started for it.
export async function buildScoop(d: LlmsDeps, row: RegistryRow): Promise<RegistryRow> {
  const built = await buildInstant(row.docs_root, { fetchImpl: d.fetchImpl, allowLocalhost: d.allowLocalhost, db: d.db, now: d.now?.() });
  let next = await storeBuilt(d, row, built);
  const indexed = await d.db.prepare('SELECT COUNT(*) AS n FROM page_index WHERE site = ?').bind(row.host).first<{ n: number }>();
  if ((indexed?.n ?? 0) >= FULL_FROM_INDEX) {
    const full = await buildFull(d.db, row.docs_root, next.title ?? built.title, { fetchImpl: d.fetchImpl, allowLocalhost: d.allowLocalhost, now: d.now?.() });
    if (full && full.pages >= Math.min(built.pages, 5)) next = await storeBuilt(d, next, full);
  } else if (d.startCrawl) {
    await d.startCrawl(row.docs_root, row.host).catch((e) => console.error(JSON.stringify({ llms: 'crawl', host: row.host, error: (e as Error).message })));
  }
  return next;
}

// Fetches a site's own llms.txt to describe it (title, links, tokens, hash).
export async function describeSiteLlms(url: string, d: LlmsDeps): Promise<{ title: string | null; pages: number; tokens: number; hash: string; excerpt: AgentExcerpt | null } | null> {
  const r = await crawlFetch(url, { fetchImpl: d.fetchImpl, allowLocalhost: d.allowLocalhost, limiter: new HostLimiter({ intervalMs: 0 }), cap: SITE_LLMS_CAP, truncate: true, timeoutMs: 5000 });
  if (!r.ok || r.notModified) return null;
  const desc = describeLlms(r.text);
  const excerpt = await agentExcerpt(r.text, r.url, excerptDeps(d)).catch(() => null);
  return { ...desc, hash: await sha256Hex(r.text), excerpt };
}

// GET /v1/llms?url=: the answer for a page.
export async function resolveLlms(pageUrl: string, d: LlmsDeps): Promise<LlmsAnswer> {
  const now = d.now?.() ?? new Date();
  const site = siteOf(pageUrl);
  const pageHost = normalizeSite(new URL(pageUrl).hostname);
  if (await knownNotDocs(d.db, pageHost)) return notDocsAnswer(site);

  const known = await rowForPage(d.db, pageHost);
  if (known) {
    await d.db.prepare('UPDATE llms_registry SET scoops = scoops + 1 WHERE host = ?').bind(known.host).run();
    if (known.status === 'preparing' && Date.parse(known.checked_at ?? known.created_at) < now.getTime() - STALE_PREPARING_MS) {
      await upsertRow(d.db, { ...known, checked_at: now.toISOString() }, now);
      later(d, buildScoop(d, known));
    }
    return answerFrom(site, known);
  }

  const q = await quickDiscover(pageUrl, { ...d.quick, fetchImpl: d.fetchImpl, allowLocalhost: d.allowLocalhost, instructions: false });
  if (!q.docs.found || !q.docs.root) return notDocsAnswer(site, q.docs.verdict === 'no' ? 'no' : 'unknown');
  const root = q.docs.root;
  const host = normalizeSite(new URL(root).hostname);
  if (host !== pageHost && (await knownNotDocs(d.db, host))) return notDocsAnswer(site);

  const existing = await getRow(d.db, host);
  if (existing) {
    await setAlias(d.db, pageHost, host, now);
    await d.db.prepare('UPDATE llms_registry SET scoops = scoops + 1 WHERE host = ?').bind(host).run();
    return answerFrom(site, existing);
  }

  // The site's own llms.txt, when it is a verified docs index.
  if (q.llms?.url && q.llms.verified) {
    const desc = await describeSiteLlms(q.llms.url, d);
    if (desc && desc.pages > 0) {
      const row: RegistryRow = {
        host, docs_root: root, llms_url: q.llms.url, source: 'site', status: 'ready', stage: null,
        title: desc.title, pages: desc.pages, tokens: desc.tokens, content_hash: desc.hash,
        full_url: q.llms.fullVerified ? q.llms.fullUrl : null, links_ok: 0,
        agent_text: desc.excerpt?.text ?? null, agent_source: desc.excerpt?.source ?? null, agent_method: desc.excerpt?.method ?? null, scoops: 1,
        checked_at: now.toISOString(), changed_at: now.toISOString(), created_at: now.toISOString(),
      };
      await upsertRow(d.db, row, now);
      await setAlias(d.db, pageHost, host, now);
      return answerFrom(site, row);
    }
  }

  // None: scoop.md prepares one. The URL is valid at once (the hosted file
  // builds the instant stage on demand while this one runs).
  const row: RegistryRow = {
    host, docs_root: root, llms_url: scoopUrl(d.publicBase ?? PUBLIC_BASE, host), source: 'scoop', status: 'preparing', stage: null,
    title: null, pages: 0, tokens: 0, content_hash: null, full_url: null, links_ok: 0,
    agent_text: null, agent_source: null, agent_method: null, scoops: 1,
    checked_at: now.toISOString(), changed_at: now.toISOString(), created_at: now.toISOString(),
  };
  await upsertRow(d.db, row, now);
  await setAlias(d.db, pageHost, host, now);
  const answer = answerFrom(site, { ...row, title: siteName(null, host) });
  answer.llms!.title = null;
  later(d, buildScoop(d, row));
  return answer;
}

// GET /v1/llms/<host>/llms.txt: a scoop-built file (the site's own is a redirect).
export async function serveLlms(host: string, d: LlmsDeps): Promise<{ status: 200 | 302 | 404 | 503; body?: string; location?: string }> {
  const row = await getRow(d.db, host);
  if (!row) return { status: 404 };
  if (row.source === 'site') return { status: 302, location: row.llms_url };
  const obj = await d.bucket.get(KEY(host));
  if (obj) return { status: 200, body: await obj.text() };
  // Preparing: build the instant stage now, so the URL never answers empty.
  try {
    const next = await storeBuilt(d, row, await buildInstant(row.docs_root, { fetchImpl: d.fetchImpl, allowLocalhost: d.allowLocalhost, db: d.db, now: d.now?.() }));
    const again = await d.bucket.get(KEY(next.host));
    return again ? { status: 200, body: await again.text() } : { status: 503 };
  } catch {
    return { status: 503 };
  }
}

// After a crawl: the full stage for a scoop-built file of that host.
export async function rebuildFull(d: LlmsDeps, host: string): Promise<RegistryRow | null> {
  const row = await getRow(d.db, host);
  if (!row || row.source !== 'scoop') return null;
  const full = await buildFull(d.db, row.docs_root, row.title ?? siteName(null, host), { fetchImpl: d.fetchImpl, allowLocalhost: d.allowLocalhost, now: d.now?.() });
  if (!full || full.pages < 1) return null;
  return storeBuilt(d, row, full);
}

// The hourly cron: rows not checked for a day (6 hours for sites scooped
// 20 times or more). A site's own file is fetched again (gone: scoop.md
// prepares one); a scoop-built one is rebuilt.
export async function refreshDue(d: LlmsDeps, limit = 10): Promise<number> {
  const now = d.now?.() ?? new Date();
  const day = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const six = new Date(now.getTime() - 6 * 3_600_000).toISOString();
  const { results } = await d.db
    .prepare(`SELECT * FROM llms_registry WHERE checked_at < ? OR (scoops >= 20 AND checked_at < ?) ORDER BY scoops DESC, checked_at LIMIT ?`)
    .bind(day, six, limit)
    .all<RegistryRow>();
  for (const row of results) {
    try {
      if (row.source === 'site') {
        const desc = await describeSiteLlms(row.llms_url, d);
        if (desc && desc.pages > 0) {
          await upsertRow(d.db, {
            ...row, title: desc.title, pages: desc.pages, tokens: desc.tokens, content_hash: desc.hash, checked_at: now.toISOString(),
            agent_text: desc.excerpt?.text ?? null, agent_source: desc.excerpt?.source ?? null, agent_method: desc.excerpt?.method ?? null,
            changed_at: desc.hash === row.content_hash ? row.changed_at : now.toISOString(),
          }, now);
        } else {
          const scoop: RegistryRow = { ...row, source: 'scoop', status: 'preparing', llms_url: scoopUrl(d.publicBase ?? PUBLIC_BASE, row.host), checked_at: now.toISOString() };
          await upsertRow(d.db, scoop, now);
          await buildScoop(d, scoop);
        }
      } else {
        const full = row.stage === 'full' ? await rebuildFull(d, row.host) : null;
        if (!full) await buildScoop({ ...d, startCrawl: undefined }, row);
      }
    } catch (e) {
      console.error(JSON.stringify({ llms: 'refresh', host: row.host, error: (e as Error).message }));
    }
  }
  return results.length;
}
