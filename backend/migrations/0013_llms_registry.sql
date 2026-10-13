-- scoop.md 0.6.0, "llms.txt first" (docs/BACKEND.md, "llms.txt"): every
-- scoop gives the user the docs site's llms.txt as a short link prompt. This
-- is the registry of every docs site's llms.txt: the site's own, or one
-- scoop.md built and hosts (its text in R2 at llms/<host>.txt). Only docs
-- sites are stored: a page that isn't docs leaves nothing behind.

CREATE TABLE llms_registry (
  host          TEXT PRIMARY KEY,              -- the docs host (www. dropped): docs.stripe.com, hono.dev
  docs_root     TEXT NOT NULL,                 -- https://docs.stripe.com, https://hono.dev/docs
  llms_url      TEXT NOT NULL,                 -- the site's own llms.txt, or https://scoop.md/<host>/llms.txt
  source        TEXT NOT NULL,                 -- site | scoop
  status        TEXT NOT NULL,                 -- ready | preparing (scoop-built, first build still running)
  stage         TEXT,                          -- scoop-built: instant (sitemap + navigation) | full (from a crawl)
  title         TEXT,                          -- the file's H1
  pages         INTEGER NOT NULL DEFAULT 0,    -- links in it
  tokens        INTEGER NOT NULL DEFAULT 0,    -- about chars / 4
  content_hash  TEXT,
  full_url      TEXT,                          -- a verified llms-full.txt, or null
  links_ok      INTEGER NOT NULL DEFAULT 0,    -- every link checked and existing (scoop-built files)
  agent_text    TEXT,                          -- "instructions for agents": verbatim lines (≤ 1,200 chars) from the file, or from the install pages
  agent_source  TEXT,                          -- where they come from (the llms.txt#section, or a page)
  agent_method  TEXT,                          -- section (headings and keywords) | jev (lines Jev selected)
  scoops        INTEGER NOT NULL DEFAULT 0,    -- how often it was asked for: refreshed more often when high
  checked_at    TEXT,
  changed_at    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX llms_registry_due ON llms_registry (checked_at);

-- Page hosts that lead to a docs host (stripe.com → docs.stripe.com), so the
-- next scoop from them reads the registry instead of probing. Docs only.
CREATE TABLE llms_aliases (
  page_host   TEXT PRIMARY KEY,
  host        TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
