# Backend decisions

Choices made while building `backend/` that [`BACKEND.md`](BACKEND.md) leaves
open, plus places where the spec and the reference server (`server/`) disagree.

## Stack

- **No router or framework.** The API has ten routes; a table of
  `{ method, pattern, handler }` in `src/api/v1.ts` is shorter than wiring up
  Hono and keeps the bundle and dependency list small.
- **One runtime dependency: [`entities`](https://github.com/fb55/entities).** §6
  requires decoding *all* HTML5 named and numeric entities; `entities/decode` is
  the standard table (also what `htmlparser2`/`cheerio` use), with no
  dependencies of its own.
- **Unit tests use `node:test`, not vitest.** `@cloudflare/vitest-pool-workers`
  0.23 needs vitest 4.1, and npm failed to resolve that peer set
  (`Cannot read properties of null (reading 'edgesOut')`). Node 22 runs the
  TypeScript directly (type stripping), and `node:sqlite` runs the real D1
  migrations and SQL, so store and rate-limit queries are tested for real. The
  Worker itself is covered end to end by the contract tests against
  `wrangler dev`. The cost: TS sources import each other with `.ts` extensions
  and use only erasable syntax (`erasableSyntaxOnly` in `tsconfig.json`).
- **Portable core.** `src/lib/` (verification, SSRF, validation, IDs,
  ranking) uses only `fetch`, web streams and Web Crypto. Everything that
  touches D1/R2 is in `src/db/`.
- **Config:** `wrangler.jsonc`. The top level is local dev only (worker name
  `scoop-api-dev`, `workers_dev: false`, placeholder D1 ID); `staging`
  (`scoop-api-staging`) and `production` (`scoop-api`) each declare their own
  D1, R2, rate limiter, vars and custom domain, since bindings and vars are not
  inherited.
- **Version:** `/v1/health` returns the `VERSION` var if set (CI passes the git
  sha for staging and the tag version for production via `--var`), else
  `0.1.0`.
- **Health reports secrets as booleans:** `secrets: { admin, rateKey }` says
  whether `ADMIN_TOKEN` and `RATE_KEY` are set, never their values. The CI
  smoke test after each deploy fails if either is false.

## API behaviour

- **IDs** are `sk_` / `rp_` + a 26-character ULID (Crockford base32, time-sortable).
- **Fingerprint** uses the reference encoding:
  `sha256(JSON.stringify([[kind, url, sha256(content) | null], ...]))`. §5
  describes objects (`[{kind, url, sha256(content)}]`); arrays were kept so
  fingerprints agree with `server/store.js` (a unit test checks this).
- **Dedupe** checks before writing, then relies on the partial unique index
  `(site, fingerprint) WHERE removed_at IS NULL` with `INSERT OR IGNORE`, so two
  concurrent identical shares still produce one skill. R2 is written before the
  D1 row (a row never points at missing content); the object is deleted again
  if the insert turns out to be a duplicate or fails.
- **Votes** are an upsert plus an `UPDATE ... SET worked/failed/last_worked_at =
  (SELECT ... FROM votes)` in one D1 batch (a transaction), so the counters are
  always recomputed from `votes` rather than incremented. Re-sending the same
  vote refreshes its `voted_at`, which can move `lastWorkedAt` forward (same as
  the reference).
- **Install IDs** are lowercased before use, so the same UUID in different case
  is one voter.
- **Validation happens before any fetch**, including the section-URL site check
  and "only `llms-full` may have `content: null`" (the reference does both
  inside verification; the error codes are the same). `verifySection` still
  checks the site itself so it is safe to call on its own.
- **URLs with credentials** (`https://user:pass@host/`) are rejected by the SSRF
  guard: fetching them would send an `Authorization` header (§10).
- **Hostnames with a trailing dot** (`localhost.`) are treated as the same host
  by the SSRF guard.
- **Kept from the reference where the spec is silent:** `title` truncated to 300
  characters; related-link `text` truncated to 120 (not rejected); a `page-html`
  source over 2 MB is `source_unreachable`; reports on unknown skills are 404
  and reports on removed skills are accepted; admin takedown of an unknown skill
  is 404, and of an already removed skill is 200; `/v1/sites/:site` is 404 only
  for sites never seen (a site whose skills were all taken down returns
  `best: null, recent: []`).
- **`/v1/sites` cursor** is the offset as a decimal string (opaque to clients,
  same as the reference). Fine at this scale; switch to a keyset cursor on
  `(last_worked_at, site)` if the list grows large.
- **Caching:** `/best` sends `public, max-age=30, s-maxage=60` (spec). `/sites`
  and `/sites/:site` send `public, max-age=60, s-maxage=60` ("cacheable for
  60 s"); the reference uses the `/best` header for those too. Every other
  response (`/v1/skills/:id`, health, admin, all writes, preflights and every
  error) sends `cache-control: no-store`.
- **No Workers Cache API yet.** The `s-maxage` headers only matter to shared
  caches in front of the Worker; a Custom Domain Worker is the origin, so
  responses are not cached at Cloudflare's edge today. Adding
  `caches.default` for `/best` and `/sites` (with purge on vote and takedown)
  is a later decision, once read volume justifies it.
- **`sizeBytes`** is the sum of section `content.length` (UTF-16 code units), as
  in the spec's wording and the reference, not a byte count.
- **Markdown stripping for shingles** (§6) removes link and image targets
  (keeping their text), bare URLs and ordered-list numbers at the start of a
  line (`1.`, `2)`), which an `<ol>` doesn't render as text. Heading, emphasis,
  code, bullet, quote and table markers get no pass of their own: shingling
  splits on letters and digits, which drops them anyway.
- **Blocked sites:** `scoop.md` and anything under it can't be shared (400).
- **`ALLOW_LOCALHOST`** is honoured only when the `ENVIRONMENT` var is `dev`
  (set at the top level of `wrangler.jsonc`; `staging`/`production` set their
  own), so a stray secret or var can't open localhost fetching in a deployed
  Worker.
- **Takedown races:** if a skill's R2 object is missing when it is served, the
  row is re-read: removed → 410 (`/v1/skills/:id`) or `skill: null`
  (`/best`); not removed → 500 (a real inconsistency).
- **Failed inserts:** when the D1 insert of a new skill throws, the R2 object is
  deleted only if a re-read confirms the row doesn't exist. An orphaned object
  is harmless; a row pointing at nothing is not.

## Rate limiting (§8)

- Cloudflare's rate limiting binding only supports 10 s and 60 s periods, so it
  is used for **reads** only (600/min per IP, keyed on the same IP subject as
  the write limits: IPv4 as is, IPv6 by /64). Admin
  routes skip it, so bad admin auth is always a plain 404.
- **Hourly write limits** are fixed one-hour windows in a D1 table
  `rate_counters(key, hour, count)`. `key` is
  `HMAC-SHA256(RATE_KEY, bucket:hour:subject)` with a Workers secret
  `RATE_KEY`: a plain hash of an IPv4 address can be reversed by trying all
  2^32, an HMAC can't without the key. Every check deletes rows from past
  hours, so nothing outlives the window (§3, §10). Increments use
  `INSERT ... ON CONFLICT DO UPDATE ... RETURNING count` in one batch with the
  prune. Without `RATE_KEY`, writes fail with 500 rather than run unlimited.
- **IP subject:** IPv4 as is (IPv4-mapped IPv6 too); IPv6 by its /64, one
  subscriber's usual allocation, so cycling addresses within it doesn't reset
  the count.
- Limits, each by install ID **and** by IP:
  - `POST /v1/skills`: 20/hour per install, 60/hour per IP (spec).
  - Feedback and reports share one bucket: 120/hour per install (spec) and
    600/hour per IP (my choice: the spec asks for IP limiting on everything but
    gives no number; 5× the per-install limit allows a shared office NAT).
- Counted **after** cheap validation and **before** verification fetches, so
  malformed requests don't use up quota but every request that would trigger
  outbound fetches does.
- `Retry-After` is the seconds until the current hour window ends (writes) or
  60 (reads).
- Fixed windows allow up to 2× the limit across a window boundary. Acceptable
  for abuse protection; revisit with a sliding window or a Durable Object if
  needed.

## CORS (§5)

- `GET` responses (and preflights for `GET`): `Access-Control-Allow-Origin: *`.
- `POST`/`DELETE` responses and their preflights echo the origin only for
  `https://scoop.md`, `chrome-extension://<id>` with `<id>` in `EXTENSION_IDS`,
  or any `chrome-extension://` origin when `ALLOW_ANY_EXTENSION=1`; otherwise
  no `Access-Control-Allow-Origin` is sent and the browser blocks the call.
  Requests are never rejected server-side for their origin (no Origin = curl).
- `OPTIONS` always answers 204 with the allowed methods/headers and
  `Access-Control-Max-Age: 86400`.

## Fetching

- Outbound verification fetches send only `User-Agent: scoop.md-verifier/1
  (+https://scoop.md)`. No `credentials` option is passed: Workers' `fetch` has
  no cookie jar, and the option isn't supported on every compatibility date.
- On Cloudflare, Worker subrequests can't reach private networks, which also
  covers DNS names that resolve to private addresses (DNS rebinding); the
  hostname rules in §6 are the first line, not the only one.
- Worst case per share: 6 sections × 6 hops = 36 subrequests, under the
  Workers Free limit of 50.
- **One 10 s timeout per section** covers every redirect hop and reading the
  body (the reference timed each hop separately).
- **Redirect targets** are checked against the site first, then the SSRF rules.
  A redirect is the source's doing, so a bad target is a 422: `site_mismatch`
  when it leaves the site (including to an IP literal or internal host), else
  `source_unreachable` (for example `http:` or a non-443 port on the same
  host). The client's own URLs that break the SSRF rules are still 400.
- **Linear-time text processing.** `htmlToText`, `markdownToPlain` and
  `normalizeText` are hand-written scans, not regexes: the regex versions were
  quadratic on crafted input (`'<script ' × n` took 6 s at 160 KB). Markdown
  link targets longer than 2,048 characters are not treated as links. Unit
  tests run 2 MB adversarial inputs against a 200 ms budget; the reference
  server has the same code and a matching test.
- **Shingles are hashed** to 53-bit numbers (cyrb53) with a fresh random seed
  per comparison, instead of kept as joined strings: one 2.3 MB page took
  about 68 MB as strings, about 31 MB as a Set of hashes for 300k shingles.
  The random seed means colliding shingles can't be precomputed offline, and
  at 53 bits a chance collision is about 3 × 10⁻¹¹ per section shingle against
  a 2 MB page.
- **page-html sections are verified one at a time**, text sections
  concurrently, so at most one page and its shingle set is in memory.

## Known limitations

- **IDN hostnames** are compared in the punycode form `new URL()` produces
  (`xn--…`). A site sent as Unicode and its URLs normalise the same way, so
  matching works, but there is no confusable/homograph check and the punycode
  form is what's stored and shown. Revisit when non-ASCII docs hosts appear.

## Logging (§11)

Workers Logs is enabled with **invocation logs and traces off** in every
environment: invocation logs record the request URL and headers (install ID,
`CF-Connecting-IP`, the admin `Authorization` header), which §3 and §10 rule
out. What remains is one JSON line per request from the Worker: `method`, `route` (pattern such as
`/v1/skills/:id`, never the path or query), `status`, `ms`, `client`. Unexpected
errors additionally log `{ route, error }` with the message only. No IPs,
install IDs, URLs or content.

## Spec vs reference disagreements found

Reported rather than silently resolved; the Worker follows the spec in each.

1. **CORS:** the reference echoes any `Origin` (or `*`) on every response; the
   spec restricts `POST`/`DELETE` to the extension IDs and `https://scoop.md`.
2. **Entities:** the reference decodes a short list of named entities; the spec
   requires the full HTML5 table.
3. **Rate limits:** not implemented in the reference.
4. **Fingerprint encoding:** spec says objects, reference uses arrays (kept the
   reference's, see above).
5. **List caching:** the reference sends `max-age=30` on `/sites` and
   `/sites/:site`; the spec says 60 s.

None of these is exercised by the contract tests, which pass against both.

## Local dev note

On the development machine port 8787 was already taken by the reference server
(`node server/server.js`), so the contract tests were run against
`wrangler dev --port 8788` with `SCOOP_API=http://127.0.0.1:8788`. Use
`127.0.0.1` rather than `localhost` in `SCOOP_API` when anything else might be
listening on `::` for that port.

## Crawl pipeline (M2/M3)

### Discovery and fetching

- **Site** is the hostname, normalised as in §3. `POST /v1/admin/crawl` takes an
  optional `startUrl` (default `https://<site>/`); a start URL with a path
  scopes the docs root (`/d1`). Without one, the docs root is inferred only from
  a sitemap first segment that names the docs as a whole (`docs`,
  `documentation`, `developer(s)`, `manual`) covering >= 20% of URLs: on
  docs.stripe.com an earlier rule picked `/api`, a section, and dropped the
  rest. Profiles are per hostname, so a scoped crawl overwrites `docs_root`.
- **llms.txt probing** tries at most three bases (start path's first segment,
  `/docs`, `/documentation`, root) and records the URL a probe *ended up at*
  (Stripe's `/docs/llms.txt` redirects to `/llms.txt`). llms-full.txt is only
  checked for existence (64 KB read) during discovery and fetched in full as a
  page.
- **Twins:** 10 sitemap pages sampled evenly; `<path>.md` first, then
  `<path>/index.md`; once one pattern hits, the other isn't tried. Twins are
  guessed for the rest of the sitemap only when >= 30% of the sample had one.
- **Fetch plan order:** llms.txt, llms-full.txt, Markdown links listed in
  llms.txt, then twins of sitemap pages; deduplicated by source URL; cut at the
  page budget (default 500, max 1000). `pages.url` is the HTML page when we
  derived the twin, else the Markdown URL itself.
- **HTML-only sites** (`html_only`: no llms files, no twins, server-rendered)
  get a profile and no pages in M2. Converting their HTML needs a DOM, which
  Workers lack; running `extract.js` over linkedom in the Worker, or sending
  them to the browser crawler, is a later call.
- **needs_browser** = no Markdown sources and the start page is a client shell:
  fewer than 150 words once scripts/styles are dropped, plus an empty mount
  point (`#root`, `#app`, `#__next`, …) or a "needs JavaScript" notice with any
  script, or fewer than 30 words with 3+ scripts.
- **robots.txt:** our product token is `scoop.md-bot`; groups naming it win over
  `*`, longest match wins, Allow wins ties, `*`/`$` wildcards (glob matched
  without regex). 4xx → no rules; 5xx or unreachable → treated as disallow-all
  for this run (RFC 9309), so the profile says `blocked`. `Crawl-delay` is
  honoured between 1 s and 10 s.
- **Politeness:** per host, 2 requests in flight and >= 1 s between request
  starts (start times are reserved in order). Each Workflow step carries the
  limiter's next start time into the next, so batches don't bunch up at step
  boundaries.
- **Crawler UA** `scoop.md-bot (+https://scoop.md/bot)` for the Worker's
  fetches; the browser sends a Chrome UA with `scoop.md-bot/1
  (+https://scoop.md/bot)` in it, since some SPAs refuse unknown browsers.
  `https://scoop.md/bot` doesn't exist yet; it should describe the bot.
- **Caps:** 2 MB per Markdown source (bigger ones count as failed), 10 MB per
  sitemap (after gunzip), 5,000 sitemap URLs kept, 8 sitemap files.

### Storage

- New tables in `0002_crawl.sql` (`site_profiles`, `crawl_runs`, `pages`); the
  v1 tables are untouched. Run IDs are `cr_<ulid>` and double as the Workflow
  instance ID.
- New bucket binding `CRAWL` (`scoop-crawl-<env>`), not the skills bucket:
  crawled pages and short-lived browser results get their own lifecycle rule and
  the R2 API token can be scoped to this bucket alone.
- **Content-addressed:** `pages/<sha256>.md` is the SHA-256 of the Markdown as
  fetched (no normalisation). R2 is `head`-checked before `put`, so identical
  content across URLs and runs is written once. Objects are never deleted when a
  page changes (other URLs may share the hash); garbage collection is later.
- **Unchanged** = 304 to our `If-None-Match`/`If-Modified-Since`, or the same
  hash. It refreshes `fetched_at`, `run_id` and validators only; no R2 write, no
  queue message.
- **Queue messages** `{ site, url, contentHash, change, runId }`, one per new or
  changed page, sent with `sendBatch` per step. The consumer logs per-site
  counts and acks (M4 replaces it).

### Workflow

- 10 pages per step (well under the Free plan's 50 subrequests per invocation,
  counting the fetch, R2 head/put and D1 calls). Network steps retry twice,
  D1-only steps three times.
- Failures anywhere run a `fail` step (kill the sandbox if one is up, mark run
  and profile `failed`) and rethrow, so the Workflow instance shows `errored`
  too.
- `GET /v1/admin/crawl/:runId` returns the D1 run row (the durable record), the
  Workflow status when the instance is still retained, and up to 10 pages the
  run stored.

### Browser crawls (E2B)

- **Interface:** `BrowserCrawler { start, poll, result, stop }` plus
  `runCrawl()` for callers that can wait. A Workflow can't hold one call open
  across `step.sleep`, so the interface is split rather than a single
  `runCrawl(site, budget)`.
- **No SDK, no Connect-RPC.** The template's start command is a small job server
  (`crawler/server.js`, port 8080) captured running in the snapshot, so the
  Worker needs only `POST /v2/sandboxes`, `DELETE /sandboxes/{id}` and plain
  HTTPS to `https://8080-<id>.<domain>`. Sandboxes are created with
  `network.allowPublicTraffic: false`: every call carries E2B's
  `e2b-traffic-access-token`, plus a random per-job bearer token so pages
  rendered inside the sandbox can't drive the job server via localhost. The
  `browser-start` step output (which holds both tokens) is marked
  `sensitive: 'output'`.
- **Upload:** the Workflow presigns one SigV4 `PUT` (with `content-type`
  signed) for `crawl-results/<runId>.json`, valid for the crawl + 10 minutes.
  R2 presigned URLs can't be made single-use; the key is unique per run, short
  lived and deleted after ingestion. In local dev without R2 credentials the
  Workflow fetches `GET /result` from the sandbox and writes the same key;
  staging/production refuse a browser crawl without the credentials.
- **Presigning by hand** (Web Crypto, ~80 lines) rather than `aws4fetch`: no new
  dependency, portable, and pinned by the AWS SigV4 test vector in the tests.
- **Untrusted output:** pages are re-checked in the Worker (`result.ts`): same
  site, http(s), robots-allowed, <= 300,000 chars, unique, within budget. The
  crawler also blocks private/local hosts, images, media and fonts, and caps the
  result at 20 MB.
- **Limits:** sandbox timeout = crawl minutes + 3 (max 60, the Hobby plan's
  continuous-runtime cap); `maxMinutes` defaults to 10 and is capped at 50.
  Polled every 20 s. Template: 2 vCPU, 2 GiB, `mcr.microsoft.com/playwright:v1.64.0-noble`.
- **Cost** recorded per run: sandbox seconds × (2 × $0.000014 + 2 × $0.0000045)
  = $0.000037/s, E2B's published per-second prices on 2026-10-12.
- **Shared code** (`extract.js`, `robots.ts`) is copied into `crawler/vendor/`
  because the template build only sees `crawler/`; a root test fails if the
  copies drift. Node in the Playwright image runs `robots.ts` directly (type
  stripping).
- **Hash routes:** docsify-style `#/page` URLs are distinct pages (kept in
  `pages.url`), and the crawler reloads the page for a hash-only navigation so it
  never reads the previous route's content.

## Indexing model (for M4)

Recorded from a 4-page trial before M4; M4 uses it as described below.

- **Default:** `qwen/qwen3.7-flash` via OpenRouter. About $0.0005 per page,
  4/4 valid JSON, good entity extraction, ~20 s latency: fine for batch indexing
  from a Queue consumer.
- **Fallback:** `openai/gpt-6-luna`. About $0.0008 per page, ~5 s, best
  quality. Use when the default fails validation or for latency-sensitive work.
- **Request shape:**
  - `response_format: { type: "json_object" }` with the JSON schema written into
    the system prompt. Strict `json_schema` plus `provider.require_parameters`
    returned 404 "no endpoints" for several models.
  - `reasoning: { effort: "low", exclude: true }`.
- **Parsing:** strip leading/trailing ``` fences before `JSON.parse`, then
  validate `slot` against the enum; treat anything else as a failed page and
  retry with the fallback model.
- **Key:** Workers secret `OPENROUTER_API_KEY`.
- **`max_tokens` 8000.** Even at `effort: "low"`, `qwen/qwen3.7-flash` used
  2,000 reasoning tokens on the D1 limits page and hit a 2,000 cap with empty
  `content` (`finish_reason: "length"`); at 8,000 it finishes. The cap bounds
  cost per call (about $0.0012 of completion at worst for the default model).

## Indexing and search (M4)

- **Pipeline:** `index-pages-<env>` message `{ site, url, contentHash }` →
  read `pages/<contentHash>.md` from R2 (`SKILLS` bucket) → chunk → embed
  (Workers AI) → classify (OpenRouter) → Vectorize upsert → one D1 batch (a
  transaction) replacing the page's `chunks`, `entities`, `page_index` row and
  topic counts. Classification comes after embedding so that a failure there
  costs nothing. The consumer never reads the crawler's `pages` table; the
  message and R2 are the whole contract. The message URL is normalised (parsed,
  fragment dropped, `href`), so one page has one spelling.
- **Classification cache:** a successful result is stored at
  `classify/<contentHash>.json` in R2 before anything else is written, and
  read back first on every attempt, so a retry after a Vectorize or D1 failure
  (or a re-sent message) never pays for the same content twice. Failed results
  aren't cached.
- **Idempotency:** a message is skipped when `page_index.content_hash` already
  equals `contentHash` (and the page was classified). Chunk IDs are
  `sha256(url)[0:32]-<ord>`, so re-indexing overwrites vectors in place;
  surplus IDs from a longer old version are deleted. Vectors are written
  before D1: if D1 fails the retry redoes both, and search drops vector hits
  whose chunk row doesn't exist.
- **Retries:** messages are handled one at a time (classifying takes 5-20 s),
  at most 3 consumer invocations at once (`max_concurrency`); failures
  `retry()` with 30 s × 2^(attempt−1) up to an hour, `max_retries` 6, then go
  to the dead-letter queue `index-pages-dlq-<env>` (nothing consumes it; it's
  for inspection). Bad messages (missing fields, non-http(s) URL, URL not on
  `site`, non-hex hash) and a missing R2 object are acked and logged instead:
  retrying can't fix them. Classification failures are not retried (see
  below), so retries are only for Workers AI, Vectorize and D1 errors.
- **Cost caps:** `index_costs(site, day)` sums OpenRouter `usage.cost` per
  site per UTC day, failed attempts included, plus an account-wide row with
  site `*`. When a response has no usage (timeout, dropped connection, cut-off
  body, gateway error) the call is charged an estimate: prompt characters / 4
  at the input price plus all 8,000 `max_tokens` at the output price, from a
  per-model table at about twice OpenRouter's listed prices (unknown models
  priced higher still). Once a site reaches `INDEX_DAILY_CAP_USD` (default $2)
  or the account reaches `INDEX_DAILY_TOTAL_CAP_USD` (default $10), pages are
  still chunked, embedded and searchable but not classified: `slot` `other`,
  no topics or entities, `model` `none`. The check runs before each call, so
  up to 3 concurrent consumers can overshoot by one call each (about a tenth
  of a cent).
- **Unclassified pages:** `model` is `none` (cap reached, or no
  `OPENROUTER_API_KEY`: indexing works without the key) or `failed` (both
  models failed, for any reason: invalid output, HTTP errors, timeouts). Such
  rows don't count as indexed for the idempotency check, and a daily cron
  (`17 4 * * *` UTC, after the caps reset) re-enqueues the 200 oldest of them
  (`src/index/reclassify.ts`); the rest follow on later days. The cron does
  nothing without the API key. Re-enqueued pages are re-embedded too (fractions
  of a cent), because Vectorize can't update a vector's `slot` metadata without
  its values.
- **Classifier output** is validated, not trusted: `slot` must be in the
  enum, `topic_path` needs 2-4 levels (normalised to lowercase slugs of
  letters, digits, `.`, `_`, `-`, so `/` can join them), summary required;
  tasks and entities are cut to 5 and 15, entities with an unknown kind or a
  name that doesn't appear verbatim in the page Markdown are dropped, and
  control and format characters (`\p{Cc}`, `\p{Cf}`: zero-width, bidi
  overrides) are removed from summary, tasks and entity names. Anything else
  is a failed attempt and goes to the fallback model.
  The page is sent inside `<page url=… title=…>…</page>` with any literal
  `</page>` in it escaped, truncated to 60,000 characters.
- **Chunking:** sections split at headings outside code fences; blocks are
  paragraphs and whole fences. Chunks are packed to at most 800 tokens
  (estimated as characters / 4); a section continues the previous chunk only
  while that chunk is under 300 tokens, so small sections share a chunk and big
  ones start their own. A fence is never split, even past 800 tokens; long prose
  is cut at line, sentence, then word boundaries. Fences are recognised at any
  indent (docs nest them in list items). The heading trail stored per chunk is
  `Title > Section > Subsection`; the embedded text is that trail plus the
  chunk. At most 400 chunks per page. Known limit: unfenced code with
  `# comment` lines (Stripe's .md files have some) reads as headings.
- **Embeddings: `@cf/qwen/qwen3-embedding-0.6b`, 1,024 dimensions, cosine.**
  `bge-base-en-v1.5` (768) truncates input at 512 tokens, under our 800-token
  chunks; Qwen3-Embedding has an 8k context, query/document modes
  (`queries` / `documents` inputs) and costs $0.012 per million tokens. Calls
  are batched 32 texts at a time.
- **Vectorize** index per environment (`scoop-chunks-dev|staging|production`),
  metadata `{ site, slot, url, chunkId }` with string metadata indexes on
  `site` and `slot` (only the first 64 bytes of a string are indexed, which
  covers hostnames and slots). `url` isn't filtered on, so it isn't indexed
  (the dev index has one from before; harmless).
- **FTS5 on D1:** `chunks_fts` is an external-content FTS5 table over
  `chunks(text, heading_path, title)`, kept in sync by insert/delete triggers,
  tokenizer `porter unicode61`. unicode61 splits on punctuation, so
  `stripe.webhooks.constructEvent` indexes `constructevent` and an exact
  identifier query matches; porter makes "verify" match "verifies". Queries are
  rebuilt from word characters only, each term quoted and OR-ed (stopwords
  dropped unless nothing else is left), so FTS5 operators in user input are
  inert. bm25 weights: text 1, heading trail 3, title 2. Caveat: `wrangler d1
  export` refuses databases with virtual tables ("cannot export databases with
  Virtual Tables (fts5)", checked locally). Time Travel is unaffected; for an
  SQL export, drop `chunks_fts` and its two triggers first, then recreate them
  from migration 0003 and run `INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`.
- **Hybrid ranking:** top 50 from FTS5 and top 50 from Vectorize (filtered by
  `site`/`slot` metadata), fused with reciprocal-rank fusion (k = 60). Scores
  are RRF scores, comparable only within one response. If embedding or
  Vectorize fails, results are FTS5 only (logged). Site and slot filters are
  re-checked against D1, since vector metadata can lag a re-index.
- **Topics:** the `topics` table counts pages per topic prefix (`a`, `a/b`,
  `a/b/c`). Indexing a page recounts every prefix of its old and new paths
  with `COUNT(*)` over `page_index`, in the same transaction after the
  `page_index` upsert, and deletes zero rows; counts are never adjusted by ±1,
  so concurrent consumers or a drifted row can't leave them wrong. `page_index.topic`
  holds the joined path for prefix queries: `topic = ? OR topic LIKE ? ESCAPE
  '\'`, with `%`, `_` and `\` escaped in the prefix (`_` is a valid topic
  character). Not `substr`: SQLite counts characters and JS `length` counts
  UTF-16 units, so a topic with a non-BMP letter would mismatch. LIKE ignores
  ASCII case, which doesn't matter for lowercase topics.
- **Packages** (`GET /v1/packages`): `q` runs the hybrid search (top 40 chunks
  for the site); `topic` takes the chunks of every page under that topic.
  Pages are ordered by their best chunk, chunks within a page by document
  order, under the same untrusted-reference note as the extension. A page's
  Sources line is only written if one of its chunks fits, and both count
  against the budget (default 60,000 characters, 2,000-400,000). Titles,
  heading trails and the query label are flattened to one line with no
  backticks, brackets or `<`, so they can't add structure or HTML. Each
  chunk's text is wrapped in a ```` ```markdown ```` fence one backtick longer
  than its longest backtick run, so page text can't close the fence and forge
  a section, Source line or heading. URLs are printed as `<url>`; a chunk
  whose URL isn't http(s) or contains whitespace, control or format
  characters, `<` or `>` is left out.
  `text/markdown; charset=utf-8`, 404 when nothing matches.
- **Public reads** (`/v1/search`, `/v1/sites/:site/topics`, `/v1/packages`) go
  through the read rate limiter and send `public, max-age=60, s-maxage=60`.
- **Query embeddings:** every search (and `?q=` package) embeds the query, and
  a flood could use up the account's Workers AI rate limit, which indexing
  needs too. So `/v1/search` and `/v1/packages?q=` also go through
  `SEARCH_LIMITER` (60/min per IP, namespaces 4110-4112), and query vectors
  are cached in `caches.default` for 10 minutes keyed by the model and a
  sha256 of the normalised query (lowercased, whitespace collapsed), `site`
  and `slot`. A cache error only costs the embedding call.
  `q` is required and at most 200 characters, `limit` 1-50 (default 10), `slot`
  must be in the enum, `site` must look like a hostname.
- **`POST /v1/admin/index {url, queue?}`** fetches the page with the same
  anonymous, SSRF-checked fetch as verification, refuses HTML (send the `.md`
  URL; HTML-to-Markdown is the crawler's job), stores it at
  `pages/<sha256>.md` and indexes inline, or enqueues with `"queue": true`.
- **Health** also reports `secrets.openrouter` (boolean).
- **CI** runs `wrangler dev --local`: the remote AI/Vectorize bindings need a
  Cloudflare login, which CI doesn't have.
- **Queue names** (per account, so per environment): `index-pages-dev`
  (simulated locally), `index-pages-staging`, `index-pages-production`, with
  dead-letter queues `index-pages-dlq-dev|staging|production`.
