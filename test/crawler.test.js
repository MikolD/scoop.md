// crawler/: the pure helpers (no Playwright needed) and the vendored copies of
// shared code, which must stay identical to their sources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { clipPage, followable, hostChecker, isPrivateHost, MAX_PAGE_CHARS, pageKey, requestAllowed, upload } from '../crawler/lib.js';
import { normalizePageUrl } from '../backend/src/lib/urls.ts';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('vendored extract.js, robots.ts, skip.ts and urls.ts match their sources (run `npm run sync` in crawler/)', () => {
  assert.equal(read('../crawler/vendor/extract.js'), read('../extension/lib/extract.js'));
  assert.equal(read('../crawler/vendor/robots.ts'), read('../backend/src/crawl/robots.ts'));
  assert.equal(read('../crawler/vendor/skip.ts'), read('../backend/src/crawl/skip.ts'));
  assert.equal(read('../crawler/vendor/urls.ts'), read('../backend/src/lib/urls.ts'));
});

test('the browser may not reach private or local hosts', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '[fd00::1]', 'printer.local', 'db.internal']) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ['docs.example.com', '8.8.8.8', '172.32.0.1', 'fd.example.com']) assert.equal(isPrivateHost(h), false, h);
  assert.equal(requestAllowed('http://localhost:8080/result'), false);
  assert.equal(requestAllowed('file:///etc/passwd'), false);
  assert.equal(requestAllowed('https://cdn.example.net/app.js'), true);
  assert.equal(requestAllowed('data:text/plain,hi'), true);
});

test('pageKey keeps client-side routes, drops anchors and queries', () => {
  assert.equal(pageKey('https://ex.com/docs/a?x=1#intro'), 'https://ex.com/docs/a');
  assert.equal(pageKey('https://ex.com/#/quickstart?id=x'), 'https://ex.com/#/quickstart');
  // Same canonical form as the indexer's normaliser.
  for (const u of ['https://ex.com/#/guide/', 'https://ex.com/#/', 'https://ex.com/a#intro', 'https://ex.com/#/x#y']) {
    assert.equal(pageKey(u), normalizePageUrl(new URL(u)), u);
  }
});

test('followable: same site, under the docs root, no assets', () => {
  assert.equal(followable('https://www.ex.com/docs/a', 'ex.com', '/docs'), true);
  assert.equal(followable('https://ex.com/docs', 'ex.com', '/docs/'), true);
  assert.equal(followable('https://ex.com/blog/a', 'ex.com', '/docs'), false);
  assert.equal(followable('https://ex.com/docsx', 'ex.com', '/docs'), false);
  assert.equal(followable('https://other.com/docs/a', 'ex.com', '/docs'), false);
  assert.equal(followable('https://ex.com/docs/logo.png', 'ex.com', '/docs'), false);
  assert.equal(followable('mailto:a@ex.com', 'ex.com'), false);
  assert.equal(followable('https://ex.com/#/guide', 'ex.com'), true);
  assert.equal(followable('https://ex.com/docs/genindex.html', 'ex.com', '/docs'), false); // skip list
  assert.equal(followable('https://ex.com/docs/' + 'a'.repeat(1100), 'ex.com', '/docs'), false); // > 1024
  assert.equal(followable('https://ex.com:8080/docs/a', 'ex.com', '/docs'), false);
});

test('clipPage bounds every field', () => {
  const p = clipPage({ url: 'https://ex.com/' + 'a'.repeat(5000), title: ' A\n\n title ', markdown: 'x'.repeat(MAX_PAGE_CHARS + 10) });
  assert.equal(p.url.length, 1024);
  assert.equal(p.title, 'A title');
  assert.equal(p.markdown.length, MAX_PAGE_CHARS);
});

test('upload PUTs the result JSON to the presigned URL and fails loudly on errors', async () => {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, type: req.headers['content-type'], body });
      res.writeHead(req.url.includes('denied') ? 403 : 200).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = { site: 'ex.com', pages: [{ url: 'https://ex.com/', title: 'Ex', markdown: '# Ex' }] };
    const n = await upload(result, `${base}/crawl-results/cr_1/x.json?X-Amz-Signature=abc`);
    assert.equal(n, JSON.stringify(result).length);
    assert.deepEqual(received[0], { method: 'PUT', url: '/crawl-results/cr_1/x.json?X-Amz-Signature=abc', type: 'application/json', body: JSON.stringify(result) });
    await assert.rejects(upload(result, `${base}/denied`), /HTTP 403/);
  } finally {
    server.close();
  }
});

test('MEDIUM-2: only default ports, and names that resolve to private addresses are blocked', async () => {
  assert.equal(requestAllowed('https://ex.com:8443/x'), false);
  assert.equal(requestAllowed('http://ex.com:8080/result'), false);
  assert.equal(requestAllowed('https://ex.com:443/x'), true);
  assert.equal(requestAllowed('http://ex.com:80/x'), true);
  for (const h of ['224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.0.8']) assert.equal(isPrivateHost(h), true, h);
  const answers = {
    'public.example': [{ address: '93.184.215.14', family: 4 }],
    'rebind.example': [{ address: '127.0.0.1', family: 4 }],
    'mixed.example': [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.5', family: 4 }],
    'v6.example': [{ address: 'fd00::1', family: 6 }],
  };
  let lookups = 0;
  const check = hostChecker(async (h) => {
    lookups++;
    if (!(h in answers)) throw new Error('ENOTFOUND');
    return answers[h];
  });
  assert.equal(await check('public.example'), true);
  assert.equal(await check('rebind.example'), false);
  assert.equal(await check('mixed.example'), false);
  assert.equal(await check('v6.example'), false);
  assert.equal(await check('missing.example'), false);
  assert.equal(await check('localhost'), false);
  assert.equal(await check('public.example'), true);
  assert.equal(lookups, 5); // cached per host; localhost never looked up
});
