import type { IndexMessage } from './index/indexer.ts';

export interface Env {
  DB: D1Database;
  SKILLS: R2Bucket;
  READ_LIMITER: RateLimit;
  // Search and query packages embed the query: 60/min per IP on top of READ_LIMITER.
  SEARCH_LIMITER: RateLimit;
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
  // Classifier spend caps per UTC day, in USD: per site (default 2) and for the account (default 10).
  INDEX_DAILY_CAP_USD?: string;
  INDEX_DAILY_TOTAL_CAP_USD?: string;
}
