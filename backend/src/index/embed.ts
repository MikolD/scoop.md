// Embeddings through the Workers AI binding (the only Workers API in indexing
// besides storage). Qwen3-Embedding-0.6B: 1,024 dimensions, an 8k-token context
// that fits whole 800-token chunks, and separate query/document modes.

export const EMBED_MODEL = '@cf/qwen/qwen3-embedding-0.6b';
export const EMBED_DIMS = 1024;
// Workers AI price for EMBED_MODEL (developers.cloudflare.com/workers-ai/platform/pricing,
// October 2026): 1,075 neurons per million input tokens at $0.011 per 1,000
// neurons, i.e. about $0.0118 per million tokens. Before the free daily
// allocation, so an upper bound. Tokens are estimated (chunk.ts estimateTokens).
export const EMBED_NEURONS_PER_M_TOKENS = 1075;
export const USD_PER_1000_NEURONS = 0.011;
export const embedCostUsd = (tokens: number) => (tokens / 1_000_000) * EMBED_NEURONS_PER_M_TOKENS * (USD_PER_1000_NEURONS / 1000);
const BATCH = 32;
// Far above any chunk (a long code fence is the worst case), well inside the context.
const MAX_CHARS = 24_000;

export type Embed = (texts: string[], mode: 'query' | 'document') => Promise<number[][]>;

export function workersAiEmbed(ai: Ai): Embed {
  return async (texts, mode) => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map((t) => t.slice(0, MAX_CHARS));
      const res = await ai.run(EMBED_MODEL, mode === 'query' ? { queries: batch } : { documents: batch });
      const data = res.data ?? [];
      if (data.length !== batch.length || data.some((v) => v.length !== EMBED_DIMS)) {
        throw new Error(`${EMBED_MODEL} returned ${data.length} vectors for ${batch.length} inputs`);
      }
      out.push(...data);
    }
    return out;
  };
}
