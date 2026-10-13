-- scoop.md 0.6.0, the llms.txt registry's security review (docs/BACKEND.md,
-- "llms.txt"): one builder at a time, a site's own file kept through a
-- passing outage, conditional refreshes, and instructions for agents that
-- passed Jev's risk question.

ALTER TABLE llms_registry ADD COLUMN building_until TEXT;                       -- a build holds the row until then (single flight)
ALTER TABLE llms_registry ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;     -- the site's own file unverifiable this many checks in a row
ALTER TABLE llms_registry ADD COLUMN etag TEXT;                                 -- the site's own file, for conditional refreshes
ALTER TABLE llms_registry ADD COLUMN last_modified TEXT;
ALTER TABLE llms_registry ADD COLUMN agent_checked INTEGER NOT NULL DEFAULT 0;  -- agent_text passed Jev's risk question (else it is not served)
ALTER TABLE llms_registry ADD COLUMN built_at TEXT;                             -- the scoop-built file was last built (the cron rebuilds weekly, or after a crawl)
