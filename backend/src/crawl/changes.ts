// Whether a fetched page is new, changed or unchanged, and what that means for
// storage: content is addressed by hash (pages/<sha256>.md), so an unchanged
// page writes nothing to R2 and is not queued for indexing.

import { sha256Hex } from '../lib/ids.ts';

export type Change = 'new' | 'changed' | 'unchanged';

export interface PrevPage {
  content_hash: string;
  etag: string | null;
  last_modified: string | null;
}

export const pageKey = (hash: string) => `pages/${hash}.md`;

// The hash of the content as stored (UTF-8 text, as fetched).
export const contentHash = (markdown: string) => sha256Hex(markdown);

// `hash` is null when the server answered 304 Not Modified.
export function classify(prev: PrevPage | null, hash: string | null): Change {
  if (!prev) return hash === null ? 'unchanged' : 'new';
  if (hash === null || hash === prev.content_hash) return 'unchanged';
  return 'changed';
}

// Only new and changed pages go to the index queue.
export const needsIndexing = (c: Change) => c !== 'unchanged';
