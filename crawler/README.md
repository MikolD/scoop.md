# crawler

Browser crawler for docs sites that only render client-side. It runs inside an
E2B sandbox (template `scoop-crawler`), started by the backend's `CrawlSite`
Workflow when discovery marks a site `needs_browser`.

- `crawl.js` — Playwright + Chromium. Renders each page, converts the main
  content to Markdown with `vendor/extract.js` (the extension's extractor, run
  inside the page), follows same-site links under the docs root breadth-first,
  stops at `maxPages` or `maxMinutes`. Honours robots.txt (`vendor/robots.ts`,
  the backend's parser) and the skip list (`vendor/skip.ts`), waits at least
  1 s between page loads, allows only ports 80/443, blocks images, media,
  fonts and private/local hosts (as literals, and by resolving each name). Deterministic; `choose` is
  the hook for an agentic mode later.
- `server.js` — the template's start command (port 8080): `POST /run`,
  `GET /status`, `GET /result`, `GET /health`. See the header comment.
- `lib.js` — pure helpers (tested from the repo's `test/crawler.test.js`).
- `vendor/` — copies of `extension/lib/extract.js`,
  `backend/src/crawl/robots.ts`, `backend/src/crawl/skip.ts` and
  `backend/src/lib/urls.ts`. Refresh with `npm run sync`; a test fails when
  they drift.

The sandbox holds no credentials at all. The backend reads the result from
`GET /result` (E2B traffic token plus the per-job token) and stores it itself.
Only when the Worker has an R2 API token configured does the job carry a
presigned PUT URL for one object key, valid for the crawl plus 10 minutes. Page
content is untrusted: the backend re-checks every page
(`backend/src/crawl/result.ts`) before storing it.

## Run locally

```sh
cd crawler
npm install
npx playwright install chromium-headless-shell
node cli.js https://docsify.js.org/ --max-pages 5 --max-minutes 2 > result.json
```

## Build the E2B template

Needs `E2B_API_KEY` in the environment (never commit it):

```sh
set -a; . ~/.config/scoop.md.env; set +a
npm run template:build      # e2b template create scoop-crawler (2 vCPU, 2 GiB)
npx e2b template list       # the TEMPLATE ID goes into wrangler.jsonc E2B_TEMPLATE_ID
```

The base image is `mcr.microsoft.com/playwright:v1.64.0-noble`; keep it in step
with the `playwright` version in `package.json`. Rebuilding keeps the template
ID.
