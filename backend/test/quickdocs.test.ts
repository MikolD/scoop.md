// /v1/quick at the site level (src/search/quick.ts, `docs`): from a product's
// home page to its docs subdomain or /docs path, a page that is docs itself,
// nothing found, llms.txt and llms-full.txt reported apart, instructions from
// the docs root's site, and the probe budget and per-host limiter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { docsCandidates, pageDocsRoot, quickDiscover } from '../src/search/quick.ts';
import type { SiteFound } from '../src/search/quick.ts';

const DOCS_HTML = readFileSync(new URL('./fixtures/gate/docs.html', import.meta.url), 'utf8');
const MARKETING_HTML = readFileSync(new URL('./fixtures/gate/marketing.html', import.meta.url), 'utf8');
const html = (body: string) => () => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const text = (body: string, type = 'text/plain') => () => new Response(body, { headers: { 'content-type': type } });
const LLMS = (name: string) => `# ${name}\n\n> Docs for ${name}.\n\n- [Start](https://docs.stripe.example/start.md): getting started\n`;

function web(routes: Record<string, () => Response>, delayMs = 0) {
  const fetched: string[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    fetched.push(url);
    if (delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('The operation timed out')); });
      });
    }
    return (routes[url] ?? (() => new Response('nf', { status: 404 })))();
  };
  return { fetched, fetchImpl };
}

function jev(answer: (id: string, q: any) => unknown) {
  const calls: any[] = [];
  const fetchImpl = async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([id, q]) => [id, answer(id, q)]));
    return Response.json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 1 } });
  };
  return { calls, fetchImpl };
}
const noul = (p: number) => ({ type: 'noul', noul: p });
const choice = (c: string) => ({ type: 'choice', choice: c, probabilities: { [c]: 1 }, confidence: 1 });

test('candidates: docs./developer./developers.<domain>, then /docs, /developers, /developer, /api/docs; on a hosting platform only its own paths', () => {
  assert.deepEqual(docsCandidates('https://stripe.example/pricing').map((c) => `${c.via} ${c.base}`), [
    'subdomain https://docs.stripe.example', 'subdomain https://developer.stripe.example', 'subdomain https://developers.stripe.example',
    'path https://stripe.example/docs', 'path https://stripe.example/developers', 'path https://stripe.example/developer', 'path https://stripe.example/api/docs',
  ]);
  assert.deepEqual(docsCandidates('https://alice.github.io/lib/').map((c) => c.base), [
    'https://alice.github.io/docs', 'https://alice.github.io/developers', 'https://alice.github.io/developer', 'https://alice.github.io/api/docs',
  ]);
  assert.equal(pageDocsRoot('https://docs.stripe.example/payments/x'), 'https://docs.stripe.example');
  assert.equal(pageDocsRoot('https://ex.example/docs/guide/a'), 'https://ex.example/docs');
  assert.equal(pageDocsRoot('https://ex.example/uv/guides/a', true), 'https://ex.example/uv');
  assert.equal(pageDocsRoot('https://ex.example/blog/a'), 'https://ex.example');
});

test('a main domain (stripe.com style) → its docs subdomain, found by its verified llms.txt; llms files from that root', async () => {
  const w = web({
    'https://stripe.example/pricing': html(MARKETING_HTML),
    'https://docs.stripe.example': html(DOCS_HTML),
    'https://docs.stripe.example/llms.txt': text(LLMS('Stripe')),
    'https://docs.stripe.example/llms-full.txt': text(`# Stripe full\n\n[x](https://docs.stripe.example/x)\n${'words '.repeat(20)}`),
  });
  const j = jev((_id, q) => (q.type === 'choice' ? choice(Object.keys(q.criteria)[0]) : noul(0.1)));
  const d = await quickDiscover('https://stripe.example/pricing', { fetchImpl: w.fetchImpl, jev: { apiKey: 'k', fetchImpl: j.fetchImpl } });
  assert.deepEqual(d.docs, { found: true, root: 'https://docs.stripe.example', via: 'subdomain', verdict: 'yes', method: 'llms' });
  assert.deepEqual(d.llms, { url: 'https://docs.stripe.example/llms.txt', verified: true, fullUrl: 'https://docs.stripe.example/llms-full.txt', fullVerified: true });
  assert.equal(d.isDevDocs.verdict, 'no', 'the page itself is not docs (Jev 0.1)');
  assert.ok(d.sources.some((s) => s.url === 'https://docs.stripe.example/llms.txt'), 'the docs llms.txt is a source');
  // No Jev question was needed to confirm the candidate.
  assert.ok(!('docs_candidate' in j.calls[0].questions));
  // robots.txt was asked for each host probed.
  assert.ok(w.fetched.includes('https://docs.stripe.example/robots.txt'));
});

test('example.com/docs: a path found by its signals, or confirmed by Jev when they say nothing', async () => {
  const signals = web({ 'https://ex.example/': html(MARKETING_HTML), 'https://ex.example/docs': html(DOCS_HTML) });
  const d = await quickDiscover('https://ex.example/', { fetchImpl: signals.fetchImpl });
  assert.deepEqual(d.docs, { found: true, root: 'https://ex.example/docs', via: 'path', verdict: 'yes', method: 'signals' });
  assert.equal(d.llms, null);

  const vague = web({ 'https://ex.example/': html(MARKETING_HTML), 'https://ex.example/developers': html(MARKETING_HTML) });
  const j = jev((id, q) => (q.type === 'choice' ? choice(Object.keys(q.criteria)[0]) : noul(id.startsWith('docs_candidate') ? 0.92 : 0.1)));
  const c = await quickDiscover('https://ex.example/', { fetchImpl: vague.fetchImpl, jev: { apiKey: 'k', fetchImpl: j.fetchImpl } });
  assert.deepEqual(c.docs, { found: true, root: 'https://ex.example/developers', via: 'path', verdict: 'yes', method: 'jev' });
  assert.equal(j.calls.length, 1, 'one Jev request for the page and the candidate');
  assert.ok(!JSON.stringify(j.calls[0]).includes('ex.example/developers"'), 'the candidate is described by its origin, title, description and nav');

  const no = jev((id, q) => (q.type === 'choice' ? choice(Object.keys(q.criteria)[0]) : noul(0.2)));
  const n = await quickDiscover('https://ex.example/', { fetchImpl: vague.fetchImpl, jev: { apiKey: 'k', fetchImpl: no.fetchImpl } });
  assert.equal(n.docs.found, false);
});

test('a page that is docs is its own answer (via page); a page on a docs path never probes elsewhere', async () => {
  const w = web({ 'https://ex.example/docs/guide': html(DOCS_HTML) });
  const d = await quickDiscover('https://ex.example/docs/guide', { fetchImpl: w.fetchImpl });
  assert.deepEqual(d.docs, { found: true, root: 'https://ex.example/docs', via: 'page', verdict: 'yes', method: 'signals' });
  // (docs.ex.example/llms.txt is the usual llms probe; its home page and developer hosts are the docs search.)
  assert.ok(!w.fetched.some((u) => u === 'https://docs.ex.example' || u.includes('developer') || u === 'https://ex.example/api/docs'), 'no docs search from a docs path');

  const j = jev((_id, q) => (q.type === 'choice' ? choice(Object.keys(q.criteria)[0]) : noul(0.95)));
  const w2 = web({ 'https://tool.example/intro': html(MARKETING_HTML) });
  const e = await quickDiscover('https://tool.example/intro', { fetchImpl: w2.fetchImpl, jev: { apiKey: 'k', fetchImpl: j.fetchImpl } });
  assert.deepEqual(e.docs, { found: true, root: 'https://tool.example', via: 'page', verdict: 'yes', method: 'jev' });
});

test('nothing found: found false, via none, with the page verdict', async () => {
  const w = web({ 'https://recipes.example/pasta': html(MARKETING_HTML) });
  const d = await quickDiscover('https://recipes.example/pasta', { fetchImpl: w.fetchImpl });
  assert.deepEqual(d.docs, { found: false, root: null, via: 'none', verdict: 'unknown', method: 'signals' });
  assert.equal(d.llms, null);
});

test('llms.txt and llms-full.txt are reported apart: either can exist, each verified or not', async () => {
  const onlyFull = web({ 'https://ex.example/llms-full.txt': text(`# Ex full\n\n[a](https://ex.example/a)\n${'w '.repeat(40)}`) });
  const a = await quickDiscover('https://ex.example/docs/a', { fetchImpl: onlyFull.fetchImpl });
  assert.deepEqual(a.llms, { url: null, verified: false, fullUrl: 'https://ex.example/llms-full.txt', fullVerified: true });
  const unverified = web({
    'https://ex.example/llms.txt': text('plain words about the product, no heading and no link anywhere in it at all'),
    'https://ex.example/llms-full.txt': text('# Full\n\nlots of words but no link in this file whatsoever, really none'),
  });
  const b = await quickDiscover('https://ex.example/docs/a', { fetchImpl: unverified.fetchImpl });
  assert.deepEqual(b.llms, { url: 'https://ex.example/llms.txt', verified: false, fullUrl: 'https://ex.example/llms-full.txt', fullVerified: false });
  // The host's own verified llms.txt, no docs elsewhere: the docs are at the host (via llms).
  const own = web({ 'https://tool.example/llms.txt': text(LLMS('Tool')), 'https://tool.example/': html(MARKETING_HTML) });
  const c = await quickDiscover('https://tool.example/', { fetchImpl: own.fetchImpl });
  assert.deepEqual(c.docs, { found: true, root: 'https://tool.example', via: 'llms', verdict: 'yes', method: 'llms' });
});

test('instructions for agents come from the docs root\'s llms.txt, only when that site is allowed', async () => {
  const llms = '# Stripe\n\n## For LLM agents\n\n- Always pass the Stripe-Version header on every request you send.\n- [Start](https://docs.stripe.example/start.md)\n';
  const routes = { 'https://stripe.example/pricing': html(MARKETING_HTML), 'https://docs.stripe.example/llms.txt': text(llms), 'https://docs.stripe.example': html(DOCS_HTML) };
  const j = jev((id, q) => (q.type === 'choice' ? choice(Object.keys(q.criteria)[0]) : noul(id === 'is_devtool_docs' ? 0.1 : /beyond/.test(q.instructions?.question ?? '') ? 0.02 : 0.9)));
  const asked: string[] = [];
  const instructionsFor = async (s: string) => { asked.push(s); return s === 'docs.stripe.example'; };
  const d = await quickDiscover('https://stripe.example/pricing', { fetchImpl: web(routes).fetchImpl, jev: { apiKey: 'k', fetchImpl: j.fetchImpl }, instructionsFor });
  assert.deepEqual(asked, ['docs.stripe.example']);
  assert.deepEqual(d.agentInstructions.map((i) => [i.text, i.url]), [['Always pass the Stripe-Version header on every request you send.', 'https://docs.stripe.example/llms.txt']]);
  const denied = await quickDiscover('https://stripe.example/pricing', { fetchImpl: web(routes).fetchImpl, jev: { apiKey: 'k', fetchImpl: j.fetchImpl }, instructionsFor: async () => false });
  assert.deepEqual(denied.agentInstructions, []);
});

test('budget and limiter: past the probe budget nothing is fetched and the cached docs answer stands; slow hosts are cut off at the budget', async () => {
  const routes = {
    'https://stripe.example/pricing': html(MARKETING_HTML),
    'https://docs.stripe.example': html(DOCS_HTML),
    'https://docs.stripe.example/llms.txt': text(LLMS('Stripe')),
  };
  const cache = new Map<string, SiteFound>();
  const siteCache = { get: async (k: string) => cache.get(k) ?? null, put: async (k: string, v: SiteFound) => { cache.set(k, v); } };
  const first = web(routes);
  await quickDiscover('https://stripe.example/pricing', { fetchImpl: first.fetchImpl, siteCache });
  assert.ok(cache.has('docs https://stripe.example'));
  // Another page of the host, the probe budget spent (PROBE_HOST_LIMITER refused): no fetch, the same docs answer.
  const later = web(routes);
  const d = await quickDiscover('https://stripe.example/about', { fetchImpl: later.fetchImpl, siteCache, probe: false });
  assert.deepEqual(later.fetched, []);
  assert.deepEqual(d.docs, { found: true, root: 'https://docs.stripe.example', via: 'subdomain', verdict: 'yes', method: 'llms' });
  assert.equal(d.llms?.url, 'https://docs.stripe.example/llms.txt');

  // Every candidate host hangs: the answer comes within the budget anyway.
  const slow = web({}, 5_000);
  const t = Date.now();
  const s = await quickDiscover('https://slow.example/home', { fetchImpl: slow.fetchImpl, budgetMs: 400 });
  assert.ok(Date.now() - t < 1500, `${Date.now() - t} ms`);
  assert.equal(s.docs.found, false);
});

test('a call whose fetches timed out caches nothing at the site level (a slow moment must not stand for an hour)', async () => {
  const cache = new Map<string, SiteFound>();
  const siteCache = { get: async (k: string) => cache.get(k) ?? null, put: async (k: string, v: SiteFound) => { cache.set(k, v); } };
  await quickDiscover('https://slow.example/home', { fetchImpl: web({}, 5_000).fetchImpl, budgetMs: 300, siteCache });
  assert.deepEqual([...cache.keys()], []);
  // A clean miss everywhere (404s) is cached.
  await quickDiscover('https://quiet.example/home', { fetchImpl: web({}).fetchImpl, siteCache });
  assert.ok(cache.has('host https://quiet.example') && cache.has('docs https://quiet.example'));
});
