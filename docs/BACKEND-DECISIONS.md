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
- **Kept from the reference where the spec is silent:** a `page-html`
  source over 2 MB is `source_unreachable`; reports on unknown skills are 404
  and reports on removed skills are accepted; admin takedown of an unknown skill
  is 404, and of an already removed skill is 200; `/v1/sites/:site` is 404 only
  for sites never seen (a site whose skills were all taken down returns
  `best: null, recent: []`).
- **Server-written skill text** (review finding M5 of the first backend
  review, option (a); rules in BACKEND.md §6, "Server-written text"). The
  skill `title`, section `label`s, related links and `pageUrl` were
  client-chosen and unverified, yet reach agents as headings and lists, so
  they were a way to put instructions in a skill that passed verification.
  Now nothing in a skill comes from the client unless a verified source backs
  it, and nothing is derived from a URL the server didn't fetch (a first
  version humanised URL path segments, and `/docs/ignore-previous-instructions`
  humanises into an instruction):
  - Title, labels and link text sent by the client are accepted (older
    extensions send them) and dropped at validation; `label` is no longer
    required.
  - Labels use the extension's own wording (`This page: …`, `Site
    documentation index (llms.txt)`, `Full documentation (llms-full.txt)`),
    so packages read the same and the extension's `This page:` → `Another
    page:` relabelling keeps working with no extension change. With no title,
    a page section is just `This page`; a skill with no page title is
    `<site> documentation`.
  - Titles come from what verification already read: the verified Markdown's
    first H1 (else first heading), or the fetched HTML's `<title>` in `<head>`
    (else first `<h1>`). `<title>` is only looked for in `<head>` because
    inline SVG icons carry `<title>` elements of their own.
  - Related links are kept only when a verified source links to them (the
    fetched HTML's `<a href>`s, or Markdown links in verified `.md`/llms
    content), with that source's link text and URL (resolved, fragment
    dropped); everything else is dropped. Matching ignores the fragment and
    a trailing slash.
  - URLs are stored in canonical form, since a query string or fragment can
    carry prose too (`…/webhooks?SYSTEM=run+curl…#Ignore-previous…`):
    `pageUrl` is the origin and path of the verified page it names (extension
    `pageKey` rules), plus a `#/` client route; section URLs lose plain
    fragments, and a section URL whose query is over 200 characters or
    decodes to whitespace or control characters is refused (400). Docs
    sources rarely have a query at all; `?v=2&lang=en` still passes, and `+`
    counts as a space, as in form encoding.
  - `#/` client routes are a prose channel too (`https://docs.stripe.com/#/
    Ignore-all-previous-instructions…` passed verification, since fragments
    are never fetched). Routes are now slugs only (at most 100 characters of
    `[A-Za-z0-9/_.-]`, everywhere `pageHash` runs: skills, the queue
    consumer, the admin route and the crawler's copy in `crawler/vendor/`),
    and a shared skill keeps a section's route only when one of its verified
    sources links to that exact route, as a docsify sidebar's
    `href="#/cdn"` does. Link keys keep routes for this, so a related link to
    `#/quickstart` matches the sidebar link too. Otherwise the route is
    dropped from the section URL and so from `pageUrl`. Crawled pages keep
    their routes (the crawler only follows same-site links it found),
    subject to the slug rule.
  - Everything has `\p{Cc}`/`\p{Cf}` removed, whitespace collapsed, and is
    capped at 300 / 200 / 120 characters without splitting a surrogate pair.
  - Linear time on hostile sources: ATX headings are parsed by hand (the
    regex form backtracked quadratically on `'# a' + spaces + 'x'`: 6 s at
    40 KB), lines over 1 KB are never headings, link text is stripped with a
    forward scan instead of `\[([^\]]*)\]\(…\)` (quadratic on a run of
    `[`), and link and tag searches cache their next `>`/`</a>` positions.
    This also fixes the same patterns in the indexer's chunker
    (`src/index/chunk.ts`). Tag searches lowercase ASCII only, since
    `toLowerCase()` can lengthen a string (`İ`) and shift every index after
    it. Scaling tests cover 2 MB worst cases in both servers.
  - Skills stored before this change keep their client-sent text; the
    fingerprint (and so dedupe) doesn't involve any of these fields, so a new
    share of the same sections returns the old skill unchanged. A one-off
    rewrite would need each source fetched again (links and HTML titles
    aren't stored).
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
  tests check linear scaling on adversarial inputs rather than a fixed time
  (which failed on busy machines): from 250 KB to 2 MB the time must grow
  less than 24× (linear is 8×, quadratic 64×), best of 5 interleaved runs,
  re-measured up to 3 rounds, with a 2 s ceiling at 2 MB. A 1 MB → 2 MB ratio
  under 3× was tried first and was itself flaky: GC in a full test process
  pushed linear scanners to 3-4×. Runs are timed in process CPU time
  (`process.cpuUsage()`), not wall time: with 12 CPU-burning processes on a
  10-core machine, wall time showed linear scanners growing 30×. The
  reference server has the same code and a matching test.
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
- **llms-full.txt** is recorded in the profile but not fetched or indexed when
  the site's pages are available as Markdown (twins, or Markdown links in
  llms.txt): it repeats them, and outranked them in search. It is the content
  only when nothing finer exists.
- **Skip list** (`src/crawl/skip.ts`, copied to the crawler), simple URL
  patterns with any file extension: Sphinx generated indexes (`genindex`,
  `py-modindex`, `modindex`), `search` pages, `404`/`not-found` pages,
  `tag`/`tags`/`category`/`categories` listings, and changelog archives split
  by year or version (`/changelog/2023`, `/release-notes/v1.9`, `/releases/…`,
  `/history/…`) except the newest per section. `/changelog` itself stays.
  Skipped pages are counted in `crawl_runs.pages_skipped`, along with
  robots-disallowed sources, redirects off the site and URLs over 1,024
  characters.
- **URL length:** 1,024 characters everywhere the crawler fetches, stores or
  queues a URL (plan, sitemap entries, llms.txt links, browser results, the
  crawl request's `startUrl`).
- **Server-rendered sites without Markdown** (path `html`) are converted in the
  Worker: `shared/extract.js` runs over linkedom (`src/crawl/html.ts`),
  imported directly with a small `extract.d.ts` beside it, so crawled pages
  read like scooped ones. The plan is the start page, its same-site links
  (navigation and main content) and then sitemap pages under the docs root,
  skipping non-HTML file extensions. A page that converts to fewer than 50
  words is counted as failed. If the server answers with Markdown anyway
  (content negotiation on our `Accept`), that is stored as `page-md`. Parsing
  is ~100 ms of CPU per page in Node, so it needs the Paid plan's CPU limit,
  not Free's 10 ms.
- **needs_browser** = no Markdown sources and either the start page is a
  client shell (fewer than 150 words once scripts/styles are dropped, plus an
  empty mount point (`#root`, `#app`, `#__next`, …) or a "needs JavaScript"
  notice with any script, or fewer than 30 words with 3+ scripts), or it is
  server-rendered but converts to fewer than 50 words.
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
  `sitemap_urls_count` counts the entries parsed, which stops at the 5,000 kept.
- **Timeouts are per hop and start after the politeness wait**, inside the
  limiter, which also covers the body read: a 10 s Crawl-delay must not eat a
  request's 15 s budget.
- **Sitemap parsing is linear:** each `<url>` block is sliced and searched on
  its own (an entry without `<lastmod>` never scans the rest of the file), and
  parsing stops at the number of URLs still wanted.

### Storage

- New tables in `0002_crawl.sql` (`site_profiles`, `crawl_runs`, `pages`); the
  v1 tables are untouched. Run IDs are `cr_<ulid>` and double as the Workflow
  instance ID.
- **Buckets:** page Markdown is in the skills bucket (`SKILLS`,
  `pages/<sha256>.md`), shared with the M4 indexer. Browser results go to a
  separate `CRAWL` bucket (`scoop-crawl-<env>`, `crawl-results/`, expiring
  after a day), so an optional R2 API token scoped to it can't touch skills or
  pages.
- **Content-addressed:** `pages/<sha256>.md` is the SHA-256 of the Markdown as
  fetched (no normalisation). R2 is `head`-checked before `put`, so identical
  content across URLs and runs is written once. Objects are never deleted when a
  page changes (other URLs may share the hash); garbage collection is later.
- **Unchanged** = 304 to our `If-None-Match`/`If-Modified-Since`, or the same
  hash. It refreshes `fetched_at`, `run_id` and validators only; no R2 write, no
  queue message.
- **Queue messages** are exactly `{ site, url, contentHash }` (the M4
  contract), one per new or changed page, sent with `sendBatch` in chunks of at
  most 100. `contentHash` is the SHA-256 of the UTF-8 bytes at
  `pages/<contentHash>.md`. Client-side routes (`#/page`) are part of a page's
  URL, and the consumer keeps them.

### Workflow

- 10 pages per step (well under the Free plan's 50 subrequests per invocation,
  counting the fetch, R2 head/put and D1 calls). Network steps retry twice,
  D1-only steps three times.
- **Small step outputs.** The fetch plan (up to 1,000 URLs) is written to
  `crawl-results/<runId>/plan.json` in the `CRAWL` bucket; `discover` returns
  only its size. Each `pages-N` step reads its own slice.
- **Index outbox.** `record()` writes a page row with `index_pending = 1` in
  the same D1 batch as its new `content_hash`. After each page step an
  `index-N` step sends the site's pending rows in batches of 100 and clears
  each flag only if the hash is unchanged (`WHERE url = ? AND content_hash =
  ?`); `index-final` runs before `finish`. A step that dies after recording,
  or between sending and clearing, leaves the flags set and the next flush
  resends them; resends are harmless because the consumer is idempotent per
  (url, contentHash).
- **One crawl per site at a time.** `POST /v1/admin/crawl` inserts the run
  only if the site has no queued or running run started in the last 6 hours
  (one `INSERT … SELECT … WHERE NOT EXISTS`, so concurrent requests can't both
  win), else 409 `conflict`. After 6 hours a stuck run (its Workflow died) no
  longer blocks. If creating the Workflow instance throws, the run is marked
  `failed`.
- **Profile status** is the outcome of the last *finished* crawl: `ready`,
  `empty`, `blocked`, `failed` or `not_devtool` (the devtool gate rejected it;
  see below) (`new` before the first one finishes). It
  changes only in `finish` and `fail` (migration `0004_crawl_state.sql`);
  whether a crawl is running now is the separate `crawl_state`
  (`idle`/`crawling`, shown publicly as `crawling: true`), so a re-crawl never
  hides a site's profile. A failed re-crawl of a `ready` site that still has
  pages keeps `ready`; otherwise it becomes `failed`. `lastCrawledAt` is set
  only when a crawl finishes. Discovery facts (docs root, llms URLs, twin
  ratio…) are written as soon as they are known, even if that crawl later
  fails. Whether the site needed a browser is the separate `needs_browser`
  flag. `GET /v1/sites/:site/profile` answers 404 while the status is `new`
  and doesn't expose the run ID.
- Failures anywhere run a `fail` step (kill every sandbox tagged with the run,
  mark run and profile `failed`, delete the run's working files) and rethrow,
  so the Workflow instance shows `errored` too. Successful runs delete
  `crawl-results/<runId>/` in a `cleanup` step.
- `GET /v1/admin/crawl/:runId` returns the D1 run row (the durable record), the
  Workflow status when the instance is still retained, and up to 10 pages the
  run stored.

### Browser crawls (E2B)

- **Interface:** `BrowserCrawler { start, poll, result, stop, stopTagged }` plus
  `runCrawl()` for callers that can wait. A Workflow can't hold one call open
  across `step.sleep`, so the interface is split rather than a single
  `runCrawl(site, budget)`.
- **No SDK, no Connect-RPC.** The template's start command is a small job server
  (`crawler/server.js`, port 8080) captured running in the snapshot, so the
  Worker needs only `POST /v2/sandboxes`, `DELETE /sandboxes/{id}` and plain
  HTTPS to `https://8080-<id>.<domain>`. Sandboxes are created with
  `secure: true` (accepted by the live v2 API; every v2 sandbox is secured
  anyway) and `network.allowPublicTraffic: false`: every call carries E2B's
  `e2b-traffic-access-token`, plus a random per-job bearer token so pages
  rendered inside the sandbox can't drive the job server via localhost. The
  `browser-start` step output (which holds both tokens) is marked
  `sensitive: 'output'`.
- **Tagged sandboxes.** Each sandbox's metadata carries `runId`.
  `browser-start` first kills any sandbox with its run's tag (left by an
  earlier attempt of the same step that died before returning its handle),
  and `fail` kills every tagged sandbox, so no handle is needed to clean up.
  The tag is re-checked client-side after `GET /v2/sandboxes?metadata=…`.
  `start()` is bounded well inside its 3-minute step: create (30 s) plus at
  most four 10 s `/run` attempts 2 s apart.
- **Collect is retry-safe** (`src/crawl/collect.ts`). `browser-collect` writes
  the batch objects, then `crawl-results/<runId>/manifest.json` ({pages,
  batches, skipped, error}) last; a retry that finds the manifest returns it
  without the sandbox. Stopping the sandbox and recording its cost is a
  separate `browser-stop` step, so a collect retry never finds the sandbox
  already killed. An uploaded result (optional presigned path) is checked
  against the 25 MB cap by its R2 `size` before it is read. When the job
  server gives no result (a 409 "not finished", an error answer, the sandbox
  unreachable), collect throws so the step's retries try again; an error
  manifest (0 pages) is written only when the job's own `/status` says
  `failed`. Retries exhausted fail the run through the `fail` step.
- **Result collection:** the Worker reads `GET /result` from the sandbox's job
  server in every environment (traffic token + job token). It must be
  `application/json`, is read with the same capped reader as page fetches (at
  most 25 MB; the crawler caps itself at 20 MB) under a 60 s timeout (25 MB at a
  pessimistic 1 MB/s through E2B's proxy, plus margin). It is validated once,
  stored as one object per page step (`crawl-results/<runId>/batch-N.json`),
  and the sandbox is killed in the same step. So the sandbox holds no
  credentials at all. A presigned SigV4 `PUT` (`content-type` signed, crawl +
  10 minutes, to `crawl-results/<runId>/upload.json`) is used instead only
  when an R2 API token is configured (`R2_ACCESS_KEY_ID` etc.). R2 presigned
  URLs can be used any number of times until they expire, so the key is unique
  per run and the object is deleted once read.
- **Terminated runs (accepted limitation).** The `fail` step runs only when
  the Workflow throws. Terminating an instance from the API or dashboard skips
  it, so a sandbox that run started keeps running until its E2B timeout (crawl
  minutes + 3, at most 60). That is bounded, and the sandbox holds no
  credentials. The kill-by-`runId` at `browser-start` removes it if that run's
  start step executes again; otherwise the E2B timeout does. Sandboxes can
  also be found by hand with `GET /v2/sandboxes?metadata=purpose%3Dscoop-crawl`.
  The run row stays `running`, and the profile's `crawl_state` stays
  `crawling`, until something moves them: the next `POST /v1/admin/crawl` for
  the site marks queued/running runs older than 6 hours `failed` ("abandoned")
  in the same D1 batch as the new run (and that crawl resets `crawl_state` as
  it starts and finishes), and the public profile stops reporting
  `crawling: true` once `crawl_state` hasn't changed for 6 hours.
- **Auth failures** (401/403 from E2B's API or proxy) make `poll` throw instead
  of reporting the sandbox as still running.
- **Endpoints verified against the live API** (2026-10-12, real key):
  `POST /v2/sandboxes` with `secure: true` and metadata → 201;
  `GET /v2/sandboxes?metadata=runId%3D…&state=running,paused` filters by tag;
  `GET /sandboxes/{id}` 200, 404 after kill; `DELETE` 204 then 404; the job
  port without the traffic token → 403; a bad API key → 401.
- **Presigning by hand** (Web Crypto, ~80 lines) rather than `aws4fetch`: no new
  dependency, portable, and pinned by the AWS SigV4 test vector in the tests.
- **Untrusted output:** pages are re-checked in the Worker (`result.ts`): same
  site, http(s), robots-allowed, not on the skip list, URL <= 1,024 chars in
  the indexer's canonical form (`normalizePageUrl`), <= 300,000 chars, unique,
  within budget. The crawler also blocks images, media and fonts, caps the
  result at 20 MB, allows only ports 80 and 443, and blocks private/local
  hosts both as literals and by resolving each hostname once per crawl
  (`dns.lookup`, all addresses must be public). Chromium resolves names
  itself, and `--host-resolver-rules` can only map names, not filter by the
  resolved IP, so a DNS answer that changes between our lookup and
  Chromium's (rebinding) is not covered; the sandbox holds no credentials and
  its job server needs a bearer token, which bounds what that could reach.
- **Limits:** sandbox timeout = crawl minutes + 3 (max 60, the Hobby plan's
  continuous-runtime cap); `maxMinutes` defaults to 10 and is capped at 50.
  Polled every 20 s. Template: 2 vCPU, 2 GiB, `mcr.microsoft.com/playwright:v1.64.0-noble`.
- **Cost** recorded per run: sandbox seconds × (2 × $0.000014 + 2 × $0.0000045)
  = $0.000037/s, E2B's published per-second prices on 2026-10-12.
- **Shared code** (`extract.js`, `robots.ts`, `skip.ts`, `urls.ts`) is copied into `crawler/vendor/`
  because the template build only sees `crawler/`; a root test fails if the
  copies drift. Node in the Playwright image runs `robots.ts` directly (type
  stripping).
- **Hash routes:** docsify-style `#/page` URLs are distinct pages (kept in
  `pages.url`), and the crawler reloads the page for a hash-only navigation so it
  never reads the previous route's content.

### Devtool gate

scoop.md indexes developer documentation. A crawl of anything else (a shop, a
search engine, a social network, a newspaper) wastes requests, sandbox time
and classifier money, and puts junk in search. So the first decision of every
crawl is the `gate` step, after `robots` and before `discover`
(`src/crawl/gate.ts`), cheapest evidence first:

- **Lists** (`src/crawl/gate-lists.ts`, plain data). A short allowlist of known
  docs hosts, optionally with a path (`vercel.com/docs`), passes with no
  request. The denylist rejects search engines, big shops and marketplaces
  (`*.myshopify.com` too), social and video sites, news, banks and a few other
  everyday services, with no request. Patterns: `host` (and subdomains),
  `name.*` (any TLD, including two-part ones like `co.uk`), `*.suffix`. The
  allowlist is checked first, so `docs.aws.amazon.com`,
  `developers.google.com` and `docs.cloud.google.com` pass although
  `amazon.*` and `google.*` are denied. Hosts are compared after
  `normalizeSite`, which also drops a trailing dot (`amazon.com.`). robots.txt is still fetched first (one
  request), as the step order is fixed.
- **Signals** from a handful of polite requests: the start page (asked again
  with an HTML Accept header if the Markdown-first request gets a 4xx/5xx:
  TanStack and Apollo answer it with 500 and 404), llms.txt at up to two bases,
  and the start page's `.md` twin. A redirect stub (meta refresh, or a
  near-empty page whose only link is same-site, as on Kotlin's `/docs/` and
  PyTorch's `/docs/stable/`) is followed, up to two hops. For: llms.txt (3), Markdown
  pages (2), a docs path or `docs.*` host (2), a docs generator (3; generator
  meta or class markers of Docusaurus, Starlight, Nextra, VitePress, MkDocs,
  Sphinx, Mintlify), 3+ docs links (1), code blocks (1–2), install commands
  (`npm i`, `pip install`, `brew install`, `cargo add`, `go get`,
  `curl … | sh`, …; 2), distinct developer terms (1–2). Against: Product/Offer
  JSON-LD or `og:type product` (4), add-to-cart (3), 3+ price elements (2),
  cart/checkout links (2), Shopify markup (3), a search page shape (4),
  NewsArticle JSON-LD (3). **Reject** when against >= 4 and for < against + 3;
  **accept** when for >= 7 and against < 3; anything else is inconclusive.
  llms.txt alone is not enough: Shopify now serves one for every store
  (allbirds.com has one), which is why it is worth 3 and not 7.
- **AI check**, only when the signals are inconclusive: one call to the
  classifier's models (`qwen/qwen3.7-flash`, then `openai/gpt-6-luna` on
  failure) through the same `callModel` (JSON mode, `usage.cost` accounting).
  The input is a summary of at most 4,000 characters: URL, title, meta
  description, up to 30 headings, up to 40 nav link texts and the signal
  counts, never the page, inside a `<site>` block the prompt declares to be
  untrusted data. Output `{isDevtool, category, confidence, reason}` is
  validated (category in a fixed list, confidence 0–1, reason cut to 200
  characters). Accepted only if `isDevtool`, category `devtool-docs` and
  confidence >= 0.6; `devtool-marketing-only` is rejected (start the crawl at
  the docs URL instead). The prompt says a thin page (a JavaScript shell, a
  redirect page) is judged by URL, title and navigation: without that line
  the model rejected Swift's DocC shell and PyTorch's stub as "placeholders"
  in one of two runs. "Mainly for software developers" keeps Figma's and
  Notion's home pages out. The cost goes to `index_costs` like page
  classification, so it counts against the site's and the account's daily
  caps; with the caps spent the call isn't made. Each model call has its own
  60 s timeout, started with the call, so the polite fetches before it can't
  use it up.
- **Outcomes.** A rejection is recorded in one D1 batch (`recordGate`): run
  `rejected` with the reason in `error`, profile `not_devtool` with
  `gate_category/confidence/reason/method` (migration `0005_devtool_gate.sql`).
  No discovery, no page, no sandbox. The public profile of a `not_devtool` site
  is only `{site, status, category, reason, confidence, method, crawling,
  checkedAt, updatedAt}`; other profiles carry the last verdict as `gate`. An
  accepted verdict is stored the same way and the crawl goes on. Invalid JSON
  from both models rejects with a reason (we couldn't verify it; force to
  override). Two cases are *undecided* rather than rejected, because a
  rejection would mislabel the site: no OpenRouter key, or the daily cap is
  spent. The run then fails with the reason; the profile's status is left as
  it was (a new site stays `new`, a `not_devtool` one stays so) and only
  `crawl_state` goes back to `idle`. A transient OpenRouter outage throws, so the step retries.
  A start page that robots.txt keeps us off passes with no category
  (discovery records `blocked`). One that can't be read (403, 5xx) is judged
  by its URL alone by the model (bestbuy.ca, which answers our bot with 403, is
  rejected as ecommerce); without a key it passes to discovery.
- **Override.** `POST /v1/admin/crawl {"site", "force": true}` skips the gate;
  `crawl_runs.forced` records it, and the profile's verdict becomes method
  `forced` (category and confidence cleared, the run ID in the reason), so an
  old rejection doesn't sit next to a crawled site. A
  rejected site can be crawled again any time (a rejected run is finished, so
  it doesn't block the next one); every crawl is gated again, so a site that
  changed is re-judged.
- **Measured** (2026-10-12, `wrangler dev`): docs.stripe.com, vercel.com/docs
  and react.dev pass by allowlist; hono.dev/docs by signals (0.95); amazon,
  google, bbc.com, etsy, wikipedia by denylist; allbirds.com by signals
  (12 price elements, Shopify; 0.63); theverge.com by AI (news, 1.0, $0.0002).
  Gate only, over the 42 seeds not on the allowlist: all 42 accepted (28 by
  signals, 14 by AI) for $0.0015. Unlisted non-devtools: zappos, espn, nasa.gov,
  notion, figma, canva and bestbuy.ca rejected by AI, gymshark by signals.
  linear.app passes by signals (llms.txt, code blocks, API docs links): it
  has a developer API, so that is defensible.

### Seeds and the crawl runner

- `backend/seeds/devtools.json`: 109 docs start URLs of tools developers use
  daily (languages, frameworks, hosting, databases, payments/auth/email, AI,
  tooling, UI). Each was fetched once with our UA on 2026-10-12 and answers 200
  without leaving its host (the crawler refuses off-site redirects, so
  `remix.run/docs` became `guides.remix.run`, `fly.io/docs` `docs.fly.io`, and
  so on). Start URLs are directories, not pages, because the start path scopes
  the docs root. Default `maxPages` 200.
- `backend/scripts/crawl-seeds.mjs` is plain Node with no dependencies beyond
  the backend's own source (the dry run imports `gate.ts` to show list
  verdicts). It runs at most `--concurrency` crawls and never two of one site
  (Cloudflare has three seeds), puts a 409 back in the queue for a minute (up
  to 30 tries), polls each run every 10 s and treats an `errored`/`terminated`
  Workflow with an unfinished run as failed. The token is only ever sent in
  the Authorization header.

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
  `href`), so one page has one spelling; `src/lib/urls.ts` does it for both
  queue messages and `POST /v1/admin/index`. Plain anchors (`#intro`) are
  dropped; a client-side route (`#/cdn`, as on docsify sites, one page per
  route) is kept, cut at a `?` or a second `#`, with trailing slashes trimmed;
  the bare root route `#/` is dropped. The crawler sends URLs already in this
  form.
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
- **Retries:** a batch holds at most 3 messages (`max_batch_size`), handled
  concurrently with `Promise.allSettled`, each acked or retried on its own, so
  one slow or failing page can't hold up or fail the others (handled one at a
  time, a batch of 5 took ~150 s in `wrangler dev` and was sometimes cancelled
  as hung). Classification has a 60 s wall-clock budget per page across both
  models (an `AbortSignal` passed to every OpenRouter call; no fallback call
  once it's spent); running out is a transient failure. At most 3 consumer
  invocations run at once (`max_concurrency`); failures
  `retry()` with 30 s × 2^(attempt−1) up to an hour, `max_retries` 6, then go
  to the dead-letter queue `index-pages-dlq-<env>` (nothing consumes it; it's
  for inspection). Bad messages (missing fields, non-http(s) URL, URL not on
  `site`, non-hex hash) and a missing R2 object are acked and logged instead:
  retrying can't fix them. A classifier that is unavailable (every model
  failed transiently: timeout, dropped connection, 429, 5xx or another HTTP
  error) throws, so the message is retried with backoff; the R2 cache means
  any part that succeeded isn't paid for again. From the 4th delivery of a
  new page (about 3.5 minutes of backoff in) it is indexed unclassified
  (`model` `none`) instead, so a long outage can't leave a first-seen page
  unsearchable in the dead-letter queue, out of the daily job's reach. A
  reclassify message keeps retrying: its page is already searchable. Output that fails validation
  is not retried here (see "Unclassified pages").
- **Cost caps:** `index_costs(site, day)` sums OpenRouter `usage.cost` per
  site per UTC day, failed attempts included, plus an account-wide row with
  site `*`. Reported `usage.cost` is used when present. Otherwise a call that
  may have been billed (timeout, dropped connection, a 200 whose body broke
  off, an unreadable 5xx such as a gateway timeout page) is charged an
  estimate: prompt characters / 4 at the input price plus all 8,000
  `max_tokens` at the output price, from a per-model table at about twice
  OpenRouter's listed prices (unknown models priced higher still). HTTP
  errors that come back with an OpenRouter error body (429, 4xx, most 5xx)
  aren't billed and are charged nothing. Once a site reaches `INDEX_DAILY_CAP_USD` (default $2)
  or the account reaches `INDEX_DAILY_TOTAL_CAP_USD` (default $10), pages are
  still chunked, embedded and searchable but not classified: `slot` `other`,
  no topics or entities, `model` `none`. The check runs before each call, so
  up to 3 concurrent consumers can overshoot by one call each (about a tenth
  of a cent).
- **Unclassified pages:** `model` is `none` (cap reached, or no
  `OPENROUTER_API_KEY`: indexing works without the key) or `failed` (no model
  produced valid output and at least one answered with output that failed
  validation; all-transient failures throw instead, see "Retries"). Such rows
  don't count as indexed for the idempotency check.
- **Reclassifying** (a message for content already indexed but unclassified):
  a classification already in the R2 cache is free, so it is applied whatever
  the caps say. Otherwise the caps are checked first, and if one is reached
  the message is `unchanged` without reading anything else. Otherwise only the
  classification-derived data changes: `page_index`, `entities`, topic counts
  and each vector's `slot` metadata. Vectorize can't update metadata alone, so
  vectors are read back with `getByIds` (20 at a time) and upserted with their
  own values; only vectors missing from the index are embedded again, from the
  chunk text in D1. Chunks and FTS rows are untouched.
- **Attempts:** `page_index.attempts` counts `failed` results for the current
  content (reset to 0 by a success or new content). After 3 the daily job
  stops re-enqueuing the page; a content change starts over.
- **Daily reclassify job** (cron `17 4 * * *` UTC, after the caps reset;
  `src/index/reclassify.ts`): re-enqueues the oldest `none`/`failed` pages
  with `attempts < 3` (index `page_index_model (model, indexed_at)`). The batch
  is today's remaining account budget (`INDEX_DAILY_TOTAL_CAP_USD` minus spend)
  divided by the average cost of the last 500 classified pages (or the
  estimate for a 20,000-character page when there are none), clamped to
  [50, 2000]. Each site gets at most `INDEX_DAILY_CAP_USD` / that average
  pages (`ROW_NUMBER() OVER (PARTITION BY site ORDER BY indexed_at)`), so one
  site with a large backlog, which its own cap would stop anyway, can't take
  the whole batch from the others. The cron does nothing without the API key.
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
  `site`/`slot` metadata), fused with reciprocal-rank fusion (k = 60).
  Chunks from an `llms-full.txt` URL are multiplied by 0.3 after fusion: the
  file repeats a site's whole documentation, so it matches nearly every query
  and outranked the pages it was copied from (the D1 one is 597 KB). Weighting
  at query time was chosen over skipping the file at index time because it
  doesn't depend on the order pages arrive in, and the file stays searchable
  for sites that publish nothing else. With all 50 fused candidates read
  back and re-sorted, a down-weighted chunk makes room for the next ones. On
  the D1 docs, "d1 database size limit" had an llms-full chunk at #2; it is
  now #10. Scores
  are RRF scores, comparable only within one response. If embedding or
  Vectorize fails, results are FTS5 only (logged). Site and slot filters are
  re-checked against D1, since vector metadata can lag a re-index.
- **Topics:** the `topics` table counts pages per topic prefix (`a`, `a/b`,
  `a/b/c`). Indexing a page recounts every prefix of its old and new paths
  from `page_index`, in the same transaction after the `page_index` write, and
  deletes zero rows; counts are never adjusted by ±1, so concurrent consumers
  or a drifted row can't leave them wrong. `page_index.topic` holds the joined
  path. A prefix `p` is counted, and topic packages are read, as two index
  range scans on `(site, topic)`: `topic = p`, and `topic >= p || '/' AND
  topic < p || '0'`, which holds exactly the topics starting with `p/` (`0`
  follows `/` in byte order). A unit test checks with `EXPLAIN QUERY PLAN`
  that both use `page_index_site_topic` and nothing scans the table. (`LIKE`
  can't use the index here and scanned the whole site; `substr` compared
  SQLite's character count with JS's UTF-16 length.)
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
  `q` is required and at most 200 characters, `limit` 1-50 (default 10), `slot`
  must be in the enum, `site` must look like a hostname.
- **Query embeddings:** every search (and `?q=` package) embeds the query, and
  a flood could use up the account's Workers AI rate limit, which indexing
  needs too. So `/v1/search` and `/v1/packages?q=` also go through
  `SEARCH_LIMITER` (60/min per IP, namespaces 4110-4112), and query vectors
  are cached in `caches.default` for 10 minutes keyed by the model and a
  sha256 of the normalised query (lowercased, whitespace collapsed). The
  vector doesn't depend on `site` or `slot`, so they aren't in the key. A
  cache error only costs the embedding call.
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

## Admin console (admin.scoop.md)

- **Same Worker, another host.** `admin.scoop.md` / `admin-staging.scoop.md`
  are custom-domain routes on the API Worker. `src/index.ts` sends the
  environment's `ADMIN_HOST` (and `admin.localhost` in dev) to `src/admin/app.ts` before the
  v1 router runs, so the API's routes, CORS and read limits are untouched and
  the console reuses the stores, search and crawl code in-process (no
  `ADMIN_TOKEN` in the browser). The v1 API is not served on admin hosts and
  the console is not served on API hosts.
- **Static UI through Workers Static Assets** (`admin/`, binding `ASSETS`,
  `run_worker_first: true`), so the Worker authenticates every file before
  calling `ASSETS.fetch`. Plain HTML, CSS and one ES module; hash routing, so
  only `/`, `app.js`, `style.css` and the icon exist. The brand tokens are a
  copy of `extension/theme.css` (the assets directory can't reach outside
  `backend/`).
- **Basic auth with a lockout.** A rate limiter that only counts failures
  can't stop a guesser on its own: the 11th guess is still checked. So when
  `ADMIN_AUTH_LIMITER` (10/min) refuses a failure, the subject (HMAC of
  `ipSubject`, keyed by `RATE_KEY`) gets a 60 s row in `admin_auth_lockouts`,
  and a locked-out subject gets 429 before its credentials are looked at.
  That is one indexed D1 read per console request, which the console's
  traffic can afford. Requests without an Authorization header don't count,
  so a browser's first, bare request (which triggers the prompt) never locks
  anyone out. Unset `ADMIN_UI_USER`, `ADMIN_UI_PASSCODE` or `RATE_KEY`: 401
  for everyone.
- **Security review follow-ups (M1, L1-L5).**
  - A passcode under 32 characters fails closed, like an unset one.
  - Every failed attempt logs `admin_auth_fail` with a 16-hex hash of the
    lockout key: one source can be told from many without logging an IP.
  - A request without credentials gets 401 before any D1 read; the others
    pass the per-IP `READ_LIMITER` before the lockout lookup, so the lockout
    table can't be used to make the Worker query D1 at line rate.
  - There is no global lockout: it would let anyone lock the owner out.
  - Cross-site reads of `/api/*` are refused when `Sec-Fetch-Site` says so;
    `search` and `package` embed the query.
  - One running batch at a time.
  - E2B spend is capped per UTC day. The cap is enforced where a sandbox is
    about to start (the Workflow's `browser-budget` step), not in
    `startCrawl`: only discovery knows whether a site needs a browser, and a
    cap reached by browser crawls shouldn't stop Markdown crawls. The
    sandbox's worst case is reserved in one conditional UPDATE, so concurrent
    runs can't overshoot. A run that fails mid-sandbox keeps its reservation
    as its cost, an overestimate on the safe side.
  - Cancelling marks a run failed only once its Workflow is certainly stopped;
    a run whose instance can't be reached is left for the stale-run rule.
  - Admin hosts are pinned per environment (`ADMIN_HOST`); `admin.localhost`
    works only when `ENVIRONMENT` is `dev`.
- **CSRF** relies on `Sec-Fetch-Site: same-origin` (sent by every current
  browser), falling back to an exact `Origin` match; neither header means
  refused. Basic auth credentials are sent automatically by the browser, so
  this check is what stops another site from POSTing to the console.
- **CSP without 'unsafe-inline'.** No inline script or style; dynamic widths
  (meters) are set through CSSOM, which `style-src 'self'` allows. All crawled
  and shared content goes in with `textContent`; links to crawled URLs only
  ever carry http(s) hrefs.
- **Seed batches in a Workflow, state in D1.** `CrawlBatch` ticks every 15 s
  (`tickBatch`: follow runs, then start waiting jobs up to the concurrency);
  the jobs live in `crawl_batch_jobs`, so the Workflow is only a clock. After
  300 ticks it hands over to a new instance (`<batchId>-<n>`) rather than
  approach the per-instance step limit. A job is claimed (run ID written)
  before its crawl starts, so a retried tick recognises a start that went
  through. Same rules as `scripts/crawl-seeds.mjs`: never two of one site,
  409 retried after a minute, 30 tries. Seeds are selected by start URL
  (`developers.cloudflare.com` appears three times).
- **Cancelling a run** terminates the CrawlSite instance, kills its tagged
  sandboxes and marks the run failed itself, because a terminated Workflow
  never runs its `fail` step. The profile only goes idle (`endCrawl`): a
  cancelled crawl has no outcome.
- **The skill package preview is the extension's code.** `api.ts` imports
  `shared/package.js` (typed by `package.d.ts`, left out of the
  extension zip) and calls `buildPackage(withCurrentPage(sections, null,
  pageUrl))`, i.e. what the popup copies on the skill's own page when the local
  scoop found nothing to add.

## Cost per crawl

What a crawl costs, so the average per crawl and per page is known over time.

- **Four parts per run** (`crawl_run_costs` view, migration 0007):
  - browser sandbox: `crawl_runs.cost_usd`, E2B seconds × the template's rate
  - devtool gate: `gate_cost_usd`, the AI check
  - page classification: `classify_cost_usd`, OpenRouter
  - embeddings: `embed_cost_usd`, Workers AI, estimated
  The total and the cost per page are computed in the view, not stored, so
  they can't drift. Per page means per stored page (new + changed).
- **Attribution.** The crawler's index messages now carry `runId` (from
  `pages.run_id`, the run that stored that content). The indexer charges what
  the page actually cost on this call to that run:
  - classification: `usage.cost`, or the estimate when OpenRouter gives none;
    nothing when the classification came from the R2 cache
  - embeddings: the estimated tokens
  The charge goes into `index_run_costs (run_id, url, content_hash)`, written
  in the same D1 batch as the page_index write. The run's totals and
  `pages_indexed` are then recomputed from those rows in that batch.
- **No double counting.** A redelivered message whose work is already done
  takes the `unchanged` path, which writes zeros (and marks the page indexed
  for the run). Since the cost row commits atomically with the index write,
  a message is charged only when its work actually ran. The keyed increments
  therefore never double-count.
- **Known undercount.** Spend on a failed attempt that is then retried (a
  classifier outage before the fallback, or an embedding redone after a D1
  failure) is in `index_costs` but not charged to the run.
- **Other buckets:**
  - The daily reclassify cron sends `runId: 'reclassify'`. Its spend goes to
    `reclassify:YYYY-MM-DD`, apart from the run that crawled the page.
  - `POST /v1/admin/index` and messages without a run go to `manual`.
  - A page that is still pending when a later run fetches it unchanged is
    charged to the later run (`pages.run_id` moved on); this is rare.
- **The daily caps are unchanged.** `index_costs` is written exactly as before.
- **Embedding rate.** `@cf/qwen/qwen3-embedding-0.6b` costs 1,075 neurons per
  million input tokens at $0.011 per 1,000 neurons, about $0.0118 per million
  tokens (developers.cloudflare.com/workers-ai/platform/pricing, last updated
  Oct 9, 2026). Tokens are estimated with `chunk.ts` `estimateTokens`. The
  10,000 free neurons a day are ignored, so this is an upper bound; for a
  typical page it is a few millionths of a dollar.
- **When a total is final.** A run's total is final once `pages_indexed`
  reaches its stored pages (`indexing_done`), because classification and
  embedding land after the crawl ends.
  - The Costs page averages only runs whose total is final, and counts the
    others as "still indexing".
  - `crawl-seeds` re-reads every run at the end and prints the per-page cost,
    or `indexing n/m`; `--wait-indexing N` waits for indexing to catch up.
- **Averages** are weighted: total spend over total pages, per crawl, and per
  path (markdown, html, browser, or rejected for runs the gate turned away).
  A message dropped as permanent (missing R2 object) keeps its run at "still
  indexing"; it shows up as indexed n/m.

## Crawl requests (on-demand crawls from the extension)

`src/crawl/requests.ts`, migration `0008_crawl_requests.sql`, spec in
BACKEND.md §5 "Crawl requests".

- **Two-phase counting, starts only** (review H1, L5; counts are also given
  back when creating the Workflow throws). Rejections (denylist,
  `not_devtool`), joins and recent answers count nothing. Otherwise the
  per-install and per-IP daily counters are bumped and checked first; only
  when both pass is the global counter bumped, and if that goes over
  `CRAWL_REQUESTS_DAILY_MAX`, or the crawl then doesn't start (a lost race),
  all three are given back. So a flood from one IP can't eat the global
  budget: 400 requests from one IP leave it at 15 (tested). A request that
  waits for another scope counts as a start, since its crawl will run.
  Because every POST still writes a `crawl_requests` row, all of them are also
  limited hourly (60 per install, 300 per IP). Limited requests (429) are not
  recorded. IPv6 counts by /48 for these limits (a site's usual allocation).
- **Daily windows get their own table** (`daily_counters`, keyed like
  `rate_counters` with an HMAC of `bucket:day:subject`): `rate_counters`
  prunes every past hour on each check, which would delete a day's counts.
  The global limit is one counter with an empty subject. `Retry-After` runs to
  00:00 UTC.
- **Install IDs are stored as HMACs** (`RATE_KEY`, `crawl-request:` prefix),
  so the admin view can group requests by install (first 8 hex characters
  shown) without the ID itself being kept.
- **Where a requested crawl starts.** The page's first path segment when the
  page is deeper than one segment (`developers.cloudflare.com/d1/get-started`
  → `/d1/`, `docs.python.org/3/library/os.html` → `/3/`), so a 100-page crawl
  covers the product the user is reading rather than the whole host; else the
  site root. The profile is still per host.
- **Scopes** (review L1). A request's scope is its start URL; scopes compare
  by site and path (`www.` and a trailing slash ignored). A request joins a
  queued/running crawl of its own scope, and is answered from a complete
  crawl of its own scope in the last 7 days. While another scope of the site
  crawls (one crawl per site at a time), it is recorded as `waiting` (no run)
  and reported `queued`; the first poll of any waiting request after the
  site is free starts the oldest waiting scope's crawl and points every
  request waiting for that scope at it. A waiting request older than 6 hours
  is `failed` ("busy, try again later"). A lost start race with nothing
  running falls back to the scope's (or site's) last complete crawl (L3).
  Waiting scopes are also started without anyone polling: every end of a
  CrawlSite run (finish, fail, gate rejection, unreachable host) runs a
  `start-waiting` step, which never throws (a failure there must not turn a
  finished run into a failed one), and the hourly cron sweeps every site with
  a fresh waiting request (`startAllWaiting`). All three paths call the same
  repeat-safe `startWaiting`, which does nothing while any crawl of the site
  is active.
- **Checks run cheapest first**: the gate's lists (a denylisted site is
  rejected before anything is counted), then `not_devtool`, scope join and
  cooldown, then the spend share, then the counters (review M3).
- **Spend share** (M3). Requested runs are marked (`crawl_runs.requested`).
  At request time, today's requested sandbox spend (reservations included)
  must be under `ONDEMAND_E2B_SHARE` × `E2B_DAILY_CAP_USD`, and requested
  runs' AI spend (their pages' classification and their gate checks) under
  `ONDEMAND_INDEX_SHARE` × `INDEX_DAILY_TOTAL_CAP_USD`; both default to 0.5,
  leaving half of each cap to admin crawls. Past either, 429 "busy". In the
  Workflow, a requested run's sandbox reservation must also fit the share
  (as well as the full cap), so runs already admitted can't overshoot it.
- **Approval for requested sites** (M2, the owner's default). A requested
  crawl passes the gate with `requireAi`: allowlisted sites are admitted;
  otherwise the signals can reject but only the AI check admits (no key, or
  its cap reached, fails the run as busy). A site first seen through a
  request gets `source = 'requested'` and `approved = 0` (`1` when
  allowlisted); an existing profile keeps its source and approval. Unapproved
  sites serve their own endpoints but are left out of `/v1/search` without
  `site` in the candidate queries themselves (FTS: `c.site NOT IN (SELECT site
  FROM site_profiles WHERE approved = 0)`; Vectorize: `site: { $nin: [...] }`
  on the existing site metadata index, for up to 100 such sites), so a flood
  of unapproved chunks can't crowd approved ones out of the top 50; the fused
  hits are filtered again (and alone past 100 unapproved sites). Admin: Approve (sets
  `approved`) and Reject (status `not_devtool`, gate method `admin`, and the
  site's chunks, vectors, entities, topics, page_index rows and page rows
  deleted; refused with 409 while a crawl of it runs; R2 Markdown, which is
  content-addressed and may be shared, stays). Reject is also refused while
  the site has pages in the outbox or a crawl that finished in the last 30
  minutes still has pages to index. Messages that arrive late anyway are
  acked and skipped by the indexer: any message for a `not_devtool` site, and
  a crawl's message (`runId` `cr_…`) whose `(url, content_hash)` has no
  `pages` row (purged, or the page changed since). Manual and reclassify
  messages need no `pages` row. The Overview shows the pending count; Sites
  has a "pending" filter.
- **Request IDs** are `rq_` + a ULID (48-bit timestamp + 80 random bits):
  not enumerable in practice. `GET /v1/crawl-requests/:id` needs no auth and
  shows only that request's progress, so holding the ID is enough.
- **Public reasons** (M1). A failed request's `reason` is one of three fixed
  strings (`crawl failed`, `this site needs a browser and that's unavailable
  right now`, `busy, try again later`), chosen from the run's error; the
  error itself is shown only in the admin console. Gate rejection reasons are
  passed through as they are.
- **Unreachable hosts** (L4). A requested crawl whose robots.txt is
  unreachable (5xx, network) stops right after the robots step: the run fails
  and the profile's status stays as it was (`new` for a first crawl, so not
  public) instead of becoming `blocked`.
- **Retention** (L2). Crawl requests are deleted after 90 days by the hourly
  cron: a page address is browsing interest even with the install ID
  hashed. The privacy page says so.
- **`not_devtool` is final for requests**: an admin can still force a crawl.
- **State comes from the run, not the request row.** `crawl_requests.state`
  records what the request did (`started`, `joined`, `recent`, `rejected`);
  the live state is computed on every read: run `queued` → `queued`
  (phase `gate`); `running` → `running` with the stored phase; `rejected` →
  `rejected` with the gate's reason; `failed` → `failed` with the error;
  `complete` → `indexing` (phase `index`) while the run's `pages_indexed` is
  below the pages it stored, else `complete`. Two escape hatches: a run still
  queued/running after 6 hours is `failed` ("crawl abandoned"), and a crawl
  finished more than 30 minutes ago is `complete` even if a page never got
  indexed (a dead-lettered message). A run from before cost tracking
  (migration 0007) can't count indexed pages and is `complete`.
- **Phase** is written by the Workflow at step boundaries (`start`: `gate`, or
  `discover` when forced; the gate's verdict: `discover`, or `done` when
  rejected; `profile`: `fetch`; `browser-budget`: `browser`; `finish`:
  `done`). A failed run keeps the phase it failed in. `index` is never stored.
- **`pagesIndexed` includes unchanged pages**, which an earlier crawl
  indexed, so a re-crawl's progress reads naturally; it equals `pagesFound`
  once complete.
- **`etaSeconds` is a rough guide**: about 1.2 s a page to fetch and 8 s a page
  to index (classification dominates; 10–12 s measured locally with one
  consumer), assuming 60 pages until the count is known. The D1 docs (55
  pages) took about 1 minute to fetch and about 10 minutes to index locally.
- **Anchored packages** match the page by its normalised URL, without a
  trailing slash, as its `.md` or `/index.md` twin, or the HTML page of a `.md`
  URL (crawled pages are stored under whichever URL the crawl planned). The
  related search uses the page title plus its section headings (≤ 200
  characters) and leaves out the anchor's own chunks. A page that isn't indexed
  gets a package from its URL's path words, so the popup still has something
  useful. `not_indexed` (404) only when the site has no indexed page at all.
- **Site status** reports `pages` as indexed pages (`page_index`) and
  `indexed` = `ready` and `pages > 0`; private hosts are 400 (checked like a
  fetch target) so the endpoint never confirms anything about internal names.
  A `ready` profile with no indexed page is reported `new` (a first crawl
  finishes before its pages are indexed), and `crawling` stays true until the
  latest request is `complete`: the run ends, and `crawl_state` goes idle,
  while its pages are still in the index queue. Found by the extension's real
  run, which saw `ready`, `indexed: false`, `crawling: false` mid-indexing.
- **The requested page is crawled first** (`priorityUrl`, passed from the
  request through `startCrawl` to discovery): its `.md` twin when one answers
  (the site's twin pattern first, then the other; a `.md` URL is used as is),
  else the page's own HTML (`page-html`), at the head of the plan, ahead of
  llms.txt and exempt from the skip list, so a 100-page crawl that starts at
  the product root can't miss it. On a site that needs the browser, the
  browser crawl starts at it. Off-site, robots-disallowed or over-long
  requested URLs are ignored. A Markdown site whose requested page has no
  twin and only renders client-side gets a `page-html` attempt that fails
  (too few words); the rest of the crawl is unaffected. Live on
  docs.python.org: without it, `/3/library/os.html` wasn't among the 21
  pages the `/3/` crawl reached and its package fell back to path words.
- **Markdown by content negotiation.** Some servers (Read the Docs, e.g.
  flask.palletsprojects.com) answer our `Accept: text/markdown` with Markdown.
  When the start page comes back as Markdown, discovery follows its Markdown
  links (under the docs root, minus the skip list) as `page-html` sources,
  which `fetchPlanned` keeps as `page-md`. Before this, the start page was fed
  to the HTML extractor, found no `<a>` links, and a live Flask crawl planned
  two pages; it now plans 30 of 30.
- **`extractPage` never throws.** linkedom builds no document element for
  input without an `<html>` tag (an empty body, a comment, a fragment, plain
  text), and the extractor then threw, failing the whole crawl in discovery
  (seen live on Flask). Such input is wrapped in a document, and any error
  extracts to nothing (0 words): a failed page, not a failed crawl.
- **Telemetry**: `api_crawl_request` through the existing API-usage path,
  with the request's state as both `props.state` and the row's `outcome`
  (`rate_limited` for 429s). The status and polling endpoints are not
  recorded (the popup polls them).
- **Reference server**: keeps the shapes in memory; it can't crawl, so a
  request stays `queued`, and `?url=` packages are always `not_indexed`.
  Rate limits are left to the Worker, as for the other writes.
- **Permalink markers** are stripped from page titles and heading trails in
  `headingText` (`src/index/chunk.ts`), which the indexer, skill titles and the
  crawler's stored page titles all use: a trailing `¶`, `§` or `🔗` (Sphinx
  serves `# Title [¶](#title)`, whose link text survives link stripping), a
  `#` standing apart at the end, and the same markers leading the text
  (VuePress). A `#` attached to a word (`C#`, `F#`) is kept. A scan, not a
  regex, since heading text comes from the site.

## On-demand crawls: live staging fixes

Found by the extension's real run against staging (2026-10-12).

- **A request stuck at "indexing 100/101"** (docs.astral.sh). The missing
  page, `ruff/default-rules/` (55.8 KB, 27 chunks of rule codes), was sent to
  Workers AI in one embedding call and refused with `3030: input too big` on
  every delivery (14:01–14:10 UTC); after `max_retries` it went to the
  dead-letter queue, and nothing recorded it, so the run's indexed count
  never reached its stored count. Dense text tokenises far above the
  chars / 4 estimate. Fixes:
  - embedding calls carry at most 16,000 characters (and 32 inputs); a call
    refused as too big is split in half, and a single input halved, until it
    fits (`src/index/embed.ts`);
  - every terminal non-indexing outcome is recorded on the run
    (migration 0010): `skipped` (site rejected, page row gone) and `failed`
    (a permanent error, or the last delivery, `MAX_DELIVERIES` = max_retries
    + 1 = 7, before the dead-letter queue, which still receives the
    message). `crawl_runs.pages_index_failed` counts them and
    `index_progress_at` records the last outcome; a request is complete when
    indexed + skipped/failed reach the pages stored, so within a minute of
    the last real index;
  - the escape hatch for anything unrecorded is now 5 minutes after the
    crawl ended or its last index progress, not 30.
- **"/packages 404 for hono.dev right after complete"**. Staging's Workers
  Logs (every request that day up to 14:14 UTC) show no 404 from
  `/v1/packages`; the request completed at 14:02:05 (its 4 pages indexed
  14:01:54–14:02:05), and the only failure is a **500 at 14:05:12**,
  `D1_ERROR: internal error`, after 3.45 s, followed by 200s from 14:05:18.
  Errors were already `cache-control: no-store`, so nothing was cached.
  Fixes: a transient `D1_ERROR: internal error` is retried once; the anchor
  lookup and the index-version check are one D1 batch (fewer round trips to
  fail); `not_indexed` is explicitly never cached (tested); and the package
  works from D1 alone when the vector side fails or has nothing yet (anchor
  chunks from `chunks`, related chunks from FTS; tested with a failing
  Vectorize).
- **`/packages` latency (~2.3 s on staging)**. The cost was sequential D1
  round trips (index check, anchor page, its chunks), embedding the query
  through Workers AI, then FTS and Vectorize, then reading the chunks.
  Now: one batch for the index check, version and anchor chunks; full-text
  search first, with the embedding and vector query skipped when FTS finds
  at least 12 related chunks, or any at all on a site of 30 indexed pages
  or fewer (measured on staging before the change: docs.astral.sh 0.4 s
  warm, hono.dev with 4 pages 3.0-6.6 s every time, all of it the vector
  side, since FTS could never reach 12); and the finished package cached in the Cache
  API for 10 minutes keyed by site, normalised page URL, budget and index
  version (`COUNT(*)` and `MAX(indexed_at)` of the site's page_index, so any
  newly indexed page changes the key). The search rate limit applies only on
  a cache miss.
- **Status semantics**: `indexed: true` / `ready` while the request is still
  `indexing` is intended (the extension uses the pages already indexed);
  `crawling: true` until the request is complete says more are coming.
- **Verified on staging after the deploy (aa0e75b)**: the astral request reads
  `complete` (101/101); fresh requests for valibot.dev (39 pages, 4 m 13 s
  end to end) and biomejs.dev complete; `/packages?url=` is 0.33-0.70 s on a
  miss and 0.25-0.33 s on a hit for docs.astral.sh and hono.dev, no errors.

## Jev: fast gating, classification and instant answers

Crawling was too slow for a user waiting in the popup: the gate's AI check
took 15-20 s and classification about 8 s a page with qwen through
OpenRouter (staging: docs.astral.sh indexed 100 pages in 10.2 minutes, 9.8
pages a minute; valibot.dev 10-12). Jev, TypeSafe's System One model
(`api.typesafe.ai/v1/systemone`, model `jev-latest`), answers typed questions
(noul: a yes/no probability; choice: one of a set, with probabilities) in
0.15-0.3 s. Generation is replaced by narrow decisions, and code does the rest.

- **Client** (`src/lib/jev.ts`): plain fetch, every question in one request
  (one call is far cheaper and faster than several), 5 s timeout per attempt,
  one retry on a timeout, a dropped connection, 429 or 5xx (529 is "overloaded"),
  none on 401/422. Answers are checked: each asked question has an answer of
  its type, and a choice is one of its options. Usage comes back in tokens.
- **Cost**: Jev's price isn't published, so tokens are stored
  (`index_run_costs.jev_tokens`, `crawl_runs.jev_tokens` and
  `gate_jev_tokens`, `index_costs.jev_tokens`, migration 0011) and priced
  with `JEV_USD_PER_MTOK` (default 0) into the existing USD columns, which
  the daily caps count. Live: about 800-1,200 tokens per gate check and
  about 1,700 per page classified.
- **Gate** (`jevVerdict` in `src/crawl/gate.ts`): `is_devtool_docs` (noul)
  and `category` (choice over the gate's categories) in one request over the
  same text summary the OpenRouter check used. Accepted on noul ≥ 0.7 and
  category `devtool-docs`; recorded as method `ai` with a reason like
  `Jev: developer docs 0.97, category devtool-docs (1.00)`. OpenRouter is
  asked only when Jev fails (after its retry); with neither key the gate is
  undecided, as before. Live: 140-215 ms (valibot.dev and biomejs.dev crawl,
  amazon.com rejected as ecommerce, figma.com as marketing-only).
- **Classification** (`src/index/jevclassify.ts`, `CLASSIFIER=jev`, the
  default; `openrouter` keeps the old classifier, off by default):
  - slot: a Jev choice over the 14 slots;
  - topic path from the URL: path segments (and a `#/` route), lowercased,
    without docs prefixes, versions, locales, extensions and `index`, at most
    four levels; a page with one segment gets its title below it. When the
    URL doesn't place the page (no segment, or one that isn't a top-level
    topic yet) and the site has topics, Jev chooses among the site's
    existing top-level topics (up to 40, plus "none of these") in the same
    request: one level of the hierarchical-classification recipe, since the
    levels below come from the URL. A pick under 0.5 is ignored;
  - summary: the first paragraph of at least a sentence's length outside
    front matter, code, headings, lists and tables, cut at a sentence end
    within 400 characters (an llms.txt blockquote when there is nothing else);
  - entities by pattern, each checked to appear in the page as written:
    inline code that is an HTTP request line, an `ERR_…`/`…_ERROR` code, an
    `ENV_VAR`, a `pkg-manager subcommand`, a call `a.b()` or a dotted name
    (a camelCase last part reads as a method, otherwise a config key; files
    and hosts are left out), and request lines and commands inside code
    fences; at most 15;
  - tasks are no longer produced (the search never used them).
  - A Jev failure is "classifier unavailable": the queue retries, and from
    the 4th delivery the page is indexed unclassified for the daily job, as
    with OpenRouter. Live on 20 docs.astral.sh pages: median 244 ms, max
    295 ms per page.
- **Throughput**: the index-pages consumer takes batches of 10, up to 10
  at once (was 3 and 3), with a 2 s batch timeout; the embeddings of a
  batch's pages are requested together (`coalesceEmbed`, packed by
  `packBatches`; a failed shared call falls back to one call per page, so
  one bad page can't fail the others).
- **`GET /v1/quick`** (`src/search/quick.ts`): an answer while a crawl runs.
  Eight candidate fetches at once through `crawlFetch` (llms files at the
  first path segment, docs.<registrable> and the host, and the page's two
  twins), 1 s each, then Jev picks the overview within what is left of
  1.5 s, without a retry. URLs only, so the API never proxies a site's
  content. Live (cold, from a laptop): 0.5-1.0 s for hono.dev, docs.astral.sh,
  developers.cloudflare.com, valibot.dev, docs.stripe.com and biomejs.dev.
- **`GET /v1/sites/index`**: approved sites with indexed pages and their
  counts, an ETag and an hour of caching, so the extension's badge is a
  local lookup and visited hosts never reach the server. Sites without a
  profile (indexed by an admin through `/v1/admin/index`) count as approved.
- **Search tab**: `GET /v1/search` hits carry the chunk `id`, and
  `GET /v1/packages?chunks=` builds a package from up to 30 picked chunks in
  the given order, with the same fencing, budget and note.
- **Discovery fix found on the way**: a requested page that redirects out
  of its scope (biomejs.dev/guides/getting-started/ → /installation/…, with
  /guides/ itself a 404) crawled 1 page. A scope whose page is gone and
  under which nothing was found now becomes the whole site, from the
  requested page; and without a Sitemap line, `/sitemap-index.xml` (Astro)
  is tried after `/sitemap.xml` and `/sitemap_index.xml`.

## No broken links

The owner's rule: no link in what an agent gets may 404. Checking at serve
time would be slow and would hammer sites, so statuses are known ahead and
served links are filtered against them, strictly.

- **Store** (migration 0012): `link_status` per normalised URL (fragment
  dropped, `#/` routes kept): ok, final HTTP status, final URL, when, and by
  whom (`crawl` | `check` | `live`); `link_refs` (site → link, one page it is
  on) for the admin view; `link_check_queue` for links met while serving.
  Existing pages were backfilled as ok (their sources were fetched with a 200).
- **Recording**: `crawlFetch` reports every fetch with its redirect chain
  (`onFetch`); discovery, the page steps and the root-file fetches write
  them. A stored page is also ok under its own URL when it came from its
  `.md` twin. A 429, a timeout, robots.txt or an off-site redirect decides
  nothing.
- **Checker**: the Workflow's `links` step after indexing is flushed; 500
  checks per crawl, same-site first, unknown or older than 14 days. Same
  site through `crawlFetch` (politeness, robots); external with the SSRF
  guard on every hop (a private address is bad without a request), `HEAD`
  then a 1 KB ranged `GET`, two at a time per host 250 ms apart. 2xx (or
  3xx ending in 2xx) is ok; 404, 410 and DNS failures are bad (statuses
  revised in "Production review fixes", H3). A bad link
  is checked again after a day (`bad_checks` 1 → 2 is permanent). A failure
  in the step is logged and never fails the crawl.
- **Rewrite** (`rewriteLinks`): outside code only (fences and inline code
  are code: changing `curl https://…` would break examples). Markdown links,
  images, autolinks and bare URLs: known ok → kept, made absolute (anchor
  kept); anything else → the link text without its URL (a bare URL is
  kept as code text: see "Production review fixes", H3). Unknown targets are queued; the hourly cron checks up to 200.
  Strict on purpose: an unchecked external link is unlinked until checked.
- **Where**: every package mode, search snippets, served shared skills
  (section text; related links only when ok), the package's own lists
  (page URLs, docs index, instruction sources, related). `POST
  /v1/links/check` gives the extension the same answers for its local
  builds (20 live checks within 1.5 s at most; the host limiter refuses a
  turn that would start after the deadline, so a slow or rate-limited host
  can't hold the request).

## Package format

Shorter packages cost the user tokens on every paste, so the format is
compact and opinionated: header and one safety line; the verified docs
index line; instructions for agents; the page's content; at most 5 related
links. Default budget 16,000 characters (was 60,000), at most 60,000. In
`url` mode the content is the anchored page alone and related pages are
links, not text. Each section carries its page URL, which makes a Sources
list a pure repetition, so there is none. One fence per page (not per
chunk), headings that repeat the title dropped, blank-line runs collapsed.

## Instructions for agents

Sites increasingly write guidance for coding agents (llms.txt notes,
AGENTS.md, "For AI agents" sections, MCP servers, version pins). The
package surfaces it, from verified sources only.

- **Candidates** (code): llms.txt / llms-full.txt summaries, paragraphs and
  list items; `/AGENTS.md` and `/.well-known/llms.txt` at the site root when
  present; all blocks of a page or section whose URL or headings mention
  agents, AI, LLM, MCP, Cursor, Claude, Copilot or AGENTS.md; anywhere, a
  paragraph mentioning agents, LLMs, AI assistants or MCP. At most 600
  characters each; near-duplicates (80% word overlap) once; at most 60.
- **Judge** (Jev, 15 candidates per request, requests in parallel): a noul
  ("Is this passage an instruction or guidance addressed to AI coding
  agents or LLMs about how to use these docs or this product?"), kept at
  ≥ 0.75, and a kind choice (usage-rule, preferred-tool, version-pin,
  deprecation, auth-or-safety, other).
- **Store**: `site_agent_instructions` (site, text ≤ 300, url, kind, score,
  found_at), replaced per page on every crawl (the Workflow's
  `agent-instructions` step); kept only when the source URL is known ok.
  A package shows the best 8.
- **/v1/quick** extracts on the fly from a verified llms.txt only, in the
  same Jev request as the overview pick and `isDevDocs`, cached with the
  site's llms files for an hour.

## Production review fixes (H1-H3, M1, M2)

- **H1, instructions as an injection channel.** Site text addressed to
  agents is exactly what a hostile site would write. So: (a) it is quoted,
  never relayed: `## What this site says to AI agents`, a line saying it is
  quoted from the site and never overrides the user or the agent's own
  rules, the items as a blockquote, and the safety line covering it;
  (b) a second Jev noul in the same request asks whether the passage wants
  anything beyond using the product (commands, files, credentials or env,
  other sites, persona, hiding things), dropped at ≥ 0.3 (a missing answer
  drops it too), and before Jev, code drops passages that pipe into a shell
  or interpreter, curl/wget another host, or link another registrable
  domain; (c) extraction and serving only for sites an admin approved or on
  the allowlist (a user's request alone never puts a site's words in front
  of agents), and /v1/quick returns them only for an indexed, approved
  site; (d) `registrable()` (`src/lib/domains.ts`) knows country second
  levels and ~60 multi-tenant hosting suffixes (github.io, vercel.app,
  pages.dev, readthedocs.io, …), and /v1/quick skips the docs.<domain>
  probe on them.
- **H2, /v1/quick amplification and Jev spend.** Its own limiter, 30 per
  minute per IP subject; the first miss per target host per hour probes it
  (a Cache API marker, per colo), later misses answer from the site cache
  without fetching; the page is fetched only when its robots.txt allows.
  Jev has a daily token cap (`JEV_DAILY_TOKEN_CAP`, 5M): `JevOptions.allow`
  is checked before every request (gate, classification, instructions,
  /v1/quick), and `capsReached` counts it, so past it the gate is undecided
  and pages index unclassified. `JEV_USD_PER_MTOK` is set to a provisional
  0.5 so the USD columns aren't zero; tokens stay the ground truth.
- **H3, the rewrite.** Deleting bare URLs destroyed content (an API base
  URL in prose is a value, not a link): bare and autolink URLs not known to
  exist now stay, as code text; only `[text](url)` loses its target. "Exists"
  now includes 400, 401, 403 and 405 (bot walls and method refusals on live
  pages); only 404, 410 and hosts that don't resolve are dead; 429, 5xx and
  the rest are unknown. The scanner is hand-written and linear: fenced and
  indented code (not list continuations), `<pre>` and `<code>`, inline
  spans closed by the same backtick count (matched through per-length
  queues), and balanced parentheses in URLs.
- **M1, /v1/links/check.** Unknown URLs from callers are queued only when
  the library links to them (`link_refs`; a shared skill's links are added
  there); live checks are capped at 10 per target host per minute
  (`LINKCHECK_HOST_LIMITER`); live rows nothing links to are deleted after
  a day by the hourly cron.
- **M2, privacy.** /v1/quick no longer sends the user's page URL to Jev:
  the state is the host; the overview options are kinds, labels and first
  lines (a page's `.md` twin URL would give its path away); the
  is-it-docs question gets the origin, title, description and navigation.

- **Follow-ups found on staging (d75080f).** An llms.txt probe that
  redirects to another page is not an llms.txt: docs.convex.dev sends
  unknown paths to its home page, which answers `Accept: text/markdown`
  with Markdown (an H1 and links), so /understanding/llms.txt "verified" as
  the home page. Discovery and /v1/quick now require the fetch to end at a
  path named llms.txt / llms-full.txt (and a `.md` twin at a `.md` path).
  And `q` mode had no cache (0.7-11 s on staging): `/v1/search` and
  `/v1/packages?q=` are now cached 10 minutes per site, normalised query,
  parameters and index version, like the `url` mode.

- **Re-review follow-ups (N1, N2) and q-mode latency.** N1: a host on a
  hosting platform (`isMultiTenant`) is never let through by the gate's
  allowlist, and readthedocs.io / .org are off it, so evil.readthedocs.io
  goes through signals or Jev and, when requested, the approval queue (no
  auto-approval, no instructions). N2: the hourly host marker skipped
  every later page's own probes; it is replaced by a counting budget per
  target host (`PROBE_HOST_LIMITER`, 20 per minute), and the llms results
  are cached per host (root, docs.<domain>) and per first path segment, so
  each page gets its twins and `isDevDocs` and the root llms.txt is
  fetched once; nothing is cached for a probe that didn't run. Q mode on
  staging after 9191938: warm hits 0.43-0.67 s, but cold misses 1.3-6 s,
  and requests from one client landed in different data centers (EWR, MIA,
  ATL), each with its own Cache API; so the vector side of a miss now gets
  1.2 s, then the answer is full-text only.

## /v1/quick at the site level (`docs`)

The Quick Copy tab works from any page of a product, including its home
page or pricing page, so /v1/quick also says where the site's docs are.
Candidates are the usual docs homes (docs./developer./developers.<domain>,
/docs, /developers, /developer, /api/docs), probed in parallel with their
llms files within the existing 1.5 s budget and per-host probe limit, and
skipped when the page is on a docs host or under a docs path already. The
cheapest evidence decides first (a verified llms.txt, the gate's lists,
the page's signals); Jev is asked only about candidates the signals can't
place, at most 3, in the same request. llms.txt and llms-full.txt are now
reported apart (Bun has only llms-full.txt; Hono's llms-full.txt isn't a
verified index), and come from the docs root when the docs are elsewhere.
Live (from a laptop, cold): stripe.com and /pricing → docs.stripe.com
(0.9-1.4 s), vercel.com → vercel.com/docs, supabase.com → its root llms.txt
or /docs, hono.dev and bun.sh → the page itself. Known gaps: a docs
subdomain that redirects to another domain (docs.anthropic.com →
docs.claude.com) isn't followed, since crawlFetch keeps redirects on site;
and a home page over the 512 KB read cap with a Content-Length (twilio.com)
gives no signals to judge.
A call in which any fetch timed out or failed to connect caches nothing at
the site level: on a cold local workerd the first stripe.com call timed out
everywhere and its empty answer was then served for an hour.

## Live test findings (staging b043896)

- **svelte.dev crawl failed** (rq_01M4RHMNFFWNAHZ6JRPMN96AWV): the
  `agent-instructions` step hit "Worker exceeded CPU time limit" on its
  first attempt and the retry ended in a Workflows internal error, which
  failed the run after its 6 pages were indexed. The CPU went to
  deduplicating candidates pairwise, rebuilding word sets for each pair:
  svelte.dev's llms-full.txt (1.26 MB) gave 1,092 blocks and took 3.5 s.
  Now word sets are built once, at most 300 candidates are compared (24 ms
  for the same file), and llms-full.txt is read like any page (only its
  passages about agents), since it is the whole docs in one file. A CPU
  limit can't be caught, so the step has to stay small.
- **hono.dev missing from /v1/sites/index**: it was first crawled on a
  user's request (`source: requested`) and is still `approved: 0`; the
  index lists approved sites only (requested sites are browsing interest
  until an admin approves them). Approving it in the admin console adds it.
  No page minimum applies.
- **Package header title**: docs.deno.com keeps the page title in YAML
  front matter (`title: "Writing an HTTP Server"`) and starts its body at
  an H2, so the stored title was that H2. Titles now read front matter
  first (page_index, pages); packages also take it from the page's first
  chunk, so pages indexed before this are titled right, and front matter
  itself is no longer copied into packages.
- **allbirds.com llms.txt**: every Shopify store serves an llms.txt; the
  host's own verified llms.txt only means docs when the page wasn't judged
  not developer docs.
- **Cross-domain docs redirect and long pages**: docs.anthropic.com
  redirects to platform.claude.com/docs/ (not docs.claude.com as expected);
  one such redirect is followed from a docs.<x> candidate to a docs host or
  docs path, with the SSRF guard on each hop. twilio.com's pages are over
  512 KB with a Content-Length: page reads for signals now keep the first
  512 KB (`crawlFetch` `truncate`; an over-cap read now also keeps the bytes
  up to the cap). The probe limiter allows 48 requests at once and each
  fetch gets what is left of the 1.5 s, so the redirect's second round fits.

## llms.txt first (0.6.0)

The owner's decision: a scoop is a short link prompt to the docs' llms.txt,
not the docs' content. The backend's job is to have an llms.txt for every
docs site, fast, and never anything for a site that isn't docs.

- **Answer from the registry first.** Discovery (/v1/quick's, ~1-1.5 s)
  only runs on a miss; the page host is remembered as an alias of the docs
  host, so stripe.com and docs.stripe.com/webhooks answer instantly after
  the first scoop. Non-docs answers store nothing: no row, no alias, no
  crawl request (the same privacy rule as `notDocs`).
- **A prepared file is usable at once.** The first answer for a site with
  no llms.txt is `preparing`, but its URL already works: the hosted file
  builds the instant stage on demand if the background build hasn't
  finished. Instant (sitemaps and the docs root's navigation, every link
  checked) takes 1-8 s on real sites; the full stage reuses the crawl and
  classification pipeline (slots give Getting started / Guides / Reference
  and the summaries give one-line descriptions).
- **Instructions for agents are selected, never written.** Verbatim lines
  from the file (or the install pages), deterministic first, Jev only to
  select among too many lines, with the H1 safety filters (no shell pipes,
  no other domains) and dead links dropped. The prompt quotes them as the
  docs' own words.
- **The public URL is configurable** (`LLMS_PUBLIC_BASE`): https://scoop.md
  in production (the site proxies the API), the staging API itself on
  staging, so staging links never point at production.
- **Not in this pass:** Context7 fill-in.

### Security review of the registry (55babfd, bf67580, and the re-review)

- **Every quoted line is screened, and none is served unscreened.** A
  deterministic pre-filter first (secrets, sending data, dotfiles, `sudo`,
  `rm -r`, shell pipes, base64 blobs, other domains and IP literals), then
  Jev's risk question for every line, every heading included; fences are
  reduced to a bare fence. No Jev, no
  excerpt. Stored text is served only at the current screening version
  (`agent_checked` ≥ 2), filtered again as it is served.
- **The install carve-out.** The owner wants "how agents should install
  it", so the llms risk question treats installing this product's own
  package, SDK or CLI with a standard package manager, its CLI's install /
  add / init / create / login / `--version` / `--help`, and setting up its
  own MCP server or API client as using the product. Any other command is
  judged as usual.
- **Accepted risk: a product's own MCP server.** Quoting "connect an MCP
  client to https://docs.example.com/mcp" lets an agent that follows it
  give that server tool access in the user's session. The owner accepted
  this for the product's own server (same registrable domain as its docs,
  passed the risk question); another domain's server is never quoted.
- **The prompt names a site only by its own name** (at most 3 words, part
  of the host's registrable label); otherwise by its host.
- **Shared hosts** (github.com, npmjs.com, pypi.org, …) are never
  registered, except where the gate's allowlist names their docs
  (huggingface.co/docs).
