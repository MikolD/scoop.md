// Deterministic browser crawl (no LLM): render each page in Chromium, turn its
// main content into Markdown with the extension's extractor, follow same-site
// docs links breadth-first, stop at the page or time budget.
//
// Agentic mode later: `options.choose` can replace the breadth-first pick of
// the next URL (e.g. an agent ranking the frontier). It receives only URLs and
// link texts, never instructions taken from page content.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { parseRobots } from './vendor/robots.ts';
import { clipPage, followable, MAX_RESULT_BYTES, pageKey, requestAllowed, siteOf } from './lib.js';

const UA = 'Mozilla/5.0 (compatible; scoop.md-bot/1; +https://scoop.md/bot) Chrome/140 Safari/537.36';
const NAV_TIMEOUT_MS = 30_000;
const SETTLE_MS = 4_000;

// extension/lib/extract.js, evaluated inside the page (it needs a real DOM).
// `export` is dropped so it runs as a plain script.
const EXTRACT = readFileSync(new URL('./vendor/extract.js', import.meta.url), 'utf8').replace(/^export /gm, '');

const IN_PAGE = `(() => {
  ${EXTRACT}
  const main = pickMain(document);
  const h1 = main.querySelector('h1') || document.querySelector('h1');
  const links = new Set(relatedLinks(document, location.href, 200).map((l) => l.url));
  for (const a of main.querySelectorAll('a[href]')) {
    try { links.add(new URL(a.getAttribute('href'), location.href).href); } catch {}
  }
  // Client-side routes (docsify: #/page) are links too.
  for (const a of document.querySelectorAll('a[href^="#/"]')) links.add(new URL(a.getAttribute('href'), location.href).href);
  return {
    title: (h1 && h1.textContent.trim()) || document.title || '',
    markdown: htmlToMarkdown(main, location.href),
    links: [...links].slice(0, 500),
  };
})()`;

/**
 * @param {{ site: string, startUrls: string[], budget: { maxPages: number, maxMinutes: number },
 *           docsRoot?: string, robotsTxt?: string, intervalMs?: number }} job
 * @param {{ onPage?: (n: number) => void, choose?: (frontier: string[]) => number }} options
 */
export async function crawl(job, { onPage = () => {}, choose = () => 0 } = {}) {
  const startedAt = new Date();
  const deadline = Date.now() + job.budget.maxMinutes * 60_000;
  const site = String(job.site).toLowerCase();
  const root = job.docsRoot || '/';
  const robots = parseRobots(job.robotsTxt || '');
  const interval = Math.max(1000, job.intervalMs || 1000);
  const allowed = (url) => {
    const u = new URL(url);
    return robots.allowed(u.pathname + u.search);
  };

  const frontier = [];
  const seen = new Set();
  const push = (url) => {
    if (!followable(url, site, root) || !allowed(url)) return;
    const key = pageKey(url);
    if (seen.has(key)) return;
    seen.add(key);
    frontier.push(key);
  };
  for (const u of job.startUrls) if (siteOf(u) === site) push(u);

  const pages = [];
  const stored = new Set();
  let bytes = 0;
  let errors = 0;
  let stoppedBy = 'done';
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ userAgent: UA, bypassCSP: true, acceptDownloads: false, serviceWorkers: 'block' });
    // Only public http(s); skip heavy media we never read.
    await context.route('**/*', (route) => {
      const req = route.request();
      if (!requestAllowed(req.url())) return route.abort('blockedbyclient');
      if (['image', 'media', 'font'].includes(req.resourceType())) return route.abort('blockedbyclient');
      return route.continue();
    });
    const page = await context.newPage();
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    let lastNav = 0;

    while (frontier.length) {
      if (pages.length >= job.budget.maxPages) { stoppedBy = 'max-pages'; break; }
      if (Date.now() >= deadline) { stoppedBy = 'max-minutes'; break; }
      const url = frontier.splice(Math.min(Math.max(0, choose(frontier)), frontier.length - 1), 1)[0];
      const wait = lastNav + interval - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastNav = Date.now();
      try {
        // A hash-only change is a same-document navigation and the old content
        // may still be on screen; load the route fresh instead.
        if (pageKey(page.url()).split('#')[0] === url.split('#')[0]) await page.goto('about:blank');
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        if (res && !res.ok() && res.status() !== 304) { errors++; continue; }
        // Client-rendered docs fill in after load; give them a moment.
        await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
        // Redirects (or client routing) may have left the site.
        if (siteOf(page.url()) !== site) { errors++; continue; }
        const out = await page.evaluate(IN_PAGE);
        for (const link of out.links) push(link);
        const clipped = clipPage({ url: pageKey(page.url()), title: out.title, markdown: out.markdown });
        if (clipped.markdown.trim().length < 50 || stored.has(clipped.url)) continue; // nothing readable, or a redirect to a page we have
        stored.add(clipped.url);
        const size = Buffer.byteLength(JSON.stringify(clipped));
        if (bytes + size > MAX_RESULT_BYTES) { stoppedBy = 'max-pages'; break; }
        bytes += size;
        pages.push(clipped);
        onPage(pages.length);
      } catch {
        errors++;
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { site, pages, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), stoppedBy, errors };
}
