// Workflow CrawlBatch: drives one seed crawl batch (batch.ts) server-side.
// Each tick is one short step; between ticks the instance sleeps. All state
// is in D1, so after TICKS_PER_INSTANCE ticks the instance hands over to a
// fresh one (`<batchId>-<n>`) instead of growing past the Workflow step limit.

import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import { startCrawl } from '../crawl/start.ts';
import type { Env } from '../env.ts';
import { tickBatch } from './batch.ts';

export interface BatchParams {
  batchId: string;
  generation?: number;
}

const TICK_SECONDS = 15;
const TICKS_PER_INSTANCE = 300;
const DB: WorkflowStepConfig = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' };

export const batchInstanceId = (batchId: string, generation = 0) => (generation ? `${batchId}-${generation}` : batchId);

export class CrawlBatch extends WorkflowEntrypoint<Env, BatchParams> {
  async run(event: Readonly<WorkflowEvent<BatchParams>>, step: WorkflowStep): Promise<unknown> {
    const { batchId, generation = 0 } = event.payload;
    const env = this.env;
    const deps = {
      db: env.DB,
      start: (j: { site: string; start_url: string; max_pages: number }, runId: string, force: boolean) =>
        startCrawl(
          { db: env.DB, bucket: env.SKILLS, workflow: env.CRAWL_SITE },
          { site: j.site, startUrl: j.start_url, maxPages: j.max_pages, maxMinutes: 10, force },
          runId,
        ),
    };
    for (let i = 0; i < TICKS_PER_INSTANCE; i++) {
      const t = await step.do(`tick-${i}`, DB, () => tickBatch(deps, batchId));
      if (t.done) return { batchId, ticks: i + 1 };
      await step.sleep(`wait-${i}`, `${TICK_SECONDS} seconds`);
    }
    await step.do('hand-over', DB, async () => {
      const id = batchInstanceId(batchId, generation + 1);
      try {
        await env.CRAWL_BATCH.create({ id, params: { batchId, generation: generation + 1 } });
      } catch (e) {
        // A retried step whose first create went through.
        if (!(await env.CRAWL_BATCH.get(id).then(() => true, () => false))) throw e;
      }
    });
    return { batchId, handedOver: generation + 1 };
  }
}
