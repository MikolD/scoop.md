// Indexes one page: chunk → embed → classify → write Vectorize, then D1
// (page_index, chunks + FTS5, entities, topics) in one transaction. Idempotent
// per content hash; a retry reuses the classification cached in R2, so it is
// paid for once. Storage comes in through IndexDeps so the logic can be
// tested against node:sqlite and in-memory fakes.

import { sha256Hex } from '../lib/ids.ts';
import { chunkMarkdown, pageTitle } from './chunk.ts';
import { FAILED } from './classify.ts';
import type { Classification, Classified, PageInput } from './classify.ts';
import type { Embed } from './embed.ts';

export interface IndexMessage {
  site: string;
  url: string;
  contentHash: string;
}

export interface IndexDeps {
  db: D1Database;
  bucket: R2Bucket;
  vectors: Pick<Vectorize, 'upsert' | 'deleteByIds'>;
  embed: Embed;
  // Null when no OpenRouter key is configured: pages are indexed unclassified.
  classify: ((page: PageInput) => Promise<Classified>) | null;
  // Classifier spend caps per UTC day: per site, and for the whole account.
  dailyCapUsd: number;
  totalCapUsd: number;
  now?: () => Date;
}

export type IndexOutcome =
  | { status: 'unchanged' }
  | { status: 'indexed'; slot: string; topicPath: string[]; chunks: number; model: string; costUsd: number; capped: boolean };

// Failures a retry can't fix: the message is acknowledged and logged.
export class PermanentError extends Error {}

export const DEFAULT_DAILY_CAP_USD = 2;
export const DEFAULT_TOTAL_CAP_USD = 10;
// page_index.model when classification was skipped (cap reached, no API key).
// Pages with this or FAILED are picked up again by the daily reclassify job.
export const UNCLASSIFIED = 'none';
export const NEEDS_CLASSIFYING = [UNCLASSIFIED, FAILED];
// index_costs row for the account-wide total.
export const ALL_SITES = '*';
const VECTOR_BATCH = 500;

export const pageKey = (hash: string) => `pages/${hash}.md`;
export const classifyKey = (hash: string) => `classify/${hash}.json`;

// Every prefix of a topic path: a/b/c → a, a/b, a/b/c.
export const topicPrefixes = (path: string[]) => path.map((_, i) => path.slice(0, i + 1).join('/'));

// "Title > Section > Subsection", without repeating a first heading that is the title.
export function headingTrail(title: string, path: string[]): string {
  return [title, ...(path[0] === title ? path.slice(1) : path)].filter(Boolean).join(' > ');
}

function capDay(now: Date) {
  return now.toISOString().slice(0, 10);
}

export async function spentToday(db: D1Database, site: string, now: Date): Promise<number> {
  const row = await db.prepare('SELECT cost_usd FROM index_costs WHERE site = ? AND day = ?').bind(site, capDay(now)).first<{ cost_usd: number }>();
  return row?.cost_usd ?? 0;
}

async function addCost(db: D1Database, site: string, now: Date, cost: number) {
  if (!(cost > 0)) return;
  const add = 'INSERT INTO index_costs (site, day, cost_usd) VALUES (?, ?, ?) ON CONFLICT (site, day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd';
  await db.batch([site, ALL_SITES].map((s) => db.prepare(add).bind(s, capDay(now), cost)));
}

// The cached result for this content, else a fresh call (cached when it succeeded).
// Returns null when classification is skipped, with capped saying whether a cap did it.
async function classifyOnce(deps: IndexDeps, page: PageInput, site: string, contentHash: string, now: Date): Promise<{ result: Classified | null; capped: boolean; fresh: boolean }> {
  const cached = await deps.bucket.get(classifyKey(contentHash));
  if (cached) return { result: await cached.json<Classified>(), capped: false, fresh: false };
  if (!deps.classify) return { result: null, capped: false, fresh: false };
  const [siteSpent, totalSpent] = await Promise.all([spentToday(deps.db, site, now), spentToday(deps.db, ALL_SITES, now)]);
  if (siteSpent >= deps.dailyCapUsd || totalSpent >= deps.totalCapUsd) return { result: null, capped: true, fresh: false };
  const result = await deps.classify(page);
  await addCost(deps.db, site, now, result.costUsd);
  if (result.classification) await deps.bucket.put(classifyKey(contentHash), JSON.stringify(result));
  return { result, capped: false, fresh: true };
}

export async function indexPage(deps: IndexDeps, msg: IndexMessage): Promise<IndexOutcome> {
  const { db, bucket, vectors, embed } = deps;
  const now = deps.now?.() ?? new Date();
  const { site, url, contentHash } = msg;

  const existing = await db
    .prepare('SELECT content_hash, model, topic FROM page_index WHERE url = ?')
    .bind(url)
    .first<{ content_hash: string; model: string; topic: string }>();
  if (existing && existing.content_hash === contentHash && !NEEDS_CLASSIFYING.includes(existing.model)) return { status: 'unchanged' };

  const obj = await bucket.get(pageKey(contentHash));
  if (!obj) throw new PermanentError(`no R2 object ${pageKey(contentHash)}`);
  const markdown = await obj.text();
  const title = pageTitle(markdown) || new URL(url).pathname;

  const chunks = chunkMarkdown(markdown);
  const urlKey = (await sha256Hex(url)).slice(0, 32);
  const rows = chunks.map((c) => ({ ...c, id: `${urlKey}-${c.ord}`, heading: headingTrail(title, c.headingPath) }));
  const values = rows.length ? await embed(rows.map((r) => `${r.heading}\n\n${r.text}`), 'document') : [];

  // Classified last of the slow steps: if embedding fails, nothing was paid for.
  const { result, capped } = await classifyOnce(deps, { url, title, markdown }, site, contentHash, now);
  const classification: Classification = result?.classification ?? { slot: 'other', topic_path: [], summary: '', tasks: [], entities: [] };
  const model = result?.model ?? UNCLASSIFIED;
  const costUsd = result?.costUsd ?? 0;

  // Vectors first: if D1 then fails, the retry redoes both (IDs are stable), and
  // search ignores vectors whose chunk row doesn't exist.
  const { results: old } = await db.prepare('SELECT id FROM chunks WHERE url = ?').bind(url).all<{ id: string }>();
  const fresh = new Set(rows.map((r) => r.id));
  const stale = old.map((r) => r.id).filter((id) => !fresh.has(id));
  if (stale.length) await vectors.deleteByIds(stale);
  for (let i = 0; i < rows.length; i += VECTOR_BATCH) {
    await vectors.upsert(rows.slice(i, i + VECTOR_BATCH).map((r, j) => ({
      id: r.id,
      values: values[i + j],
      metadata: { site, slot: classification.slot, url, chunkId: r.id },
    })));
  }

  const topic = classification.topic_path.join('/');
  const stmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM chunks WHERE url = ?').bind(url),
    db.prepare('DELETE FROM entities WHERE url = ?').bind(url),
    ...rows.map((r) =>
      db.prepare('INSERT INTO chunks (id, url, site, ord, heading_path, title, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(r.id, url, site, r.ord, r.heading, title, r.text)),
    ...classification.entities.map((e) =>
      db.prepare('INSERT INTO entities (site, kind, name, url) VALUES (?, ?, ?, ?)').bind(site, e.kind, e.name, url)),
    db.prepare(
      `INSERT INTO page_index (url, site, content_hash, title, slot, topic, topic_path, summary, tasks, entities, model, cost_usd, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (url) DO UPDATE SET site = excluded.site, content_hash = excluded.content_hash, title = excluded.title,
         slot = excluded.slot, topic = excluded.topic, topic_path = excluded.topic_path, summary = excluded.summary,
         tasks = excluded.tasks, entities = excluded.entities, model = excluded.model, cost_usd = excluded.cost_usd,
         indexed_at = excluded.indexed_at`,
    ).bind(
      url, site, contentHash, title, classification.slot, topic, JSON.stringify(classification.topic_path),
      classification.summary, JSON.stringify(classification.tasks), JSON.stringify(classification.entities),
      model, costUsd, now.toISOString(),
    ),
  ];
  // Counts for the old and new paths' prefixes are recounted from page_index
  // (after the upsert above, in the same transaction), never adjusted by ±1.
  const affected = new Set([...topicPrefixes(existing?.topic ? existing.topic.split('/') : []), ...topicPrefixes(classification.topic_path)]);
  for (const p of affected) {
    stmts.push(db.prepare(
      `INSERT INTO topics (site, path, count)
       SELECT ?, ?, COUNT(*) FROM page_index WHERE site = ? AND (topic = ? OR substr(topic, 1, ?) = ?)
       ON CONFLICT (site, path) DO UPDATE SET count = excluded.count`,
    // SQLite's substr counts characters, not UTF-16 units: count code points.
    ).bind(site, p, site, p, [...p].length + 1, `${p}/`));
  }
  stmts.push(db.prepare('DELETE FROM topics WHERE site = ? AND count = 0').bind(site));
  await db.batch(stmts);

  return { status: 'indexed', slot: classification.slot, topicPath: classification.topic_path, chunks: rows.length, model, costUsd, capped };
}
