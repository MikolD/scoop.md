// D1 + R2 store for the crawl pipeline (migrations/0002_crawl.sql): site
// profiles, crawl runs and pages. Page Markdown is content-addressed in the
// skills bucket at pages/<sha256>.md (shared with the M4 indexer), so identical
// content is stored once and unchanged pages write nothing.

import { classify, contentHash, pageKey } from '../crawl/changes.ts';
import type { PrevPage } from '../crawl/changes.ts';
import type { GateVerdict } from '../crawl/gate.ts';
import type { FetchedSource } from '../crawl/site.ts';
import type { IndexMessage } from '../index/indexer.ts';

export interface SiteProfileRow {
  site: string;
  // Outcome of the last finished crawl: new | ready | empty | blocked | failed
  // | not_devtool. Changes only in finishCrawl/failCrawl/recordGate
  // (migrations/0004_crawl_state.sql, 0005_devtool_gate.sql).
  status: string;
  crawl_state: string; // idle | crawling
  source: string; // admin | requested (migrations/0009_requested_sites.sql)
  approved: number; // 0: requested, not yet approved: left out of cross-site search
  docs_root: string;
  has_llms: number;
  has_llms_full: number;
  llms_url: string | null;
  llms_full_url: string | null;
  // llms.txt checked to be a docs index for agents (migrations/0012): 200, text, an H1 and a link.
  has_llms_verified: number;
  has_llms_full_verified: number;
  llms_checked_at: string | null;
  md_twins_ratio: number | null;
  twin_pattern: string | null;
  sitemap_urls_count: number;
  openapi_json: string;
  pages_fetched: number;
  needs_browser: number;
  crawl_delay: number | null;
  last_crawled_at: string | null;
  last_run_id: string | null;
  updated_at: string;
  // The devtool gate's last verdict (migrations/0005_devtool_gate.sql).
  gate_category: string | null;
  gate_confidence: number | null;
  gate_reason: string | null;
  gate_method: string | null;
  gate_checked_at: string | null;
}

export interface CrawlRunRow {
  id: string;
  site: string;
  start_url: string;
  started_at: string;
  finished_at: string | null;
  status: string; // queued | running | complete | failed | rejected
  path: string | null;
  pages_new: number;
  pages_changed: number;
  pages_unchanged: number;
  pages_failed: number;
  pages_skipped: number;
  browser_seconds: number;
  cost_usd: number;
  error: string | null;
  forced: number;
  gate_decision: string | null;
  gate_category: string | null;
  gate_method: string | null;
  gate_reason: string | null;
  gate_cost_usd: number;
  // Indexing this run's pages (migrations/0007_run_costs.sql), recomputed by the indexer.
  classify_cost_usd: number;
  embed_cost_usd: number;
  pages_indexed: number;
  costs_tracked: number; // 0: from before migration 0007, indexing costs unknown
  requested: number; // 1: started by a crawl request (migrations/0009_requested_sites.sql)
  // Indexing outcomes (migrations/0010_index_outcomes.sql): pages skipped or
  // failed for good, and when any page last reached an outcome.
  pages_index_failed: number;
  index_progress_at: string | null;
  // Jev tokens (migrations/0011_jev_tokens.sql): page classification and the gate.
  jev_tokens: number;
  gate_jev_tokens: number;
  // Where the Workflow is (migrations/0008_crawl_requests.sql): gate | discover | fetch | browser | done.
  phase: string | null;
}

// A run's spend, broken down. Per page is over the pages it stored (new +
// changed); the total is final once every one of them is indexed.
type LlmsCheck = 'has_llms_verified' | 'has_llms_full_verified' | 'llms_checked_at';

export function runCosts(r: CrawlRunRow) {
  const pagesStored = r.pages_new + r.pages_changed;
  const totalUsd = r.cost_usd + r.gate_cost_usd + r.classify_cost_usd + r.embed_cost_usd;
  return {
    browserUsd: r.cost_usd,
    gateUsd: r.gate_cost_usd,
    classifyUsd: r.classify_cost_usd,
    embedUsd: r.embed_cost_usd,
    // Jev's tokens (gate and classification); their USD, at JEV_USD_PER_MTOK, is in gateUsd and classifyUsd.
    jevTokens: (r.jev_tokens ?? 0) + (r.gate_jev_tokens ?? 0),
    totalUsd,
    pagesStored,
    pagesIndexed: r.pages_indexed,
    perPageUsd: pagesStored ? totalUsd / pagesStored : null,
    indexingDone: Boolean(r.costs_tracked) && r.pages_indexed >= pagesStored,
    tracked: Boolean(r.costs_tracked),
  };
}

export interface RecordStats {
  new: number;
  changed: number;
  unchanged: number;
}

// A run older than this that never finished (its Workflow died or was
// terminated) no longer blocks a new crawl of the same site, and a profile
// whose crawl_state hasn't moved for this long is not shown as crawling.
export const STALE_RUN_HOURS = 6;
// sendBatch takes at most 100 messages.
const OUTBOX_BATCH = 100;

// D1 allows 100 bound parameters per statement.
const IN_CHUNK = 90;

export class CrawlStore {
  db: D1Database;
  bucket: R2Bucket;

  constructor(db: D1Database, bucket: R2Bucket) {
    this.db = db;
    this.bucket = bucket;
  }

  // Creates a queued run unless the site already has a queued or running one
  // (started in the last STALE_RUN_HOURS). One statement, so two concurrent
  // requests can't both win. Returns false when another run is active.
  // Runs still queued/running past STALE_RUN_HOURS (a terminated Workflow
  // never ran its fail step) are marked failed in the same batch, so they stop
  // showing as active.
  // `forced`: an admin skipped the devtool gate.
  async createRun(id: string, site: string, startUrl: string, now = new Date(), forced = false, requested = false): Promise<boolean> {
    const since = new Date(now.getTime() - STALE_RUN_HOURS * 3_600_000).toISOString();
    const [, inserted] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE crawl_runs SET status = 'failed', finished_at = ?3, error = 'abandoned: still unfinished after ${STALE_RUN_HOURS} hours'
           WHERE site = ?1 AND status IN ('queued', 'running') AND started_at <= ?2`,
        )
        .bind(site, since, now.toISOString()),
      this.db
        .prepare(
          `INSERT INTO crawl_runs (id, site, start_url, started_at, status, forced, requested)
           SELECT ?1, ?2, ?3, ?4, 'queued', ?5, ?6
           WHERE NOT EXISTS (SELECT 1 FROM crawl_runs WHERE site = ?2 AND status IN ('queued', 'running'))
           RETURNING id`,
        )
        .bind(id, site, startUrl, now.toISOString(), forced ? 1 : 0, requested ? 1 : 0),
    ]);
    return (inserted.results as unknown[]).length === 1;
  }

  // The E2B daily cap: reserves a browser crawl's worst case (`usd`, the
  // sandbox's full timeout) as the run's cost_usd, only if today's sandbox
  // spend (runs started this UTC day, reservations included) stays within
  // `capUsd`. One statement, so two runs can't both squeeze under the cap.
  // The real cost replaces the reservation when the sandbox stops.
  // `requestedCapUsd`: for a requested run, the on-demand share of the cap,
  // checked against today's requested runs only (both limits must hold).
  async reserveBrowser(id: string, usd: number, capUsd: number, now = new Date(), requestedCapUsd?: number): Promise<{ ok: boolean; spentUsd: number }> {
    const day = now.toISOString().slice(0, 10);
    const reserved = await this.db
      .prepare(
        `UPDATE crawl_runs SET cost_usd = ?2
         WHERE id = ?1 AND (SELECT COALESCE(SUM(cost_usd), 0) FROM crawl_runs WHERE started_at >= ?3 AND id != ?1) + ?2 <= ?4
           AND (?5 IS NULL OR (SELECT COALESCE(SUM(cost_usd), 0) FROM crawl_runs WHERE started_at >= ?3 AND requested = 1 AND id != ?1) + ?2 <= ?5)
         RETURNING id`,
      )
      .bind(id, usd, day, capUsd, requestedCapUsd ?? null)
      .first<{ id: string }>();
    const spent = await this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM crawl_runs WHERE started_at >= ?').bind(day).first<{ s: number }>();
    return { ok: reserved !== null, spentUsd: spent?.s ?? 0 };
  }

  async getRun(id: string): Promise<CrawlRunRow | null> {
    return this.db.prepare('SELECT * FROM crawl_runs WHERE id = ?').bind(id).first<CrawlRunRow>();
  }

  async updateRun(id: string, fields: Partial<Omit<CrawlRunRow, 'id' | 'site' | 'start_url' | 'started_at'>>): Promise<void> {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    await this.db
      .prepare(`UPDATE crawl_runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .bind(...keys.map((k) => fields[k] ?? null), id)
      .run();
  }

  // Adds page counts to a run (each Workflow step reports its own batch).
  async addRunCounts(id: string, c: { new: number; changed: number; unchanged: number; failed: number; skipped: number }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE crawl_runs SET pages_new = pages_new + ?, pages_changed = pages_changed + ?,
           pages_unchanged = pages_unchanged + ?, pages_failed = pages_failed + ?, pages_skipped = pages_skipped + ? WHERE id = ?`,
      )
      .bind(c.new, c.changed, c.unchanged, c.failed, c.skipped, id)
      .run();
  }

  async getProfile(site: string): Promise<SiteProfileRow | null> {
    return this.db.prepare('SELECT * FROM site_profiles WHERE site = ?').bind(site).first<SiteProfileRow>();
  }

  // A crawl of `site` started: the public status (the last finished crawl's
  // outcome) stays as it is. A site seen for the first time is 'new'.
  // `requested`: the crawl was asked for by a user (crawl requests). A site
  // seen for the first time then gets source 'requested' and is approved only
  // when `approved` (on the gate's allowlist); an existing profile keeps its
  // source and approval.
  async beginCrawl(site: string, now = new Date(), requested?: { approved: boolean }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO site_profiles (site, status, crawl_state, updated_at, source, approved) VALUES (?1, 'new', 'crawling', ?2, ?3, ?4)
         ON CONFLICT (site) DO UPDATE SET crawl_state = 'crawling', updated_at = excluded.updated_at`,
      )
      .bind(site, now.toISOString(), requested ? 'requested' : 'admin', requested && !requested.approved ? 0 : 1)
      .run();
  }

  // Admin decision on a requested site: approve (include it in cross-site
  // search) or reject (not_devtool, and its index purged by the caller).
  async approveSite(site: string, now = new Date()): Promise<boolean> {
    const r = await this.db.prepare(`UPDATE site_profiles SET approved = 1, updated_at = ?2 WHERE site = ?1`).bind(site, now.toISOString()).run();
    return r.meta.changes === 1;
  }

  async rejectSite(site: string, now = new Date()): Promise<boolean> {
    const at = now.toISOString();
    const r = await this.db
      .prepare(
        `UPDATE site_profiles SET status = 'not_devtool', approved = 0, crawl_state = 'idle', updated_at = ?2,
           gate_method = 'admin', gate_category = 'other', gate_reason = 'rejected by an admin', gate_confidence = 1, gate_checked_at = ?2
         WHERE site = ?1`,
      )
      .bind(site, at)
      .run();
    return r.meta.changes === 1;
  }

  // Discovery facts. Never touches status, crawl_state or last_crawled_at,
  // which describe the last finished crawl.
  async putProfile(
    p: Omit<SiteProfileRow, 'pages_fetched' | 'status' | 'crawl_state' | 'last_crawled_at' | `gate_${string}` | 'source' | 'approved' | LlmsCheck>
      & Partial<Pick<SiteProfileRow, LlmsCheck>>,
  ): Promise<void> {
    const cols = Object.keys(p) as (keyof typeof p)[];
    await this.db
      .prepare(
        `INSERT INTO site_profiles (${cols.join(', ')}, status) VALUES (${cols.map(() => '?').join(', ')}, 'new')
         ON CONFLICT (site) DO UPDATE SET ${cols.filter((c) => c !== 'site').map((c) => `${c} = excluded.${c}`).join(', ')}`,
      )
      .bind(...cols.map((c) => p[c]))
      .run();
  }

  async finishCrawl(site: string, status: 'ready' | 'empty' | 'blocked', now = new Date()): Promise<void> {
    await this.db
      .prepare(
        `UPDATE site_profiles SET status = ?2, crawl_state = 'idle', updated_at = ?3, last_crawled_at = ?3,
           pages_fetched = (SELECT COUNT(*) FROM pages WHERE site = ?1) WHERE site = ?1`,
      )
      .bind(site, status, now.toISOString())
      .run();
  }

  // The devtool gate's verdict, on the run and the site. A rejection ends the
  // run ('rejected', the reason in `error`) and the crawl: the site becomes
  // 'not_devtool', whatever it was before. One D1 batch, safe to repeat.
  async recordGate(runId: string, site: string, v: GateVerdict, now = new Date()): Promise<void> {
    const at = now.toISOString();
    const reject = v.decision === 'reject';
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE crawl_runs SET gate_decision = ?2, gate_category = ?3, gate_method = ?4, gate_reason = ?5, gate_cost_usd = ?6, gate_jev_tokens = ?9,
             status = CASE WHEN ?7 THEN 'rejected' ELSE status END,
             phase = CASE WHEN ?7 THEN 'done' ELSE 'discover' END,
             finished_at = CASE WHEN ?7 THEN ?8 ELSE finished_at END,
             error = CASE WHEN ?7 THEN ?5 ELSE error END
           WHERE id = ?1`,
        )
        .bind(runId, v.decision, v.category, v.method, v.reason, v.costUsd, reject ? 1 : 0, at, v.jevTokens ?? 0),
      this.db
        .prepare(
          `UPDATE site_profiles SET gate_category = ?2, gate_confidence = ?3, gate_reason = ?4, gate_method = ?5, gate_checked_at = ?6,
             last_run_id = ?7, updated_at = ?6,
             status = CASE WHEN ?8 THEN 'not_devtool' ELSE status END,
             crawl_state = CASE WHEN ?8 THEN 'idle' ELSE crawl_state END,
             last_crawled_at = CASE WHEN ?8 THEN ?6 ELSE last_crawled_at END
           WHERE site = ?1`,
        )
        .bind(site, v.category, v.confidence, v.reason, v.method, at, runId, reject ? 1 : 0),
    ]);
  }

  // An admin skipped the gate: the profile's verdict says so instead of
  // keeping an earlier one. Safe to repeat.
  async forceGate(runId: string, site: string, now = new Date()): Promise<void> {
    await this.db
      .prepare(
        `UPDATE site_profiles SET gate_category = NULL, gate_confidence = NULL, gate_reason = 'crawl forced by an admin (' || ?2 || ')',
           gate_method = 'forced', gate_checked_at = ?3, updated_at = ?3 WHERE site = ?1`,
      )
      .bind(site, runId, now.toISOString())
      .run();
  }

  // A crawl that ended without an outcome (the gate could not decide): the
  // status, the last finished crawl's outcome, stays as it was.
  async endCrawl(site: string, now = new Date()): Promise<void> {
    await this.db.prepare(`UPDATE site_profiles SET crawl_state = 'idle', updated_at = ?2 WHERE site = ?1`).bind(site, now.toISOString()).run();
  }

  // A failed crawl: a site that was 'ready' and still has pages stays 'ready'
  // (its stored pages are still good); anything else becomes 'failed'.
  async failCrawl(site: string, now = new Date()): Promise<void> {
    await this.db
      .prepare(
        `UPDATE site_profiles SET
           status = CASE WHEN status = 'ready' AND EXISTS (SELECT 1 FROM pages WHERE site = ?1) THEN 'ready' ELSE 'failed' END,
           crawl_state = 'idle', updated_at = ?2,
           pages_fetched = (SELECT COUNT(*) FROM pages WHERE site = ?1)
         WHERE site = ?1`,
      )
      .bind(site, now.toISOString())
      .run();
  }

  async prevPages(urls: string[]): Promise<Map<string, PrevPage>> {
    const out = new Map<string, PrevPage>();
    for (let i = 0; i < urls.length; i += IN_CHUNK) {
      const chunk = urls.slice(i, i + IN_CHUNK);
      const { results } = await this.db
        .prepare(`SELECT url, content_hash, etag, last_modified FROM pages WHERE url IN (${chunk.map(() => '?').join(', ')})`)
        .bind(...chunk)
        .all<PrevPage & { url: string }>();
      for (const r of results) out.set(r.url, { content_hash: r.content_hash, etag: r.etag, last_modified: r.last_modified });
    }
    return out;
  }

  // Records a batch of fetched pages: new or changed content goes to R2 (once
  // per hash) and is marked index_pending in the same D1 batch as the row, so
  // a lost queue send is retried by the next flush; unchanged pages only get
  // their fetched_at (and validators) refreshed.
  async record(runId: string, site: string, pages: FetchedSource[], now = new Date()): Promise<RecordStats> {
    const prev = await this.prevPages(pages.map((p) => p.url));
    const stats: RecordStats = { new: 0, changed: 0, unchanged: 0 };
    const at = now.toISOString();
    const writes: D1PreparedStatement[] = [];
    for (const p of pages) {
      const before = prev.get(p.url) ?? null;
      const hash = p.markdown === null ? null : await contentHash(p.markdown);
      const change = classify(before, hash);
      stats[change]++;
      if (change === 'unchanged') {
        writes.push(
          this.db
            .prepare(
              `UPDATE pages SET fetched_at = ?, run_id = ?, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified) WHERE url = ?`,
            )
            .bind(at, runId, p.etag, p.lastModified, p.url),
        );
        continue;
      }
      const markdown = p.markdown!;
      if (!(await this.bucket.head(pageKey(hash!)))) {
        await this.bucket.put(pageKey(hash!), markdown, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
      }
      writes.push(
        this.db
          .prepare(
            `INSERT INTO pages (url, site, source_url, source_kind, title, content_hash, bytes, etag, last_modified, fetched_at, changed_at, run_id, index_pending)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, 1)
             ON CONFLICT (url) DO UPDATE SET site = excluded.site, source_url = excluded.source_url, source_kind = excluded.source_kind,
               title = excluded.title, content_hash = excluded.content_hash, bytes = excluded.bytes, etag = excluded.etag,
               last_modified = excluded.last_modified, fetched_at = excluded.fetched_at, changed_at = excluded.changed_at, run_id = excluded.run_id,
               index_pending = 1`,
          )
          .bind(p.url, site, p.sourceUrl, p.kind, p.title, hash, new TextEncoder().encode(markdown).byteLength, p.etag, p.lastModified, at, runId),
      );
    }
    if (writes.length) await this.db.batch(writes);
    return stats;
  }

  // Sends the site's pending index messages ({ site, url, contentHash, runId }) in
  // batches of 100 and clears each flag only if the page's hash is still the
  // one sent. Safe to repeat: a resend after a failure is harmless, since the
  // consumer is idempotent on (url, contentHash). Returns how many were sent.
  async flushIndex(site: string, send: (batch: IndexMessage[]) => Promise<void>, maxBatches = 50): Promise<number> {
    let sent = 0;
    for (let i = 0; i < maxBatches; i++) {
      const { results } = await this.db
        .prepare('SELECT url, content_hash, run_id FROM pages WHERE site = ? AND index_pending = 1 ORDER BY url LIMIT ?')
        .bind(site, OUTBOX_BATCH)
        .all<{ url: string; content_hash: string; run_id: string }>();
      if (!results.length) break;
      // run_id is the run that stored this content: it pays for indexing it.
      await send(results.map((r) => ({ site, url: r.url, contentHash: r.content_hash, runId: r.run_id })));
      await this.db.batch(
        results.map((r) => this.db.prepare('UPDATE pages SET index_pending = 0 WHERE url = ? AND content_hash = ?').bind(r.url, r.content_hash)),
      );
      sent += results.length;
    }
    return sent;
  }

  async pendingIndex(site: string): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(*) AS n FROM pages WHERE site = ? AND index_pending = 1').bind(site).first<{ n: number }>();
    return row?.n ?? 0;
  }

  // A sample of the pages a run fetched, for the admin status view.
  async pagesForRun(runId: string, limit = 10) {
    const { results } = await this.db
      .prepare('SELECT url, source_kind, title, content_hash, bytes, changed_at FROM pages WHERE run_id = ? ORDER BY url LIMIT ?')
      .bind(runId, limit)
      .all<{ url: string; source_kind: string; title: string | null; content_hash: string; bytes: number; changed_at: string }>();
    return results.map((r) => ({ url: r.url, kind: r.source_kind, title: r.title, contentHash: r.content_hash, bytes: r.bytes, changedAt: r.changed_at }));
  }
}
