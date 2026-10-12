// Embeddings through the Workers AI binding (the only Workers API in indexing
// besides storage). Qwen3-Embedding-0.6B: 1,024 dimensions, an 8k-token context
// that fits whole 800-token chunks, and separate query/document modes.

export const EMBED_MODEL = '@cf/qwen/qwen3-embedding-0.6b';
export const EMBED_DIMS = 1024;
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
