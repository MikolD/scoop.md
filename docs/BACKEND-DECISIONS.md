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

## Indexing model (for M4)

Not used yet; recorded from a 4-page trial so M4 starts from a known baseline.

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
- **Key:** Workers secret `OPENROUTER_API_KEY` (not needed until M4).
