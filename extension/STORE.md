# Chrome Web Store listing: scoop.md

Everything the Web Store dashboard asks for, matching what the code in this folder does (version 0.6.0). Build the upload with `npm run pack:extension` → `dist/scoop.md-extension-<version>.zip`. This file and the artwork in `store-assets/` aren't included in the zip.

## Store listing

**Name:** scoop.md

**Summary (≤ 132 chars):**
Scoop any doc. One click copies the docs page you're on as Markdown your coding agent can use.

**Category:** Developer Tools

**Language:** English

**Description:**

> Scoop any doc.
>
> scoop.md gives your coding agent the docs of the site you're on, the way agents read them best: the site's llms.txt. Click it on any documentation site and a short prompt with the llms.txt link is on your clipboard, ready to paste into Claude Code, Codex, Cursor or any other coding agent. Your agent reads the index and fetches only the pages it needs.
>
> • One button: "Copy llms.txt". The site's own llms.txt when it has one; when it doesn't, scoop.md prepares one and hosts it at scoop.md/<site>/llms.txt.
> • Works from anywhere on the site: on stripe.com it finds the docs at docs.stripe.com.
> • Not a documentation site? It says so, and copies nothing.
> • The toolbar icon shows whether the site you're on is developer docs (a check, or "!" when it isn't), looked up in lists kept on your device.
>
> Advanced (one click away):
> • This page as one Markdown document: uses the scoop.md docs index when the site is in it: the site's docs, read and arranged around the page you're on. Never waits: on a site that isn't indexed yet you get the page, a link to the site's llms.txt and what the site says to AI agents at once, and scoop.md indexes the rest in the background (the icon shows ✓ when it's ready).
> • The toolbar icon shows whether the site you're on is developer docs (a check, or "!" when it isn't), looked up in lists kept on your device.
> • Overview and Search tabs for indexed sites: the site's topics and llms.txt, or search its docs and copy just the results you pick.
> • Uses what the site already publishes for agents: the page's Markdown version (page.md), llms.txt and llms-full.txt.
> • If there's none, converts the page's main content to clean Markdown: headings, code blocks, tables, without menus and footers.
> • Adds links to related pages so your agent can fetch more when it needs to.
> • Opens with its sources and a note telling your agent to treat the material as reference, not as instructions.
>
> Shared library: when a package for a site has helped someone's agent get their task done, the next person on that site gets the same package. After pasting, tell scoop.md whether it worked. Only public material, fetched without your cookies or logins, is ever shared. Pages that only load when you're signed in, and pages on your computer or a private network, still go to your clipboard but never leave your machine. You can turn sharing off in Settings.
>
> Usage statistics: scoop.md sends anonymous usage events (which public docs sites and pages you scoop, whether it worked, version, browser and OS, errors) so we can see what to fix. Never page content; for a signed-in page, only its site's domain. The first time you open scoop.md it tells you, with a button to turn it off; you can also turn it off in Settings ("Send usage statistics").
>
> Keyboard shortcut: Alt+Shift+C.

**Homepage:** https://scoop.md
**Support:** https://scoop.md (contact link on the site)
**Privacy policy URL:** https://scoop.md/privacy (required, because the extension sends website content to api.scoop.md; the page must say what the "Data usage" section below says)

## Single purpose

Copy the documentation page the user is viewing to the clipboard as Markdown for a coding agent, using a shared library of packages other users confirmed worked.

## Permission justifications

| Permission | Justification |
|---|---|
| `activeTab` | When the user clicks the toolbar button (or presses Alt+Shift+C), read the current tab's URL and title to know which documentation page to package. Nothing runs on tabs the user hasn't clicked on. |
| `scripting` | Fallback for pages that only render for a signed-in user or in the browser: on click, read the current tab's HTML once so it can be converted to Markdown for the clipboard. This content is never uploaded. |
| `clipboardWrite` | Put the Markdown package on the clipboard. That's the extension's only output. |
| `storage` | Remember settings (sharing on/off, usage statistics on/off, theme), an anonymous random install ID, whether the first-run note was dismissed, and the queue of usage events not yet sent (at most 500). |
| `alarms` | Wake the extension's service worker once an hour to send the once-a-day "active" usage event and any queued usage events, and to retry sending with backoff when the network was down; and, while a docs site the user asked about is being indexed after the popup was closed, every 30 seconds to check that request and show its progress on the toolbar badge ("…", then "✓" when ready). Every 6 hours, to download the list of indexed sites and their page counts (`GET /v1/sites/index`, with If-None-Match) that the toolbar badge is looked up in. The service worker reads tab addresses for the badge, never page content. No usage events are sent when usage statistics are off. |
| Host permission `<all_urls>` | Documentation lives on any domain. On click, the extension fetches, **without cookies**, files next to the page the user is on: `<page>.md` (or `<page>/index.md`), `llms.txt` and `llms-full.txt` (at the site root and under the docs section) and the page's public HTML. These are cross-origin requests from the popup, so they need host permission for that site, and the site isn't known in advance. It also calls the shared library at `https://api.scoop.md`: to look up a shared package and the site's place in the docs index (by hostname), to fetch the indexed package for a public page (its URL, whatever the sharing setting), and, when the site isn't indexed yet, sharing is on and the page is public and recognised as developer docs, to ask for the site to be crawled (the page URL; the library then fetches the site's public docs itself, without the user's cookies). For a public page, it also checks the links in a package before copying it, so dead links can be removed: HEAD requests without cookies, over https only, only to the page's own site (its registrable domain) or to hosts the package's sources came from, and never to private-network addresses. Links on a page that isn't public are not checked at all. The same permission lets the service worker read the address of the active tab when it is activated or finishes loading, to show on the toolbar icon whether that site is developer docs: the site is looked up in lists downloaded to the device (and in the library's verdicts for sites the user scooped, kept on the device for 7 days), so no request is made per page, and private-network hosts are never looked up (no "tabs" permission is used). No content scripts are injected automatically; no page is read or fetched until the user clicks; usage statistics (below) are sent in the background. |

**Remote code:** No. All JavaScript ships in the package. The extension downloads only text (Markdown, llms.txt, HTML to convert, JSON from the library), which is never executed.

## Data usage (privacy practices tab)

Data the extension **collects** (sends off the device). Library lookups and shares happen only after the user clicks the button. Usage statistics (`POST https://api.scoop.md/v1/events`, on by default, off with "Send usage statistics" in Settings) are sent in batches when the popup closes and hourly from the service worker; the full event list is in docs/TELEMETRY.md and on scoop.md/privacy. **Prominent disclosure:** the first popup shows "scoop.md sends anonymous usage statistics, including the hostname and path of public docs pages you scoop." with [Turn off] and [OK], whatever the sharing setting; until it has been shown, events carry no hostname or path.

| Category | Collected? | What exactly |
|---|---|---|
| Web history | Yes | When the popup opens, the **page URL without its query or fragment** is sent to `api.scoop.md` (`GET /v1/llms?url=`) to get the site's llms.txt (never for private-network hosts), whatever the sharing setting. In Advanced, on each scoop, the **hostname** of the page is sent to `api.scoop.md` to look up a shared package (`GET /v1/skills/best?site=<hostname>`) and whether the site's docs are indexed (`GET /v1/sites/<hostname>/status`), whether or not sharing is on. When the page is public, the **page URL** is sent to fetch the package anchored on it if the site is indexed (`GET /v1/packages?site=&url=`), or else to look up the site's llms.txt files and the page's Markdown version (`GET /v1/quick?url=`), whatever the sharing setting (turning sharing off stops uploads and crawl requests, not this lookup). When the site isn't indexed yet, sharing is on and the page is public and recognised as developer docs, the **page URL** is sent to ask for a crawl (`POST /v1/crawl-requests`), and the request is then checked by its ID until it finishes. When sharing is on and the page is public developer docs, the **page URL** is also sent with a share, with tracking parameters removed (`utm_*`, `gclid`, `fbclid`, `_gl`, `mc_cid`, `ref_src` and similar). Nothing is sent, not even the hostname, for pages on the user's computer or a private network (localhost, private and link-local IP addresses, single-label hosts, `.local`, `.internal`, `.lan`, `.home.arpa`). Usage statistics record the **hostname** of the page the user clicks scoop.md on and its **path** only for public docs pages (the site publishes `.md`/`llms.txt` for it, or the public page looks like docs), without query string or fragment, tracking parameters removed, and secret-looking segments (long random strings, hashes, UUIDs) replaced with `:id`; for a page that only renders signed in, only the registrable domain (e.g. `atlassian.net` for `acme.atlassian.net`) and no path; for private hosts (also `.corp`, `.home`, `.intranet`, `.onion`, `.test` and similar), nothing. Before a package built from a **public** page is copied, the **link addresses** in it are checked so the agent gets no dead links: when sharing is on they are sent to `api.scoop.md` (`POST /v1/links/check`, never private-network addresses), and links on the page's own site or its sources' hosts that the library can't vouch for are requested directly (HEAD over https, without cookies); dead or unconfirmed links lose their link (bare addresses are kept as text). For a page that isn't public, no link address is sent or requested. To set the toolbar icon, the service worker reads the address of the tab you switch to or that finishes loading and compares its hostname with lists downloaded to the device; this stays on the device and is never sent. Browsing history beyond the clicked page is never sent. |
| Website content | Yes | When sharing is on (the default), the page is recognised as developer docs and every source was fetched without cookies: the page title, the text of the page's public sources (its `.md` file, `llms.txt`, `llms-full.txt`, or the Markdown converted from its public HTML), their URLs, and up to 60 same-site links from the page's navigation (their URLs and link text). Content read from the signed-in tab is never sent. Only pages recognised as developer docs are shared; other pages are neither shared nor sent for crawling. |
| User activity | Yes | "It worked" / "It didn't" votes and report reasons ("wrong", "malicious", "copyright", "other") on a shared package (no text the user types is sent with them). On an indexed site's Search tab, the **search query** the user types is sent to `api.scoop.md` (`GET /v1/search`, and `GET /v1/packages?q=` for "Copy all results"); usage statistics record only its length. App usage events: install, update, browser update, a once-a-day "active" ping, popup opened/closed (with how long it was open), each scoop (start, outcome, which kinds of sources, size, duration, whether the shared library or the docs index had it), copies, the "copied" animation being shown (and whether reduced motion is on), crawl requests (site and how they went), tab switches (which tab), searches (site, query length and result count, never the query), copies of the overview or of search results (site, how many), an hourly count of toolbar docs-count badges shown (one number, no sites), rebuilds, share outcomes, votes, reports, settings changes (sharing, theme, usage statistics), the settings page being opened, and error codes with a short message stripped of URLs. Each event has a timestamp, a per-popup session ID and the install ID, plus the extension version, browser name and version, OS, CPU architecture, UI language and time zone. |
| Location | Yes | **Coarse location** (country, region, continent) and the network's ISP or organisation name, derived on the server from the request's IP address by Cloudflare. The IP address itself is never stored. For abuse analysis a hash of it is kept, made with a random key created each day and deleted after 48 hours (so a hash can't be traced back or linked across days once its key is gone); the hash itself is deleted after 30 days and never archived. Library requests from an extension with usage statistics off are not recorded. |
| Personally identifiable information | No | The extension sends a random install ID (UUID created on install, stored locally) with shares, votes, reports and usage events, plus its version (`X-Scoop-Client: extension/0.6.0`). The ID isn't linked to any account, name or email. No names, emails, Google account, cookies or IP addresses are stored. |
| Authentication, financial, health, personal communications | No | |

Requests to the documentation site itself (`.md`, `llms.txt`, page HTML) go to the site the user is on, without cookies or credentials.

Stored on the device only: the sharing and usage-statistics settings (`chrome.storage.sync`), theme, install ID, first-run flag and the unsent usage-event queue (`chrome.storage.local`).

Uninstall: the extension sets its uninstall page to `https://scoop.md/bye#i=<install ID>&v=<version>` (just `https://scoop.md/bye` when usage statistics are off). The ID is in the fragment, which browsers never send to a server; the page sends no Referer. That page records the uninstall, and an optional reason the user picks, against the install ID.

Retention: raw usage events are kept 180 days in the database, then deleted; daily counts (no install IDs) are kept. Every raw event (without the IP hash) is also archived (compressed) for 13 months. Deletion requests by install ID (team@ddamoah.com) remove the install's events from the database and exclude them from every export of the archive until those archive objects expire.

Certifications to tick:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Crawl requests: when the user asks for an unknown docs site to be crawled, the extension sends the page URL (with its path) and the install ID to `POST /v1/crawl-requests`. This reveals which documentation page the user was reading; the library stores the URL with an HMAC of the install ID (not the ID) for 90 days. Disclose under "Web history" / "Website content" as appropriate.

Note for the privacy policy: shared packages are public (anyone can fetch them from the library and the scoop.md website), and the library itself only keeps content it could fetch anonymously from the cited URL (see docs/BACKEND.md §6).

## Store artwork

In `store-assets/` (copies in `dist/store/`), taken in Chrome with the real extension and composed with the popup at the top right:

Screenshots 1–3 predate 0.6.0 (the main "Copy llms.txt" view, Advanced, the docs pill and the ✓/! icon) and are to be retaken from the 0.6.0 build (scratchpad/ux-evidence/060/).

| File | Size | Shows |
|---|---|---|
| `1-stripe-webhooks-copied.png` | 1280×800 | docs.stripe.com/webhooks rebuilt from the page ("Rebuild from this page", since the live library already serves a Stripe skill): "Copied. Paste it into your agent.", 2 sources (the page's `.md` and `llms.txt`), "Shared with the library" (api.scoop.md) |
| `2-stripe-library-hit.png` | 1280×800 | docs.stripe.com/payments/checkout served from the live library (api.scoop.md): "shared, worked for 2 people", vote buttons, "Rebuild from this page" |
| `3-python-html-converted.png` | 1280×800 | docs.python.org/3/library/json.html (no Markdown published) converted from HTML, the preview scrolled to a converted code block, "Shared with the library" (api.scoop.md) |
| `4-settings.png` | 1280×800 | Settings (0.3.0): sharing toggle, "Send usage statistics" toggle with the install ID, theme, keyboard shortcut, version |
| `5-first-run-notice.png` | 1280×800 | The first popup after install, on react.dev/learn against the live library: the usage statistics notice ("Turn off" / "OK") and the sharing note above the copied result |
| `promo-small-440x280.png` | 440×280 | Small promo tile: icon, "scoop.md", "Scoop any doc into your coding agent" on #ffeee0 |
| `promo-marquee-1400x560.png` | 1400×560 | Marquee: the same, with the popup from screenshot 2 |

