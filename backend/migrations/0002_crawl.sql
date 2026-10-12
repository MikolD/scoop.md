-- Crawl pipeline (M2/M3): what we know about each docs site, each crawl run,
-- and every page fetched. Page content lives in R2 at pages/<content_hash>.md.
-- The v1 tables in 0001 are untouched.

-- One row per site (hostname, normalised like skills.site).
CREATE TABLE site_profiles (
  site               TEXT PRIMARY KEY,
  status             TEXT NOT NULL,          -- crawling | ready | empty | blocked | failed (needs_browser is its own column)
  docs_root          TEXT NOT NULL DEFAULT '/',
  has_llms           INTEGER NOT NULL DEFAULT 0,
  has_llms_full      INTEGER NOT NULL DEFAULT 0,
  llms_url           TEXT,
  llms_full_url      TEXT,
  md_twins_ratio     REAL,                   -- share of sampled sitemap pages with a .md twin; null if none sampled
  twin_pattern       TEXT,                   -- suffix (<path>.md) | index (<path>/index.md)
  sitemap_urls_count INTEGER NOT NULL DEFAULT 0,
  openapi_json       TEXT NOT NULL DEFAULT '[]', -- OpenAPI/Swagger URLs seen during discovery
  pages_fetched      INTEGER NOT NULL DEFAULT 0, -- pages stored for this site, all runs
  needs_browser      INTEGER NOT NULL DEFAULT 0,
  crawl_delay        REAL,                   -- robots.txt Crawl-delay for our UA, seconds
  last_crawled_at    TEXT,
  last_run_id        TEXT,
  updated_at         TEXT NOT NULL
);

CREATE TABLE crawl_runs (
  id              TEXT PRIMARY KEY,          -- cr_<ulid>, also the Workflow instance ID
  site            TEXT NOT NULL,
  start_url       TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL,             -- queued | running | complete | failed
  path            TEXT,                      -- markdown | html | browser | blocked | none
  pages_new       INTEGER NOT NULL DEFAULT 0,
  pages_changed   INTEGER NOT NULL DEFAULT 0,
  pages_unchanged INTEGER NOT NULL DEFAULT 0,
  pages_failed    INTEGER NOT NULL DEFAULT 0,
  pages_skipped   INTEGER NOT NULL DEFAULT 0, -- kept out by robots.txt, redirects off the site, the skip list or URL length
  browser_seconds REAL NOT NULL DEFAULT 0,   -- sandbox wall time, when escalated
  cost_usd        REAL NOT NULL DEFAULT 0,   -- estimated sandbox cost
  error           TEXT
);
CREATE INDEX crawl_runs_site ON crawl_runs (site, started_at DESC);
CREATE INDEX crawl_runs_active ON crawl_runs (site) WHERE status IN ('queued', 'running');

CREATE TABLE pages (
  url           TEXT PRIMARY KEY,            -- the page's URL (the HTML page, not its .md twin)
  site          TEXT NOT NULL,
  source_url    TEXT NOT NULL,               -- where the Markdown came from (.md twin, llms.txt, or the page itself)
  source_kind   TEXT NOT NULL,               -- page-md | llms | llms-full | page-html (converted in the Worker) | browser
  title         TEXT,
  content_hash  TEXT NOT NULL,               -- sha256 of the stored Markdown; R2 key pages/<hash>.md
  bytes         INTEGER NOT NULL,
  etag          TEXT,
  last_modified TEXT,
  fetched_at    TEXT NOT NULL,               -- last time we fetched it (any outcome but failure)
  changed_at    TEXT NOT NULL,               -- last time its content hash changed
  run_id        TEXT NOT NULL,               -- last run that fetched it
  -- Outbox for the index-pages queue: set in the same write as a new or
  -- changed content_hash, cleared once the message for that hash is sent.
  index_pending INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pages_site ON pages (site, url);
CREATE INDEX pages_hash ON pages (content_hash);
CREATE INDEX pages_index_pending ON pages (site) WHERE index_pending = 1;
