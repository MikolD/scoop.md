// Crawl pipeline: robots, sitemaps, llms.txt links, twins, client-shell
// detection, politeness, change detection and the R2 presign helper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { matches, parseRobots } from '../src/crawl/robots.ts';
import { parseSitemap } from '../src/crawl/sitemap.ts';
import { docsRoot, underRoot, llmsBases, llmsLinks, looksLikeClientShell, openApiLinks, twinUrl } from '../src/crawl/discover.ts';
import { crawlFetch, HostLimiter, intervalFor } from '../src/crawl/polite.ts';
import type { Clock } from '../src/crawl/polite.ts';
import { classify, contentHash, needsIndexing, pageKey } from '../src/crawl/changes.ts';
import { amzDate, presign, r2Endpoint, uriEncode } from '../src/crawl/presign.ts';
import { discoverSite, fetchPlanned, markdownTitle } from '../src/crawl/site.ts';
import { CrawlStore } from '../src/db/crawl.ts';
import { browserPages } from '../src/crawl/result.ts';
import { E2BCrawler } from '../src/crawl/e2b.ts';
import { runCrawl } from '../src/crawl/runner.ts';
import { validateCrawl } from '../src/lib/validate.ts';
import { batchKey, collectResult, manifestKey, uploadKey } from '../src/crawl/collect.ts';
import type { Manifest } from '../src/crawl/collect.ts';
import { parseMessage } from '../src/index/consumer.ts';
import type { IndexMessage } from '../src/index/indexer.ts';
import { archiveVersion, lowValue, skipLowValue } from '../src/crawl/skip.ts';
import { fakeD1, fakeFetch, fakeR2 } from './helpers.ts';

// --- robots.txt

test('robots: our group wins over *, longest match wins, Allow wins ties', () => {
  const r = parseRobots(`
User-agent: *
Disallow: /

User-agent: Scoop.md-Bot
Disallow: /private
Allow: /private/ok
Disallow: /*.json$
Crawl-delay: 2
Sitemap: https://ex.com/sitemap.xml
`);
  assert.equal(r.allowed('/docs/a'), true);
  assert.equal(r.allowed('/private/x'), false);
  assert.equal(r.allowed('/private/ok/y'), true);
  assert.equal(r.allowed('/data.json'), false);
  assert.equal(r.allowed('/data.json?x=1'), true);
  assert.equal(r.crawlDelay, 2);
  assert.deepEqual(r.sitemaps, ['https://ex.com/sitemap.xml']);
});

test('robots: falls back to *, consecutive user-agent lines share a group, empty Disallow allows', () => {
  const r = parseRobots('User-agent: googlebot\nUser-agent: *\nDisallow: /admin # comment\n\nUser-agent: other\nDisallow:\n');
  assert.equal(r.allowed('/admin/x'), false);
  assert.equal(r.allowed('/docs'), true);
  assert.equal(r.allowed('/robots.txt'), true);
  const open = parseRobots('User-agent: *\nDisallow:\n');
  assert.equal(open.allowed('/anything'), true);
  const none = parseRobots('');
  assert.equal(none.allowed('/x'), true);
  const tie = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a\n');
  assert.equal(tie.allowed('/a'), true);
});

test('robots: wildcard matching is linear and correct', () => {
  assert.equal(matches('/a*b', '/axxb'), true);
  assert.equal(matches('/a*b$', '/axxbc'), false);
  assert.equal(matches('/a*b', '/axxbc'), true);
  assert.equal(matches('/', '/'), true);
  assert.equal(matches('/x', '/'), false);
  assert.equal(matches('*', '/q'), true);
  const t0 = performance.now();
  assert.equal(matches('/' + '*a'.repeat(200) + 'b$', '/' + 'a'.repeat(2000)), false);
  assert.ok(performance.now() - t0 < 500);
});

// --- sitemaps

test('sitemap: urlset with entities, CDATA and lastmod; ignores image:loc', () => {
  const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://ex.com/docs/a?x=1&amp;y=2</loc><lastmod>2026-01-01</lastmod><image:image><image:loc>https://ex.com/i.png</image:loc></image:image></url>
  <url><loc><![CDATA[https://ex.com/docs/b]]></loc></url>
  <url ><loc> https://ex.com/docs/c </loc></url>
</urlset>`;
  const s = parseSitemap(xml);
  assert.equal(s.kind, 'urlset');
  assert.deepEqual(s.entries, [
    { loc: 'https://ex.com/docs/a?x=1&y=2', lastmod: '2026-01-01' },
    { loc: 'https://ex.com/docs/b', lastmod: null },
    { loc: 'https://ex.com/docs/c', lastmod: null },
  ]);
});

test('sitemap: index lists child sitemaps', () => {
  const s = parseSitemap('<sitemapindex><sitemap><loc>https://ex.com/s1.xml</loc></sitemap><sitemap><loc>https://ex.com/s2.xml.gz</loc></sitemap></sitemapindex>');
  assert.equal(s.kind, 'index');
  assert.deepEqual(s.entries.map((e) => e.loc), ['https://ex.com/s1.xml', 'https://ex.com/s2.xml.gz']);
});

// --- llms.txt and discovery helpers

test('llmsLinks: same-site Markdown links resolved against the file, fragments dropped', () => {
  const text = `# Ex
> Docs
- [Quickstart](/docs/quickstart.md): start here
- [API](https://ex.com/docs/api.md#top "API ref")
- [Elsewhere](https://other.com/x.md)
- [Rel](guide/intro)
- [Mail](mailto:a@ex.com)
- [Dup](https://ex.com/docs/api.md)`;
  assert.deepEqual(llmsLinks(text, 'https://www.ex.com/docs/llms.txt'), [
    'https://www.ex.com/docs/quickstart.md',
    'https://ex.com/docs/api.md',
    'https://www.ex.com/docs/guide/intro',
  ]);
});

test('llmsBases: start path first, then docs prefixes, then the root', () => {
  assert.deepEqual(llmsBases('https://ex.com', '/d1/get-started'), ['https://ex.com/d1', 'https://ex.com/docs', 'https://ex.com']);
  assert.deepEqual(llmsBases('https://ex.com', ''), ['https://ex.com/docs', 'https://ex.com/documentation', 'https://ex.com']);
});

test('twinUrl, docsRoot and openApiLinks', () => {
  assert.equal(twinUrl('https://ex.com/docs/a/', 'suffix'), 'https://ex.com/docs/a.md');
  assert.equal(twinUrl('https://ex.com/docs/a', 'index'), 'https://ex.com/docs/a/index.md');
  assert.equal(twinUrl('https://ex.com/a.html', 'suffix'), null);
  assert.equal(twinUrl('https://ex.com/', 'index'), 'https://ex.com/index.md');
  const urls = ['https://ex.com/docs/a', 'https://ex.com/docs/b', 'https://ex.com/blog/c', 'https://ex.com/pricing'];
  assert.equal(docsRoot('', urls), '/docs');
  assert.equal(docsRoot('/d1/', urls), '/d1');
  assert.equal(docsRoot('', ['https://ex.com/a', 'https://ex.com/b']), '/');
  assert.equal(underRoot('https://ex.com/3/library/os.html', '/3'), true);
  assert.equal(underRoot('https://ex.com/3.md', '/3'), true);
  assert.equal(underRoot('https://ex.com/3.11/', '/3'), false);
  assert.equal(underRoot('https://ex.com/30', '/3'), false);
  assert.equal(docsRoot('', ['https://ex.com/api/a', 'https://ex.com/api/b', 'https://ex.com/payments']), '/'); // a section, not the docs
  assert.deepEqual(openApiLinks(['https://ex.com/openapi.json', 'https://ex.com/api/v1/swagger.yaml', 'https://ex.com/docs']), [
    'https://ex.com/openapi.json',
    'https://ex.com/api/v1/swagger.yaml',
  ]);
});

test('needs_browser: client-rendered shells vs server-rendered docs', () => {
  const shell = '<!doctype html><html><head><script src="/a.js"></script></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>';
  assert.equal(looksLikeClientShell(shell), true);
  const next = '<html><body><div id="__next"></div><script>1</script><script>2</script><script>3</script></body></html>';
  assert.equal(looksLikeClientShell(next), true);
  const prose = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
  const ssr = `<html><body><div id="root"><main><h1>Docs</h1><p>${prose}</p></main></div><script src="/a.js"></script></body></html>`;
  assert.equal(looksLikeClientShell(ssr), false);
  assert.equal(looksLikeClientShell('<html><body><h1>Tiny static page</h1><p>Hello.</p></body></html>'), false);
});

test('markdownTitle takes the first h1/h2', () => {
  assert.equal(markdownTitle('intro\n\n# Webhooks #\n\n## More'), 'Webhooks');
  assert.equal(markdownTitle('no heading'), null);
});

// --- politeness

function fakeClock(): Clock & { t: number; sleeps: number[] } {
  const c = {
    t: 0,
    sleeps: [] as number[],
    now: () => c.t,
    async sleep(ms: number) {
      c.sleeps.push(ms);
      c.t += ms;
    },
  };
  return c;
}

test('politeness: request starts are spaced by the interval, concurrency is capped', async () => {
  const clock = fakeClock();
  const limiter = new HostLimiter({ concurrency: 2, intervalMs: 1000, clock });
  const starts: number[] = [];
  let active = 0;
  let maxActive = 0;
  await Promise.all(
    Array.from({ length: 5 }, () =>
      limiter.run(async () => {
        starts.push(clock.t);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      }),
    ),
  );
  assert.deepEqual(starts, [0, 1000, 2000, 3000, 4000]);
  assert.ok(maxActive <= 2);
  assert.equal(limiter.nextStart, 5000);
});

test('politeness: Crawl-delay raises the interval, capped at 10 s', () => {
  assert.equal(intervalFor(null), 1000);
  assert.equal(intervalFor(0.2), 1000);
  assert.equal(intervalFor(3), 3000);
  assert.equal(intervalFor(120), 10_000);
});

test('crawlFetch: sends our UA and validators, returns 304, refuses off-site redirects and private hosts', async () => {
  const limiter = new HostLimiter({ intervalMs: 0 });
  const { impl, calls } = fakeFetch({
    'https://ex.com/a.md': () => new Response(null, { status: 304, headers: { etag: '"v1"' } }),
    'https://ex.com/r': () => new Response(null, { status: 302, headers: { location: 'https://evil.com/x' } }),
    'https://ex.com/r2': () => new Response(null, { status: 301, headers: { location: 'http://127.0.0.1/' } }),
  });
  const r = await crawlFetch('https://ex.com/a.md', { limiter, fetchImpl: impl, etag: '"v1"', lastModified: 'Mon, 01 Jan 2026 00:00:00 GMT' });
  assert.equal(r.ok && r.notModified, true);
  const h = calls[0].init.headers as Record<string, string>;
  assert.match(h['user-agent'], /^scoop\.md-bot \(\+https:\/\/scoop\.md\/bot\)$/);
  assert.equal(h['if-none-match'], '"v1"');
  assert.equal(calls[0].init.redirect, 'manual');
  const off = await crawlFetch('https://ex.com/r', { limiter, fetchImpl: impl });
  assert.equal(off.ok, false);
  const priv = await crawlFetch('https://ex.com/r2', { limiter, fetchImpl: impl });
  assert.equal(priv.ok, false);
  const direct = await crawlFetch('https://10.0.0.1/', { limiter, fetchImpl: impl });
  assert.equal(direct.ok, false);
  assert.equal(calls.length, 3); // the private IP was never fetched
});

test('crawlFetch: caps the body and gunzips .gz sitemaps', async () => {
  const limiter = new HostLimiter({ intervalMs: 0 });
  const xml = '<urlset><url><loc>https://ex.com/a</loc></url></urlset>';
  const { impl } = fakeFetch({
    'https://ex.com/big': () => new Response('x'.repeat(5000)),
    'https://ex.com/s.xml.gz': () => new Response(gzipSync(xml)),
  });
  const big = await crawlFetch('https://ex.com/big', { limiter, fetchImpl: impl, cap: 1000 });
  assert.equal(big.ok && !big.notModified && big.over, true);
  const gz = await crawlFetch('https://ex.com/s.xml.gz', { limiter, fetchImpl: impl });
  assert.equal(gz.ok && !gz.notModified && gz.text, xml);
});

// --- discovery end to end over a fake site

const md = (title: string) => `# ${title}\n\n${'Some documentation text. '.repeat(10)}`;

test('discoverSite: llms.txt, sitemap and .md twins produce a profile and a fetch plan; robots is honoured', async () => {
  const text = (body: string) => () => new Response(body, { headers: { 'content-type': 'text/plain' } });
  const { impl } = fakeFetch({
    'https://ex.com/docs/llms.txt': text(`# Ex\n- [A](https://ex.com/docs/a.md)\n- [B](https://ex.com/docs/b)\n- [Secret](https://ex.com/docs/private/s.md)`),
    'https://ex.com/sitemap.xml': text(
      '<urlset>' + ['a', 'b', 'c', 'private/s'].map((p) => `<url><loc>https://ex.com/docs/${p}</loc></url>`).join('') + '<url><loc>https://ex.com/blog/x</loc></url></urlset>',
    ),
    'https://ex.com/docs/a.md': text(md('A')),
    'https://ex.com/docs/b.md': text(md('B')),
    'https://ex.com/docs/c.md': text(md('C')),
  });
  const robots = { state: 'ok' as const, text: 'User-agent: *\nDisallow: /docs/private\n' };
  const d = await discoverSite('https://ex.com/', robots, { fetchImpl: impl, limiter: new HostLimiter({ intervalMs: 0 }) });
  assert.equal(d.llmsUrl, 'https://ex.com/docs/llms.txt');
  assert.equal(d.llmsFullUrl, null);
  assert.equal(d.docsRoot, '/docs');
  assert.equal(d.sitemapUrlsCount, 5);
  assert.equal(d.twinPattern, 'suffix');
  assert.equal(d.twinRatio, 1);
  assert.equal(d.needsBrowser, false);
  assert.deepEqual(d.plan.map((p) => [p.kind, p.url, p.sourceUrl]), [
    ['llms', 'https://ex.com/docs/llms.txt', 'https://ex.com/docs/llms.txt'],
    ['page-md', 'https://ex.com/docs/a.md', 'https://ex.com/docs/a.md'],
    ['page-md', 'https://ex.com/docs/b', 'https://ex.com/docs/b.md'],
    ['page-md', 'https://ex.com/docs/c', 'https://ex.com/docs/c.md'],
  ]);
  const budgeted = await discoverSite('https://ex.com/', robots, { fetchImpl: impl, limiter: new HostLimiter({ intervalMs: 0 }), budget: 2 });
  assert.equal(budgeted.plan.length, 2);
});

test('discoverSite: no Markdown and a JS shell means needs_browser; disallowed start URL means blocked', async () => {
  const shell = '<html><body><div id="app"></div><script src="/x.js"></script></body></html>';
  const { impl } = fakeFetch({
    'https://spa.com/': () => new Response(shell, { headers: { 'content-type': 'text/html' } }),
    'https://spa.com/docs/llms.txt': () => new Response(shell, { headers: { 'content-type': 'text/html' } }), // SPA catch-all
  });
  const d = await discoverSite('https://spa.com/', { state: 'missing', text: '' }, { fetchImpl: impl, limiter: new HostLimiter({ intervalMs: 0 }) });
  assert.equal(d.llmsUrl, null);
  assert.equal(d.clientShell, true);
  assert.equal(d.needsBrowser, true);
  assert.deepEqual(d.browserStartUrls, ['https://spa.com/']);
  const blocked = await discoverSite('https://spa.com/', { state: 'ok', text: 'User-agent: scoop.md-bot\nDisallow: /' }, { fetchImpl: impl });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.plan.length, 0);
  const down = await discoverSite('https://spa.com/', { state: 'unreachable', text: '' }, { fetchImpl: impl });
  assert.equal(down.blocked, true);
});

// --- change detection and storage

test('classify: new, changed, unchanged (same hash or 304); only changes are indexed', async () => {
  const h = await contentHash('x');
  const prev = { content_hash: h, etag: null, last_modified: null };
  assert.equal(classify(null, h), 'new');
  assert.equal(classify(prev, h), 'unchanged');
  assert.equal(classify(prev, null), 'unchanged');
  assert.equal(classify(prev, await contentHash('y')), 'changed');
  assert.equal(needsIndexing('unchanged'), false);
  assert.equal(needsIndexing('changed'), true);
  assert.equal(pageKey(h), `pages/${h}.md`);
});

test('CrawlStore.record: dedupes R2 by hash, skips writes for unchanged pages, flags only changes in the outbox', async () => {
  const { d1, raw } = fakeD1();
  const { r2, objects } = fakeR2();
  const store = new CrawlStore(d1, r2);
  const page = (url: string, markdown: string | null, etag: string | null = null) => ({
    url,
    sourceUrl: `${url}.md`,
    kind: 'page-md' as const,
    title: markdown ? markdownTitle(markdown) : null,
    markdown,
    etag,
    lastModified: null,
  });
  const sent: IndexMessage[] = [];
  const flush = () => store.flushIndex('ex.com', async (b) => { sent.push(...b); });

  const first = await store.record('cr_1', 'ex.com', [page('https://ex.com/a', md('A'), '"a1"'), page('https://ex.com/b', md('A'))]);
  assert.deepEqual([first.new, first.changed, first.unchanged], [2, 0, 0]);
  assert.equal(objects.size, 1); // same content, one object
  assert.equal(await store.pendingIndex('ex.com'), 2);
  assert.equal(await flush(), 2);
  assert.equal(await store.pendingIndex('ex.com'), 0);

  const puts = objects.size;
  sent.length = 0;
  const second = await store.record('cr_2', 'ex.com', [page('https://ex.com/a', null, '"a1"'), page('https://ex.com/b', md('A')), page('https://ex.com/c', md('C'))]);
  assert.deepEqual([second.new, second.changed, second.unchanged], [1, 0, 2]);
  await flush();
  assert.deepEqual(sent.map((m) => m.url), ['https://ex.com/c']);
  assert.equal(objects.size, puts + 1);

  sent.length = 0;
  const third = await store.record('cr_3', 'ex.com', [page('https://ex.com/a', md('A2'))]);
  assert.deepEqual([third.new, third.changed, third.unchanged], [0, 1, 0]);
  await flush();
  assert.deepEqual(Object.keys(sent[0]).sort(), ['contentHash', 'runId', 'site', 'url']); // the M4 message contract, exactly
  assert.equal(sent[0].runId, 'cr_3'); // the run that stored the content pays for indexing it
  assert.equal(sent[0].contentHash, await contentHash(md('A2')));
  assert.ok(objects.has(`pages/${sent[0].contentHash}.md`));
  const row = raw.prepare("SELECT title, run_id, etag FROM pages WHERE url = 'https://ex.com/a'").get() as { title: string; run_id: string; etag: string | null };
  assert.equal(row.title, 'A2');
  assert.equal(row.run_id, 'cr_3');
  const b = raw.prepare("SELECT run_id, title FROM pages WHERE url = 'https://ex.com/b'").get() as { run_id: string; title: string };
  assert.deepEqual({ ...b }, { run_id: 'cr_2', title: 'A' });
});

test('HIGH-3: the index outbox survives a failed send and a retried step; nothing is lost', async () => {
  const { d1 } = fakeD1();
  const { r2 } = fakeR2();
  const store = new CrawlStore(d1, r2);
  const pages = Array.from({ length: 150 }, (_, i) => ({
    url: `https://ex.com/p${i}`, sourceUrl: `https://ex.com/p${i}.md`, kind: 'page-md' as const, title: null, markdown: md(`P${i}`), etag: null, lastModified: null,
  }));
  await store.record('cr_1', 'ex.com', pages);
  // The first flush dies after the queue accepted batch 1 (100) and before batch 2.
  const delivered: IndexMessage[] = [];
  let calls = 0;
  await assert.rejects(store.flushIndex('ex.com', async (b) => {
    if (++calls === 2) throw new Error('queue unavailable');
    assert.ok(b.length <= 100);
    delivered.push(...b);
  }));
  assert.equal(await store.pendingIndex('ex.com'), 50);
  // The step is retried: the rest goes out; a page changed meanwhile is re-flagged with its new hash.
  await store.record('cr_1', 'ex.com', [{ ...pages[0], markdown: md('P0 v2') }]);
  await store.flushIndex('ex.com', async (b) => { delivered.push(...b); });
  assert.equal(await store.pendingIndex('ex.com'), 0);
  const latest = new Map(delivered.map((m) => [m.url, m.contentHash]));
  assert.equal(latest.size, 150);
  assert.equal(latest.get('https://ex.com/p0'), await contentHash(md('P0 v2')));
});

test('createRun: one queued or running crawl per site; stale runs stop blocking', async () => {
  const { d1 } = fakeD1();
  const { r2 } = fakeR2();
  const store = new CrawlStore(d1, r2);
  const t = new Date('2026-10-12T00:00:00Z');
  assert.equal(await store.createRun('cr_1', 'ex.com', 'https://ex.com/', t), true);
  assert.equal(await store.createRun('cr_2', 'ex.com', 'https://ex.com/', t), false);
  assert.equal(await store.createRun('cr_3', 'other.com', 'https://other.com/', t), true);
  await store.updateRun('cr_3', { status: 'complete' });
  assert.equal(await store.createRun('cr_4', 'other.com', 'https://other.com/', t), true);
  assert.equal(await store.createRun('cr_5', 'ex.com', 'https://ex.com/', new Date(t.getTime() + 7 * 3_600_000)), true);
});

test('fetchPlanned: conditional requests, HTML and failures are not stored', async () => {
  const { impl, calls } = fakeFetch({
    'https://ex.com/a.md': () => new Response(null, { status: 304 }),
    'https://ex.com/b.md': () => new Response('<!doctype html><p>nope</p>', { headers: { 'content-type': 'text/html' } }),
    'https://ex.com/c.md': () => new Response(md('C'), { headers: { 'content-type': 'text/markdown', etag: '"c"' } }),
  });
  const plan = ['a', 'b', 'c', 'd'].map((p) => ({ url: `https://ex.com/${p}`, sourceUrl: `https://ex.com/${p}.md`, kind: 'page-md' as const }));
  const prev = new Map([['https://ex.com/a', { etag: '"a"', last_modified: null }]]);
  const { pages, failed } = await fetchPlanned(plan, prev, { state: 'missing', text: '' }, { fetchImpl: impl, limiter: new HostLimiter({ intervalMs: 0 }) });
  assert.equal(failed, 2);
  assert.deepEqual(pages.map((p) => [p.url, p.markdown === null, p.etag]), [
    ['https://ex.com/a', true, '"a"'], // a 304 keeps the validator we sent
    ['https://ex.com/c', false, '"c"'],
  ]);
  assert.equal((calls[0].init.headers as Record<string, string>)['if-none-match'], '"a"');
});

// --- presign

test('presign: matches the AWS SigV4 query-string test vector', async () => {
  const url = await presign({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    expiresIn: 86400,
    region: 'us-east-1',
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(
    url,
    'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
  );
});

test('presign: R2 PUT URLs sign extra headers and reject bad expiries', async () => {
  const endpoint = r2Endpoint('acct', 'scoop-crawl-staging', 'crawl-results/cr_1/a b.json');
  assert.equal(endpoint, 'https://acct.r2.cloudflarestorage.com/scoop-crawl-staging/crawl-results/cr_1/a%20b.json');
  const url = new URL(
    await presign({ method: 'PUT', url: endpoint, accessKeyId: 'k', secretAccessKey: 's', expiresIn: 900, headers: { 'Content-Type': 'application/json' }, now: new Date('2026-10-12T00:00:00Z') }),
  );
  assert.equal(url.pathname, '/scoop-crawl-staging/crawl-results/cr_1/a%20b.json');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host');
  assert.equal(url.searchParams.get('X-Amz-Credential'), 'k/20261012/auto/s3/aws4_request');
  assert.match(url.searchParams.get('X-Amz-Signature')!, /^[0-9a-f]{64}$/);
  await assert.rejects(presign({ method: 'PUT', url: endpoint, accessKeyId: 'k', secretAccessKey: 's', expiresIn: 0 }));
  await assert.rejects(presign({ method: 'PUT', url: endpoint, accessKeyId: 'k', secretAccessKey: 's', expiresIn: 604_801 }));
  assert.equal(uriEncode("a!'()*~"), 'a%21%27%28%29%2A~');
  assert.equal(amzDate(new Date('2026-10-12T01:02:03.456Z')), '20261012T010203Z');
});

test('discoverSite records where llms.txt ended up after a same-site redirect', async () => {
  const { impl } = fakeFetch({
    'https://ex.com/docs/llms.txt': () => new Response(null, { status: 301, headers: { location: '/llms.txt' } }),
    'https://ex.com/llms.txt': () => new Response(`# Ex\n- [A](https://ex.com/a.md)\n${'text '.repeat(20)}`, { headers: { 'content-type': 'text/plain' } }),
    'https://ex.com/a.md': () => new Response(md('A')),
  });
  const d = await discoverSite('https://ex.com/', { state: 'missing', text: '' }, { fetchImpl: impl, limiter: new HostLimiter({ intervalMs: 0 }) });
  assert.equal(d.llmsUrl, 'https://ex.com/llms.txt');
  assert.deepEqual(d.plan.map((p) => p.sourceUrl), ['https://ex.com/llms.txt', 'https://ex.com/a.md']);
});

// --- admin crawl requests

test('validateCrawl: defaults, scoping and refusals', () => {
  assert.deepEqual(validateCrawl({ site: 'WWW.Ex.com' }, false), { site: 'ex.com', startUrl: 'https://ex.com/', maxPages: 500, maxMinutes: 10, force: false });
  assert.equal(validateCrawl({ site: 'ex.com', force: true }, false).force, true);
  assert.throws(() => validateCrawl({ site: 'ex.com', force: 'yes' }, false), /force must be a boolean/);
  assert.equal(validateCrawl({ site: 'ex.com', startUrl: 'https://ex.com/docs/', maxPages: 30 }, false).maxPages, 30);
  assert.throws(() => validateCrawl({ site: 'ex.com', startUrl: 'https://other.com/' }, false), /not on ex.com/);
  assert.throws(() => validateCrawl({ site: 'ex.com', maxPages: 0 }, false), /maxPages/);
  assert.throws(() => validateCrawl({ site: 'ex.com', maxPages: 1001 }, false), /maxPages/);
  assert.throws(() => validateCrawl({ site: 'scoop.md' }, false), /cannot be crawled/);
  assert.throws(() => validateCrawl({ site: '10.0.0.1' }, false), /not allowed/);
  assert.throws(() => validateCrawl({ site: 'ex.com', startUrl: 'http://ex.com/' }, false), /https/);
});

// --- browser results are untrusted

test('browserPages: keeps same-site, robots-allowed, bounded, unique pages within budget', () => {
  const body = 'Readable docs text. '.repeat(10);
  const raw = JSON.stringify({
    pages: [
      { url: 'https://ex.com/#/a', title: ' A\n', markdown: body },
      { url: 'https://evil.com/x', title: 'X', markdown: body },
      { url: 'https://ex.com/private/p', title: 'P', markdown: body },
      { url: 'javascript:alert(1)', title: 'J', markdown: body },
      { url: 'https://ex.com/#/a', title: 'dup', markdown: body },
      { url: 'https://ex.com/short', title: 'S', markdown: 'tiny' },
      { url: 'https://ex.com/big', title: 7, markdown: 'y'.repeat(400_000) },
      { url: 'https://ex.com/c', title: 'C', markdown: body },
      'not an object',
    ],
  });
  const robots = parseRobots('User-agent: *\nDisallow: /private');
  const { pages, skipped } = browserPages(raw, 'ex.com', robots, 10);
  assert.deepEqual(pages.map((p) => [p.url, p.title, p.kind]), [
    ['https://ex.com/#/a', 'A', 'browser'],
    ['https://ex.com/big', null, 'browser'],
    ['https://ex.com/c', 'C', 'browser'],
  ]);
  assert.equal(skipped, 3); // evil.com, robots-disallowed, javascript:
  assert.equal(pages[1].markdown?.length, 300_000);
  assert.equal(browserPages(raw, 'ex.com', robots, 1).pages.length, 1);
  assert.deepEqual(browserPages('not json', 'ex.com', robots, 10), { pages: [], skipped: 0 });
  assert.deepEqual(browserPages('{"pages":5}', 'ex.com', robots, 10), { pages: [], skipped: 0 });
});

test('browserPages: URLs in the indexer\'s canonical form, <= 1024 chars, skip list applied', () => {
  const body = 'Readable docs text. '.repeat(10);
  const raw = JSON.stringify({
    pages: [
      { url: 'https://ex.com/#/guide/', title: 'G', markdown: body },
      { url: 'https://ex.com/#/', title: 'Root', markdown: body },
      { url: 'https://ex.com/a#intro', title: 'A', markdown: body },
      { url: 'https://ex.com/' + 'x'.repeat(1100), title: 'Long', markdown: body },
      { url: 'https://ex.com/genindex.html', title: 'Index', markdown: body },
      { url: 'https://ex.com/changelog/2023', title: 'Old', markdown: body },
      { url: 'https://ex.com/changelog/2025', title: 'New', markdown: body },
    ],
  });
  const { pages, skipped } = browserPages(raw, 'ex.com', parseRobots(''), 20);
  assert.deepEqual(pages.map((p) => p.url), ['https://ex.com/#/guide', 'https://ex.com/', 'https://ex.com/a', 'https://ex.com/changelog/2025']);
  assert.equal(skipped, 3);
});

// --- E2B over REST

function e2bFake({ runStatus = 202, states = ['running', 'finished'] } = {}) {
  const calls: { method: string; url: string; headers: Record<string, string>; body: string | null }[] = [];
  let polls = 0;
  const impl = async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', url, headers: (init.headers ?? {}) as Record<string, string>, body: (init.body as string) ?? null });
    if (url === 'https://api.e2b.app/v2/sandboxes') return Response.json({ sandboxID: 'sbx1', domain: 'e2b.app', trafficAccessToken: 'traffic' }, { status: 201 });
    if (url === 'https://8080-sbx1.e2b.app/run') return new Response('{}', { status: runStatus });
    if (url === 'https://8080-sbx1.e2b.app/status') return Response.json({ state: states[Math.min(polls++, states.length - 1)], pages: 1, error: null, uploaded: false });
    if (url === 'https://8080-sbx1.e2b.app/result') return Response.json({ site: 'ex.com', pages: [{ url: 'https://ex.com/', title: 'Ex', markdown: '# Ex' }] });
    if (url === 'https://api.e2b.app/sandboxes/sbx1') return new Response(null, { status: 204 });
    return new Response('nope', { status: 404 });
  };
  return { impl, calls };
}

test('E2BCrawler: creates a private sandbox, starts the job with a token, polls, reads, always kills', async () => {
  const { impl, calls } = e2bFake();
  const crawler = new E2BCrawler({ apiKey: 'key', templateId: 'tpl', fetchImpl: impl, sleep: async () => {} });
  const job = { site: 'ex.com', startUrls: ['https://ex.com/'], budget: { maxPages: 5, maxMinutes: 2 }, uploadUrl: null };
  const result = await runCrawl(crawler, job, { pollMs: 0, sleep: async () => {} });
  assert.equal(result.pages.length, 1);
  const create = calls[0];
  assert.equal(create.headers['x-api-key'], 'key');
  const body = JSON.parse(create.body!);
  assert.deepEqual([body.templateID, body.timeout, body.secure, body.network], ['tpl', 300, true, { allowPublicTraffic: false }]);
  const run = calls[1];
  assert.equal(run.headers['e2b-traffic-access-token'], 'traffic');
  const sent = JSON.parse(run.body!);
  assert.match(sent.token, /^[0-9a-f]{64}$/);
  assert.equal(run.headers.authorization, `Bearer ${sent.token}`);
  assert.deepEqual(sent.job, job);
  assert.ok(!JSON.stringify(sent).includes('key'), 'the API key never reaches the sandbox');
  assert.deepEqual(calls.at(-1)!.method + ' ' + calls.at(-1)!.url, 'DELETE https://api.e2b.app/sandboxes/sbx1');
});

test('E2BCrawler: a sandbox that refuses the job is killed', async () => {
  const { impl, calls } = e2bFake({ runStatus: 400 });
  const crawler = new E2BCrawler({ apiKey: 'key', templateId: 'tpl', fetchImpl: impl, sleep: async () => {} });
  await assert.rejects(crawler.start({ site: 'ex.com', startUrls: ['https://ex.com/'], budget: { maxPages: 5, maxMinutes: 2 }, uploadUrl: null }), /did not accept/);
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1);
});

test('index-pages messages: client-side routes keep their #/ path, plain anchors are dropped', () => {
  const h = 'a'.repeat(64);
  assert.equal(parseMessage({ site: 'docsify.js.org', url: 'https://docsify.js.org/#/cdn', contentHash: h }).url, 'https://docsify.js.org/#/cdn');
  assert.equal(parseMessage({ site: 'docsify.js.org', url: 'https://docsify.js.org/#/cdn?id=x', contentHash: h }).url, 'https://docsify.js.org/#/cdn');
  assert.equal(parseMessage({ site: 'ex.com', url: 'https://ex.com/a#intro', contentHash: h }).url, 'https://ex.com/a');
});

test('E2BCrawler.result: application/json only, streamed with a 25 MB cap, sent with both tokens', async () => {
  const handle = { id: 'sbx1', startedAt: 0, data: { domain: 'e2b.app', traffic: 'traffic', token: 'job' } };
  const seen: Record<string, string>[] = [];
  const JSON_TYPE = { 'content-type': 'application/json' };
  const big = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        const chunk = new Uint8Array(1_000_000);
        for (let i = 0; i < 26; i++) c.enqueue(chunk);
        c.close();
      },
    });
  const make = (body: () => BodyInit, headers: Record<string, string> = JSON_TYPE) =>
    new E2BCrawler({
      apiKey: 'key',
      templateId: 'tpl',
      fetchImpl: async (_url, init) => {
        seen.push(init.headers as Record<string, string>);
        return new Response(body(), { headers });
      },
    });
  assert.equal(await make(() => '{"pages":[]}').result(handle), '{"pages":[]}');
  assert.equal(seen[0]['e2b-traffic-access-token'], 'traffic');
  assert.equal(seen[0].authorization, 'Bearer job');
  await assert.rejects(make(big).result(handle), /over 25000000 bytes/);
  await assert.rejects(make(() => 'x', { ...JSON_TYPE, 'content-length': '30000000' }).result(handle), /over 25000000 bytes/);
  await assert.rejects(make(() => '<html>', { 'content-type': 'text/html' }).result(handle), /not application\/json/);
});

test('E2BCrawler: poll throws on 401/403; stopTagged kills only sandboxes carrying the run ID', async () => {
  const handle = { id: 'sbx1', startedAt: 0, data: { domain: 'e2b.app', traffic: 'traffic', token: 'job' } };
  const forbidden = new E2BCrawler({ apiKey: 'k', templateId: 't', fetchImpl: async () => new Response('', { status: 403 }) });
  await assert.rejects(forbidden.poll(handle), /HTTP 403/);
  const unauth = new E2BCrawler({
    apiKey: 'k',
    templateId: 't',
    fetchImpl: async (url) => (url.includes('8080-') ? Promise.reject(new Error('down')) : new Response('', { status: 401 })),
  });
  await assert.rejects(unauth.poll(handle), /HTTP 401/);
  const calls: string[] = [];
  const lister = new E2BCrawler({
    apiKey: 'k',
    templateId: 't',
    fetchImpl: async (url, init) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (url.startsWith('https://api.e2b.app/v2/sandboxes?')) {
        return Response.json([
          { sandboxID: 'a', metadata: { runId: 'cr_1' } },
          { sandboxID: 'b', metadata: { runId: 'cr_other' } }, // a filter we don't trust blindly
        ]);
      }
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(await lister.stopTagged('cr_1'), 1);
  assert.match(calls[0], /metadata=runId%3Dcr_1/);
  assert.deepEqual(calls.slice(1), ['DELETE https://api.e2b.app/sandboxes/a']);
});

// --- server-rendered HTML converted in the Worker

const prose = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const docPage = (title: string, links: string[] = []) =>
  `<!doctype html><html><head><title>${title} | Ex</title></head><body>
  <nav>${links.map((l) => `<a href="${l}">${l}</a>`).join('')}</nav>
  <main><h1>${title}<a class="headerlink" href="#x">¶</a></h1><p>${prose(120)}</p><pre><code class="language-py">print(1)</code></pre></main>
  <footer>Footer text</footer></body></html>`;
const htmlResponse = (body: string) => () => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

test('discoverSite: a server-rendered site is planned as page-html (start page, its links, then sitemap pages)', async () => {
  const { impl } = fakeFetch({
    'https://ex.com/docs/': htmlResponse(docPage('Docs', ['/docs/a', '/docs/b.html', '/docs/file.pdf', '/blog/x', 'https://other.com/docs/y'])),
    'https://ex.com/sitemap.xml': () => new Response('<urlset><url><loc>https://ex.com/docs/c</loc></url><url><loc>https://ex.com/docs/a</loc></url></urlset>'),
  });
  const d = await discoverSite('https://ex.com/docs/', { state: 'missing', text: '' }, { fetchImpl: impl, limiter: new HostLimiter({ intervalMs: 0 }) });
  assert.equal(d.needsBrowser, false);
  assert.equal(d.clientShell, false);
  assert.deepEqual(d.plan.map((p) => [p.kind, p.url]), [
    ['page-html', 'https://ex.com/docs/'],
    ['page-html', 'https://ex.com/docs/a'],
    ['page-html', 'https://ex.com/docs/b.html'],
    ['page-html', 'https://ex.com/docs/c'],
  ]);
  const small = await discoverSite('https://ex.com/docs/', { state: 'missing', text: '' }, { fetchImpl: impl, limiter: new HostLimiter({ intervalMs: 0 }), budget: 2 });
  assert.equal(small.plan.length, 2);
});

test('discoverSite: a start page that extracts to too little text falls back to the browser crawler', async () => {
  const thin = '<html><body><main><h1>Docs</h1><p>Loading the documentation, please wait.</p></main><script src="/a.js"></script></body></html>';
  const { impl } = fakeFetch({ 'https://thin.com/': htmlResponse(thin) });
  const d = await discoverSite('https://thin.com/', { state: 'missing', text: '' }, { fetchImpl: impl, limiter: new HostLimiter({ intervalMs: 0 }) });
  assert.equal(d.clientShell, false);
  assert.equal(d.needsBrowser, true);
  assert.equal(d.plan.length, 0);
});

test('fetchPlanned: page-html pages become Markdown via extract.js; thin pages fail; Markdown answers are kept as is', async () => {
  const { impl } = fakeFetch({
    'https://ex.com/a': htmlResponse(docPage('Alpha')),
    'https://ex.com/thin': htmlResponse('<html><body><main><h1>T</h1><p>short</p></main></body></html>'),
    'https://ex.com/md': () => new Response(md('Negotiated'), { headers: { 'content-type': 'text/markdown' } }),
  });
  const plan = ['a', 'thin', 'md'].map((x) => ({ url: `https://ex.com/${x}`, sourceUrl: `https://ex.com/${x}`, kind: 'page-html' as const }));
  const { pages, failed } = await fetchPlanned(plan, new Map(), { state: 'missing', text: '' }, { fetchImpl: impl, limiter: new HostLimiter({ intervalMs: 0 }) });
  assert.equal(failed, 1);
  const [a, m] = pages;
  assert.equal(a.kind, 'page-html');
  assert.equal(a.title, 'Alpha');
  assert.match(a.markdown!, /^# Alpha\n\nword0 word1/);
  assert.match(a.markdown!, /```py\nprint\(1\)\n```/);
  assert.ok(!a.markdown!.includes('Footer text'));
  assert.deepEqual([m.kind, m.title], ['page-md', 'Negotiated']);
});

test('HIGH-1: with Crawl-delay 3, all 10 pages succeed; the timeout starts after the politeness wait', async () => {
  // Politeness waits run at 1/10 real time: page 10 starts 27 s (2.7 s real)
  // in, well past the 1.5 s per-hop timeout. A timeout that started before the
  // wait would abort the later pages.
  const base = Date.now();
  const scaled: Clock = {
    now: () => (Date.now() - base) * 10,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms / 10)),
  };
  const robots = { state: 'ok' as const, text: 'User-agent: *\nCrawl-delay: 3\n' };
  const interval = intervalFor(parseRobots(robots.text).crawlDelay);
  assert.equal(interval, 3000);
  const routes: Record<string, () => Response> = {};
  const plan = Array.from({ length: 10 }, (_, i) => {
    routes[`https://ex.com/p${i}.md`] = () => new Response(md(`P${i}`), { headers: { 'content-type': 'text/markdown' } });
    return { url: `https://ex.com/p${i}`, sourceUrl: `https://ex.com/p${i}.md`, kind: 'page-md' as const };
  });
  const { impl } = fakeFetch(routes);
  const slow = async (url: string, init: RequestInit) => {
    await new Promise((r) => setTimeout(r, 20));
    if (init.signal?.aborted) throw new Error('aborted');
    return impl(url, init);
  };
  const limiter = new HostLimiter({ intervalMs: interval, clock: scaled });
  const t0 = Date.now();
  const { pages, failed, skipped } = await fetchPlanned(plan, new Map(), robots, { fetchImpl: slow, limiter, timeoutMs: 1500 });
  assert.ok(Date.now() - t0 >= 2500, 'the politeness waits really happened');
  assert.deepEqual([pages.length, failed, skipped], [10, 0, 0]);
});

test('L4: robots-disallowed and off-site pages are skipped, not failed', async () => {
  const { impl } = fakeFetch({
    'https://ex.com/away.md': () => new Response(null, { status: 302, headers: { location: 'https://other.com/x.md' } }),
    'https://ex.com/ok.md': () => new Response(md('Ok'), { headers: { 'content-type': 'text/markdown' } }),
  });
  const plan = ['private/a', 'away', 'ok', 'missing'].map((x) => ({ url: `https://ex.com/${x}`, sourceUrl: `https://ex.com/${x}.md`, kind: 'page-md' as const }));
  const r = await fetchPlanned(plan, new Map(), { state: 'ok', text: 'User-agent: *\nDisallow: /private' }, { fetchImpl: impl, limiter: new HostLimiter({ intervalMs: 0 }) });
  assert.deepEqual([r.pages.length, r.failed, r.skipped], [1, 1, 2]);
});

test('HIGH-2: a 50,000-entry sitemap without lastmod parses in linear time, and parsing stops at the cap', () => {
  const xml = '<urlset>' + Array.from({ length: 50_000 }, (_, i) => `<url><loc>https://ex.com/docs/p${i}</loc></url>`).join('\n') + '</urlset>';
  const t0 = performance.now();
  const all = parseSitemap(xml);
  const ms = performance.now() - t0;
  assert.equal(all.entries.length, 50_000);
  assert.equal(all.entries[49_999].loc, 'https://ex.com/docs/p49999');
  assert.equal(all.entries[0].lastmod, null);
  assert.ok(ms < 500, `took ${Math.round(ms)} ms`);
  assert.equal(parseSitemap(xml, 5001).entries.length, 5001);
});

test('skip list: generated indexes, search, 404, tag/category listings and old changelog archives', () => {
  for (const u of [
    'https://docs.python.org/3/genindex.html',
    'https://docs.python.org/3/genindex-A.html',
    'https://docs.python.org/3/py-modindex.html',
    'https://ex.com/docs/search',
    'https://ex.com/search.html',
    'https://ex.com/404.html',
    'https://ex.com/blog/tags/webhooks',
    'https://ex.com/category/guides/',
  ]) assert.equal(lowValue(u), true, u);
  for (const u of ['https://ex.com/docs/searching-data', 'https://ex.com/docs/tagging', 'https://ex.com/changelog', 'https://ex.com/docs/http-404-errors']) {
    assert.equal(lowValue(u), false, u);
  }
  assert.deepEqual(archiveVersion('https://ex.com/release-notes/v1.10'), [1, 10]);
  assert.equal(archiveVersion('https://ex.com/changelog'), null);
  const { kept, skipped } = skipLowValue([
    'https://ex.com/changelog',
    'https://ex.com/changelog/2023',
    'https://ex.com/changelog/2025-01',
    'https://ex.com/changelog/2024-12',
    'https://ex.com/release-notes/v1.9',
    'https://ex.com/release-notes/v1.10',
    'https://ex.com/genindex.html',
    'https://ex.com/guide',
  ]);
  assert.deepEqual(kept, ['https://ex.com/changelog', 'https://ex.com/changelog/2025-01', 'https://ex.com/release-notes/v1.10', 'https://ex.com/guide']);
  assert.equal(skipped, 4);
});

test('discoverSite: llms-full.txt is recorded but not planned when the pages exist as Markdown', async () => {
  const text = (body: string) => () => new Response(body, { headers: { 'content-type': 'text/plain' } });
  const { impl } = fakeFetch({
    'https://ex.com/llms.txt': text(`# Ex\n- [A](https://ex.com/a.md)\n- [Search](https://ex.com/search.md)\n${'text '.repeat(20)}`),
    'https://ex.com/llms-full.txt': text(md('Everything')),
    'https://ex.com/a.md': text(md('A')),
  });
  const d = await discoverSite('https://ex.com/', { state: 'missing', text: '' }, { fetchImpl: impl, limiter: new HostLimiter({ intervalMs: 0 }) });
  assert.equal(d.llmsFullUrl, 'https://ex.com/llms-full.txt');
  assert.deepEqual(d.plan.map((p) => [p.kind, p.url]), [['llms', 'https://ex.com/llms.txt'], ['page-md', 'https://ex.com/a.md']]);
  assert.equal(d.skipped, 1); // search.md
  // Without per-page Markdown, llms-full.txt is the content and is planned.
  const { impl: only } = fakeFetch({ 'https://ex.com/llms-full.txt': text(md('Everything')) });
  const d2 = await discoverSite('https://ex.com/', { state: 'missing', text: '' }, { fetchImpl: only, limiter: new HostLimiter({ intervalMs: 0 }) });
  assert.deepEqual(d2.plan.map((p) => p.kind), ['llms-full']);
});

test('MEDIUM-4: plan URLs are at most 1024 characters', async () => {
  const long = 'https://ex.com/docs/' + 'a'.repeat(1100);
  const { impl } = fakeFetch({
    'https://ex.com/llms.txt': () => new Response(`# Ex\n- [Long](${long}.md)\n- [A](https://ex.com/docs/a.md)\n${'text '.repeat(20)}`, { headers: { 'content-type': 'text/plain' } }),
  });
  const d = await discoverSite('https://ex.com/', { state: 'missing', text: '' }, { fetchImpl: impl, limiter: new HostLimiter({ intervalMs: 0 }) });
  assert.ok(d.plan.every((p) => p.url.length <= 1024 && p.sourceUrl.length <= 1024));
  assert.deepEqual(d.plan.map((p) => p.url), ['https://ex.com/llms.txt', 'https://ex.com/docs/a.md']);
});

// --- N1/N2: collecting a browser result survives retries

function collectSetup() {
  const { r2, objects } = fakeR2();
  const body = 'Readable docs text. '.repeat(10);
  const result = JSON.stringify({ pages: Array.from({ length: 23 }, (_, i) => ({ url: `https://ex.com/#/p${i}`, title: `P${i}`, markdown: body })).concat([{ url: 'https://evil.com/x', title: 'X', markdown: body }]) });
  let reads = 0;
  let alive = true;
  // What the job server answers: the result, or null (a 409 / error), and its /status.
  const job = { result: result as string | null, state: 'finished', error: null as string | null };
  const crawler = {
    async result() {
      reads++;
      if (!alive) throw new Error('sandbox gone');
      return job.result;
    },
    async status() {
      return alive ? { state: job.state, error: job.error } : null;
    },
  };
  const input = {
    bucket: r2, crawler, handle: { id: 'sbx1', startedAt: 0 }, runId: 'cr_1', site: 'ex.com', robots: parseRobots(''), maxPages: 100, perBatch: 10,
  };
  return { r2, objects, input, job, reads: () => reads, kill: () => { alive = false; } };
}

test('N1: collectResult writes batches then a manifest; a retry after the sandbox is gone returns the manifest', async () => {
  const t = collectSetup();
  const first = await collectResult(t.input);
  assert.deepEqual(first, { pages: 23, batches: 3, skipped: 1, error: null } satisfies Manifest);
  assert.equal(JSON.parse(t.objects.get(batchKey('cr_1', 2))!).length, 3);
  assert.ok(t.objects.has(manifestKey('cr_1')));
  // The step is retried after the sandbox was stopped: nothing is lost.
  t.kill();
  assert.deepEqual(await collectResult(t.input), first);
  assert.equal(t.reads(), 1);
});

test('N1: a collect attempt that dies before the manifest is simply redone', async () => {
  const t = collectSetup();
  const bucket = t.r2 as unknown as { put: (key: string, value: string) => Promise<void> };
  const put = bucket.put.bind(bucket);
  let failOnManifest = true;
  bucket.put = async (key, value) => {
    if (key === manifestKey('cr_1') && failOnManifest) { failOnManifest = false; throw new Error('R2 hiccup'); }
    return put(key, value);
  };
  await assert.rejects(collectResult(t.input), /R2 hiccup/);
  assert.equal(t.objects.has(manifestKey('cr_1')), false);
  const again = await collectResult(t.input); // the sandbox is still up: stopping is a later step
  assert.equal(again.pages, 23);
  assert.equal(t.reads(), 2);
});

test('N2: an uploaded result over the cap is refused before it is read; a valid upload is used and deleted', async () => {
  const t = collectSetup();
  t.objects.set(uploadKey('cr_1'), 'x'.repeat(25_000_001));
  await assert.rejects(collectResult(t.input), /over 25000000 bytes/);
  assert.equal(t.reads(), 0);
  const u = collectSetup();
  u.objects.set(uploadKey('cr_1'), JSON.stringify({ pages: [{ url: 'https://ex.com/a', title: 'A', markdown: 'Uploaded docs text. '.repeat(10) }] }));
  assert.equal((await collectResult(u.input)).pages, 1);
  assert.equal(u.reads(), 0);
  assert.equal(u.objects.has(uploadKey('cr_1')), false);
});

// --- N3: the public profile survives re-crawls

test('N3: status changes only when a crawl finishes or fails; a failed re-crawl keeps ready', async () => {
  const { d1 } = fakeD1();
  const { r2 } = fakeR2();
  const store = new CrawlStore(d1, r2);
  const facts = (runId: string) => ({
    site: 'ex.com', docs_root: '/', has_llms: 1, has_llms_full: 0, llms_url: null, llms_full_url: null, md_twins_ratio: 1, twin_pattern: 'suffix',
    sitemap_urls_count: 3, openapi_json: '[]', needs_browser: 0, crawl_delay: null, last_run_id: runId, updated_at: new Date().toISOString(),
  });
  const state = async () => {
    const r = (await store.getProfile('ex.com'))!;
    return [r.status, r.crawl_state, r.pages_fetched];
  };

  await store.beginCrawl('ex.com');
  await store.putProfile(facts('cr_1'));
  assert.deepEqual(await state(), ['new', 'crawling', 0]); // first crawl: not public yet
  await store.record('cr_1', 'ex.com', [{ url: 'https://ex.com/a', sourceUrl: 'https://ex.com/a.md', kind: 'page-md', title: 'A', markdown: md('A'), etag: null, lastModified: null }]);
  await store.finishCrawl('ex.com', 'ready');
  assert.deepEqual(await state(), ['ready', 'idle', 1]);
  const finishedAt = (await store.getProfile('ex.com'))!.last_crawled_at;
  assert.ok(finishedAt);

  // A re-crawl: still 'ready' (public) while it runs, flagged as crawling.
  await store.beginCrawl('ex.com');
  await store.putProfile(facts('cr_2'));
  assert.deepEqual(await state(), ['ready', 'crawling', 1]);
  assert.equal((await store.getProfile('ex.com'))!.last_crawled_at, finishedAt);
  // It fails: the stored pages are still good, so the site stays 'ready'.
  await store.failCrawl('ex.com');
  assert.deepEqual(await state(), ['ready', 'idle', 1]);

  // A site with no pages whose crawl fails is 'failed'.
  await store.beginCrawl('empty.com');
  await store.failCrawl('empty.com');
  assert.equal((await store.getProfile('empty.com'))!.status, 'failed');
});

test('L-a: no result yet (409 / error) throws so the step retries; only a job that says failed gets an error manifest', async () => {
  const t = collectSetup();
  t.job.result = null; // e.g. /result answered 409 "not finished"
  t.job.state = 'running';
  await assert.rejects(collectResult(t.input), /not available yet \(job state: running\)/);
  assert.equal(t.objects.has(manifestKey('cr_1')), false);
  // The job finishes; the retry collects the real result.
  t.job.result = JSON.stringify({ pages: [{ url: 'https://ex.com/a', title: 'A', markdown: 'Readable docs text. '.repeat(10) }] });
  t.job.state = 'finished';
  assert.equal((await collectResult(t.input)).pages, 1);

  // Sandbox unreachable: still a retry, never an empty manifest.
  const u = collectSetup();
  u.job.result = null;
  u.kill();
  await assert.rejects(collectResult(u.input), /sandbox gone|job state: unknown/);
  assert.equal(u.objects.has(manifestKey('cr_1')), false);

  // The job itself reports failure: that is final.
  const f = collectSetup();
  f.job.result = null;
  f.job.state = 'failed';
  f.job.error = 'browser crashed';
  assert.deepEqual(await collectResult(f.input), { pages: 0, batches: 0, skipped: 0, error: 'browser crashed' });
  assert.ok(f.objects.has(manifestKey('cr_1')));
});

test('L-c: a run still queued/running after 6 hours is marked failed (abandoned) when a new crawl starts', async () => {
  const { d1, raw } = fakeD1();
  const { r2 } = fakeR2();
  const store = new CrawlStore(d1, r2);
  const t = new Date('2026-10-12T00:00:00Z');
  assert.equal(await store.createRun('cr_1', 'ex.com', 'https://ex.com/', t), true);
  await store.updateRun('cr_1', { status: 'running' }); // then the Workflow is terminated
  assert.equal(await store.createRun('cr_2', 'ex.com', 'https://ex.com/', new Date(t.getTime() + 3_600_000)), false);
  assert.equal(await store.createRun('cr_3', 'ex.com', 'https://ex.com/', new Date(t.getTime() + 7 * 3_600_000)), true);
  const old = raw.prepare("SELECT status, error, finished_at FROM crawl_runs WHERE id = 'cr_1'").get() as { status: string; error: string; finished_at: string };
  assert.equal(old.status, 'failed');
  assert.match(old.error, /abandoned/);
  assert.ok(old.finished_at);
  const active = raw.prepare("SELECT COUNT(*) AS n FROM crawl_runs WHERE site = 'ex.com' AND status IN ('queued', 'running')").get() as { n: number };
  assert.equal(active.n, 1);
});
