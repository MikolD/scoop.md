-- Crawl requests, production rules (docs/BACKEND-DECISIONS.md, "Crawl
-- requests"): sites first crawled because a user asked are kept out of
-- cross-site search until an admin approves them; requested runs are marked
-- so their spend can be held to a share of the daily caps; a request
-- remembers the scope (start URL) its crawl covers.

-- admin: crawled by an admin, a seed batch or before this migration.
-- requested: first crawled because a user asked (POST /v1/crawl-requests).
ALTER TABLE site_profiles ADD COLUMN source TEXT NOT NULL DEFAULT 'admin';
-- 0: a requested site not yet approved: its own endpoints work, cross-site
-- search (GET /v1/search without site) leaves it out.
ALTER TABLE site_profiles ADD COLUMN approved INTEGER NOT NULL DEFAULT 1;
CREATE INDEX site_profiles_pending ON site_profiles (approved) WHERE approved = 0;

-- 1: started by a crawl request (on-demand spend share, ONDEMAND_*_SHARE).
ALTER TABLE crawl_runs ADD COLUMN requested INTEGER NOT NULL DEFAULT 0;

-- The scope a request's crawl covers (its start URL). Join and cooldown are
-- per scope; a request whose scope can't start yet (another scope of the
-- site is crawling) waits with run_id null and state 'waiting'.
ALTER TABLE crawl_requests ADD COLUMN start_url TEXT;
CREATE INDEX crawl_requests_waiting ON crawl_requests (site, created_at) WHERE state = 'waiting';
