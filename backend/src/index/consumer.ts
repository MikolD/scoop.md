// Queue consumer for `index-pages`. One message per changed page:
// { site, url, contentHash }. Messages are handled one at a time (classifying
// takes seconds each); each is acked on success, retried with exponential
// backoff on failure, and acked and logged when retrying can't help.

import { normalizeSite, siteOf } from '../lib/ssrf.ts';
import { normalizePageUrl } from '../lib/urls.ts';
import { indexPage, PermanentError } from './indexer.ts';
import type { IndexDeps, IndexMessage } from './indexer.ts';

const HEX64 = /^[0-9a-f]{64}$/;

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
  return { site, url, contentHash: b.contentHash };
}

// 30 s, 60 s, 2 min, … capped at an hour. `attempts` starts at 1.
export const backoffSeconds = (attempts: number) => Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));

export async function handleIndexBatch(batch: MessageBatch<unknown>, deps: IndexDeps): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const outcome = await indexPage(deps, parseMessage(msg.body), { attempt: msg.attempts });
      const { topicPath: _, ...fields } = outcome as { topicPath?: string[] };
      console.log(JSON.stringify({ queue: batch.queue, ...fields }));
      msg.ack();
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (e instanceof PermanentError) {
        console.error(JSON.stringify({ queue: batch.queue, status: 'dropped', error }));
        msg.ack();
      } else {
        console.error(JSON.stringify({ queue: batch.queue, status: 'retry', attempts: msg.attempts, error }));
        msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
      }
    }
  }
}
