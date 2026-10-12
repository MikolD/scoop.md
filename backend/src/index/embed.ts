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
// Total characters per call. Workers AI answers "3030: input too big" for a
// request over its token budget: on staging a 27-chunk page of rule codes
// (55 KB of Markdown, all in one 32-input batch) never indexed. Dense text
// tokenises at far more than chars / 4, so batches are kept small by size,
// and a batch that is still refused is split in half, and a single input
// halved, until it fits.
const MAX_BATCH_CHARS = 16_000;
const MIN_INPUT_CHARS = 500;

export type Embed = (texts: string[], mode: 'query' | 'document') => Promise<number[][]>;

const tooBig = (e: unknown) => /\b3030\b|too (big|large|long)/i.test(e instanceof Error ? e.message : String(e));

// Batches of at most BATCH inputs and MAX_BATCH_CHARS characters, in order.
export function packBatches(texts: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const t of texts.map((x) => x.slice(0, MAX_CHARS))) {
    if (cur.length && (cur.length === BATCH || size + t.length > MAX_BATCH_CHARS)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(t);
    size += t.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function workersAiEmbed(ai: Ai): Embed {
  return async (texts, mode) => {
    const call = async (batch: string[]): Promise<number[][]> => {
      const res = await ai.run(EMBED_MODEL, mode === 'query' ? { queries: batch } : { documents: batch });
      const data = res.data ?? [];
      if (data.length !== batch.length || data.some((v) => v.length !== EMBED_DIMS)) {
        throw new Error(`${EMBED_MODEL} returned ${data.length} vectors for ${batch.length} inputs`);
      }
      return data;
    };
    // Refused as too big: halve the batch, or the one input, and try again.
    const fit = async (batch: string[]): Promise<number[][]> => {
      try {
        return await call(batch);
      } catch (e) {
        if (!tooBig(e)) throw e;
        if (batch.length > 1) {
          const mid = Math.ceil(batch.length / 2);
          return [...(await fit(batch.slice(0, mid))), ...(await fit(batch.slice(mid)))];
        }
        if (batch[0].length <= MIN_INPUT_CHARS) throw e;
        return fit([batch[0].slice(0, Math.floor(batch[0].length / 2))]);
      }
    };
    const out: number[][] = [];
    for (const batch of packBatches(texts)) out.push(...(await fit(batch)));
    return out;
  };
}

// Shares Workers AI calls between concurrent callers: texts asked for within
// `waitMs` of each other are embedded together (packed by packBatches), so a
// queue batch of small pages costs a few calls instead of one or more per
// page. When a shared call fails, each caller's texts are embedded on their
// own, so one bad page can't fail the others.
export function coalesceEmbed(embed: Embed, waitMs = 25): Embed {
  type Job = { texts: string[]; mode: 'query' | 'document'; resolve: (v: number[][]) => void; reject: (e: unknown) => void };
  let pending: Job[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const alone = (j: Job) => embed(j.texts, j.mode).then(j.resolve, j.reject);
  const flush = async () => {
    const jobs = pending;
    pending = [];
    timer = null;
    for (const mode of ['document', 'query'] as const) {
      const group = jobs.filter((j) => j.mode === mode);
      if (group.length === 1) void alone(group[0]);
      if (group.length < 2) continue;
      try {
        const all = await embed(group.flatMap((j) => j.texts), mode);
        let i = 0;
        for (const j of group) {
          j.resolve(all.slice(i, i + j.texts.length));
          i += j.texts.length;
        }
      } catch {
        for (const j of group) void alone(j);
      }
    }
  };
  return (texts, mode) =>
    new Promise((resolve, reject) => {
      if (!texts.length) return resolve([]);
      pending.push({ texts, mode, resolve, reject });
      timer ??= setTimeout(() => void flush(), waitMs);
    });
}
