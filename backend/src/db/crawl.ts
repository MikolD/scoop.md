// D1 + R2 store for the crawl pipeline (migrations/0002_crawl.sql): site
// profiles, crawl runs and pages. Page Markdown is content-addressed in R2 at
// pages/<sha256>.md, so identical content is stored once and unchanged pages
// write nothing.

import { classify, contentHash, pageKey } from '../crawl/changes.ts';
import type { Change, PrevPage } from '../crawl/changes.ts';
import type { FetchedSource } from '../crawl/site.ts';

export interface SiteProfileRow {
  site: string;
  status: string;
  docs_root: string;
  has_llms: number;
  has_llms_full: number;
  llms_url: string | null;
  llms_full_url: string | null;
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
}

export interface CrawlRunRow {
  id: string;
  site: string;
  start_url: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  path: string | null;
  pages_new: number;
  pages_changed: number;
  pages_unchanged: number;
  pages_failed: number;
  browser_seconds: number;
  cost_usd: number;
  error: string | null;
}

// What the index-pages queue receives for each new or changed page.
export interface IndexMessage {
  site: string;
  url: string;
  contentHash: string;
  change: Exclude<Change, 'unchanged'>;
  runId: string;
}

export interface RecordStats {
  new: number;
  changed: number;
  unchanged: number;
  toIndex: IndexMessage[];
}

// D1 allows 100 bound parameters per statement.
const IN_CHUNK = 90;

export class CrawlStore {
  db: D1Database;
  bucket: R2Bucket;

  constructor(db: D1Database, bucket: R2Bucket) {
    this.db = db;
    this.bucket = bucket;
  }

  async createRun(id: string, site: string, startUrl: string, now = new Date()): Promise<void> {
    await this.db
      .prepare(`INSERT INTO crawl_runs (id, site, start_url, started_at, status) VALUES (?, ?, ?, ?, 'queued')`)
      .bind(id, site, startUrl, now.toISOString())
      .run();
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
  async addRunCounts(id: string, c: { new: number; changed: number; unchanged: number; failed: number }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE crawl_runs SET pages_new = pages_new + ?, pages_changed = pages_changed + ?,
           pages_unchanged = pages_unchanged + ?, pages_failed = pages_failed + ? WHERE id = ?`,
      )
      .bind(c.new, c.changed, c.unchanged, c.failed, id)
      .run();
  }

  async getProfile(site: string): Promise<SiteProfileRow | null> {
    return this.db.prepare('SELECT * FROM site_profiles WHERE site = ?').bind(site).first<SiteProfileRow>();
  }

  async putProfile(p: Omit<SiteProfileRow, 'pages_fetched'>): Promise<void> {
    const cols = Object.keys(p) as (keyof typeof p)[];
    await this.db
      .prepare(
        `INSERT INTO site_profiles (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
         ON CONFLICT (site) DO UPDATE SET ${cols.filter((c) => c !== 'site').map((c) => `${c} = excluded.${c}`).join(', ')}`,
      )
      .bind(...cols.map((c) => p[c]))
      .run();
  }

  async setProfileStatus(site: string, status: string, now = new Date()): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO site_profiles (site, status, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (site) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
      )
      .bind(site, status, now.toISOString())
      .run();
  }

  // Recounts pages_fetched from the pages table.
  async refreshPageCount(site: string): Promise<void> {
    await this.db
      .prepare('UPDATE site_profiles SET pages_fetched = (SELECT COUNT(*) FROM pages WHERE site = ?1) WHERE site = ?1')
      .bind(site)
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
  // per hash) and is returned for indexing; unchanged pages only get their
  // fetched_at (and validators) refreshed.
  async record(runId: string, site: string, pages: FetchedSource[], now = new Date()): Promise<RecordStats> {
    const prev = await this.prevPages(pages.map((p) => p.url));
    const stats: RecordStats = { new: 0, changed: 0, unchanged: 0, toIndex: [] };
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
            `INSERT INTO pages (url, site, source_url, source_kind, title, content_hash, bytes, etag, last_modified, fetched_at, changed_at, run_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)
             ON CONFLICT (url) DO UPDATE SET site = excluded.site, source_url = excluded.source_url, source_kind = excluded.source_kind,
               title = excluded.title, content_hash = excluded.content_hash, bytes = excluded.bytes, etag = excluded.etag,
               last_modified = excluded.last_modified, fetched_at = excluded.fetched_at, changed_at = excluded.changed_at, run_id = excluded.run_id`,
          )
          .bind(p.url, site, p.sourceUrl, p.kind, p.title, hash, new TextEncoder().encode(markdown).byteLength, p.etag, p.lastModified, at, runId),
      );
      stats.toIndex.push({ site, url: p.url, contentHash: hash!, change, runId });
    }
    if (writes.length) await this.db.batch(writes);
    return stats;
  }

  async pagesForSite(site: string, limit = 20): Promise<{ url: string; source_kind: string; content_hash: string; bytes: number }[]> {
    const { results } = await this.db
      .prepare('SELECT url, source_kind, content_hash, bytes FROM pages WHERE site = ? ORDER BY url LIMIT ?')
      .bind(site, limit)
      .all<{ url: string; source_kind: string; content_hash: string; bytes: number }>();
    return results;
  }
}
