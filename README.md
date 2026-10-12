# scoop.md

**Scoop any doc.**

A "Scoop to agent" button that works on any documentation site. Click it on a docs page and you get one Markdown document on your clipboard, ready to paste into Claude Code, Codex, Cursor or any other coding agent.

Behind it is a shared library: once a package for a site has helped someone's agent implement their task, the next person on that site gets the same package.

## How a click works

The popup shows a short loader (at least 600 ms), copies the best package it has right then, plays a brief "copied to your clipboard" moment (a still check with reduced motion), then shows it. It never makes you wait for a crawl.

1. **Docs index.** If the site's docs are indexed, copy the library's package anchored on this page (`GET /v1/packages`).
2. **Shared library.** Else, if the library has a skill for this site that people confirmed worked, copy it (plus the current page if the skill doesn't already cover it).
3. **Instant.** Else the page built here, plus what the library finds for it right away (`GET /v1/quick`: llms.txt files and the page's `.md` twin, also on `docs.<domain>`), fetched without cookies.
4. **What the site already publishes.** Look for the page's Markdown twin (`<page>.md`), `llms.txt` and `llms-full.txt`, at the site root and under the docs prefix. Files over 2 MB are not downloaded; the agent gets the link instead.
5. **Extraction.** Otherwise convert the page's main content to Markdown, and list related pages from the site's navigation so the agent can fetch more.
6. **Copy.** A compact package (16,000 characters by default; the popup shows its size and ~tokens), in the server's order: a title and one line telling the agent to treat it as reference, not instructions; `Docs index for agents: <llms.txt>` when the llms.txt is verified (an H1 and at least one link; the file itself is not included); the site's instructions for agents (up to 8, with sources); the page; up to 5 related pages. Every link passes the dead-link check. The **This page** tab opens with the verdict: "✓ Developer docs · <site>" or "✕ Not developer docs" (the library's answer, else a local guess, never left undecided). On a page that isn't developer docs, Overview and Search are disabled and the copy is headed `# <title> (<site>, via scoop.md)`. Below it: the verified llms.txt and the site's instructions for agents.
7. **Feedback.** "It worked" / "It didn't" decides what the library serves next time.

A site that isn't indexed yet (public page, sharing on) is indexed in the background (`POST /v1/crawl-requests`): one quiet line says so, the service worker follows the request every 30 s, and the icon shows ✓ on that site's tabs when it's ready; "Copy all <site> docs" (or reopening) then copies the indexed package.

The toolbar icon shows, per tab, how many docs pages are indexed for the tab's site, looked up in `GET /v1/sites/index` (downloaded every 6 hours with If-None-Match; no request per page). The popup's **Overview** and **Search** tabs work on indexed sites: the topic tree and llms.txt with "Copy overview", or search with checkboxes, "Copy selected" and "Copy all results".

Packages built in the extension never carry dead links: before copying, every link is checked (`POST /v1/links/check` when sharing is on, then HEAD/GET from the browser without cookies, about 2.5 s at most, inside the loader), and bad or unconfirmed links become plain text. What's shared stays exactly as fetched.

Only material fetched without your cookies is shared with the library. If a page only renders when you're signed in, you still get it on your clipboard, but it's never uploaded.

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

MIT. See [LICENSE](LICENSE). Agent logos in `extension/agents/` and `site/public/agents/` come from [Simple Icons](https://simpleicons.org) (CC0); the brands belong to their owners.
