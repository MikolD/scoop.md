-- A re-crawl no longer hides a site's profile. site_profiles.status is the
-- outcome of the last finished crawl (ready | empty | blocked | failed, or
-- 'new' before the first one finishes) and changes only when a crawl finishes
-- or fails; whether a crawl is running now is crawl_state.

ALTER TABLE site_profiles ADD COLUMN crawl_state TEXT NOT NULL DEFAULT 'idle'; -- idle | crawling

-- Profiles caught mid-crawl by this migration: their previous outcome is
-- unknown, so they show as 'new' (not public) until their crawl finishes.
UPDATE site_profiles SET status = 'new', crawl_state = 'crawling' WHERE status = 'crawling';
