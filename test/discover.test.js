import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteKey, candidateUrls, looksLikeText, discover, fetchPublicText } from '../extension/lib/discover.js';
import { DOMParser } from 'linkedom';

test('siteKey strips www', () => {
  assert.equal(siteKey('https://www.example.com/docs/a'), 'example.com');
  assert.equal(siteKey('https://api.jquery.com/ajax/'), 'api.jquery.com');
});

test('candidateUrls covers page .md twins and llms files at docs prefix and root', () => {
  const urls = candidateUrls('https://ex.com/docs/guides/webhooks/').map((c) => c.url);
  assert.deepEqual(urls, [
    'https://ex.com/docs/guides/webhooks.md',
    'https://ex.com/docs/guides/webhooks/index.md',
    'https://ex.com/docs/llms-full.txt',
    'https://ex.com/docs/llms.txt',
    'https://ex.com/llms-full.txt',
    'https://ex.com/llms.txt',
  ]);
});

test('candidateUrls treats a one-segment directory as a docs prefix (developers.cloudflare.com/d1/)', () => {
  const urls = candidateUrls('https://ex.com/d1/').map((c) => c.url);
  assert.ok(urls.includes('https://ex.com/d1/index.md'));
  assert.ok(urls.indexOf('https://ex.com/d1/llms.txt') < urls.indexOf('https://ex.com/llms.txt'));
  assert.ok(!candidateUrls('https://ex.com/webhooks').some((c) => c.url === 'https://ex.com/webhooks/llms.txt'));
});

test('discover prefers the docs prefix llms.txt over the site root one', async () => {
  const fakeFetch = async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/plain' }), text: async () => '# Docs\n\n' + 'x'.repeat(100) });
  const found = await discover('https://ex.com/d1/', fakeFetch);
  assert.equal(found.llms.url, 'https://ex.com/d1/llms.txt');
  assert.equal(found['page-md'].url, 'https://ex.com/d1.md');
});

test('candidateUrls follows hash routes (docsify.js.org/#/quickstart loads /quickstart.md)', () => {
  const urls = candidateUrls('https://ex.com/#/quickstart').map((c) => c.url);
  assert.equal(urls[0], 'https://ex.com/quickstart.md');
  assert.equal(candidateUrls('https://ex.com/docs/a#install')[0].url, 'https://ex.com/docs/a.md', 'plain anchors are not routes');
  assert.equal(candidateUrls('https://user.github.io/repo/#/quickstart')[0].url, 'https://user.github.io/repo/quickstart.md', 'under the current path');
  assert.equal(candidateUrls('https://ex.com/docs/index.html#/guide/a')[0].url, 'https://ex.com/docs/guide/a.md');
});

test('candidateUrls skips .md twin for root and files with extensions', () => {
  assert.ok(!candidateUrls('https://ex.com/').some((c) => c.kind === 'page-md'));
  assert.ok(!candidateUrls('https://ex.com/a/page.html').some((c) => c.kind === 'page-md'));
});

test('looksLikeText rejects HTML shells served for any path', () => {
  const md = '# Title\n\nSome real documentation content that is long enough.';
  assert.equal(looksLikeText('text/markdown', md), true);
  assert.equal(looksLikeText('text/html; charset=utf-8', md), false);
  assert.equal(looksLikeText('text/plain', '<!DOCTYPE html><html>…'), false);
  assert.equal(looksLikeText('text/plain', 'short'), false);
});

test('discover returns first hit per kind and never sends credentials', async () => {
  const body = '# Docs\n\n' + 'x'.repeat(100);
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push(init);
    const hit = url.endsWith('/docs/llms.txt') || url.endsWith('/webhooks.md');
    return {
      ok: hit,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => body,
    };
  };
  const found = await discover('https://ex.com/docs/webhooks', fakeFetch);
  assert.equal(found['page-md'].url, 'https://ex.com/docs/webhooks.md');
  assert.equal(found['llms'].url, 'https://ex.com/docs/llms.txt');
  assert.equal(found['llms-full'], undefined);
  assert.ok(calls.every((c) => c.credentials === 'omit'));
});

test('oversized files are not downloaded; only their size and URL are kept', async () => {
  let read = false;
  const fakeFetch = async (url) => ({
    ok: url.endsWith('/llms-full.txt'),
    headers: new Headers({ 'content-type': 'text/plain', 'content-length': '40000000' }),
    body: { cancel() {} },
    text: async () => { read = true; return ''; },
  });
  const found = await discover('https://ex.com/', fakeFetch);
  assert.deepEqual(found['llms-full'], { url: 'https://ex.com/llms-full.txt', content: null, bytes: 40_000_000 });
  assert.equal(read, false);
});

test('streams without Content-Length stop at the cap instead of downloading everything', async () => {
  let pulled = 0;
  const chunk = new Uint8Array(500_000).fill(97);
  const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(chunk); } }); // endless
  const res = { ok: true, headers: new Headers({ 'content-type': 'text/plain' }), body };
  const out = await fetchPublicText('https://ex.com/llms-full.txt', async () => res);
  assert.deepEqual(out, { content: null, bytes: 2_000_000 });
  assert.ok(pulled <= 6, `pulled ${pulled} chunks`);
});

test('pageUrlOf drops anchors but keeps hash routes', async () => {
  const { pageUrlOf } = await import('../extension/lib/scoop.js');
  assert.equal(pageUrlOf('https://ex.com/docs/a#install'), 'https://ex.com/docs/a');
  assert.equal(pageUrlOf('https://ex.com/#/quickstart'), 'https://ex.com/#/quickstart');
});

test('local, private and link-local hosts are never shared', async () => {
  const { isPrivateHost, scoopPage } = await import('../extension/lib/scoop.js');
  for (const h of ['localhost', 'app.localhost', 'intranet', 'wiki.local', 'docs.internal', 'nas.lan', 'printer.home.arpa',
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '[::1]', '[fd00::1]', '[fe80::1]', '[::ffff:7f00:1]', 'docs.internal.']) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ['docs.stripe.com', '172.32.0.1', '8.8.8.8', '[2606:4700::1111]', 'local.example.com']) {
    assert.equal(isPrivateHost(h), false, h);
  }
  const html = `<main><h1>Intranet</h1><p>${'Internal docs text. '.repeat(30)}</p></main>`;
  const fetchImpl = async (url) => ({ ok: !url.endsWith('.md') && !url.endsWith('.txt'), headers: new Headers({ 'content-type': 'text/html' }), text: async () => html });
  const parseHtml = (h) => new DOMParser().parseFromString(h, 'text/html');
  const local = await scoopPage('http://wiki.local/docs/a', { fetchImpl, parseHtml });
  assert.equal(local.sections[0].kind, 'page-html', 'still copied');
  assert.equal(local.isPublic, false, 'never shared');
  assert.equal((await scoopPage('http://wiki.local/docs/a', { fetchImpl, parseHtml, allowPrivateHosts: true })).isPublic, true);
  assert.equal((await scoopPage('https://ex.com/docs/a', { fetchImpl, parseHtml })).isPublic, true);
});
