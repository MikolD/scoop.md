// Daily cron: re-enqueue pages indexed without a classification (cap reached,
// no API key, or the models' output failed validation) so they get one once
// budget allows, oldest first. Pages that FAILED MAX_ATTEMPTS times are left
// alone. The batch is what today's remaining account budget can pay for at
// the recent average cost per page, clamped to [50, 2000].

import { DEFAULT_MODEL, estimateCost } from './classify.ts';
import { ALL_SITES, MAX_ATTEMPTS, NEEDS_CLASSIFYING, spentToday } from './indexer.ts';
import type { IndexMessage } from './indexer.ts';

export const MIN_BATCH = 50;
export const MAX_BATCH = 2000;
// Queue sendBatch takes at most 100 messages.
const SEND_BATCH = 100;
// Used until there are classified pages to average: a 20,000-character page
// with the whole max_tokens spent.
const FALLBACK_PAGE_COST = estimateCost(DEFAULT_MODEL, 20_000);

export async function batchSize(db: D1Database, totalCapUsd: number, now: Date): Promise<number> {
  const remaining = totalCapUsd - (await spentToday(db, ALL_SITES, now));
  const avg = await db
    .prepare(
      `SELECT AVG(cost_usd) AS c FROM (SELECT cost_usd FROM page_index
       WHERE model NOT IN (${NEEDS_CLASSIFYING.map(() => '?').join(', ')}) AND cost_usd > 0 ORDER BY indexed_at DESC LIMIT 500)`,
    )
    .bind(...NEEDS_CLASSIFYING)
    .first<{ c: number | null }>();
  const perPage = avg?.c && avg.c > 0 ? avg.c : FALLBACK_PAGE_COST;
  return Math.min(MAX_BATCH, Math.max(MIN_BATCH, Math.floor(Math.max(0, remaining) / perPage)));
}

export async function reclassify(
  db: D1Database,
  queue: Pick<Queue<IndexMessage>, 'sendBatch'>,
  { totalCapUsd, now = new Date() }: { totalCapUsd: number; now?: Date },
): Promise<number> {
  const limit = await batchSize(db, totalCapUsd, now);
  const { results } = await db
    .prepare(
      `SELECT url, site, content_hash FROM page_index
       WHERE model IN (${NEEDS_CLASSIFYING.map(() => '?').join(', ')}) AND attempts < ?
       ORDER BY indexed_at LIMIT ?`,
    )
    .bind(...NEEDS_CLASSIFYING, MAX_ATTEMPTS, limit)
    .all<{ url: string; site: string; content_hash: string }>();
  for (let i = 0; i < results.length; i += SEND_BATCH) {
    await queue.sendBatch(results.slice(i, i + SEND_BATCH).map((r) => ({ body: { site: r.site, url: r.url, contentHash: r.content_hash } })));
  }
  return results.length;
}
