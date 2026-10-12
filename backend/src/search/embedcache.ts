// Query embeddings cached in the Cache API for 10 minutes, keyed by the
// normalised query, so repeated or flooded searches don't each cost a
// Workers AI call. The vector depends only on the text, so site and slot
// filters share one entry.

import { sha256Hex } from '../lib/ids.ts';
import { EMBED_MODEL } from '../index/embed.ts';
import type { Embed } from '../index/embed.ts';

export const QUERY_EMBED_TTL = 600;

export const normalizeQuery = (q: string) => q.toLowerCase().replace(/\s+/g, ' ').trim();

export function cachedQueryEmbed(embed: Embed, cache: Pick<Cache, 'match' | 'put'> | undefined): Embed {
  return async (texts, mode) => {
    if (mode !== 'query' || texts.length !== 1 || !cache) return embed(texts, mode);
    const q = normalizeQuery(texts[0]);
    // A synthetic URL: the cache only stores GET requests keyed by URL.
    const key = new Request(`https://query-embeddings.scoop.md/${encodeURIComponent(EMBED_MODEL)}/${await sha256Hex(q)}`);
    try {
      const hit = await cache.match(key);
      if (hit) return [(await hit.json()) as number[]];
    } catch {
      // A cache failure only costs an embedding call.
    }
    const [vector] = await embed([q], mode);
    try {
      await cache.put(key, new Response(JSON.stringify(vector), { headers: { 'cache-control': `public, max-age=${QUERY_EMBED_TTL}` } }));
    } catch {
      // Same.
    }
    return [vector];
  };
}
