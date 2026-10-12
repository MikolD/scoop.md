// Daily cron: re-enqueue pages indexed without a classification (cap reached,
// no API key, or every model failed) so they get one once budget allows. The
// batch is bounded; the next day picks up the rest, oldest first.

import { NEEDS_CLASSIFYING } from './indexer.ts';
import type { IndexMessage } from './indexer.ts';

export const RECLASSIFY_BATCH = 200;
// Queue sendBatch takes at most 100 messages.
const SEND_BATCH = 100;

export async function reclassify(db: D1Database, queue: Pick<Queue<IndexMessage>, 'sendBatch'>, limit = RECLASSIFY_BATCH): Promise<number> {
  const { results } = await db
    .prepare(`SELECT url, site, content_hash FROM page_index WHERE model IN (${NEEDS_CLASSIFYING.map(() => '?').join(', ')}) ORDER BY indexed_at LIMIT ?`)
    .bind(...NEEDS_CLASSIFYING, limit)
    .all<{ url: string; site: string; content_hash: string }>();
  for (let i = 0; i < results.length; i += SEND_BATCH) {
    await queue.sendBatch(results.slice(i, i + SEND_BATCH).map((r) => ({ body: { site: r.site, url: r.url, contentHash: r.content_hash } })));
  }
  return results.length;
}
