-- On-demand crawls asked for by the extension (POST /v1/crawl-requests,
-- src/crawl/requests.ts): every request with its outcome, daily request
-- limits, and the Workflow's phase on each run so a request can report it.

-- One row per request that was answered (rate-limited requests are not
-- recorded). The install ID is never stored: install_hash is
-- HMAC-SHA256(RATE_KEY, 'crawl-request:' || install ID), so requests from one
-- install can be grouped but not traced back to it.
CREATE TABLE crawl_requests (
  id           TEXT PRIMARY KEY,   -- rq_<ulid>: 80 random bits, the public handle
  site         TEXT NOT NULL,
  url          TEXT NOT NULL,      -- the page the user was on (normalised)
  install_hash TEXT NOT NULL,
  run_id       TEXT,               -- the crawl that answers it: started, joined or the recent one; null when rejected without a run
  -- What the request did: started (a new crawl) | joined (a crawl already
  -- queued/running) | recent (crawled within the cooldown) | rejected (not a
  -- devtool site). The live state comes from the run.
  state        TEXT NOT NULL,
  reason       TEXT,               -- why it was rejected
  created_at   TEXT NOT NULL,
  day          TEXT NOT NULL       -- YYYY-MM-DD (UTC) of created_at
);
CREATE INDEX crawl_requests_created ON crawl_requests (created_at DESC);
CREATE INDEX crawl_requests_site ON crawl_requests (site, created_at DESC);
CREATE INDEX crawl_requests_day ON crawl_requests (day, state);

-- Fixed-window counters per UTC day (like rate_counters, which is hourly and
-- prunes every past hour). `key` is HMAC-SHA256(RATE_KEY, bucket:day:subject);
-- rows from past days are deleted on every check.
CREATE TABLE daily_counters (
  key   TEXT NOT NULL,
  day   TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  count INTEGER NOT NULL,
  PRIMARY KEY (key, day)
);
CREATE INDEX daily_counters_day ON daily_counters (day);

-- Where the CrawlSite Workflow is: gate | discover | fetch | browser | done,
-- written at step boundaries. A run that finished but whose pages are still
-- in the index queue is reported as phase 'index' (derived, never stored).
ALTER TABLE crawl_runs ADD COLUMN phase TEXT;
