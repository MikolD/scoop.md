-- v1 schema (docs/BACKEND.md §9). Section content lives in R2 at skills/<id>.json.

CREATE TABLE skills (
  id             TEXT PRIMARY KEY,
  site           TEXT NOT NULL,
  page_url       TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  fingerprint    TEXT NOT NULL,
  sources_json   TEXT NOT NULL,          -- [{kind,label,url}] for summaries without hitting R2
  size_bytes     INTEGER NOT NULL,
  worked         INTEGER NOT NULL DEFAULT 0,
  failed         INTEGER NOT NULL DEFAULT 0,
  last_worked_at TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL,          -- install ID
  removed_at     TEXT
);
CREATE INDEX skills_site_best ON skills (site, removed_at, last_worked_at DESC);
CREATE INDEX skills_site_recent ON skills (site, created_at DESC);
CREATE UNIQUE INDEX skills_site_fp ON skills (site, fingerprint) WHERE removed_at IS NULL;

CREATE TABLE votes (
  skill_id   TEXT NOT NULL REFERENCES skills(id),
  install_id TEXT NOT NULL,
  worked     INTEGER NOT NULL,           -- 1 or 0
  voted_at   TEXT NOT NULL,
  PRIMARY KEY (skill_id, install_id)
);

CREATE TABLE reports (
  id          TEXT PRIMARY KEY,
  skill_id    TEXT NOT NULL,
  install_id  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  details     TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX reports_open ON reports (resolved_at, created_at DESC);

-- Fixed-window counters for the hourly write limits (docs/BACKEND.md §8).
-- `key` is a SHA-256 of bucket + hour + install ID or IP, never the raw IP;
-- rows are deleted once their window has passed.
CREATE TABLE rate_counters (
  key    TEXT NOT NULL,
  hour   INTEGER NOT NULL,               -- window start, in hours since the Unix epoch
  count  INTEGER NOT NULL,
  PRIMARY KEY (key, hour)
);
CREATE INDEX rate_counters_hour ON rate_counters (hour);
