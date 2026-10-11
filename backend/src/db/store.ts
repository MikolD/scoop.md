// D1 + R2 store for the v1 API (docs/BACKEND.md §9). Metadata, votes and
// reports in D1; `{ sections, relatedLinks }` in R2 at skills/<id>.json.
// Semantics match server/store.js: ranking, dedupe, vote replacement, takedown.

import { fingerprint, newId } from '../lib/ids.ts';
import { QUALIFIES_SQL, RANK_ORDER_SQL } from '../lib/ranking.ts';
import type { NewSkill, RelatedLink, Section, Skill, SkillMeta, SkillSummary, Source } from '../lib/types.ts';
import type { NewReport } from '../lib/validate.ts';

export interface SkillRow {
  id: string;
  site: string;
  page_url: string;
  title: string;
  sources_json: string;
  size_bytes: number;
  worked: number;
  failed: number;
  last_worked_at: string | null;
  created_at: string;
  removed_at: string | null;
}

interface ReportRow {
  id: string;
  skill_id: string;
  install_id: string;
  reason: string;
  details: string | null;
  created_at: string;
  resolved_at: string | null;
}

const COLUMNS = 'id, site, page_url, title, sources_json, size_bytes, worked, failed, last_worked_at, created_at, removed_at';
const objectKey = (id: string) => `skills/${id}.json`;

function meta(r: SkillRow): SkillMeta {
  return {
    id: r.id,
    site: r.site,
    pageUrl: r.page_url,
    title: r.title,
    worked: r.worked,
    failed: r.failed,
    createdAt: r.created_at,
    lastWorkedAt: r.last_worked_at,
    status: 'verified',
  };
}

export function summary(r: SkillRow): SkillSummary {
  return { ...meta(r), sources: JSON.parse(r.sources_json) as Source[], sizeBytes: r.size_bytes };
}

export class Store {
  db: D1Database;
  bucket: R2Bucket;

  constructor(db: D1Database, bucket: R2Bucket) {
    this.db = db;
    this.bucket = bucket;
  }

  async getRow(id: string): Promise<SkillRow | null> {
    return this.db.prepare(`SELECT ${COLUMNS} FROM skills WHERE id = ?`).bind(id).first<SkillRow>();
  }

  // Full skill with content from R2, or null if the object is gone (a takedown
  // that landed after `row` was read). Callers check removed_at first.
  async load(row: SkillRow): Promise<Skill | null> {
    const obj = await this.bucket.get(objectKey(row.id));
    if (!obj) return null;
    const { sections, relatedLinks } = await obj.json<{ sections: Section[]; relatedLinks: RelatedLink[] }>();
    return { ...meta(row), sections, relatedLinks };
  }

  async bestRow(site: string): Promise<SkillRow | null> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM skills WHERE site = ? AND ${QUALIFIES_SQL} ORDER BY ${RANK_ORDER_SQL} LIMIT 1`)
      .bind(site)
      .first<SkillRow>();
  }

  // Sites that have a best skill, most recently confirmed first. Fetches one
  // extra row to know whether there is a next page.
  async sites(limit: number, offset: number): Promise<{ rows: SkillRow[]; more: boolean }> {
    const { results } = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY site ORDER BY ${RANK_ORDER_SQL}) AS rn
           FROM skills WHERE ${QUALIFIES_SQL}
         ) WHERE rn = 1 ORDER BY ${RANK_ORDER_SQL}, site LIMIT ? OFFSET ?`,
      )
      .bind(limit + 1, offset)
      .all<SkillRow>();
    return { rows: results.slice(0, limit), more: results.length > limit };
  }

  async recent(site: string, limit = 20): Promise<SkillRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${COLUMNS} FROM skills WHERE site = ? AND removed_at IS NULL ORDER BY created_at DESC LIMIT ?`)
      .bind(site, limit)
      .all<SkillRow>();
    return results;
  }

  async hasSite(site: string): Promise<boolean> {
    return (await this.db.prepare('SELECT 1 FROM skills WHERE site = ? LIMIT 1').bind(site).first()) !== null;
  }

  private async findDuplicate(site: string, fp: string): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT id FROM skills WHERE site = ? AND fingerprint = ? AND removed_at IS NULL')
      .bind(site, fp)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  // Stores a verified skill, or returns the existing one with the same site and
  // fingerprint. R2 is written first so a D1 row never points at missing content;
  // the partial unique index settles races between concurrent identical shares.
  async add(skill: NewSkill, installId: string, now = new Date()): Promise<{ id: string; duplicate: boolean }> {
    const fp = await fingerprint(skill.sections);
    const existing = await this.findDuplicate(skill.site, fp);
    if (existing) return { id: existing, duplicate: true };

    const id = newId('sk', now.getTime());
    const sources: Source[] = skill.sections.map(({ kind, label, url }) => ({ kind, label, url }));
    const sizeBytes = skill.sections.reduce((n, s) => n + (s.content?.length ?? 0), 0);
    await this.bucket.put(objectKey(id), JSON.stringify({ sections: skill.sections, relatedLinks: skill.relatedLinks }), {
      httpMetadata: { contentType: 'application/json' },
    });
    const insert = this.db
      .prepare(
        `INSERT OR IGNORE INTO skills (id, site, page_url, title, fingerprint, sources_json, size_bytes, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, skill.site, skill.pageUrl, skill.title, fp, JSON.stringify(sources), sizeBytes, now.toISOString(), installId);
    let changes: number;
    try {
      changes = (await insert.run()).meta.changes;
    } catch (e) {
      // The insert may have committed even though the call failed. An orphaned
      // R2 object is harmless; a row without its object is not, so delete only
      // when the row certainly doesn't exist.
      const row = await this.getRow(id).catch(() => undefined);
      if (row === null) await this.bucket.delete(objectKey(id)).catch(() => {});
      throw e;
    }
    if (changes === 0) {
      // Ignored by the unique index: a concurrent identical share won, and `id` has no row.
      await this.bucket.delete(objectKey(id));
      const dup = await this.findDuplicate(skill.site, fp);
      if (dup) return { id: dup, duplicate: true };
      throw new Error('skill insert ignored without a duplicate');
    }
    return { id, duplicate: false };
  }

  // One vote per (skill, install); a new vote replaces the old one. The counters
  // are recomputed from `votes` in the same batch (one transaction).
  async vote(skillId: string, installId: string, worked: boolean, now = new Date()): Promise<{ worked: number; failed: number }> {
    const [, updated] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO votes (skill_id, install_id, worked, voted_at) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (skill_id, install_id) DO UPDATE SET worked = excluded.worked, voted_at = excluded.voted_at`,
        )
        .bind(skillId, installId, worked ? 1 : 0, now.toISOString()),
      this.db
        .prepare(
          `UPDATE skills SET
             worked = (SELECT COUNT(*) FROM votes WHERE skill_id = ?1 AND worked = 1),
             failed = (SELECT COUNT(*) FROM votes WHERE skill_id = ?1 AND worked = 0),
             last_worked_at = (SELECT MAX(voted_at) FROM votes WHERE skill_id = ?1 AND worked = 1)
           WHERE id = ?1 RETURNING worked, failed`,
        )
        .bind(skillId),
    ]);
    const row = (updated.results as { worked: number; failed: number }[])[0];
    return { worked: row.worked, failed: row.failed };
  }

  async report(r: NewReport, installId: string, now = new Date()): Promise<void> {
    await this.db
      .prepare('INSERT INTO reports (id, skill_id, install_id, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(newId('rp', now.getTime()), r.skillId, installId, r.reason, r.details, now.toISOString())
      .run();
  }

  async openReports() {
    const { results } = await this.db
      .prepare('SELECT * FROM reports WHERE resolved_at IS NULL ORDER BY created_at DESC, id DESC')
      .all<ReportRow>();
    return results.map((r) => ({
      id: r.id,
      skillId: r.skill_id,
      installId: r.install_id,
      reason: r.reason,
      details: r.details,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    }));
  }

  // Takedown: keep the row for audit, delete the content.
  async remove(id: string, now = new Date()): Promise<void> {
    await this.db.prepare('UPDATE skills SET removed_at = ? WHERE id = ? AND removed_at IS NULL').bind(now.toISOString(), id).run();
    await this.bucket.delete(objectKey(id));
  }
}
