// Starting a crawl: one queued run row (the per-site lock) and its CrawlSite
// Workflow instance. Shared by POST /v1/admin/crawl, the admin console and
// the CrawlBatch Workflow.

import { CrawlStore } from '../db/crawl.ts';
import { newId } from '../lib/ids.ts';
import type { NewCrawl } from '../lib/validate.ts';
import type { CrawlParams } from './workflow.ts';

export interface StartDeps {
  db: D1Database;
  bucket: R2Bucket;
  workflow: Pick<Workflow<CrawlParams>, 'create'>;
}

// The new run's ID, or null when the site already has a queued or running crawl.
export async function startCrawl(deps: StartDeps, crawl: NewCrawl, runId = newId('cr')): Promise<string | null> {
  const crawls = new CrawlStore(deps.db, deps.bucket);
  if (!(await crawls.createRun(runId, crawl.site, crawl.startUrl, new Date(), crawl.force, crawl.requested))) return null;
  try {
    await deps.workflow.create({ id: runId, params: { runId, ...crawl } });
  } catch (e) {
    // No Workflow will ever finish this run; don't leave it blocking the site.
    await crawls.updateRun(runId, { status: 'failed', finished_at: new Date().toISOString(), error: 'Workflow could not be created' });
    throw e;
  }
  return runId;
}
