// Collecting a browser crawl's result into R2, retry-safe. The result is read
// once (from the optional presigned upload, else from the sandbox), validated,
// split into one object per page step, and summarised in a manifest written
// last. A retry that finds the manifest returns it without touching the
// sandbox, which may already be gone. Stopping the sandbox is the caller's
// next step, never part of this one. Plain TS over an R2-shaped bucket.

import { MAX_RESULT_BYTES } from './e2b.ts';
import { browserPages } from './result.ts';
import type { Robots } from './robots.ts';
import type { BrowserCrawler, RunHandle } from './runner.ts';
import type { FetchedSource } from './site.ts';

export const runPrefix = (runId: string) => `crawl-results/${runId}/`;
export const planKey = (runId: string) => `${runPrefix(runId)}plan.json`;
// Where the optional presigned upload puts the raw result.
export const uploadKey = (runId: string) => `${runPrefix(runId)}upload.json`;
export const batchKey = (runId: string, i: number) => `${runPrefix(runId)}batch-${i}.json`;
export const manifestKey = (runId: string) => `${runPrefix(runId)}manifest.json`;

export interface Manifest {
  pages: number;
  batches: number;
  skipped: number;
  error: string | null;
}

export interface CollectInput {
  bucket: Pick<R2Bucket, 'get' | 'put' | 'delete'>;
  crawler: Pick<BrowserCrawler, 'result'> & { status?(h: RunHandle): Promise<{ error: string | null } | null> };
  handle: RunHandle;
  runId: string;
  site: string;
  robots: Robots;
  maxPages: number;
  perBatch: number;
}

const JSON_META = { httpMetadata: { contentType: 'application/json' } };

export async function collectResult(c: CollectInput): Promise<Manifest> {
  const done = await c.bucket.get(manifestKey(c.runId));
  if (done) return done.json<Manifest>();

  const uploaded = await c.bucket.get(uploadKey(c.runId));
  // Check the size before reading: the upload is the sandbox's doing.
  if (uploaded && uploaded.size > MAX_RESULT_BYTES) {
    await uploaded.body.cancel();
    throw new Error(`uploaded crawl result is over ${MAX_RESULT_BYTES} bytes`);
  }
  const raw = uploaded ? await uploaded.text() : await c.crawler.result(c.handle);
  const error = raw === null ? ((await c.crawler.status?.(c.handle))?.error ?? 'no result') : null;
  const { pages, skipped } = raw === null ? { pages: [] as FetchedSource[], skipped: 0 } : browserPages(raw, c.site, c.robots, c.maxPages);

  let batches = 0;
  for (; batches * c.perBatch < pages.length; batches++) {
    await c.bucket.put(batchKey(c.runId, batches), JSON.stringify(pages.slice(batches * c.perBatch, (batches + 1) * c.perBatch)), JSON_META);
  }
  const manifest: Manifest = { pages: pages.length, batches, skipped, error };
  // Written last: its presence means every batch object is in place.
  await c.bucket.put(manifestKey(c.runId), JSON.stringify(manifest), JSON_META);
  await c.bucket.delete(uploadKey(c.runId));
  return manifest;
}
