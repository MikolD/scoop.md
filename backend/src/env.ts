export interface Env {
  DB: D1Database;
  SKILLS: R2Bucket;
  READ_LIMITER: RateLimit;
  // Secret.
  ADMIN_TOKEN?: string;
  // Vars (docs/BACKEND.md §11).
  EXTENSION_IDS?: string;
  ALLOW_ANY_EXTENSION?: string;
  ALLOW_LOCALHOST?: string;
  VERSION?: string;
}
