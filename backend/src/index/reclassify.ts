// Daily cron: re-enqueue pages indexed without a classification (cap reached,
// no API key, or the models' output failed validation) so they get one once
// budget allows, oldest first. Pages that FAILED MAX_ATTEMPTS times are left
// alone. The batch is what today's remaining account budget can pay for at
// the recent average cost per page, clamped to [50, 2000], and each site gets
// at most what its own daily cap pays for, so one site can't starve the rest.

import { DEFAULT_MODEL, estimateCost } from './classify.ts';
import { ALL_SITES, MAX_ATTEMPTS, NEEDS_CLASSIFYING, RECLASSIFY_RUN, spentToday } from './indexer.ts';
import type { IndexMessage } from './indexer.ts';

export const MIN_BATCH = 50;
export const MAX_BATCH = 2000;
// Queue sendBatch takes at most 100 messages.
const SEND_BATCH = 100;
// Used until there are classified pages to average: a 20,000-character page
// with the whole max_tokens spent.
const FALLBACK_PAGE_COST = estimateCost(DEFAULT_MODEL, 20_000);

async function pageCost(db: D1Database): Promise<number> {
  const avg = await db
    .prepare(
      `SELECT AVG(cost_usd) AS c FROM (SELECT cost_usd FROM page_index
       WHERE model NOT IN (${NEEDS_CLASSIFYING.map(() => '?').join(', ')}) AND cost_usd > 0 ORDER BY indexed_at DESC LIMIT 500)`,
    )
    .bind(...NEEDS_CLASSIFYING)
    .first<{ c: number | null }>();
  return avg?.c && avg.c > 0 ? avg.c : FALLBACK_PAGE_COST;
}

export async function batchSize(db: D1Database, totalCapUsd: number, now: Date, perPage?: number): Promise<number> {
  const remaining = totalCapUsd - (await spentToday(db, ALL_SITES, now));
  const cost = perPage ?? (await pageCost(db));
  return Math.min(MAX_BATCH, Math.max(MIN_BATCH, Math.floor(Math.max(0, remaining) / cost)));
}

export async function reclassify(
  db: D1Database,
  queue: Pick<Queue<IndexMessage>, 'sendBatch'>,
  { totalCapUsd, dailyCapUsd, now = new Date() }: { totalCapUsd: number; dailyCapUsd: number; now?: Date },
): Promise<number> {
  const perPage = await pageCost(db);
  const limit = await batchSize(db, totalCapUsd, now, perPage);
  const perSite = Math.max(1, Math.floor(dailyCapUsd / perPage));
  const { results } = await db
    .prepare(
      `SELECT url, site, content_hash FROM (
         SELECT url, site, content_hash, indexed_at, ROW_NUMBER() OVER (PARTITION BY site ORDER BY indexed_at) AS n
         FROM page_index WHERE model IN (${NEEDS_CLASSIFYING.map(() => '?').join(', ')}) AND attempts < ?
       ) WHERE n <= ? ORDER BY indexed_at LIMIT ?`,
    )
    .bind(...NEEDS_CLASSIFYING, MAX_ATTEMPTS, perSite, limit)
    .all<{ url: string; site: string; content_hash: string }>();
  for (let i = 0; i < results.length; i += SEND_BATCH) {
    await queue.sendBatch(results.slice(i, i + SEND_BATCH).map((r) => ({ body: { site: r.site, url: r.url, contentHash: r.content_hash, runId: RECLASSIFY_RUN } })));
  }
  return results.length;
}
