-- What each crawl costs (docs/BACKEND-DECISIONS.md, "Cost per crawl"). The
-- crawler's index messages carry the run that queued them; the indexer
-- records what indexing that page cost in the same D1 batch as its
-- page_index write, so a redelivered message that finds the page already
-- indexed adds nothing. index_costs (the daily caps) is unchanged.

-- Indexing spend per (run, page, content). run_id is a crawl run, or
-- 'reclassify:YYYY-MM-DD' (the daily cron, per UTC day) or 'manual' (POST
-- /v1/admin/index, messages without a run).
CREATE TABLE index_run_costs (
  run_id            TEXT NOT NULL,
  url               TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  site              TEXT NOT NULL,
  classify_cost_usd REAL NOT NULL DEFAULT 0, -- OpenRouter spend on this call (a cached classification is free)
  embed_tokens      INTEGER NOT NULL DEFAULT 0,
  embed_cost_usd    REAL NOT NULL DEFAULT 0, -- Workers AI estimate: embed_tokens x the published rate
  indexed           INTEGER NOT NULL DEFAULT 0, -- 1 once the page was indexed for this run
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (run_id, url, content_hash)
);
CREATE INDEX index_run_costs_day ON index_run_costs (run_id, updated_at);

-- Per-run totals, recomputed from index_run_costs in the same batch (so
-- repeating a write never drifts). Sandbox spend stays in crawl_runs.cost_usd
-- and the gate's in gate_cost_usd.
ALTER TABLE crawl_runs ADD COLUMN classify_cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE crawl_runs ADD COLUMN embed_cost_usd    REAL NOT NULL DEFAULT 0;
ALTER TABLE crawl_runs ADD COLUMN pages_indexed     INTEGER NOT NULL DEFAULT 0;
-- Runs from before this migration have no indexing costs on record: they are
-- shown as untracked and left out of the averages. Every new run is tracked.
ALTER TABLE crawl_runs ADD COLUMN costs_tracked     INTEGER NOT NULL DEFAULT 1;
UPDATE crawl_runs SET costs_tracked = 0;

-- Every run's cost broken down, its total and its cost per stored page
-- (new + changed). indexing_done: every page the run stored is indexed, so
-- the total is final (never, for an untracked run).
CREATE VIEW crawl_run_costs AS
SELECT
  id, site, status, path, forced, started_at, finished_at, costs_tracked,
  pages_new + pages_changed AS pages_stored,
  pages_indexed,
  cost_usd AS browser_cost_usd,
  gate_cost_usd,
  classify_cost_usd,
  embed_cost_usd,
  cost_usd + gate_cost_usd + classify_cost_usd + embed_cost_usd AS total_cost_usd,
  CASE WHEN pages_new + pages_changed > 0
    THEN (cost_usd + gate_cost_usd + classify_cost_usd + embed_cost_usd) / (pages_new + pages_changed) END AS cost_per_page,
  costs_tracked AND pages_indexed >= pages_new + pages_changed AS indexing_done
FROM crawl_runs;
