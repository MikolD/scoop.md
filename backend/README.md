# scoop.md backend (api.scoop.md)

Cloudflare Worker serving the shared library API (`/v1`). The spec is
[`docs/BACKEND.md`](../docs/BACKEND.md); choices it doesn't make are in
[`docs/BACKEND-DECISIONS.md`](../docs/BACKEND-DECISIONS.md). `server/` at the
repo root is the dependency-free reference implementation of the same contract.

- Metadata, votes, reports, write rate-limit counters: **D1** (`DB`)
- Skill content (`skills/<id>.json`): **R2** (`SKILLS`)
- Read rate limit (600/min/IP): **rate limiting binding** (`READ_LIMITER`)
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
src/db/           D1/R2 store and hourly rate-limit counters
src/crawl/        (later) Workflow "CrawlSite"
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
cp .dev.vars.example .dev.vars        # ADMIN_TOKEN, RATE_KEY, ALLOW_LOCALHOST=1, ALLOW_ANY_EXTENSION=1
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
8. For CI deploys: repository secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts,
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
