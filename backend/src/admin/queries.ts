// D1 reads behind the admin console's JSON endpoints (api.ts). Read-only
// except where noted; every query is bounded by a LIMIT.

import { STALE_RUN_HOURS } from '../db/crawl.ts';
import type { CrawlRunRow, SiteProfileRow } from '../db/crawl.ts';
import { FAILED } from '../index/classify.ts';
import { ALL_SITES, UNCLASSIFIED } from '../index/indexer.ts';

export const today = (now: Date) => now.toISOString().slice(0, 10);
const daysAgo = (now: Date, n: number) => new Date(now.getTime() - n * 86_400_000).toISOString().slice(0, 10);
const num = (v: unknown) => Number(v ?? 0);

export interface Caps {
  dailyCapUsd: number;
  totalCapUsd: number;
}

export async function overview(db: D1Database, caps: Caps, now = new Date()) {
  const day = today(now);
  const stale = new Date(now.getTime() - STALE_RUN_HOURS * 3_600_000).toISOString();
  const [statuses, crawling, counts, models, runs, spend, crawlCost, batches] = await db.batch([
    db.prepare('SELECT status, COUNT(*) AS n FROM site_profiles GROUP BY status ORDER BY n DESC'),
    db.prepare(`SELECT COUNT(*) AS n FROM site_profiles WHERE crawl_state = 'crawling' AND updated_at > ?`).bind(stale),
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM site_profiles) AS sites,
              (SELECT COUNT(*) FROM pages) AS pages,
              (SELECT COUNT(*) FROM page_index) AS indexed,
              (SELECT COUNT(*) FROM pages WHERE index_pending = 1) AS index_pending,
              (SELECT COUNT(*) FROM pages p WHERE NOT EXISTS (SELECT 1 FROM page_index pi WHERE pi.url = p.url AND pi.content_hash = p.content_hash)) AS awaiting_index,
              (SELECT COUNT(*) FROM chunks) AS chunks,
              (SELECT COUNT(*) FROM skills WHERE removed_at IS NULL) AS skills,
              (SELECT COUNT(*) FROM reports WHERE resolved_at IS NULL) AS open_reports`,
    ),
    db.prepare('SELECT model, COUNT(*) AS n FROM page_index WHERE model IN (?, ?) GROUP BY model').bind(UNCLASSIFIED, FAILED),
    db.prepare(`SELECT status, COUNT(*) AS n FROM crawl_runs WHERE status IN ('queued', 'running') OR started_at >= ? GROUP BY status`).bind(day),
    db.prepare('SELECT site, cost_usd FROM index_costs WHERE day = ? ORDER BY cost_usd DESC LIMIT 50').bind(day),
    db.prepare(
      `SELECT COALESCE(SUM(browser_seconds), 0) AS seconds, COALESCE(SUM(cost_usd), 0) AS e2b, COALESCE(SUM(gate_cost_usd), 0) AS gate
       FROM crawl_runs WHERE started_at >= ?`,
    ).bind(day),
    db.prepare(`SELECT COUNT(*) AS n FROM crawl_batches WHERE status = 'running'`),
  ]);
  const c = counts.results[0] as Record<string, number>;
  const byModel = Object.fromEntries((models.results as { model: string; n: number }[]).map((r) => [r.model, r.n]));
  const spendRows = spend.results as { site: string; cost_usd: number }[];
  const cc = crawlCost.results[0] as { seconds: number; e2b: number; gate: number };
  return {
    day,
    sites: {
      total: num(c.sites),
      byStatus: Object.fromEntries((statuses.results as { status: string; n: number }[]).map((r) => [r.status, r.n])),
      crawling: num((crawling.results[0] as { n: number }).n),
    },
    pages: num(c.pages),
    indexed: num(c.indexed),
    chunks: num(c.chunks),
    skills: num(c.skills),
    openReports: num(c.open_reports),
    backlog: {
      indexPending: num(c.index_pending),
      awaitingIndex: num(c.awaiting_index),
      unclassified: num(byModel[UNCLASSIFIED]),
      classifyFailed: num(byModel[FAILED]),
    },
    runs: Object.fromEntries((runs.results as { status: string; n: number }[]).map((r) => [r.status, r.n])),
    batchesRunning: num((batches.results[0] as { n: number }).n),
    aiSpend: {
      totalUsd: spendRows.find((r) => r.site === ALL_SITES)?.cost_usd ?? 0,
      totalCapUsd: caps.totalCapUsd,
      siteCapUsd: caps.dailyCapUsd,
      bySite: spendRows.filter((r) => r.site !== ALL_SITES).map((r) => ({ site: r.site, costUsd: r.cost_usd })),
    },
    e2b: { seconds: num(cc.seconds), costUsd: num(cc.e2b) },
    gateCostUsd: num(cc.gate),
  };
}

export async function listRuns(db: D1Database, f: { status?: string; site?: string; limit: number; offset: number }) {
  const where: string[] = [];
  const params: string[] = [];
  if (f.status) {
    // 'active' is queued or running.
    if (f.status === 'active') where.push(`status IN ('queued', 'running')`);
    else (where.push('status = ?'), params.push(f.status));
  }
  if (f.site) (where.push('site = ?'), params.push(f.site));
  const { results } = await db
    .prepare(`SELECT * FROM crawl_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...params, f.limit + 1, f.offset)
    .all<CrawlRunRow>();
  return { rows: results.slice(0, f.limit), more: results.length > f.limit };
}

export interface SiteListRow extends SiteProfileRow {
  pages: number;
  indexed: number;
  last_run_status: string | null;
  last_run_started_at: string | null;
}

export async function listSites(db: D1Database, f: { status?: string; q?: string; limit: number; offset: number }) {
  const where: string[] = [];
  const params: string[] = [];
  if (f.status === 'crawling') where.push(`sp.crawl_state = 'crawling'`);
  else if (f.status) (where.push('sp.status = ?'), params.push(f.status));
  if (f.q) (where.push(`sp.site LIKE ? ESCAPE '\\'`), params.push(`%${f.q.replace(/[\\%_]/g, '\\$&')}%`));
  const { results } = await db
    .prepare(
      `SELECT sp.*,
         (SELECT COUNT(*) FROM pages p WHERE p.site = sp.site) AS pages,
         (SELECT COUNT(*) FROM page_index pi WHERE pi.site = sp.site) AS indexed,
         r.status AS last_run_status, r.started_at AS last_run_started_at
       FROM site_profiles sp LEFT JOIN crawl_runs r ON r.id = sp.last_run_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY sp.updated_at DESC, sp.site LIMIT ? OFFSET ?`,
    )
    .bind(...params, f.limit + 1, f.offset)
    .all<SiteListRow>();
  return { rows: results.slice(0, f.limit), more: results.length > f.limit };
}

export async function siteCounts(db: D1Database, site: string) {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM pages WHERE site = ?1) AS pages,
              (SELECT COUNT(*) FROM page_index WHERE site = ?1) AS indexed,
              (SELECT COUNT(*) FROM pages WHERE site = ?1 AND index_pending = 1) AS index_pending,
              (SELECT COUNT(*) FROM chunks WHERE site = ?1) AS chunks,
              (SELECT COUNT(*) FROM skills WHERE site = ?1 AND removed_at IS NULL) AS skills,
              (SELECT COALESCE(SUM(cost_usd), 0) FROM page_index WHERE site = ?1) AS classify_usd`,
    )
    .bind(site)
    .first<Record<string, number>>();
  return {
    pages: num(row?.pages),
    indexed: num(row?.indexed),
    indexPending: num(row?.index_pending),
    chunks: num(row?.chunks),
    skills: num(row?.skills),
    classifyUsd: num(row?.classify_usd),
  };
}

export interface SitePageRow {
  url: string;
  title: string | null;
  source_kind: string | null;
  content_hash: string | null;
  bytes: number | null;
  changed_at: string | null;
  index_pending: number | null;
  indexed_hash: string | null;
  slot: string | null;
  topic: string | null;
  summary: string | null;
  model: string | null;
  cost_usd: number | null;
}

// A site's pages: crawled ones and pages indexed by hand (POST /v1/admin/index,
// no pages row), with their labels. `topic` narrows to a topic and everything below it.
export async function sitePages(db: D1Database, site: string, f: { topic?: string; limit: number; offset: number }) {
  const topicWhere = f.topic ? `WHERE pi.topic = ?2 OR (pi.topic >= ?2 || '/' AND pi.topic < ?2 || '0')` : '';
  const { results } = await db
    .prepare(
      `SELECT u.url AS url, COALESCE(p.title, pi.title) AS title, p.source_kind AS source_kind, COALESCE(p.content_hash, pi.content_hash) AS content_hash,
         p.bytes AS bytes, p.changed_at AS changed_at, p.index_pending AS index_pending, pi.content_hash AS indexed_hash,
         pi.slot AS slot, pi.topic AS topic, pi.summary AS summary, pi.model AS model, pi.cost_usd AS cost_usd
       FROM (SELECT url FROM pages WHERE site = ?1 UNION SELECT url FROM page_index WHERE site = ?1) u
       LEFT JOIN pages p ON p.url = u.url LEFT JOIN page_index pi ON pi.url = u.url
       ${topicWhere}
       ORDER BY u.url LIMIT ?3 OFFSET ?4`,
    )
    .bind(site, f.topic ?? '', f.limit + 1, f.offset)
    .all<SitePageRow>();
  return { rows: results.slice(0, f.limit), more: results.length > f.limit };
}

export async function siteRuns(db: D1Database, site: string, limit = 20) {
  const { results } = await db.prepare('SELECT * FROM crawl_runs WHERE site = ? ORDER BY started_at DESC, id DESC LIMIT ?').bind(site, limit).all<CrawlRunRow>();
  return results;
}

export async function pageDetail(db: D1Database, url: string) {
  const [page, index, chunks] = await db.batch([
    db.prepare('SELECT * FROM pages WHERE url = ?').bind(url),
    db.prepare('SELECT * FROM page_index WHERE url = ?').bind(url),
    db.prepare('SELECT id, ord, heading_path, text FROM chunks WHERE url = ? ORDER BY ord LIMIT 500').bind(url),
  ]);
  return {
    page: (page.results[0] ?? null) as Record<string, unknown> | null,
    index: (index.results[0] ?? null) as Record<string, unknown> | null,
    chunks: chunks.results as { id: string; ord: number; heading_path: string; text: string }[],
  };
}

// Sites with shared skills, most recently shared first.
export async function librarySites(db: D1Database, f: { limit: number; offset: number }) {
  const { results } = await db
    .prepare(
      `SELECT site, COUNT(*) AS total, SUM(removed_at IS NULL) AS live, SUM(worked) AS worked, SUM(failed) AS failed, MAX(created_at) AS last_shared_at
       FROM skills GROUP BY site ORDER BY last_shared_at DESC, site LIMIT ? OFFSET ?`,
    )
    .bind(f.limit + 1, f.offset)
    .all<{ site: string; total: number; live: number; worked: number; failed: number; last_shared_at: string }>();
  return { rows: results.slice(0, f.limit), more: results.length > f.limit };
}

export async function removedSkills(db: D1Database, site: string, limit = 20) {
  const { results } = await db
    .prepare('SELECT id, title, page_url, created_at, removed_at FROM skills WHERE site = ? AND removed_at IS NOT NULL ORDER BY removed_at DESC LIMIT ?')
    .bind(site, limit)
    .all<{ id: string; title: string; page_url: string; created_at: string; removed_at: string }>();
  return results;
}

export async function reports(db: D1Database, f: { open: boolean; skillId?: string; limit: number }) {
  const where = [f.open ? 'r.resolved_at IS NULL' : '1'];
  const params: (string | number)[] = [];
  if (f.skillId) (where.push('r.skill_id = ?'), params.push(f.skillId));
  const { results } = await db
    .prepare(
      `SELECT r.id, r.skill_id, r.reason, r.details, r.created_at, r.resolved_at, s.site, s.title, s.removed_at
       FROM reports r LEFT JOIN skills s ON s.id = r.skill_id WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
    )
    .bind(...params, f.limit)
    .all<{ id: string; skill_id: string; reason: string; details: string | null; created_at: string; resolved_at: string | null; site: string | null; title: string | null; removed_at: string | null }>();
  return results.map((r) => ({
    id: r.id,
    skillId: r.skill_id,
    reason: r.reason,
    details: r.details,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    site: r.site,
    title: r.title,
    skillRemoved: Boolean(r.removed_at),
  }));
}

// Spend per day for the last `days` days: classifier and gate AI (index_costs,
// per site and the account total) and crawl sandboxes (crawl_runs).
export async function costs(db: D1Database, days: number, now = new Date()) {
  const since = daysAgo(now, days - 1);
  const [ai, crawls] = await db.batch([
    db.prepare('SELECT day, site, cost_usd FROM index_costs WHERE day >= ? ORDER BY day DESC, cost_usd DESC').bind(since),
    db.prepare(
      `SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS runs, COALESCE(SUM(browser_seconds), 0) AS seconds,
         COALESCE(SUM(cost_usd), 0) AS e2b, COALESCE(SUM(gate_cost_usd), 0) AS gate
       FROM crawl_runs WHERE started_at >= ? GROUP BY day ORDER BY day DESC`,
    ).bind(since),
  ]);
  const byDay = new Map<string, { day: string; aiUsd: number; e2bUsd: number; gateUsd: number; browserSeconds: number; runs: number; sites: { site: string; costUsd: number }[] }>();
  for (let i = 0; i < days; i++) {
    const day = daysAgo(now, i);
    byDay.set(day, { day, aiUsd: 0, e2bUsd: 0, gateUsd: 0, browserSeconds: 0, runs: 0, sites: [] });
  }
  for (const r of ai.results as { day: string; site: string; cost_usd: number }[]) {
    const d = byDay.get(r.day);
    if (!d) continue;
    if (r.site === ALL_SITES) d.aiUsd = r.cost_usd;
    else d.sites.push({ site: r.site, costUsd: r.cost_usd });
  }
  for (const r of crawls.results as { day: string; runs: number; seconds: number; e2b: number; gate: number }[]) {
    const d = byDay.get(r.day);
    if (!d) continue;
    Object.assign(d, { runs: num(r.runs), browserSeconds: num(r.seconds), e2bUsd: num(r.e2b), gateUsd: num(r.gate) });
  }
  return [...byDay.values()];
}
