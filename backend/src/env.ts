import type { CrawlParams } from './crawl/workflow.ts';
import type { IndexMessage } from './index/indexer.ts';
import type { BatchParams } from './admin/batch-workflow.ts';
import type { TelemetryMessage } from './telemetry/ingest.ts';

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
  // Admin console (admin.scoop.md): static UI, seed crawl batches, failed Basic auth attempts (10/min per IP).
  ASSETS: Fetcher;
  CRAWL_BATCH: Workflow<BatchParams>;
  ADMIN_AUTH_LIMITER: RateLimit;
  // Usage telemetry (docs/TELEMETRY.md): POST /v1/events limit (per install and per IP subject),
  // the telemetry-events queue, and the raw-event archive bucket (scoop-telemetry-<env>).
  // Telemetry has its own D1 database (migrations-telemetry/), apart from DB.
  TELEMETRY_DB: D1Database;
  EVENTS_LIMITER: RateLimit;          // 30/min per IP subject
  EVENTS_INSTALL_LIMITER: RateLimit;  // 10/min per install ID
  TELEMETRY_QUEUE: Queue<TelemetryMessage>;
  TELEMETRY: R2Bucket;
  // Secrets.
  ADMIN_TOKEN?: string;
  // Admin console Basic auth: user name and passcode. Unset means no one gets in.
  ADMIN_UI_USER?: string;
  ADMIN_UI_PASSCODE?: string; // at least 32 characters, or no one gets in
  // The admin console's host in this environment (admin.scoop.md, admin-staging.scoop.md).
  ADMIN_HOST?: string;
  // Browser sandbox (E2B) spend cap per UTC day, in USD (default 2).
  E2B_DAILY_CAP_USD?: string;
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
  // Usage telemetry switches (docs/TELEMETRY.md): on | lifecycle | off; share of API
  // requests recorded (0–1); daily ceilings for events (then lifecycle only) and API rows.
  TELEMETRY_INGEST?: string;
  TELEMETRY_API_SAMPLE?: string;
  TELEMETRY_DAILY_MAX?: string;
  TELEMETRY_API_DAILY_MAX?: string;
}
