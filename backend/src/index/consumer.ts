// Queue consumer for `index-pages`. One message per changed page:
// { site, url, contentHash, runId? }. A batch's messages run concurrently; each is
// acked on success, retried with exponential backoff on failure, and acked
// and logged when retrying can't help.

import { normalizeSite, siteOf } from '../lib/ssrf.ts';
import { normalizePageUrl } from '../lib/urls.ts';
import { indexPage, PermanentError, RECLASSIFY_RUN, recordIndexOutcome } from './indexer.ts';
import type { IndexDeps, IndexMessage } from './indexer.ts';

const HEX64 = /^[0-9a-f]{64}$/;
const RUN_ID = /^cr_[0-9A-Z]{26}$/;

export function parseMessage(body: unknown): IndexMessage {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.url !== 'string' || typeof b.site !== 'string' || typeof b.contentHash !== 'string') {
    throw new PermanentError('message needs site, url and contentHash strings');
  }
  // One spelling per page (src/lib/urls.ts).
  let u: URL;
  try { u = new URL(b.url); } catch { throw new PermanentError('url is not a URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new PermanentError('url is not http(s)');
  const url = normalizePageUrl(u);
  const site = normalizeSite(b.site);
  if (siteOf(url) !== site) throw new PermanentError('url is not on site');
  if (!HEX64.test(b.contentHash)) throw new PermanentError('contentHash is not a sha256 hex digest');
  // The run charged for indexing it; anything else is charged to 'manual'.
  const runId = typeof b.runId === 'string' && (RUN_ID.test(b.runId) || b.runId === RECLASSIFY_RUN) ? b.runId : undefined;
  return { site, url, contentHash: b.contentHash, ...(runId ? { runId } : {}) };
}

// Deliveries before a message goes to the dead-letter queue: max_retries
// (wrangler.jsonc, index-pages consumers) + 1.
export const MAX_DELIVERIES = 7;

// 30 s, 60 s, 2 min, … capped at an hour. `attempts` starts at 1.
export const backoffSeconds = (attempts: number) => Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));

// A batch's messages run concurrently, each acked or retried on its own, so
// one slow or failing page can't hold up or fail the others.
export async function handleIndexBatch(batch: MessageBatch<unknown>, deps: IndexDeps): Promise<void> {
  await Promise.allSettled(batch.messages.map((msg) => handleMessage(batch.queue, msg, deps)));
}

async function handleMessage(queue: string, msg: Message<unknown>, deps: IndexDeps): Promise<void> {
  let parsed: IndexMessage | null = null;
  try {
    parsed = parseMessage(msg.body);
    const outcome = await indexPage(deps, parsed, { attempt: msg.attempts });
    const { topicPath: _, ...fields } = outcome as { topicPath?: string[] };
    console.log(JSON.stringify({ queue, ...fields }));
    msg.ack();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // A page that will never be indexed is recorded as failed, so its crawl's
    // requests can complete: a permanent error, or the last delivery before
    // the dead-letter queue (which still gets the message, for inspection).
    const final = e instanceof PermanentError || msg.attempts >= MAX_DELIVERIES;
    if (final && parsed) await recordIndexOutcome(deps.db, parsed, 'failed').catch(() => {});
    if (e instanceof PermanentError) {
      console.error(JSON.stringify({ queue, status: 'dropped', error }));
      msg.ack();
    } else {
      console.error(JSON.stringify({ queue, status: final ? 'dead_letter' : 'retry', attempts: msg.attempts, error }));
      msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
    }
  }
}
