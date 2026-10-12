-- Jev (TypeSafe's System One model: the devtool gate's check and page
-- classification, docs/BACKEND-DECISIONS.md, "Jev") is billed in tokens and
-- its price isn't published yet. Tokens are recorded next to the existing
-- USD columns, which get tokens × JEV_USD_PER_MTOK (default 0) added.

-- Per page and run: Jev tokens spent classifying it.
ALTER TABLE index_run_costs ADD COLUMN jev_tokens INTEGER NOT NULL DEFAULT 0;
-- Per run: classification tokens (recomputed from index_run_costs) and the gate's.
ALTER TABLE crawl_runs ADD COLUMN jev_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crawl_runs ADD COLUMN gate_jev_tokens INTEGER NOT NULL DEFAULT 0;
-- Per site and UTC day, next to the classifier spend the daily caps count.
ALTER TABLE index_costs ADD COLUMN jev_tokens INTEGER NOT NULL DEFAULT 0;
