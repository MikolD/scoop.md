import type { CrawlParams } from './crawl/workflow.ts';
import type { IndexMessage } from './index/indexer.ts';

export interface Env {
  DB: D1Database;
  SKILLS: R2Bucket;
  READ_LIMITER: RateLimit;
  // Crawl pipeline: page Markdown (pages/) and browser-crawl results (crawl-results/).
  CRAWL: R2Bucket;
  CRAWL_SITE: Workflow<CrawlParams>;
  // Search and query packages embed the query: 60/min per IP on top of READ_LIMITER.
  SEARCH_LIMITER: RateLimit;
  // Indexing and search (M4): embeddings, chunk vectors, the index-pages queue.
  AI: Ai;
  VECTORS: Vectorize;
  INDEX_QUEUE: Queue<IndexMessage>;
  // Secrets.
  ADMIN_TOKEN?: string;
  RATE_KEY?: string;
  E2B_API_KEY?: string;
  // R2 S3 API token (Object Read & Write on the crawl bucket) for presigning uploads.
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  OPENROUTER_API_KEY?: string;
  // Vars (docs/BACKEND.md §11).
  ENVIRONMENT?: 'dev' | 'staging' | 'production';
  EXTENSION_IDS?: string;
  ALLOW_ANY_EXTENSION?: string;
  ALLOW_LOCALHOST?: string;
  VERSION?: string;
  E2B_TEMPLATE_ID?: string;
  CRAWL_BUCKET_NAME?: string;
  // Classifier spend caps per UTC day, in USD: per site (default 2) and for the account (default 10).
  INDEX_DAILY_CAP_USD?: string;
  INDEX_DAILY_TOTAL_CAP_USD?: string;
}
