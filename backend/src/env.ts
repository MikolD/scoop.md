import type { IndexMessage } from './index/indexer.ts';

export interface Env {
  DB: D1Database;
  SKILLS: R2Bucket;
  READ_LIMITER: RateLimit;
  // Indexing and search (M4): embeddings, chunk vectors, the index-pages queue.
  AI: Ai;
  VECTORS: Vectorize;
  INDEX_QUEUE: Queue<IndexMessage>;
  // Secrets.
  ADMIN_TOKEN?: string;
  RATE_KEY?: string;
  OPENROUTER_API_KEY?: string;
  // Vars (docs/BACKEND.md §11).
  ENVIRONMENT?: 'dev' | 'staging' | 'production';
  EXTENSION_IDS?: string;
  ALLOW_ANY_EXTENSION?: string;
  ALLOW_LOCALHOST?: string;
  VERSION?: string;
  // Classifier spend cap per site per UTC day, in USD (default 2).
  INDEX_DAILY_CAP_USD?: string;
}
