# Telemetry

Usage statistics for scoop.md: who installs and keeps the extension, which documentation sites it is used on, what works and what breaks, how the library API is used, and how the website is found. Everything here is disclosed on [scoop.md/privacy](../site/src/pages/privacy.astro) and in the Web Store data-usage answers ([extension/STORE.md](../extension/STORE.md)); a test (`test/manifest.test.js`) fails if an event the backend accepts is missing from the privacy page.

## Rules

- **No identity.** No names, emails, Google account, cookies. The extension's random install ID is the only identifier.
- **No IP addresses stored.** The IP is used at ingest for rate limiting (the IP subject: IPv4, or the IPv6 /64), for Cloudflare's country/region/continent/network lookup (`request.cf`), and for a daily-rotating salted hash `HMAC(TELEMETRY_SALT, "ip:" + day + subject)` kept for abuse analysis. The website's visitor ID is the same idea with the user agent added. Neither can be linked across days without the salt, and the raw IP never reaches the queue, D1 or R2.
- **Only the clicked tab.** Events describe the page the user clicked scoop.md on, nothing else.
- **No private hosts.** Any event whose `site` is a private host (`isPrivateHost` in `extension/lib/hosts.js`: localhost, private and link-local IPs, `.local`, `.internal`, `.lan`, `.home.arpa`, single-label names) is dropped by the extension and again by the server.
- **Paths only for public pages.** A page's path (no query string, no fragment unless it is a `#/` route, tracking parameters stripped) is sent only when its content was fetched without cookies. For a page that only renders signed in, events carry the hostname only. `scoop_start` therefore carries no path: whether the page is public is known only at `scoop_result`.
- **Opt-out.** Settings → "Send usage statistics", on by default. Switching it off drops the unsent queue, sends exactly one `telemetry_opt_out`, and from then on nothing is sent (no daily ping either), and the uninstall page no longer gets the install ID. Switching it on sends `telemetry_opt_in` and `settings_change`.
- **Website.** No cookies, no storage, no third-party scripts. Page views and CTA clicks are skipped when the browser sends Global Privacy Control or Do Not Track.
- **API callers are not tracked.** Server-side API usage records the request, never an IP hash or install ID.

## Events

Envelope (`POST /v1/events`, JSON, sent as `text/plain` by beacons so there is no preflight):

```json
{ "installId": "<uuid v4>", "sessionId": "<uuid>", "client": { "extVersion": "0.3.0", "browser": "Google Chrome", "browserVersion": "130", "os": "mac", "platformArch": "arm64", "locale": "en-GB", "timezone": "Europe/London" },
  "events": [{ "name": "scoop_result", "ts": 1791780858485, "seq": 3, "props": { "site": "docs.stripe.com", "path": "/webhooks", "outcome": "copied_ready" } }] }
```

The website sends `{ "source": "site", "sessionId": "<random per page load>", "events": [...] }` without `installId` or `client`.

| Event | Source | Props |
|---|---|---|
| `install` | extension (service worker) | `reason` |
| `update` | extension (service worker) | `from`, `to` |
| `browser_update` | extension (service worker) | `from`, `to` (browser major version) |
| `active_daily` | extension (service worker, hourly alarm, once per UTC day) | |
| `telemetry_opt_out` / `telemetry_opt_in` | extension (options) | |
| `popup_open` | popup | `trigger` (accepted, not sent: MV3 can't tell toolbar from shortcut) |
| `popup_close` | popup | `durationMs` |
| `scoop_start` | popup | `site` |
| `scoop_result` | popup | `site`, `path`, `outcome` (`copied_ready` / `empty` / `error` / `unsupported_page`), `sourceKinds[]`, `sources`, `sizeBytes`, `truncated`, `durationMs`, `libraryHit`, `libraryWorked`, `isPublic`, `relatedLinks`, `clipboard` |
| `copy` | popup | `site`, `path`, `sizeBytes`, `trigger` (`auto` / `button`) |
| `rebuild` | popup | `site`, `path` |
| `share_result` | popup | `site`, `path`, `outcome` (`shared` / `duplicate` / `not_shared`), `reason` (`sharing_off`, `private_host`, `signed_in`, or the library's error code) |
| `vote` | popup | `site`, `path`, `skillId`, `worked`, `ok` |
| `report` | popup | `site`, `path`, `skillId`, `reason`, `ok` |
| `settings_change` | popup, options | `key` (`share` / `theme` / `telemetry`), `value` |
| `options_open` | options | |
| `error` | popup | `where`, `code`, `message` (≤200 chars, URLs and hostnames removed on both sides) |
| `page_view` | website | `path`, `referrerHost`, `utmSource`, `utmMedium`, `utmCampaign` |
| `cta_click` | website | `target`, `path` |
| `uninstall` | website (`/bye?i=<installId>&v=<version>`) | `installId`, `version` |
| `uninstall_reason` | website (`/bye`) | `installId`, `reason` (`too_noisy` / `didnt_work` / `privacy` / `other`) |
| `api_search`, `api_packages`, `api_best`, `api_sites`, `api_site`, `api_profile`, `api_topics` | server | `route`, `status`, `latencyMs`, `q` (≤200), `topic`, `results`, `hit`, `client` (`X-Scoop-Client`) |

The catalog lives in `backend/src/telemetry/schema.ts`; the reference server (`server/app.js`) keeps the same names, checked by a test.

Server-added fields on every event: `received_at`, `country`, `region`, `continent`, `as_org` (from `request.cf`), `ua_browser` / `ua_os` (parsed family and major version, the raw user agent is not kept), `ip_hash` (extension and website only), `visitor_id` (website only), and `outcome` (the event's result, for rollups).

## Pipeline

1. **Extension** (`extension/lib/telemetry.js`): `track()` appends to `chrome.storage.local.telemetryQueue` (≤500, oldest dropped). The popup sends its session's events with `navigator.sendBeacon` on `pagehide` (fetch `keepalive` if the beacon is refused) and drops them from the queue. The service worker (`extension/background.js`) flushes the whole queue on install/update/startup and on an hourly alarm, which also sends `active_daily` once per UTC day. Requests carry ≤100 events and ≤60 KB. A network error, 429 or 5xx keeps the queue and schedules a retry (1, 2, 4 … minutes, capped at 6 hours); a 4xx drops the refused batch. The endpoint is the library's base URL + `/events`, so `devLibraryUrl` works on unpacked installs.
2. **Ingest** (`POST /v1/events`, `backend/src/telemetry/ingest.ts`): Origin must be the extension, `https://scoop.md`, absent, or localhost in dev. Rate limit `EVENTS_LIMITER` (120 requests/min) per IP subject, then per install ID. Body ≤64 KB, ≤100 events, strict schema, timestamps within ±7 days. Answers `202 {accepted, dropped}` after one `TELEMETRY_QUEUE.send`.
3. **API usage**: after each response of the routes above, `ctx.waitUntil(recordApiUsage(...))` queues one event. `TELEMETRY_API_SAMPLE` (0–1, default 1) is the sampled share.
4. **Consumer** (`telemetry-events-<env>`, `backend/src/telemetry/consumer.ts`): drops events of deleted installs, writes the batch to R2 (one gzipped NDJSON object per receive hour), then per message, in one D1 transaction: `INSERT OR IGNORE` into `events` (the ID is a hash of install or visitor, session, seq and name, so resends and redeliveries are stored once), `events_daily` counts, `install_days`, the `installs` upsert, opt-out state (the last toggle wins) and uninstall state. Failures retry with backoff; 10 retries, then the dead-letter queue.
5. **Retention**: the daily cron (`17 4 * * *`) deletes `events` rows received more than 180 days ago. `events_daily`, `install_days`, `installs` and the R2 archive are kept.

## Storage

D1 (`backend/migrations/0008_telemetry.sql`):

| Table | Holds | Kept |
|---|---|---|
| `events` | every event, enriched (indexes: name+ts, install_id+ts, site+ts, received_at, day) | 180 days |
| `installs` | per install: first/last seen, install time, version, browser, OS, arch, locale, time zone, country, events/scoops/copies, opted out, uninstalled at and why | until deleted |
| `install_days` | (install_id, day) pairs: DAU/WAU/MAU and retention past 180 days | until deleted |
| `events_daily` | count per (day, source, name, site, country, version, outcome); no install IDs | forever |
| `telemetry_deletions` | install IDs whose data was deleted on request | forever |

R2 bucket `scoop-telemetry-<env>` (binding `TELEMETRY`; its own bucket so the archive's access, lifecycle and cost stay apart from the skills bucket):

- `telemetry/raw/dt=YYYY-MM-DD/hour=HH/<uuid>.ndjson.gz`: one JSON row per line, the D1 columns. A redelivered message can archive an event twice: dedupe on `id`.
- `telemetry/tombstones/<install_id>.json`: deletion tombstones. Objects are never rewritten; every read of the archive (`readArchive`, the admin export) skips tombstoned install IDs.

## Deletion requests

Users email team@ddamoah.com with the install ID shown on the extension's settings page. Admin console → Telemetry → Users → the install → "Delete all data for this install" (or `DELETE /api/telemetry/installs/<id>`): deletes its `events`, `installs` and `install_days` rows, records it in `telemetry_deletions` (the consumer then refuses its events), and writes the R2 tombstone. `events_daily` holds no install IDs and stays.

## Admin console

`admin.scoop.md` → Telemetry: Overview (installs and uninstalls per day, net installs, DAU/WAU/MAU, the popup → scoop → copy → vote funnel per session and per install, library hit rate, share outcomes, average size and duration), Sites (with a drilldown: paths, outcomes, sources, shares, search queries, best hit/miss, problems), Users (installs table and per-install timeline), Retention (weekly cohorts × weeks active), Versions & platforms (with update adoption), Geography, Errors, API usage (top and zero-result queries, packages, best hit/miss by site, clients), Website (page views, visitors, referrers, UTM, CTAs, the uninstall page) and Export (CSV or NDJSON of `events`, `installs`, `install_days`, `events_daily` for a date range, or the R2 archive as NDJSON for up to 31 days; a same-origin GET with `Content-Disposition: attachment`, CSV cells starting with `= + - @` are prefixed with `'`).

JSON endpoints (`/api/telemetry/…`): `overview?days=`, `sites?days=`, `sites/:site?days=`, `installs?status=&q=&cursor=`, `installs/:id`, DELETE `installs/:id`, `deletions`, `retention?weeks=`, `platforms?days=`, `geo?days=`, `errors?days=`, `api?days=`, `website?days=`, `export?table=&from=&to=&format=`.

## Remote resources (per environment)

| Resource | Dev | Staging | Production |
|---|---|---|---|
| Queue | `telemetry-events-dev` | `telemetry-events-staging` | `telemetry-events-production` |
| Dead-letter queue | `telemetry-events-dlq-dev` | `telemetry-events-dlq-staging` | `telemetry-events-dlq-production` |
| R2 bucket | `scoop-telemetry-dev` | `scoop-telemetry-staging` | `scoop-telemetry-production` |
| Rate limit namespace (`EVENTS_LIMITER`) | 4130 | 4131 | 4132 |
| Secret | `TELEMETRY_SALT` (`.dev.vars`) | `TELEMETRY_SALT` | `TELEMETRY_SALT` |
| Migration | `0008_telemetry.sql` | same | same |

See backend/README.md, "Before the first deploy", step 11.
