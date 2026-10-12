// Queue consumer for `index-pages`: one message per new or changed page
// (src/db/crawl.ts IndexMessage). A stub until M4 (classify → chunks →
// embeddings); it logs counts per site and acks the batch.

import type { IndexMessage } from '../db/crawl.ts';

export async function indexPages(batch: MessageBatch<IndexMessage>): Promise<void> {
  const perSite = new Map<string, number>();
  for (const m of batch.messages) perSite.set(m.body.site, (perSite.get(m.body.site) ?? 0) + 1);
  for (const [site, pages] of perSite) console.log(JSON.stringify({ queue: batch.queue, site, pages, stub: true }));
  batch.ackAll();
}
