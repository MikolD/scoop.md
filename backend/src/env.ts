export interface Env {
  DB: D1Database;
  SKILLS: R2Bucket;
  READ_LIMITER: RateLimit;
  // Secrets.
  ADMIN_TOKEN?: string;
  RATE_KEY?: string;
  // Vars (docs/BACKEND.md §11).
  ENVIRONMENT?: 'dev' | 'staging' | 'production';
  EXTENSION_IDS?: string;
  ALLOW_ANY_EXTENSION?: string;
  ALLOW_LOCALHOST?: string;
  VERSION?: string;
}
