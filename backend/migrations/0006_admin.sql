-- The admin console (admin.scoop.md, src/admin/): seed crawl batches driven
-- by the CrawlBatch Workflow, and lockouts for its Basic auth.

-- One batch of crawls started from the console. The Workflow starts jobs up
-- to `concurrency` at a time and stops once every job is final or the batch
-- is cancelled.
CREATE TABLE crawl_batches (
  id          TEXT PRIMARY KEY,               -- cb_<ulid>
  status      TEXT NOT NULL,                  -- running | complete | cancelled
  concurrency INTEGER NOT NULL,               -- 1-8
  max_pages   INTEGER,                        -- override for every job; null keeps each seed's
  force       INTEGER NOT NULL DEFAULT 0,     -- skip the devtool gate
  created_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX crawl_batches_created ON crawl_batches (created_at DESC);

CREATE TABLE crawl_batch_jobs (
  batch_id    TEXT NOT NULL,
  ord         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  site        TEXT NOT NULL,
  start_url   TEXT NOT NULL,
  max_pages   INTEGER NOT NULL,
  -- waiting | starting | running | complete | failed | rejected | cancelled | error
  status      TEXT NOT NULL,
  run_id      TEXT,                           -- crawl_runs.id once started
  attempts    INTEGER NOT NULL DEFAULT 0,     -- start attempts (a 409 is retried later)
  not_before  TEXT,                           -- a busy site waits until then
  error       TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (batch_id, ord)
);

-- Too many failed Basic auth attempts from one IP subject (key: HMAC of
-- ipSubject, never the IP): every request from it gets 429 until `until`,
-- right password or not.
CREATE TABLE admin_auth_lockouts (
  key   TEXT PRIMARY KEY,
  until TEXT NOT NULL
);
