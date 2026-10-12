-- M4 indexing and search (docs/BACKEND-DECISIONS.md, "Indexing and search").
-- Page Markdown lives in R2 at pages/<content_hash>.md (written by the crawler,
-- or by POST /v1/admin/index). Vectors live in Vectorize, keyed by chunks.id.

-- One row per indexed page: the classifier's output for one content hash.
CREATE TABLE page_index (
  url           TEXT PRIMARY KEY,
  site          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  slot          TEXT NOT NULL,
  topic         TEXT NOT NULL DEFAULT '',  -- topic_path joined with '/', for prefix queries
  topic_path    TEXT NOT NULL DEFAULT '[]', -- JSON array, 2-4 levels
  summary       TEXT NOT NULL DEFAULT '',
  tasks         TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  entities      TEXT NOT NULL DEFAULT '[]', -- JSON array of {kind, name}
  model         TEXT NOT NULL,              -- 'none' when the daily cost cap skipped classification
  cost_usd      REAL NOT NULL DEFAULT 0,
  indexed_at    TEXT NOT NULL
);
CREATE INDEX page_index_site_topic ON page_index (site, topic);

-- Heading-aware Markdown chunks. rowid is the FTS5 content rowid; id is the
-- Vectorize vector ID.
CREATE TABLE chunks (
  rowid         INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  url           TEXT NOT NULL,
  site          TEXT NOT NULL,
  ord           INTEGER NOT NULL,
  heading_path  TEXT NOT NULL DEFAULT '',   -- "Title > Section > Subsection"
  title         TEXT NOT NULL DEFAULT '',   -- page title, repeated so FTS5 can index it
  text          TEXT NOT NULL
);
CREATE INDEX chunks_url ON chunks (url, ord);

-- External-content FTS5 index over chunks, kept in sync by triggers. porter
-- stems English words; unicode61 splits identifiers on punctuation, so
-- `stripe.webhooks.constructEvent` indexes `constructevent` as its own token.
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text, heading_path, title,
  content = 'chunks', content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, text, heading_path, title) VALUES (new.rowid, new.text, new.heading_path, new.title);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text, heading_path, title) VALUES ('delete', old.rowid, old.text, old.heading_path, old.title);
END;

CREATE TABLE entities (
  site  TEXT NOT NULL,
  kind  TEXT NOT NULL,
  name  TEXT NOT NULL,
  url   TEXT NOT NULL
);
CREATE INDEX entities_site_name ON entities (site, name);
CREATE INDEX entities_url ON entities (url);

-- Pages per topic prefix: a page at a/b/c counts towards a, a/b and a/b/c.
CREATE TABLE topics (
  site   TEXT NOT NULL,
  path   TEXT NOT NULL,
  count  INTEGER NOT NULL,
  PRIMARY KEY (site, path)
);

-- Classifier spend per site per UTC day, for the daily cost cap.
CREATE TABLE index_costs (
  site      TEXT NOT NULL,
  day       TEXT NOT NULL,                -- YYYY-MM-DD (UTC)
  cost_usd  REAL NOT NULL,
  PRIMARY KEY (site, day)
);
