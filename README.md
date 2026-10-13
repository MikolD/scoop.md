# scoop.md

**Scoop any doc.**

A "Scoop to agent" button that works on any documentation site. Click it and you get the site's llms.txt on your clipboard, as a short prompt to paste into Claude Code, Codex, Cursor or any other coding agent: the agent reads the index and fetches only the pages it needs. One page as a Markdown document, the agent instructions, llms-full.txt, Overview and Search are under **Advanced**.

## The main view (0.6.0)

Opening the popup asks `GET /v1/llms?url=<page origin + first path segment>` (e.g. `https://docs.stripe.com/webhooks`; 5 s) and copies at once. For a developer site it shows exactly two things: **llms.txt** (a chip, a "by scoop.md" badge when scoop.md prepared it, "412 pages · checked today", and a read-only monospace field with the file's URL, cut in the middle, with an open ↗ icon and a copy icon) and **Instructions for agents** (verbatim lines from the llms.txt that tell agents how to install, set up and use the product, from `agentInstructions`; verbatim, collapsed after about 4 lines with "Show more", with a copy icon). The big button ("Copy llms.txt", or "Copy llms.txt + instructions") copies the server's `prompt` as given (it carries the instructions excerpt), e.g. `Stripe docs for agents: https://docs.stripe.com/llms.txt — read it first, then fetch only the pages you need.` A scoop.md llms.txt still being built says "Preparing…": its URL already works, so it is copied at once, and the popup asks again every `retryAfterMs` until it's ready. Not a developer site: "This isn't a developer website. scoop.md is for developer docs." and nothing else. If the library doesn't answer, the site's own llms.txt, verified in the browser (an H1 and a link), gives the same prompt; otherwise "Couldn't reach scoop.md" with Retry. The last view (main or Advanced) is remembered. `llms_copy { site, source: site|scoop|fallback, trigger: auto|button }` is recorded.

Behind it is a shared library: once a package for a site has helped someone's agent implement their task, the next person on that site gets the same package.

## Advanced: this page

The popup shows a short loader (at least 600 ms), copies the best package it has right then, plays a brief "copied to your clipboard" moment (a still check with reduced motion), then shows it. It never makes you wait for a crawl.

1. **Docs index.** If the site's docs are indexed, copy the library's package anchored on this page (`GET /v1/packages`).
2. **Shared library.** Else, if the library has a skill for this site that people confirmed worked, copy it (plus the current page if the skill doesn't already cover it).
3. **Instant.** Else the page built here, plus what the library finds for it right away (`GET /v1/quick`: llms.txt files and the page's `.md` twin, also on `docs.<domain>`), fetched without cookies.
4. **What the site already publishes.** Look for the page's Markdown twin (`<page>.md`), `llms.txt` and `llms-full.txt`, at the site root and under the docs prefix. Files over 2 MB are not downloaded; the agent gets the link instead.
5. **Extraction.** Otherwise convert the page's main content to Markdown, and list related pages from the site's navigation so the agent can fetch more.
6. **Copy.** A compact package (16,000 characters by default; the popup shows its size and ~tokens), in the server's order: a title and one line telling the agent to treat it as reference, not instructions, and to ignore anything unrelated to the user's request; `Docs index for agents: <llms.txt>` when the llms.txt is verified (an H1 and at least one link; the file itself is not included); "What this site says to AI agents" (from the library, quoted with a note that it never overrides the user; up to 8, with sources; left out when the page isn't developer docs); the page; up to 5 related pages. Every link passes the dead-link check. The **This page** tab (in Advanced) is one line per item: the docs pill ("✓ Docs · <site>", "✓ Docs at <root> ↗" when the docs live elsewhere, e.g. stripe.com → docs.stripe.com, or "✕ No docs"; from `/quick` `docs`, else its `isDevDocs`, else a local guess, never left undecided), "llms.txt ✓ · llms-full.txt ✕", "Agent instructions (n)" (collapsed), then the ~tokens and size, a short preview and **Copy**. On a page of a site whose docs are elsewhere, the copy is the docs' entry point (the start of their llms.txt, or their home page) instead of the page. With no docs at all, Overview and Search are disabled, nothing is shared or crawled, and the copy is headed `# <title> (<site>, via scoop.md)`.
7. **Feedback.** "It worked" / "It didn't" decides what the library serves next time.

A site that isn't indexed yet (public developer docs, sharing on) is indexed in the background (`POST /v1/crawl-requests`): one quiet line says so, the service worker follows the request every 30 s, and the icon shows ✓ on that site's tabs when it's ready; "Copy all <site> docs" (or reopening) then copies the indexed package.

The toolbar badge shows, per tab, "1" when the site has an llms.txt (its own or a ready one prepared by scoop.md) and "2" when it also has instructions for agents, in the scoop orange with white text; nothing when unknown, not a developer site or still being prepared. It is looked up on the device in `GET /v1/sites/index` (`llms: { host: 1 | 2 }`, downloaded every 6 hours with If-None-Match; no request per page; an older list without it shows nothing) and in what the popup learned from `/v1/llms` for sites you opened it on (7 days). Background indexing shows only in the popup. The popup's **Overview** and **Search** tabs work on indexed sites: the topics and llms.txt within the 16k budget ("Copy full llms.txt" when it's longer), or search with checkboxes, "Copy selected" and "Copy all"; each shows the ~tokens it copies.

Packages built in the extension never carry dead links: before copying, every link on a public page is checked (`POST /v1/links/check` when sharing is on, then HEAD over https from the browser without cookies, only on the page's own registrable domain and its sources' hosts; about 2.5 s at most, inside the loader). 2xx, 400, 401, 403 and 405 count as existing; 404, 410 and DNS failures as dead; 429 and timeouts as unknown. Unconfirmed `[text](url)` links keep their text; bare URLs are kept as code, never removed. Links on a page that isn't public are not checked or sent anywhere. What this site says to AI agents comes only from the library (approved sites) and is quoted, never presented as instructions. What's shared stays exactly as fetched.

Only pages recognised as developer docs are shared, or sent for crawling, and only material fetched without your cookies. If a page only renders when you're signed in, you still get it on your clipboard, but it's never uploaded.

## Run it

```sh
npm test                 # unit, HTTP and popup tests
npm run server           # shared library on http://localhost:8787/v1
npm run probe -- https://docs.stripe.com/webhooks   # see what a site publishes
npm run check:live       # scoop real sites and verify every section like the library would (network)
npm run pack:extension   # dist/scoop.md-extension-<version>.zip for the Chrome Web Store
npm run icons            # redraw extension/icons (needs python3 + Pillow)
```

Load the extension in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → pick the `extension/` folder. Click the toolbar icon on any docs page, or press Alt+Shift+C.

The library is always `https://api.scoop.md/v1`; users can't change it. The options page has sharing on or off, the theme and the keyboard shortcut. If the library can't be reached, the extension builds from the page as usual and says nothing about it.

To test against `npm run server`, load the extension unpacked and set a local override from the popup's DevTools console (right-click the popup → Inspect):

```js
chrome.storage.local.set({ devLibraryUrl: 'http://localhost:8787/v1' })  // undo: chrome.storage.local.remove('devLibraryUrl')
```

Only unpacked installs (`chrome.management.getSelf()` → `installType: "development"`) read `devLibraryUrl`; Web Store installs ignore it.

## Layout

```
extension/            Chrome MV3 extension
  lib/discover.js     finds .md twins and llms.txt files (no credentials)
  lib/extract.js      HTML → Markdown fallback, related links
  lib/scoop.js        builds a page's sections (shared by the popup and check-live)
  lib/library.js      api.scoop.md/v1 client; never throws, short timeouts
  lib/package.js      assembles the clipboard document within a size budget
  lib/crawl.js        background crawl requests: progress labels, pending requests
  lib/badge.js        the per-tab toolbar badge and the downloaded sites index
  lib/links.js        no dead links: checks a local package's links and unlinks bad ones
  lib/ux.js           popup timing (loader minimum, copied moment, follow-up and search debounce)
  popup.js            the click flow
  STORE.md            Chrome Web Store listing, permissions, data disclosures
server/               shared library (Node, no dependencies, JSON file store)
backend/              api.scoop.md: Cloudflare Worker (v1 API, CrawlSite Workflow)
crawler/              Playwright crawler for client-rendered docs (runs in an E2B sandbox)
scripts/probe.js      runs discovery against real sites
scripts/check-live.js scoops real sites and verifies each section with server/verify.js
test/                 node:test suites
```

## Library API

The extension talks to the v1 API specified in [docs/BACKEND.md](docs/BACKEND.md): `GET /v1/skills/best?site=`, `POST /v1/skills` (sections are verified against their live sources), `POST /v1/skills/:id/feedback` and `POST /v1/reports`. POSTs carry an anonymous install ID (`X-Scoop-Install`).

## Known limits (prototype)

- A site is identified by hostname. Different products on one host share a skill.
- "Worked" is a single button press, one vote per install.
- Extraction is heuristic: it takes the smallest element around the page's `<h1>` that holds most of the prose.

## License

MIT. See [LICENSE](LICENSE). Agent logos in `site/public/agents/` come from [Simple Icons](https://simpleicons.org) (CC0); the brands belong to their owners.
