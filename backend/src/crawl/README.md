# crawl

Proactive crawling of docs sites into our own copy of each site's docs (M2/M3).
Everything except `workflow.ts` is plain TypeScript over `fetch` and Web Crypto,
so it also runs in Node, E2B or on a VPS. Every outbound fetch goes through
`assertFetchable` (`../lib/ssrf.ts`), on every redirect hop.

```
robots.ts    robots.txt (RFC 9309) for scoop.md-bot (+https://scoop.md/bot)
sitemap.ts   sitemap.xml / sitemap indexes (gzip too), linear scan, no DOM
discover.ts  llms.txt links, .md twin URLs, docs root, client-shell detection
polite.ts    per-host politeness (2 in flight, >= 1 s apart, Crawl-delay up to 10 s),
             conditional GETs, same-site manual redirects, read cap
site.ts      discoverSite(): the deterministic discovery pass and fetch plan;
             fetchPlanned(): fetch a batch of Markdown sources
changes.ts   new / changed / unchanged by content hash; R2 key pages/<sha256>.md
presign.ts   SigV4 query presigning for R2's S3 API (PUT of the browser result)
runner.ts    BrowserCrawler interface (start / poll / result / stop) + runCrawl()
e2b.ts       BrowserCrawler on E2B over REST (no SDK)
result.ts    re-validates the browser crawler's (untrusted) output
workflow.ts  Workflow CrawlSite: the Workers-only glue (D1, R2, Queue, steps)
```

Storage is in `../db/crawl.ts` and `migrations/0002_crawl.sql`; the queue
consumer stub is `../index/consumer.ts`; the browser crawler itself is
`/crawler` at the repo root.

## A run

1. `robots` — fetch robots.txt. 4xx: no rules. 5xx/unreachable: stay away
   (status `blocked`).
2. `discover` — llms.txt / llms-full.txt under the start path, `/docs`,
   `/documentation` and the root; sitemaps from robots.txt or `/sitemap.xml`
   (indexes followed, up to 8 files); `.md` twins for 10 sampled pages
   (`<path>.md`, then `<path>/index.md`); OpenAPI links seen along the way.
   The plan, within the page budget: llms.txt, llms-full.txt, Markdown links
   from llms.txt, then twins of sitemap pages (only if >= 30% of sampled pages
   had one). With no Markdown at all, the start page's HTML decides between
   `html_only` and `needs_browser` (a client-rendered shell).
3. `profile` — upsert `site_profiles`.
4. `pages-N` — 10 sources per step, conditional GETs; new/changed content goes
   to R2 once per hash and onto `index-pages`; unchanged pages only refresh
   `fetched_at`.
5. Browser sites only: `browser-start` (create sandbox, start the job with a
   presigned upload URL), `browser-wait-N`/`browser-poll-N` every 20 s,
   `browser-collect`, `browser-stop` (always; records seconds and cost),
   `browser-pages-N` (stored like step 4, source kind `browser`),
   `browser-cleanup`.
6. `finish` — run `complete`; on any error, `fail` kills the sandbox and marks
   the run and profile `failed`.
