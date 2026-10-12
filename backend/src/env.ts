import type { IndexMessage } from './db/crawl.ts';
import type { CrawlParams } from './crawl/workflow.ts';

export interface Env {
  DB: D1Database;
  SKILLS: R2Bucket;
  READ_LIMITER: RateLimit;
  // Crawl pipeline: page Markdown (pages/) and browser-crawl results (crawl-results/).
  CRAWL: R2Bucket;
  CRAWL_SITE: Workflow<CrawlParams>;
  INDEX_QUEUE: Queue<IndexMessage>;
  // Secrets.
  ADMIN_TOKEN?: string;
  RATE_KEY?: string;
  E2B_API_KEY?: string;
  // R2 S3 API token (Object Read & Write on the crawl bucket) for presigning uploads.
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  // Vars (docs/BACKEND.md §11).
  ENVIRONMENT?: 'dev' | 'staging' | 'production';
  EXTENSION_IDS?: string;
  ALLOW_ANY_EXTENSION?: string;
  ALLOW_LOCALHOST?: string;
  VERSION?: string;
  E2B_TEMPLATE_ID?: string;
  CRAWL_BUCKET_NAME?: string;
}
