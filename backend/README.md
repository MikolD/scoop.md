# scoop.md backend (api.scoop.md)

Cloudflare Worker serving the shared library API (`/v1`). The spec is
[`docs/BACKEND.md`](../docs/BACKEND.md); choices it doesn't make are in
[`docs/BACKEND-DECISIONS.md`](../docs/BACKEND-DECISIONS.md). `server/` at the
repo root is the dependency-free reference implementation of the same contract.

- Metadata, votes, reports, write rate-limit counters: **D1** (`DB`)
- Skill content (`skills/<id>.json`): **R2** (`SKILLS`)
- Read rate limit (600/min/IP): **rate limiting binding** (`READ_LIMITER`)
- Crawl pipeline: **Workflow** `CrawlSite` (`CRAWL_SITE`) writes page Markdown
  to **R2** `SKILLS` (`pages/<sha256>.md`) and one message per new or changed
  page to `INDEX_QUEUE`; browser crawls run in E2B sandboxes (`/crawler`) and
  upload their results to a separate **R2** bucket `CRAWL` (`crawl-results/`)
- Indexing and search (M4): page Markdown in **R2** (`SKILLS`, `pages/<sha256>.md`),
  index tables + FTS5 in **D1**, chunk vectors in **Vectorize** (`VECTORS`),
  embeddings from **Workers AI** (`AI`), page classification via **OpenRouter**,
  work arriving on the **Queue** `index-pages-<env>` (`INDEX_QUEUE`), failures
  ending in `index-pages-dlq-<env>`, and a daily **cron** re-enqueueing pages
  still waiting for a classification

## Layout

```
src/index.ts      Worker entry: CORS, read rate limit, errors, request log
src/env.ts        bindings and vars
src/api/          v1 routes (v1.ts) and HTTP helpers (http.ts)
src/lib/          portable logic, no Workers APIs: verify, ssrf, validate, ids, ranking
src/db/           D1/R2 stores (skills; crawl profiles, runs, pages) and hourly rate-limit counters
src/crawl/        Workflow "CrawlSite" and its portable parts (see src/crawl/README.md)
src/index/        Queue consumer and pipeline: classify → chunk → embed → Vectorize + D1
src/search/       hybrid search (FTS5 + Vectorize, RRF), topic trees, Markdown packages
migrations/       D1 migrations (wrangler d1 migrations apply)
test/             unit tests (node:test; node:sqlite stands in for D1)
```

`src/lib` is plain TypeScript over `fetch` and Web Crypto so later milestones
(reader links, re-verification, the crawler) can reuse verification and
ranking outside the request path.

## Local development

Node 22.18+ (unit tests run TypeScript directly and use `node:sqlite`).

```sh
cd backend
npm install
cp .dev.vars.example .dev.vars        # ADMIN_TOKEN, RATE_KEY, ALLOW_LOCALHOST=1, ALLOW_ANY_EXTENSION=1; add E2B_API_KEY for browser crawls
npm run db:migrate:local              # creates the local D1 in .wrangler/state
npm run dev                           # wrangler dev on http://localhost:8787
```

Checks:

```sh
npx tsc --noEmit                      # typecheck
npm test                              # unit tests
# contract tests, from the repo root, with `npm run dev` running:
SCOOP_API=http://127.0.0.1:8787 SCOOP_ADMIN_TOKEN=local-admin-token npm run test:contract
```

### Indexing and search locally

Workers AI and Vectorize have no local simulation, so the top-level config
binds `AI` and `VECTORS` with `remote: true` to the dev index
`scoop-chunks-dev` (needs `npx wrangler login`; embeddings are billed to the
account, fractions of a cent). D1, R2 and the queue stay local. Put
`OPENROUTER_API_KEY` in `.dev.vars`. Then:

```sh
npm run db:migrate:local
npx wrangler dev --port 8791
curl -X POST http://127.0.0.1:8791/v1/admin/index -H "Authorization: Bearer local-admin-token" \
  -d '{"url":"https://docs.stripe.com/webhooks.md"}'            # add "queue": true to go through index-pages-dev
curl 'http://127.0.0.1:8791/v1/search?q=verify+webhook+signature&site=docs.stripe.com'
curl  http://127.0.0.1:8791/v1/sites/docs.stripe.com/topics
curl 'http://127.0.0.1:8791/v1/packages?site=docs.stripe.com&q=verify+webhook+signature'
```

`npx wrangler dev --local` (what CI runs) needs no login: the remote bindings
are off, search answers from FTS5 alone and indexing fails at the embedding step.

The dev index was created with (it also has a `url` metadata index from
before that was dropped from the plan; harmless):

```sh
npx wrangler vectorize create scoop-chunks-dev --dimensions=1024 --metric=cosine
for p in site slot; do npx wrangler vectorize create-metadata-index scoop-chunks-dev --property-name=$p --type=string; done
```

Local state persists in `.wrangler/state`. Each contract run makes about a dozen
share attempts from 127.0.0.1, so a few runs in the same hour hit the 60/hour
per-IP share limit (429). Reset with:

```sh
npx wrangler d1 execute DB --local --command "DELETE FROM rate_counters"
```

## Crawling sites

Every crawl starts with the **devtool gate** (`src/crawl/gate.ts`): known docs
hosts pass, known shops, search engines, social and news sites are rejected
(`src/crawl/gate-lists.ts`, easy to extend), and everything else is judged on
its start page, with one cheap OpenRouter call only when that is
inconclusive. A rejected run ends as `rejected` before any page is fetched,
and the site's profile says why:

```sh
curl http://127.0.0.1:8787/v1/sites/amazon.com/profile
# {"profile":{"site":"amazon.com","status":"not_devtool","category":"ecommerce","reason":"amazon.com is a known ecommerce site (amazon.*)",…}}
```

Add `"force": true` to the crawl request to skip the gate (recorded on the run).

### The seed list and the crawl runner

`seeds/devtools.json` lists about 100 developer docs people use daily
(`{name, site, startUrl, maxPages}`, default 200 pages). `scripts/crawl-seeds.mjs`
starts the crawls a few at a time, never two of the same site, retries a site
that is busy (409) later, polls every run and prints a live table, then a
summary (status, path, pages new/changed/unchanged/failed/skipped, gate
verdict, cost). The admin token comes from `STAGING_ADMIN_TOKEN` or
`PRODUCTION_ADMIN_TOKEN` (`LOCAL_ADMIN_TOKEN` for `--env local`) and is never
printed.

```sh
cd backend
set -a; . ~/.config/scoop.md.env; set +a          # STAGING_ADMIN_TOKEN, PRODUCTION_ADMIN_TOKEN

npm run crawl:seeds -- --env staging --dry-run     # what would run, with each seed's gate list verdict; no requests
npm run crawl:seeds -- --env staging --only react.dev,docs.stripe.com --max-pages 20
npm run crawl:seeds -- --env staging --concurrency 4 --out seeds-staging.json
npm run crawl:seeds -- --env production --out seeds-production.json

npm run crawl:site -- --env staging https://docs.example.com/        # one site (several URLs work too)
npm run crawl:site -- --env staging --force https://example.com/docs # skip the gate

# against wrangler dev
LOCAL_ADMIN_TOKEN=local-admin-token npm run crawl:site -- --env local --api http://127.0.0.1:8787 https://hono.dev/docs
```

Options: `--only site1,site2`, `--max-pages N` (overrides the seeds'),
`--concurrency N` (default 4), `--force`, `--dry-run`, `--out FILE` (JSON
report), `--seeds FILE`, `--api URL`, `--poll-seconds N` (default 10),
`--timeout-minutes N` (default 90; the crawl carries on server-side after the
runner stops waiting). The exit code is 1 if a crawl could not be started or
followed. A full seed run is about 100 × 200 pages at one request per second
per site; at concurrency 4 expect a few hours, plus OpenRouter classification
of every new page against the daily caps (`INDEX_DAILY_CAP_USD`, default $2
per site, `INDEX_DAILY_TOTAL_CAP_USD`, default $10 overall). Raise the total
cap for the first full run, or spread it over several days.

### By hand

```sh
# start a crawl (admin); startUrl scopes the docs root, maxPages defaults to 500
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:8787/v1/admin/crawl -d '{"site":"developers.cloudflare.com","startUrl":"https://developers.cloudflare.com/d1/","maxPages":30}'
# -> 202 { "runId": "cr_…", … }
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8787/v1/admin/crawl/cr_…   # run stats, Workflow status, sample pages
curl http://127.0.0.1:8787/v1/sites/developers.cloudflare.com/profile                       # public SiteProfile
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:8787/v1/admin/crawl -d '{"site":"example.com","force":true}'              # skip the devtool gate
```

`wrangler dev` runs the Workflow and the Queue locally. Browser crawls need
`E2B_API_KEY` in `.dev.vars` and create a real sandbox (template
`E2B_TEMPLATE_ID`, built from `/crawler`). In every environment the Workflow
reads the crawl result from the sandbox itself (20 MB cap) and kills it right
after; the R2 API token secrets are optional and only switch on a presigned
upload instead.

## Before the first deploy

Nothing below exists yet; the owner creates it. Never touch unrelated resources
on the account (`accralions-com-worker`, `herd-room`, the `big-files` bucket).

1. D1 databases, then paste each `database_id` into `wrangler.jsonc` in place of
   `REPLACE_ME_STAGING_D1_ID` / `REPLACE_ME_PRODUCTION_D1_ID`:
   ```sh
   npx wrangler d1 create scoop-staging
   npx wrangler d1 create scoop-production
   ```
2. R2 buckets:
   ```sh
   npx wrangler r2 bucket create scoop-skills-staging
   npx wrangler r2 bucket create scoop-skills-production
   ```
3. Secrets, per environment: `ADMIN_TOKEN` (admin routes) and `RATE_KEY`
   (HMAC key for the rate-limit counters; writes fail with 500 without it):
   ```sh
   for env in staging production; do
     openssl rand -base64 32 | npx wrangler secret put ADMIN_TOKEN --env $env
     openssl rand -base64 32 | npx wrangler secret put RATE_KEY --env $env
   done
   ```
4. Rate limiting namespaces need no creation, but `namespace_id` must be unique
   on the account: `4100` (dev), `4101` (staging), `4102` (production) for
   reads, and `4110`-`4112` for the stricter search limiter. Change
   them if another Worker already uses those numbers.
5. Custom domains (`api-staging.scoop.md`, `api.scoop.md`) are created by
   `wrangler deploy` from `routes`. The `scoop.md` zone must be on the same
   account and those hostnames must not already have DNS records.
6. When the extension's Chrome Web Store ID is known, set `EXTENSION_IDS` in
   the `production` (and `staging`) vars.
7. Indexing and search (M4), per environment. Metadata indexes must exist
   before the first vector is inserted (vectors inserted earlier aren't
   filterable):
   ```sh
   npx wrangler vectorize create scoop-chunks-staging --dimensions=1024 --metric=cosine
   for p in site slot; do
     npx wrangler vectorize create-metadata-index scoop-chunks-staging --property-name=$p --type=string
   done
   npx wrangler queues create index-pages-staging
   npx wrangler queues create index-pages-dlq-staging
   npx wrangler secret put OPENROUTER_API_KEY --env staging
   ```
   Production is the same with `scoop-chunks-production`, `index-pages-production`
   and `index-pages-dlq-production`. The `AI` binding and the daily cron
   (`17 4 * * *` UTC) need nothing created. Classifier spend caps per UTC day:
   `INDEX_DAILY_CAP_USD` per site (default 2) and `INDEX_DAILY_TOTAL_CAP_USD`
   for the account (default 10). A deploy fails while the index or queue named
   in `wrangler.jsonc` doesn't exist (a missing dead-letter queue is created).
8. Crawl pipeline (M2/M3), per environment (`-staging` / production):
   ```sh
   npx wrangler r2 bucket create scoop-crawl-staging
   npx wrangler r2 bucket create scoop-crawl-production
   ```
   This bucket only holds browser-crawl results; page Markdown goes to the
   skills bucket under `pages/`. The queues are the ones from step 7.
   Staging already has `scoop-crawl-staging` (with the lifecycle rule) and
   `E2B_API_KEY`.
   - Lifecycle rule on each crawl bucket: delete objects under
     `crawl-results/` after 1 day (the Workflow deletes them itself; this
     catches failed runs).
   - `npx wrangler secret put E2B_API_KEY --env staging` (and production).
   - Optional: an **R2 API token** (dashboard → R2 → Manage API tokens →
     Create, *Object Read & Write*, scoped to the crawl bucket only) makes the
     sandbox upload its result to a presigned URL instead of the Worker
     reading it. Not needed; without it the sandbox holds no credentials.
     ```sh
     npx wrangler secret put R2_ACCESS_KEY_ID --env staging       # token's Access Key ID
     npx wrangler secret put R2_SECRET_ACCESS_KEY --env staging   # token's Secret Access Key
     npx wrangler secret put R2_ACCOUNT_ID --env staging          # Cloudflare account ID
     ```
   - The Workflows (`crawl-site-staging`, `crawl-site`) are created by
     `wrangler deploy`; nothing to create by hand.
   - `E2B_TEMPLATE_ID` in `wrangler.jsonc` is the `scoop-crawler` template
     built from `/crawler` (see `crawler/README.md`). If production uses a
     different E2B team, build the template there and set its ID.
9. For CI deploys: repository secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts,
   D1, Workers Routes, Queues and Vectorize edit) and `CLOUDFLARE_ACCOUNT_ID`, then set the repository
   variable `BACKEND_DEPLOY=1` to switch the deploy jobs on.

## Deploy

```sh
npx wrangler d1 migrations apply DB --env staging --remote
npx wrangler deploy --env staging --var VERSION:$(git rev-parse --short HEAD)
curl https://api-staging.scoop.md/v1/health
```

Production is the same with `--env production`, done by the owner after
reviewing staging. CI (`.github/workflows/backend.yml`) runs typecheck, unit
and contract tests on every push and PR; with `BACKEND_DEPLOY=1` it deploys
staging on push to `main` and production on a `backend-v*` tag.

Never run `wrangler deploy` without `--env`: the top-level config is for local
development only.

## Logs

Workers Logs is on (`observability.enabled`) with **invocation logs off**
(`logs.invocation_logs: false`) and traces off: Cloudflare's automatic
per-request log records the URL and headers, including install IDs, client IPs
and the admin `Authorization` header. Each request logs one JSON line instead:
`method`, `route` (the pattern, not the path), `status`, `ms`, `client`
(`X-Scoop-Client`). No IPs, install IDs or content. Unexpected errors log
`{ route, error }` with the message only.

```sh
npx wrangler tail --env staging
```

## Backups and restore (D1 Time Travel)

Time Travel is always on for D1; restores reach back up to 30 days (the
retention depends on the plan, see Cloudflare's D1 Time Travel docs). To restore:

```sh
# 1. Find a bookmark for the moment before the problem (RFC3339 or Unix seconds).
npx wrangler d1 time-travel info DB --env production --timestamp 2026-10-11T12:00:00Z
# 2. Restore the whole database to it. This overwrites current data; the
#    command prints a bookmark for the pre-restore state so it can be undone.
npx wrangler d1 time-travel restore DB --env production --bookmark <bookmark>
```

R2 content is not versioned by Time Travel. A restore can bring back a D1 row
whose R2 object was deleted by a takedown; such skills fail to load (500) until
taken down again with `DELETE /v1/admin/skills/:id`.

## Takedown

```sh
curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" https://api.scoop.md/v1/admin/skills/sk_…
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://api.scoop.md/v1/admin/reports
```
