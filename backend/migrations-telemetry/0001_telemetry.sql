-- Usage telemetry (docs/TELEMETRY.md), in its own D1 database (binding
-- TELEMETRY_DB, migrations-telemetry/), so a flood of events can never fill
-- the database the library runs on. Events from the extension and the
-- website (POST /v1/events) and API usage, written by the telemetry-events
-- queue consumer (src/telemetry/consumer.ts). Raw events are kept 180 days
-- (the hourly cron prunes them, and clears ip_hash after 30 days); the
-- rollups and the R2 archive are kept. No IP addresses, names, emails or
-- cookies are ever stored.

-- One row per event. id is derived from (install or visitor, session, seq,
-- name), so a resent or redelivered event is ignored. rolled is 0 only inside
-- the consumer's transaction, until the event is counted in the rollups.
CREATE TABLE events (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,            -- extension | site | api
  name            TEXT NOT NULL,            -- docs/TELEMETRY.md, "Events"
  ts              TEXT NOT NULL,            -- client time (ISO), within 7 days of received_at
  day             TEXT NOT NULL,            -- UTC day of ts
  received_at     TEXT NOT NULL,
  install_id      TEXT,                     -- extension events, and the website's uninstall events
  session_id      TEXT,
  visitor_id      TEXT,                     -- website: HMAC(that day's random key, IP subject + user agent), no cookie
  seq             INTEGER,
  site            TEXT,                     -- public hostname only
  path            TEXT,                     -- public pages only; no query or fragment
  outcome         TEXT,                     -- outcome / hit|miss / worked|failed / reason, for rollups
  props           TEXT NOT NULL DEFAULT '{}', -- the event's other properties (JSON, schema-checked)
  ext_version     TEXT,
  browser         TEXT,
  browser_version TEXT,
  os              TEXT,
  arch            TEXT,
  locale          TEXT,
  timezone        TEXT,
  ua_browser      TEXT,                     -- parsed from the User-Agent at ingest (family and major version)
  ua_os           TEXT,
  country         TEXT,                     -- Cloudflare's request.cf, from the IP; the IP itself is never stored
  region          TEXT,
  continent       TEXT,
  as_org          TEXT,                     -- the network's ISP or organisation (coarse)
  ip_hash         TEXT,                     -- HMAC(that day's random key, IP subject); the key is deleted after 48 h, the hash after 30 days
  rolled          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX events_name_ts ON events (name, ts);
CREATE INDEX events_install_ts ON events (install_id, ts);
CREATE INDEX events_site_ts ON events (site, ts);
CREATE INDEX events_received ON events (received_at);
CREATE INDEX events_day ON events (day);
CREATE INDEX events_unrolled ON events (rolled) WHERE rolled = 0;

-- One row per extension install ID that sent extension events (an uninstall
-- alone never creates one: see uninstalls).
CREATE TABLE installs (
  install_id       TEXT PRIMARY KEY,
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  installed_at     TEXT,                    -- the install event, when we saw it
  ext_version      TEXT,
  browser          TEXT,
  browser_version  TEXT,
  os               TEXT,
  arch             TEXT,
  locale           TEXT,
  timezone         TEXT,
  country          TEXT,
  events           INTEGER NOT NULL DEFAULT 0,
  scoops           INTEGER NOT NULL DEFAULT 0, -- scoop_result events
  copies           INTEGER NOT NULL DEFAULT 0, -- copy events
  opted_out        INTEGER NOT NULL DEFAULT 0,
  opted_out_at     TEXT,
  opted_changed_at TEXT,                    -- ts of the toggle that set opted_out: only a newer one changes it
  uninstalled_at   TEXT,
  uninstall_reason TEXT
);
CREATE INDEX installs_first_seen ON installs (first_seen);
CREATE INDEX installs_installed_at ON installs (installed_at);

-- Every uninstall reported by scoop.md/bye, whether or not the install is
-- known (known = 1 when an installs row existed). Unknown ones are counted
-- apart: they may be forged or predate telemetry.
CREATE TABLE uninstalls (
  install_id     TEXT PRIMARY KEY,
  uninstalled_at TEXT NOT NULL,
  reason         TEXT,
  version        TEXT,
  known          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX uninstalls_at ON uninstalls (uninstalled_at);
CREATE INDEX installs_last_seen ON installs (last_seen);

-- Days (UTC, by when the server received it) each install sent anything:
-- DAU/WAU/MAU and retention, kept past the 180-day pruning of events.
CREATE TABLE install_days (
  install_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  PRIMARY KEY (install_id, day)
);
CREATE INDEX install_days_day ON install_days (day);

-- Daily counts, kept forever. Empty strings stand for "none" so the key is unique.
CREATE TABLE events_daily (
  day     TEXT NOT NULL,
  source  TEXT NOT NULL,
  name    TEXT NOT NULL,
  site    TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  count   INTEGER NOT NULL,
  PRIMARY KEY (day, source, name, site, country, version, outcome)
);
CREATE INDEX events_daily_name ON events_daily (name, day);
CREATE INDEX events_daily_site ON events_daily (site, day);

-- Install IDs whose data was deleted on request. Their events are refused by
-- the consumer, and every R2 archive export skips them (the R2 tombstones,
-- telemetry/tombstones/<install_id>.json, are the archive's copy of this list).
CREATE TABLE telemetry_deletions (
  install_id     TEXT PRIMARY KEY,
  deleted_at     TEXT NOT NULL,
  events_deleted INTEGER NOT NULL DEFAULT 0
);

-- A random key per UTC day for ip_hash and visitor_id. Keys older than 48 h
-- are deleted, after which that day's hashes can't be linked to an IP.
CREATE TABLE day_keys (
  day        TEXT PRIMARY KEY,
  key        TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Daily quotas (src/telemetry/consumer.ts), by received day. kind is
-- ip_events (subject ip_hash), install_events (install ID), all_events and
-- api_rows (subject ''). Rows older than 2 days are deleted.
CREATE TABLE quota_counters (
  day     TEXT NOT NULL,
  kind    TEXT NOT NULL,
  subject TEXT NOT NULL,
  count   INTEGER NOT NULL,
  PRIMARY KEY (day, kind, subject)
);

-- Install IDs seen per ip_hash per day, for the new-installs-per-IP quota.
CREATE TABLE ip_installs (
  day        TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  install_id TEXT NOT NULL,
  PRIMARY KEY (day, ip_hash, install_id)
);
