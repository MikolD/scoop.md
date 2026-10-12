// Seed crawl batches (migrations/0006_admin.sql): the jobs live in D1 and the
// CrawlBatch Workflow (batch-workflow.ts) calls tickBatch every few seconds.
// A tick follows the batch's running crawls, then starts waiting jobs up to the
// concurrency, never two of the same site at once. A site that is busy (409:
// a crawl of it is already queued or running, perhaps started elsewhere) waits
// BUSY_RETRY_MS and is tried again, up to MAX_START_ATTEMPTS times. Same rules
// as scripts/crawl-seeds.mjs, but server-side.
// No Workers APIs here, so the scheduling runs under node:test.

import { STALE_RUN_HOURS } from '../db/crawl.ts';
import { newId, ulid } from '../lib/ids.ts';

export const MAX_CONCURRENCY = 8;
export const BUSY_RETRY_MS = 60_000;
export const MAX_START_ATTEMPTS = 30;
const FINAL_RUN = new Set(['complete', 'failed', 'rejected']);
export const FINAL_JOB = ['complete', 'failed', 'rejected', 'cancelled', 'error'];
// D1 allows 100 bound parameters per statement.
const IN_CHUNK = 90;

export interface BatchRow {
  id: string;
  status: string; // running | complete | cancelled
  concurrency: number;
  max_pages: number | null;
  force: number;
  created_at: string;
  finished_at: string | null;
}

export interface JobRow {
  batch_id: string;
  ord: number;
  name: string;
  site: string;
  start_url: string;
  max_pages: number;
  status: string; // waiting | starting | running | complete | failed | rejected | cancelled | error
  run_id: string | null;
  attempts: number;
  not_before: string | null;
  error: string | null;
  updated_at: string;
}

export interface NewJob {
  name: string;
  site: string;
  startUrl: string;
  maxPages: number;
}

export interface TickDeps {
  db: D1Database;
  // Starts one crawl under `runId`; null when the site already has one queued or running.
  start: (job: JobRow, runId: string, force: boolean) => Promise<string | null>;
  now?: () => Date;
}

export const newBatchId = (now = Date.now()) => `cb_${ulid(now)}`;
// The CrawlBatch Workflow instance driving a batch; each hand-over gets the next generation.
export const batchInstanceId = (batchId: string, generation = 0) => (generation ? `${batchId}-${generation}` : batchId);

export async function createBatch(
  db: D1Database,
  b: { id: string; concurrency: number; maxPages: number | null; force: boolean; jobs: NewJob[] },
  now = new Date(),
): Promise<void> {
  const at = now.toISOString();
  await db.batch([
    db
      .prepare(`INSERT INTO crawl_batches (id, status, concurrency, max_pages, force, created_at) VALUES (?, 'running', ?, ?, ?, ?)`)
      .bind(b.id, b.concurrency, b.maxPages, b.force ? 1 : 0, at),
    ...b.jobs.map((j, i) =>
      db
        .prepare(
          `INSERT INTO crawl_batch_jobs (batch_id, ord, name, site, start_url, max_pages, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)`,
        )
        .bind(b.id, i, j.name, j.site, j.startUrl, j.maxPages, at),
    ),
  ]);
}

export async function getBatch(db: D1Database, id: string) {
  const batch = await db.prepare('SELECT * FROM crawl_batches WHERE id = ?').bind(id).first<BatchRow>();
  if (!batch) return null;
  // Each job with its run's live status and counts, so a cancelled batch still shows its crawls finishing.
  const { results } = await db
    .prepare(
      `SELECT j.*, r.status AS run_status, r.path AS run_path, r.pages_new + r.pages_changed AS run_pages, r.error AS run_error
       FROM crawl_batch_jobs j LEFT JOIN crawl_runs r ON r.id = j.run_id WHERE j.batch_id = ? ORDER BY j.ord`,
    )
    .bind(id)
    .all<JobRow & { run_status: string | null; run_path: string | null; run_pages: number | null; run_error: string | null }>();
  return { batch, jobs: results };
}

export async function listBatches(db: D1Database, limit = 20) {
  const { results } = await db
    .prepare(
      `SELECT b.*,
         (SELECT COUNT(*) FROM crawl_batch_jobs j WHERE j.batch_id = b.id) AS jobs,
         (SELECT COUNT(*) FROM crawl_batch_jobs j WHERE j.batch_id = b.id AND j.status IN (${FINAL_JOB.map(() => '?').join(', ')})) AS done,
         (SELECT COUNT(*) FROM crawl_batch_jobs j WHERE j.batch_id = b.id AND j.status IN ('starting', 'running')) AS active
       FROM crawl_batches b ORDER BY b.created_at DESC, b.id DESC LIMIT ?`,
    )
    .bind(...FINAL_JOB, limit)
    .all<BatchRow & { jobs: number; done: number; active: number }>();
  return results;
}

// Stops scheduling: waiting jobs are cancelled, crawls already running carry
// on. Returns the run IDs still in flight, for a caller that stops them too.
export async function cancelBatch(db: D1Database, id: string, now = new Date()): Promise<string[] | null> {
  const at = now.toISOString();
  const [updated] = await db.batch([
    db.prepare(`UPDATE crawl_batches SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running' RETURNING id`).bind(at, id),
    db.prepare(`UPDATE crawl_batch_jobs SET status = 'cancelled', updated_at = ? WHERE batch_id = ? AND status = 'waiting'`).bind(at, id),
  ]);
  if (!(updated.results as unknown[]).length) return null;
  const { results } = await db
    .prepare(`SELECT run_id FROM crawl_batch_jobs WHERE batch_id = ? AND status IN ('starting', 'running') AND run_id IS NOT NULL`)
    .bind(id)
    .all<{ run_id: string }>();
  return results.map((r) => r.run_id);
}

async function setJob(db: D1Database, j: JobRow, fields: Partial<JobRow>, at: string) {
  const f = { ...fields, updated_at: at };
  const keys = Object.keys(f) as (keyof typeof f)[];
  await db
    .prepare(`UPDATE crawl_batch_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE batch_id = ? AND ord = ?`)
    .bind(...keys.map((k) => f[k] ?? null), j.batch_id, j.ord)
    .run();
  Object.assign(j, f);
}

async function runsById(db: D1Database, ids: string[]) {
  const out = new Map<string, { status: string; error: string | null; started_at: string }>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`SELECT id, status, error, started_at FROM crawl_runs WHERE id IN (${chunk.map(() => '?').join(', ')})`)
      .bind(...chunk)
      .all<{ id: string; status: string; error: string | null; started_at: string }>();
    for (const r of results) out.set(r.id, r);
  }
  return out;
}

// One scheduling pass. Returns done once the batch is finished or cancelled.
export async function tickBatch(deps: TickDeps, batchId: string): Promise<{ done: boolean; started: number; active: number }> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const at = now.toISOString();
  const batch = await db.prepare('SELECT * FROM crawl_batches WHERE id = ?').bind(batchId).first<BatchRow>();
  if (!batch || batch.status !== 'running') return { done: true, started: 0, active: 0 };
  const { results: jobs } = await db.prepare('SELECT * FROM crawl_batch_jobs WHERE batch_id = ? ORDER BY ord').bind(batchId).all<JobRow>();

  // Follow the crawls in flight. 'starting' is a start an earlier tick didn't
  // finish recording: it went through if its run row exists.
  const inFlight = jobs.filter((j) => (j.status === 'starting' || j.status === 'running') && j.run_id);
  const runs = await runsById(db, inFlight.map((j) => j.run_id!));
  const stale = now.getTime() - STALE_RUN_HOURS * 3_600_000;
  for (const j of inFlight) {
    const run = runs.get(j.run_id!);
    if (!run) {
      await setJob(db, j, j.status === 'starting' ? { status: 'waiting', run_id: null } : { status: 'error', error: 'crawl run row is missing' }, at);
    } else if (FINAL_RUN.has(run.status)) {
      await setJob(db, j, { status: run.status, error: run.error }, at);
    } else if (Date.parse(run.started_at) < stale) {
      await setJob(db, j, { status: 'failed', error: `abandoned: still unfinished after ${STALE_RUN_HOURS} hours` }, at);
    } else if (j.status === 'starting') {
      await setJob(db, j, { status: 'running' }, at);
    }
  }

  const active = jobs.filter((j) => j.status === 'starting' || j.status === 'running');
  const busySites = new Set(active.map((j) => j.site));
  let slots = batch.concurrency - active.length;
  let started = 0;
  for (const j of jobs) {
    if (slots <= 0) break;
    if (j.status !== 'waiting' || busySites.has(j.site) || (j.not_before && j.not_before > at)) continue;
    // Claim first, so a retried tick finds the run by its ID.
    const runId = newId('cr', now.getTime());
    await setJob(db, j, { status: 'starting', run_id: runId, attempts: j.attempts + 1 }, at);
    let got: string | null;
    try {
      got = await deps.start(j, runId, Boolean(batch.force));
    } catch (e) {
      await setJob(db, j, { status: 'error', run_id: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) }, at);
      continue;
    }
    if (got) {
      await setJob(db, j, { status: 'running', error: null }, at);
      busySites.add(j.site);
      slots--;
      started++;
    } else if (j.attempts >= MAX_START_ATTEMPTS) {
      await setJob(db, j, { status: 'error', run_id: null, error: `a crawl of ${j.site} stayed busy (409) after ${j.attempts} attempts` }, at);
    } else {
      const notBefore = new Date(now.getTime() + BUSY_RETRY_MS).toISOString();
      await setJob(db, j, { status: 'waiting', run_id: null, not_before: notBefore, error: `busy (409): a crawl of ${j.site} is already queued or running` }, at);
    }
  }

  const left = jobs.filter((j) => !FINAL_JOB.includes(j.status));
  if (!left.length) {
    await db.prepare(`UPDATE crawl_batches SET status = 'complete', finished_at = ? WHERE id = ? AND status = 'running'`).bind(at, batchId).run();
    return { done: true, started, active: 0 };
  }
  return { done: false, started, active: left.filter((j) => j.status === 'starting' || j.status === 'running').length };
}
