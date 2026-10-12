// Indexes one page: chunk → embed → classify → write Vectorize, then D1
// (page_index, chunks + FTS5, entities, topics) in one transaction. Idempotent
// per content hash; a retry reuses the classification cached in R2, so it is
// paid for once. A message for unchanged content whose classification is
// missing only classifies: page_index, entities, topics and the vectors' slot
// metadata are updated, nothing is re-chunked. Storage comes in through IndexDeps so the logic can be
// tested against node:sqlite and in-memory fakes.

import { sha256Hex } from '../lib/ids.ts';
import { chunkMarkdown, estimateTokens, pageTitle } from './chunk.ts';
import { ClassifyUnavailable, FAILED } from './classify.ts';
import type { Classification, Classified, PageInput } from './classify.ts';
import { embedCostUsd } from './embed.ts';
import type { Embed } from './embed.ts';

export interface IndexMessage {
  site: string;
  url: string;
  contentHash: string;
  // Who pays for indexing it (index_run_costs): the crawl run that queued it,
  // or RECLASSIFY_RUN for the daily cron. Absent: MANUAL_RUN.
  runId?: string;
}

export const RECLASSIFY_RUN = 'reclassify';
export const MANUAL_RUN = 'manual';

export interface IndexDeps {
  db: D1Database;
  bucket: R2Bucket;
  vectors: Pick<Vectorize, 'upsert' | 'deleteByIds' | 'getByIds'>;
  embed: Embed;
  // Null when no OpenRouter key is configured: pages are indexed unclassified.
  classify: ((page: PageInput) => Promise<Classified>) | null;
  // Classifier spend caps per UTC day: per site, and for the whole account.
  dailyCapUsd: number;
  totalCapUsd: number;
  // Jev tokens per UTC day for the whole account (JEV_DAILY_TOKEN_CAP); absent: no cap.
  jevTokenCap?: number;
  now?: () => Date;
}

export type IndexOutcome =
  | { status: 'unchanged' }
  // Acked without indexing: the site was rejected (not_devtool), or a crawl's
  // page is no longer stored at this content (the site was purged since).
  | { status: 'skipped'; reason: 'not_devtool' | 'no_page' }
  | { status: 'indexed'; slot: string; topicPath: string[]; chunks: number; model: string; costUsd: number; capped: boolean }
  | { status: 'reclassified'; slot: string; topicPath: string[]; model: string; costUsd: number };

// Failures a retry can't fix: the message is acknowledged and logged.
export class PermanentError extends Error {}

export const DEFAULT_DAILY_CAP_USD = 2;
export const DEFAULT_TOTAL_CAP_USD = 10;
export const DEFAULT_JEV_DAILY_TOKEN_CAP = 5_000_000;
// page_index.model when classification was skipped (cap reached, no API key).
// Pages with this or FAILED are picked up again by the daily reclassify job.
export const UNCLASSIFIED = 'none';
export const NEEDS_CLASSIFYING = [UNCLASSIFIED, FAILED];
// After this many FAILED results for the same content, the daily job stops trying.
export const MAX_ATTEMPTS = 3;
// From this queue delivery on (about 3.5 minutes of backoff in), a new page
// whose classifier is unavailable is indexed unclassified rather than retried,
// so an outage can't leave it unsearchable in the dead-letter queue. The
// daily job classifies it later.
export const UNAVAILABLE_FALLBACK_ATTEMPT = 4;
// index_costs row for the account-wide total.
export const ALL_SITES = '*';
const VECTOR_BATCH = 500;
// IDs per Vectorize getByIds call.
const GET_BATCH = 20;
// Top-level topics offered to the classifier.
const MAX_TOPICS = 40;
const EMPTY: Classification = { slot: 'other', topic_path: [], summary: '', tasks: [], entities: [] };

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

// Classifier spend (USD) and Jev tokens, per site and for the account.
export async function addCost(db: D1Database, site: string, now: Date, cost: number, jevTokens = 0) {
  if (!(cost > 0) && !(jevTokens > 0)) return;
  const add = `INSERT INTO index_costs (site, day, cost_usd, jev_tokens) VALUES (?, ?, ?, ?)
    ON CONFLICT (site, day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd, jev_tokens = jev_tokens + excluded.jev_tokens`;
  await db.batch([site, ALL_SITES].map((s) => db.prepare(add).bind(s, capDay(now), cost > 0 ? cost : 0, jevTokens > 0 ? jevTokens : 0)));
}

export async function jevTokensToday(db: D1Database, now: Date): Promise<number> {
  const row = await db.prepare('SELECT jev_tokens FROM index_costs WHERE site = ? AND day = ?').bind(ALL_SITES, capDay(now)).first<{ jev_tokens: number }>();
  return row?.jev_tokens ?? 0;
}

// For JevOptions.allow: false once today's Jev tokens reach the cap.
export const jevAllowance = (db: D1Database, cap: number) => async () => (await jevTokensToday(db, new Date())) < cap;

export async function capsReached(deps: Pick<IndexDeps, 'db' | 'dailyCapUsd' | 'totalCapUsd' | 'jevTokenCap'>, site: string, now: Date): Promise<boolean> {
  const [siteSpent, totalSpent, jevTokens] = await Promise.all([
    spentToday(deps.db, site, now),
    spentToday(deps.db, ALL_SITES, now),
    deps.jevTokenCap === undefined ? 0 : jevTokensToday(deps.db, now),
  ]);
  return siteSpent >= deps.dailyCapUsd || totalSpent >= deps.totalCapUsd || (deps.jevTokenCap !== undefined && jevTokens >= deps.jevTokenCap);
}

async function cachedClassification(deps: IndexDeps, contentHash: string): Promise<Classified | null> {
  const cached = await deps.bucket.get(classifyKey(contentHash));
  return cached ? cached.json<Classified>() : null;
}

// The cached result for this content, else a fresh call (cached when it succeeded).
// Returns null when classification is skipped, with capped saying whether a cap did it.
// Throws ClassifyUnavailable (after recording its cost) when the classifier is down.
// `paid` and `tokens` are what this call spent: nothing for a cached classification.
async function classifyOnce(
  deps: IndexDeps, page: PageInput, site: string, contentHash: string, now: Date,
): Promise<{ result: Classified | null; capped: boolean; paid: number; tokens: number }> {
  const cached = await cachedClassification(deps, contentHash);
  if (cached) return { result: cached, capped: false, paid: 0, tokens: 0 };
  if (!deps.classify) return { result: null, capped: false, paid: 0, tokens: 0 };
  if (await capsReached(deps, site, now)) return { result: null, capped: true, paid: 0, tokens: 0 };
  let result: Classified;
  try {
    // The site's top-level topics, for a page whose URL doesn't place it (src/index/jevclassify.ts).
    const { results } = await deps.db
      .prepare(`SELECT path FROM topics WHERE site = ? AND instr(path, '/') = 0 ORDER BY count DESC, path LIMIT ${MAX_TOPICS}`)
      .bind(site)
      .all<{ path: string }>();
    result = await deps.classify({ ...page, topics: results.map((r) => r.path) });
  } catch (e) {
    if (e instanceof ClassifyUnavailable) await addCost(deps.db, site, now, e.costUsd);
    throw e;
  }
  const tokens = result.jevTokens ?? 0;
  await addCost(deps.db, site, now, result.costUsd, tokens);
  if (result.classification) await deps.bucket.put(classifyKey(contentHash), JSON.stringify(result));
  return { result, capped: false, paid: result.costUsd, tokens };
}

// What indexing this page cost, charged to the message's run, in the same D1
// batch as the index write. A redelivered message whose work is already done
// adds nothing (an 'unchanged' outcome records zeros), so increments never
// double-count; the run's totals are recomputed from the rows, never added to.
// The daily cron's spend is kept per UTC day ('reclassify:YYYY-MM-DD').
export function runCostStmts(
  db: D1Database, msg: IndexMessage, c: { classifyUsd: number; embedTokens: number; jevTokens?: number }, now: Date,
): D1PreparedStatement[] {
  const run = msg.runId === RECLASSIFY_RUN ? `${RECLASSIFY_RUN}:${capDay(now)}` : (msg.runId ?? MANUAL_RUN);
  const stmts = [
    db.prepare(
      `INSERT INTO index_run_costs (run_id, url, content_hash, site, classify_cost_usd, embed_tokens, embed_cost_usd, jev_tokens, indexed, outcome, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'indexed', ?)
       ON CONFLICT (run_id, url, content_hash) DO UPDATE SET
         classify_cost_usd = classify_cost_usd + excluded.classify_cost_usd, embed_tokens = embed_tokens + excluded.embed_tokens,
         embed_cost_usd = embed_cost_usd + excluded.embed_cost_usd, jev_tokens = jev_tokens + excluded.jev_tokens,
         indexed = 1, outcome = 'indexed', updated_at = excluded.updated_at`,
    ).bind(run, msg.url, msg.contentHash, msg.site, c.classifyUsd, c.embedTokens, embedCostUsd(c.embedTokens), c.jevTokens ?? 0, now.toISOString()),
  ];
  if (run.startsWith('cr_')) stmts.push(runRecount(db, run, now));
  return stmts;
}

// A crawl run's indexing totals, recomputed from index_run_costs: costs, pages
// indexed, pages whose indexing was skipped or failed for good, and when any
// page last reached an outcome (migrations/0010_index_outcomes.sql).
function runRecount(db: D1Database, run: string, now: Date): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE crawl_runs SET
         classify_cost_usd = (SELECT COALESCE(SUM(classify_cost_usd), 0) FROM index_run_costs WHERE run_id = ?1),
         embed_cost_usd = (SELECT COALESCE(SUM(embed_cost_usd), 0) FROM index_run_costs WHERE run_id = ?1),
         jev_tokens = (SELECT COALESCE(SUM(jev_tokens), 0) FROM index_run_costs WHERE run_id = ?1),
         pages_indexed = (SELECT COUNT(*) FROM index_run_costs WHERE run_id = ?1 AND indexed = 1),
         pages_index_failed = (SELECT COUNT(*) FROM index_run_costs WHERE run_id = ?1 AND indexed = 0 AND outcome IN ('skipped', 'failed')),
         index_progress_at = ?2
       WHERE id = ?1`,
    )
    .bind(run, now.toISOString());
}

// Records that a crawl page's indexing ended without indexing it: 'skipped'
// (nothing to index any more) or 'failed' (a permanent error, or the last
// delivery before the dead-letter queue). Counts as done for the run's crawl
// requests; a later success for the same content turns it back to 'indexed'.
// Only crawl runs (runId cr_…) are tracked.
export async function recordIndexOutcome(db: D1Database, msg: IndexMessage, outcome: 'skipped' | 'failed', now = new Date()): Promise<void> {
  if (!msg.runId?.startsWith('cr_')) return;
  await db.batch([
    db
      .prepare(
        `INSERT INTO index_run_costs (run_id, url, content_hash, site, indexed, outcome, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (run_id, url, content_hash) DO UPDATE SET
           outcome = CASE WHEN indexed = 1 THEN outcome ELSE excluded.outcome END, updated_at = excluded.updated_at`,
      )
      .bind(msg.runId, msg.url, msg.contentHash, msg.site, outcome, now.toISOString()),
    runRecount(db, msg.runId, now),
  ]);
}

const embedTokens = (texts: string[]) => texts.reduce((n, t) => n + estimateTokens(t), 0);

// Recounts every prefix of the old and new topic paths from page_index, as two
// index range counts on (site, topic): the topic itself, and topics in
// [p + '/', p + '0'), which is exactly those starting with p + '/' ('0' follows
// '/'). Runs after the page_index write in the same batch; zero rows are deleted.
function topicRecount(db: D1Database, site: string, oldTopic: string | undefined, newPath: string[]): D1PreparedStatement[] {
  const affected = new Set([...topicPrefixes(oldTopic ? oldTopic.split('/') : []), ...topicPrefixes(newPath)]);
  const stmts = [...affected].map((p) =>
    db.prepare(
      `INSERT INTO topics (site, path, count)
       SELECT ?1, ?2,
         (SELECT COUNT(*) FROM page_index WHERE site = ?1 AND topic = ?2)
         + (SELECT COUNT(*) FROM page_index WHERE site = ?1 AND topic >= ?2 || '/' AND topic < ?2 || '0')
       WHERE true
       ON CONFLICT (site, path) DO UPDATE SET count = excluded.count`,
    ).bind(site, p));
  stmts.push(db.prepare('DELETE FROM topics WHERE site = ? AND count = 0').bind(site));
  return stmts;
}

async function readPage(deps: IndexDeps, url: string, contentHash: string) {
  const obj = await deps.bucket.get(pageKey(contentHash));
  if (!obj) throw new PermanentError(`no R2 object ${pageKey(contentHash)}`);
  const markdown = await obj.text();
  return { markdown, title: pageTitle(markdown) || new URL(url).pathname };
}

interface Existing {
  content_hash: string;
  model: string;
  topic: string;
  attempts: number;
}

// attempt is the queue delivery count (1 for the first; inline calls pass nothing).
export async function indexPage(deps: IndexDeps, msg: IndexMessage, { attempt = 1 }: { attempt?: number } = {}): Promise<IndexOutcome> {
  const { db, vectors, embed } = deps;
  const now = deps.now?.() ?? new Date();
  const { site, url, contentHash } = msg;

  // Late messages for a site an admin rejected (its index was purged), or for
  // a crawled page whose row is gone or has moved on: nothing to index.
  const gone = await db
    .prepare(
      `SELECT (SELECT status FROM site_profiles WHERE site = ?1) AS status,
              (SELECT 1 FROM pages WHERE url = ?2 AND content_hash = ?3) AS stored`,
    )
    .bind(site, url, contentHash)
    .first<{ status: string | null; stored: number | null }>();
  const skip = gone?.status === 'not_devtool' ? 'not_devtool' : msg.runId?.startsWith('cr_') && !gone?.stored ? 'no_page' : null;
  // Only crawl messages have a pages row; manual and reclassify ones don't need one.
  if (skip) {
    await recordIndexOutcome(db, msg, 'skipped', now);
    return { status: 'skipped', reason: skip };
  }

  const existing = await db
    .prepare('SELECT content_hash, model, topic, attempts FROM page_index WHERE url = ?')
    .bind(url)
    .first<Existing>();
  if (existing && existing.content_hash === contentHash) {
    if (!NEEDS_CLASSIFYING.includes(existing.model)) {
      // Indexed already: counts as indexed for this run, at no cost.
      await db.batch(runCostStmts(db, msg, { classifyUsd: 0, embedTokens: 0 }, now));
      return { status: 'unchanged' };
    }
    return reclassifyPage(deps, msg, existing, now);
  }

  const { markdown, title } = await readPage(deps, url, contentHash);
  const chunks = chunkMarkdown(markdown);
  const urlKey = (await sha256Hex(url)).slice(0, 32);
  const rows = chunks.map((c) => ({ ...c, id: `${urlKey}-${c.ord}`, heading: headingTrail(title, c.headingPath) }));
  const texts = rows.map((r) => `${r.heading}\n\n${r.text}`);
  const values = rows.length ? await embed(texts, 'document') : [];

  // Classified last of the slow steps: if embedding fails, nothing was paid for.
  let result: Classified | null = null;
  let capped = false;
  let paid = 0;
  let tokens = 0;
  try {
    ({ result, capped, paid, tokens } = await classifyOnce(deps, { url, title, markdown }, site, contentHash, now));
  } catch (e) {
    // Its cost is already recorded; late in the retries, index without it.
    if (!(e instanceof ClassifyUnavailable) || attempt < UNAVAILABLE_FALLBACK_ATTEMPT) throw e;
    paid = e.costUsd;
  }
  const classification = result?.classification ?? EMPTY;
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
      `INSERT INTO page_index (url, site, content_hash, title, slot, topic, topic_path, summary, tasks, entities, model, cost_usd, attempts, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (url) DO UPDATE SET site = excluded.site, content_hash = excluded.content_hash, title = excluded.title,
         slot = excluded.slot, topic = excluded.topic, topic_path = excluded.topic_path, summary = excluded.summary,
         tasks = excluded.tasks, entities = excluded.entities, model = excluded.model, cost_usd = excluded.cost_usd,
         attempts = excluded.attempts, indexed_at = excluded.indexed_at`,
    ).bind(
      url, site, contentHash, title, classification.slot, topic, JSON.stringify(classification.topic_path),
      classification.summary, JSON.stringify(classification.tasks), JSON.stringify(classification.entities),
      model, costUsd, model === FAILED ? 1 : 0, now.toISOString(),
    ),
    ...topicRecount(db, site, existing?.topic, classification.topic_path),
    ...runCostStmts(db, msg, { classifyUsd: paid, embedTokens: embedTokens(texts), jevTokens: tokens }, now),
  ];
  await db.batch(stmts);

  return { status: 'indexed', slot: classification.slot, topicPath: classification.topic_path, chunks: rows.length, model, costUsd, capped };
}

// Same content, classification missing. A cached classification (free) is
// applied whatever the caps say; otherwise the caps are checked before the
// page is read. Only the classification-derived data changes.
async function reclassifyPage(deps: IndexDeps, msg: IndexMessage, existing: Existing, now: Date): Promise<IndexOutcome> {
  const { db, vectors } = deps;
  const { site, url, contentHash } = msg;
  // Indexed already (unclassified): counts as indexed for this run either way.
  const free = () => db.batch(runCostStmts(db, msg, { classifyUsd: 0, embedTokens: 0 }, now));
  let result = await cachedClassification(deps, contentHash);
  let paid = 0;
  let jevTokens = 0;
  if (!result) {
    if (!deps.classify || (await capsReached(deps, site, now))) return free().then(() => ({ status: 'unchanged' }));
    const { markdown, title } = await readPage(deps, url, contentHash);
    ({ result, paid, tokens: jevTokens } = await classifyOnce(deps, { url, title, markdown }, site, contentHash, now));
    if (!result) return free().then(() => ({ status: 'unchanged' }));
  }
  if (!result.classification) {
    await db.batch([
      db
        .prepare('UPDATE page_index SET model = ?, cost_usd = ?, attempts = attempts + 1, indexed_at = ? WHERE url = ?')
        .bind(FAILED, result.costUsd, now.toISOString(), url),
      ...runCostStmts(db, msg, { classifyUsd: paid, embedTokens: 0, jevTokens }, now),
    ]);
    return { status: 'reclassified', slot: 'other', topicPath: [], model: FAILED, costUsd: result.costUsd };
  }
  const c = result.classification;

  // Vectorize can't change metadata alone: each vector is upserted again with
  // its stored values. Any missing from the index are embedded from D1.
  let tokens = 0;
  const { results: chunks } = await db
    .prepare('SELECT id, heading_path, text FROM chunks WHERE url = ? ORDER BY ord')
    .bind(url)
    .all<{ id: string; heading_path: string; text: string }>();
  for (let i = 0; i < chunks.length; i += GET_BATCH) {
    const batch = chunks.slice(i, i + GET_BATCH);
    const found = new Map((await vectors.getByIds(batch.map((r) => r.id))).map((v) => [v.id, Array.from(v.values as ArrayLike<number>)]));
    const missing = batch.filter((r) => !found.get(r.id)?.length);
    if (missing.length) {
      const texts = missing.map((r) => `${r.heading_path}\n\n${r.text}`);
      tokens += embedTokens(texts);
      const embedded = await deps.embed(texts, 'document');
      missing.forEach((r, j) => found.set(r.id, embedded[j]));
    }
    await vectors.upsert(batch.map((r) => ({ id: r.id, values: found.get(r.id)!, metadata: { site, slot: c.slot, url, chunkId: r.id } })));
  }

  await db.batch([
    db.prepare('DELETE FROM entities WHERE url = ?').bind(url),
    ...c.entities.map((e) => db.prepare('INSERT INTO entities (site, kind, name, url) VALUES (?, ?, ?, ?)').bind(site, e.kind, e.name, url)),
    db.prepare(
      `UPDATE page_index SET slot = ?, topic = ?, topic_path = ?, summary = ?, tasks = ?, entities = ?, model = ?, cost_usd = ?,
         attempts = 0, indexed_at = ? WHERE url = ?`,
    ).bind(
      c.slot, c.topic_path.join('/'), JSON.stringify(c.topic_path), c.summary, JSON.stringify(c.tasks), JSON.stringify(c.entities),
      result.model, result.costUsd, now.toISOString(), url,
    ),
    ...topicRecount(db, site, existing.topic, c.topic_path),
    ...runCostStmts(db, msg, { classifyUsd: paid, embedTokens: tokens, jevTokens }, now),
  ]);
  return { status: 'reclassified', slot: c.slot, topicPath: c.topic_path, model: result.model, costUsd: result.costUsd };
}
