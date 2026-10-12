-- The devtool gate (src/crawl/gate.ts): its verdict on each site and on each
-- run. A rejected run ends with crawl_runs.status 'rejected' and the site's
-- status 'not_devtool'; no page is fetched. `force` on POST /v1/admin/crawl
-- skips the gate and is recorded on the run.

ALTER TABLE site_profiles ADD COLUMN gate_category   TEXT; -- devtool-docs | devtool-marketing-only | ecommerce | search-engine | social | news | other
ALTER TABLE site_profiles ADD COLUMN gate_confidence REAL; -- 0-1
ALTER TABLE site_profiles ADD COLUMN gate_reason     TEXT; -- at most 200 characters
ALTER TABLE site_profiles ADD COLUMN gate_method     TEXT; -- denylist | allowlist | signals | ai | forced (an admin skipped the gate)
ALTER TABLE site_profiles ADD COLUMN gate_checked_at TEXT;

ALTER TABLE crawl_runs ADD COLUMN forced        INTEGER NOT NULL DEFAULT 0; -- the gate was skipped by an admin
ALTER TABLE crawl_runs ADD COLUMN gate_decision TEXT;                       -- crawl | reject; null when skipped or not reached
ALTER TABLE crawl_runs ADD COLUMN gate_category TEXT;
ALTER TABLE crawl_runs ADD COLUMN gate_method   TEXT;
ALTER TABLE crawl_runs ADD COLUMN gate_reason   TEXT;
ALTER TABLE crawl_runs ADD COLUMN gate_cost_usd REAL NOT NULL DEFAULT 0;   -- the AI check's OpenRouter spend (also in index_costs)
