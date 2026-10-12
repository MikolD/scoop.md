// Findings from the live test against staging b043896: the svelte.dev crawl
// that hit the CPU limit in the instructions step, page titles from front
// matter, an llms.txt on a non-devtool site, the not-docs hosts, a docs
// subdomain that redirects to another domain, and pages over the read cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { candidatesFromPage, dedupe, findRunInstructions, MAX_DEDUPE } from '../src/agents/instructions.ts';
import { frontMatterTitle, pageTitle } from '../src/index/chunk.ts';
import { markdownTitle } from '../src/crawl/site.ts';
import { denylistHosts } from '../src/crawl/gate.ts';
import { crawlFetch, HostLimiter } from '../src/crawl/polite.ts';
import { quickDiscover } from '../src/search/quick.ts';
import { fakeD1, fakeR2 } from './helpers.ts';

const MARKETING_HTML = readFileSync(new URL('./fixtures/gate/marketing.html', import.meta.url), 'utf8');
const SHOP_HTML = readFileSync(new URL('./fixtures/gate/shopify-product.html', import.meta.url), 'utf8');
const html = (body: string) => () => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const text = (body: string, type = 'text/plain') => () => new Response(body, { headers: { 'content-type': type } });

test('svelte.dev: an llms-full.txt of thousands of blocks no longer blows the instructions step\'s CPU', async () => {
  // 3,000 distinct paragraphs: deduplicating them pairwise took seconds of CPU.
  const many = Array.from({ length: 3000 }, (_, i) => ({ text: `Paragraph ${i} about component ${i * 7} and its props number ${i * 13} here.` }));
  let t = performance.now();
  const d = dedupe(many);
  assert.ok(performance.now() - t < 500, `${performance.now() - t} ms`);
  assert.equal(d.length, MAX_DEDUPE);

  const { d1, raw } = fakeD1();
  const { r2 } = fakeR2();
  const full = `# Svelte\n\n${Array.from({ length: 3000 }, (_, i) => `Svelte paragraph ${i} explains runes, ${i} stores and ${i * 3} snippets in detail.`).join('\n\n')}\n\n## Using an AI agent\n\nAgents should use the Svelte MCP server for documentation lookups.\n`;
  raw.prepare(`INSERT INTO pages (url, site, source_url, source_kind, content_hash, bytes, fetched_at, changed_at, run_id) VALUES ('https://svelte.example/llms-full.txt', 'svelte.example', 'https://svelte.example/llms-full.txt', 'llms-full', 'f', 1, 'x', 'x', 'cr_S')`).run();
  await r2.put('pages/f.md', full);
  const asked: number[] = [];
  const jevFetch = async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    asked.push(Object.keys(body.questions).length);
    const answers = Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([id, q]) => [id, q.type === 'choice' ? { type: 'choice', choice: 'preferred-tool', probabilities: {}, confidence: 1 } : { type: 'noul', noul: /beyond/.test(q.instructions.question) ? 0.01 : 0.9 }]));
    return Response.json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } });
  };
  t = performance.now();
  const r = await findRunInstructions({ db: d1, bucket: r2, jev: { apiKey: 'k', fetchImpl: jevFetch } }, 'cr_S', 'svelte.example', 'https://svelte.example', {
    fetchImpl: async () => new Response('nf', { status: 404 }), limiter: new HostLimiter({ intervalMs: 0 }),
  });
  assert.ok(performance.now() - t < 1500, `${performance.now() - t} ms`);
  // llms-full.txt is read like a page: only its passages about agents are candidates.
  assert.equal(r.candidates, 1);
  assert.deepEqual(asked, [3]);
  assert.equal(candidatesFromPage(full, 'https://svelte.example/llms-full.txt').length, 1);
});

test('page titles: front matter title first (docs.deno.com\'s "Writing an HTTP Server", not its first H2)', () => {
  const md = '---\nlast_modified: 2026-06-25\ntitle: "Writing an HTTP Server"\ndescription: "A guide"\n---\n\nDeno has a built-in HTTP server.\n\n## A "Hello World" server\n\ntext\n';
  assert.equal(frontMatterTitle(md), 'Writing an HTTP Server');
  assert.equal(pageTitle(md), 'Writing an HTTP Server');
  assert.equal(markdownTitle(md), 'Writing an HTTP Server');
  assert.equal(pageTitle('# Real title\n\n## Section\n'), 'Real title');
  assert.equal(frontMatterTitle('---\nlayout: x\n---\n# T'), null);
  assert.equal(frontMatterTitle("---\ntitle: 'Single quoted'\n---\n"), 'Single quoted');
});

test('allbirds.com: a store\'s llms.txt (Shopify serves one for every store) is not docs', async () => {
  const llms = '# Allbirds\n\n> Sustainable shoes.\n\n- [Men\'s shoes](https://www.allbirds.example/collections/mens.md)\n';
  const fetchImpl = async (url: string) => {
    if (url === 'https://allbirds.example/llms.txt') return text(llms)();
    if (url === 'https://allbirds.example/') return html(SHOP_HTML)();
    return new Response('nf', { status: 404 });
  };
  const d = await quickDiscover('https://allbirds.example/', { fetchImpl });
  assert.equal(d.isDevDocs.verdict, 'no');
  assert.equal(d.docs.found, false);
  assert.equal(d.docs.via, 'none');
  // Its llms.txt is still reported as what it is.
  assert.equal(d.llms?.url, 'https://allbirds.example/llms.txt');
});

test('notDocs: the denylist as concrete hosts, with www. and common TLDs; no patterns', () => {
  const hosts = denylistHosts();
  for (const h of ['amazon.com', 'www.amazon.com', 'amazon.co.uk', 'amazon.de', 'google.com', 'www.google.com', 'ebay.com', 'facebook.com', 'www.facebook.com']) {
    assert.ok(hosts.includes(h), h);
  }
  assert.ok(!hosts.some((h) => h.includes('*')));
  assert.ok(!hosts.some((h) => h.endsWith('myshopify.com')), 'subdomain-only patterns are left out');
  assert.ok(JSON.stringify(hosts).length < 12_000, 'compact');
});

test('anthropic.com: one redirect from a docs.<x> host to another domain\'s docs host is followed (docs.anthropic → docs.claude); nothing else crosses domains', async () => {
  const llms = '# Claude Docs\n\n- [Intro](https://docs.claude.example/intro.md)\n';
  const fetched: string[] = [];
  const fetchImpl = async (url: string) => {
    fetched.push(url);
    if (url === 'https://anthropic.example/') return html(MARKETING_HTML)();
    if (url.startsWith('https://docs.anthropic.example')) return new Response(null, { status: 301, headers: { location: `https://docs.claude.example${new URL(url).pathname}` } });
    if (url === 'https://docs.claude.example/llms.txt') return text(llms)();
    if (url === 'https://docs.claude.example/') return html(MARKETING_HTML)();
    if (url.startsWith('https://developer.anthropic.example')) return new Response(null, { status: 301, headers: { location: 'https://evil.example/' } });
    return new Response('nf', { status: 404 });
  };
  const d = await quickDiscover('https://anthropic.example/', { fetchImpl });
  assert.deepEqual(d.docs, { found: true, root: 'https://docs.claude.example', via: 'subdomain', verdict: 'yes', method: 'llms' });
  assert.equal(d.llms?.url, 'https://docs.claude.example/llms.txt');
  assert.ok(!fetched.some((u) => u.startsWith('https://evil.example')), 'a developer. host redirecting elsewhere is not followed');

  // The SSRF guard still runs on the redirect target.
  const ssrf = async (url: string) => (url.startsWith('https://docs.anthropic.example')
    ? new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/latest' } })
    : new Response('nf', { status: 404 }));
  const s = await quickDiscover('https://anthropic.example/', { fetchImpl: ssrf });
  assert.equal(s.docs.found, false);
});

test('twilio.com: a page over the read cap with a Content-Length is read up to the cap for its signals', async () => {
  const big = MARKETING_HTML + '<!--' + 'x'.repeat(600_000) + '-->';
  const fetchImpl = async () => new Response(big, { headers: { 'content-type': 'text/html', 'content-length': String(big.length) } });
  const limiter = new HostLimiter({ intervalMs: 0 });
  const refused = await crawlFetch('https://big.example/', { fetchImpl, limiter, cap: 512_000 });
  assert.ok(refused.ok && !refused.notModified && refused.over && refused.text === '');
  const read = await crawlFetch('https://big.example/', { fetchImpl, limiter, cap: 512_000, truncate: true });
  assert.ok(read.ok && !read.notModified && read.over && read.text.length === 512_000);

  let asked = 0;
  const jev = { apiKey: 'k', fetchImpl: async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    asked++;
    const answers = Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([id, q]) => [id, q.type === 'choice' ? { type: 'choice', choice: Object.keys(q.criteria)[0], probabilities: {}, confidence: 1 } : { type: 'noul', noul: 0.9 }]));
    return Response.json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } });
  } };
  const d = await quickDiscover('https://big.example/', { fetchImpl: async (url: string) => (url === 'https://big.example/' ? fetchImpl() : new Response('nf', { status: 404 })), jev });
  assert.equal(asked, 1);
  assert.deepEqual(d.isDevDocs, { verdict: 'yes', method: 'jev', score: 0.9 }, 'judged from its first 512 KB');
});

test('anthropic.com as it is today: docs.anthropic.com → platform.claude.com/docs/ (a docs path on another domain)', async () => {
  const llms = '# Anthropic Developer Documentation\n\n- [Home](https://platform.claude.example/docs/en/home.md)\n';
  const fetchImpl = async (url: string) => {
    if (url.startsWith('https://docs.anthropic.example')) return new Response(null, { status: 301, headers: { location: `https://platform.claude.example/docs${new URL(url).pathname}` } });
    if (url === 'https://platform.claude.example/docs/llms.txt') return new Response(null, { status: 308, headers: { location: '/llms.txt' } });
    if (url === 'https://platform.claude.example/llms.txt') return text(llms)();
    if (url === 'https://anthropic.example/') return html(MARKETING_HTML)();
    return new Response('nf', { status: 404 });
  };
  const d = await quickDiscover('https://anthropic.example/', { fetchImpl });
  assert.deepEqual(d.docs, { found: true, root: 'https://platform.claude.example/docs', via: 'subdomain', verdict: 'yes', method: 'llms' });
  assert.equal(d.llms?.url, 'https://platform.claude.example/llms.txt');
});

test('the package is titled with the page title (front matter), and front matter never reaches the agent', async () => {
  const { buildIndexPackage } = await import('../src/search/package.ts');
  const { anchorLookup } = await import('../src/search/anchor.ts');
  const { d1, raw } = fakeD1();
  const url = 'https://docs.deno.example/runtime/fundamentals/http_server/';
  const md = '---\nlast_modified: 2026-06-25\ntitle: "Writing an HTTP Server"\noldUrl:\n  - /old/\n---\n\nDeno has a built-in HTTP server.\n\n## A "Hello World" server\n\nCall Deno.serve.';
  // As stored before titles read front matter: the first heading.
  raw.prepare(`INSERT INTO page_index (url, site, content_hash, title, slot, model, cost_usd, indexed_at) VALUES (?, 'docs.deno.example', 'h', 'A "Hello World" server', 'guide', 'm', 0, 'x')`).run(url);
  raw.prepare(`INSERT INTO chunks (id, url, site, ord, heading_path, title, text) VALUES ('c0', ?, 'docs.deno.example', 0, 'A "Hello World" server', 'A "Hello World" server', ?)`).run(url, md);
  const look = await anchorLookup(d1, 'docs.deno.example', url);
  assert.equal(look.anchor?.title, 'Writing an HTTP Server');
  const out = buildIndexPackage({ site: 'docs.deno.example', label: look.anchor!.title, chunks: look.anchor!.chunks, links: new Map([[url, 'ok']]) });
  assert.match(out, /^# docs\.deno\.example docs for Writing an HTTP Server \(via scoop\.md\)/);
  assert.match(out, /^## Writing an HTTP Server$/m);
  assert.ok(!out.includes('oldUrl') && !out.includes('last_modified'));
  assert.match(out, /```markdown\nDeno has a built-in HTTP server\./);
});
