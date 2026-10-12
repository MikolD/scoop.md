-- Link health (docs/BACKEND-DECISIONS.md, "No broken links"): the agent must
-- never get a link that 404s. Every URL the crawler fetches, and every link
-- target found in crawled pages, gets a status; packages, search snippets,
-- /v1/quick and shared skills only keep links known to be ok.

CREATE TABLE link_status (
  url         TEXT PRIMARY KEY,           -- normalised (fragment dropped, #/ routes kept)
  ok          INTEGER NOT NULL,           -- 1: 2xx, directly or after redirects; 0: 4xx, 5xx or the host doesn't resolve
  status      INTEGER,                    -- the final HTTP status; null when no answer came back
  final_url   TEXT,                       -- where the redirects ended
  checked_at  TEXT NOT NULL,
  source      TEXT NOT NULL,              -- crawl (fetched by the crawler) | check (the link checker) | live (POST /v1/links/check)
  bad_checks  INTEGER NOT NULL DEFAULT 0  -- consecutive bad results: 1 is re-checked a day later, 2 or more is permanently bad
);
CREATE INDEX link_status_bad ON link_status (ok, checked_at);

-- Where links were found: which site's pages link to a URL (the admin's broken-links view).
CREATE TABLE link_refs (
  site      TEXT NOT NULL,
  url       TEXT NOT NULL,
  page_url  TEXT NOT NULL,                -- one page that links to it
  seen_at   TEXT NOT NULL,
  PRIMARY KEY (site, url)
);
CREATE INDEX link_refs_url ON link_refs (url);

-- Links met while serving (packages, skills, /v1/links/check) with no status
-- yet: unlinked meanwhile, checked by the hourly cron.
CREATE TABLE link_check_queue (
  url        TEXT PRIMARY KEY,
  site       TEXT,
  queued_at  TEXT NOT NULL
);

-- Pages fetched before this migration: their sources were fetched with a
-- 200 by the crawler, and their pages are what they stand for.
INSERT OR IGNORE INTO link_status (url, ok, status, final_url, checked_at, source)
  SELECT source_url, 1, 200, source_url, fetched_at, 'crawl' FROM pages;
INSERT OR IGNORE INTO link_status (url, ok, status, final_url, checked_at, source)
  SELECT url, 1, 200, url, fetched_at, 'crawl' FROM pages;
INSERT OR IGNORE INTO link_status (url, ok, status, final_url, checked_at, source)
  SELECT url, 1, 200, url, indexed_at, 'crawl' FROM page_index;

-- Instructions a site addresses to AI agents (use the v2 API, prefer our MCP
-- server, always pass a version header), found at crawl time with Jev.
-- Replaced on every crawl of the site.
CREATE TABLE site_agent_instructions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  site      TEXT NOT NULL,
  text      TEXT NOT NULL,                -- at most 300 characters
  url       TEXT NOT NULL,                -- its source, a verified URL
  kind      TEXT NOT NULL,                -- usage-rule | preferred-tool | version-pin | deprecation | auth-or-safety | other
  score     REAL NOT NULL,                -- Jev's probability that it is guidance for agents
  found_at  TEXT NOT NULL
);
CREATE INDEX site_agent_instructions_site ON site_agent_instructions (site, score);

-- llms.txt that is really a docs index for agents: fetched with a 200, plain
-- text or Markdown, starting with an H1 and holding at least one link.
ALTER TABLE site_profiles ADD COLUMN has_llms_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_profiles ADD COLUMN has_llms_full_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_profiles ADD COLUMN llms_checked_at TEXT;
