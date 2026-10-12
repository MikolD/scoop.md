-- Index outcomes per run, so a crawl request completes when every page it
-- stored reached an outcome, not only when each was indexed
-- (docs/BACKEND-DECISIONS.md, "Crawl requests"). A page whose indexing was
-- skipped (its site rejected, its page row gone) or failed for good (a
-- permanent error, or the last delivery before the dead-letter queue) is
-- recorded as such and counted as done.

-- indexed | skipped | failed. A later success turns a row back to 'indexed'.
ALTER TABLE index_run_costs ADD COLUMN outcome TEXT NOT NULL DEFAULT 'indexed';

-- Pages of the run whose indexing was skipped or failed for good.
ALTER TABLE crawl_runs ADD COLUMN pages_index_failed INTEGER NOT NULL DEFAULT 0;
-- When any of the run's pages last reached an outcome: a request whose crawl
-- shows no index progress for 5 minutes is reported complete.
ALTER TABLE crawl_runs ADD COLUMN index_progress_at TEXT;
