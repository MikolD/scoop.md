# Chrome Web Store listing: scoop.md

Everything the Web Store dashboard asks for, matching what the code in this folder does (version 0.2.0). Build the upload with `npm run pack:extension` → `dist/scoop.md-extension-<version>.zip`. This file and the artwork in `store-assets/` aren't included in the zip.

## Store listing

**Name:** scoop.md

**Summary (≤ 132 chars):**
Scoop any doc. One click copies the docs page you're on as Markdown your coding agent can use.

**Category:** Developer Tools

**Language:** English

**Description:**

> Scoop any doc.
>
> scoop.md adds one button, "Scoop to agent". Click it on any documentation page and you get one Markdown document on your clipboard, ready to paste into Claude Code, Codex, Cursor or any other coding agent.
>
> How it builds the package:
> • Uses what the site already publishes for agents: the page's Markdown version (page.md), llms.txt and llms-full.txt.
> • If there's none, converts the page's main content to clean Markdown: headings, code blocks, tables, without menus and footers.
> • Adds links to related pages so your agent can fetch more when it needs to.
> • Opens with its sources and a note telling your agent to treat the material as reference, not as instructions.
>
> Shared library: when a package for a site has helped someone's agent get their task done, the next person on that site gets the same package. After pasting, tell scoop.md whether it worked. Only public material, fetched without your cookies or logins, is ever shared. Pages that only load when you're signed in, and pages on your computer or a private network, still go to your clipboard but never leave your machine. You can turn sharing off in Settings.
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
| `storage` | Remember settings (sharing on/off, theme), an anonymous random install ID, and whether the first-run note was dismissed. |
| Host permission `<all_urls>` | Documentation lives on any domain. On click, the extension fetches, **without cookies**, files next to the page the user is on: `<page>.md` (or `<page>/index.md`), `llms.txt` and `llms-full.txt` (at the site root and under the docs section) and the page's public HTML. These are cross-origin requests from the popup, so they need host permission for that site, and the site isn't known in advance. It also calls the shared library at `https://api.scoop.md`. No content scripts are injected automatically; nothing is fetched until the user clicks. |

**Remote code:** No. All JavaScript ships in the package. The extension downloads only text (Markdown, llms.txt, HTML to convert, JSON from the library), which is never executed.

## Data usage (privacy practices tab)

Data the extension **collects** (sends off the device), all only after the user clicks the button:

| Category | Collected? | What exactly |
|---|---|---|
| Web history | Yes | On each scoop, the **hostname** of the page is sent to `api.scoop.md` to look up a shared package (`GET /v1/skills/best?site=<hostname>`), whether or not sharing is on. When sharing is on and the page is public, the **page URL** is sent too, with tracking parameters removed (`utm_*`, `gclid`, `fbclid`, `_gl`, `mc_cid`, `ref_src` and similar). Nothing is sent, not even the hostname, for pages on the user's computer or a private network (localhost, private and link-local IP addresses, single-label hosts, `.local`, `.internal`, `.lan`, `.home.arpa`). Browsing history beyond the clicked page is never read. |
| Website content | Yes | When sharing is on (the default) and every source was fetched without cookies: the page title, the text of the page's public sources (its `.md` file, `llms.txt`, `llms-full.txt`, or the Markdown converted from its public HTML), their URLs, and up to 60 same-site links from the page's navigation (their URLs and link text). Content read from the signed-in tab is never sent. |
| User activity | Yes | "It worked" / "It didn't" votes and report reasons ("wrong", "malicious", "copyright", "other") on a shared package. No free text is sent. |
| Personally identifiable information | No | The extension sends a random install ID (UUID created on install, stored locally) with shares, votes and reports, plus its version (`X-Scoop-Client: extension/0.2.0`). The ID isn't linked to any account, name or email. |
| Authentication, financial, health, personal communications, location | No | |

Requests to the documentation site itself (`.md`, `llms.txt`, page HTML) go to the site the user is on, without cookies or credentials.

Stored on the device only: the sharing setting (`chrome.storage.sync`), theme, install ID and first-run flag (`chrome.storage.local`).

Certifications to tick:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Note for the privacy policy: shared packages are public (anyone can fetch them from the library and the scoop.md website), and the library itself only keeps content it could fetch anonymously from the cited URL (see docs/BACKEND.md §6).

## Store artwork

In `store-assets/` (copies in `dist/store/`), taken in Chrome with the real extension and composed with the popup at the top right:

| File | Size | Shows |
|---|---|---|
| `1-stripe-webhooks-copied.png` | 1280×800 | docs.stripe.com/webhooks rebuilt from the page ("Rebuild from this page", since the live library already serves a Stripe skill): "Copied. Paste it into your agent.", 2 sources (the page's `.md` and `llms.txt`), "Shared with the library" (api.scoop.md) |
| `2-stripe-library-hit.png` | 1280×800 | docs.stripe.com/payments/checkout served from the live library (api.scoop.md): "shared, worked for 2 people", vote buttons, "Rebuild from this page" |
| `3-python-html-converted.png` | 1280×800 | docs.python.org/3/library/json.html (no Markdown published) converted from HTML, the preview scrolled to a converted code block, "Shared with the library" (api.scoop.md) |
| `4-settings.png` | 1280×800 | Settings: sharing toggle, theme, keyboard shortcut |
| `promo-small-440x280.png` | 440×280 | Small promo tile: icon, "scoop.md", "Scoop any doc into your coding agent" on #ffeee0 |
| `promo-marquee-1400x560.png` | 1400×560 | Marquee: the same, with the popup from screenshot 2 |

