// Jev (src/lib/jev.ts) and what it made fast: the devtool gate's AI check,
// page classification (src/index/jevclassify.ts), embeddings shared across a
// queue batch, GET /v1/quick, GET /v1/sites/index, search hit ids and
// GET /v1/packages?chunks=. Jev is always a fake fetch here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Env } from '../src/env.ts';
import { askJev, JEV_ENDPOINT, JevError, jevCostUsd, usdPerMTok } from '../src/lib/jev.ts';
import type { JevQuestion } from '../src/lib/jev.ts';
import { aiVerdict, jevVerdict, MIN_JEV_DEVTOOL, pageSignals } from '../src/crawl/gate.ts';
import type { GateAi } from '../src/crawl/gate.ts';
import { classifyWithJev, codeEntities, firstParagraph, topicPathFor, urlAmbiguous, urlTopicSegments } from '../src/index/jevclassify.ts';
import { ClassifyUnavailable } from '../src/index/classify.ts';
import { pageClassifier } from '../src/index/deps.ts';
import { indexPage, pageKey } from '../src/index/indexer.ts';
import type { IndexDeps } from '../src/index/indexer.ts';
import { coalesceEmbed, EMBED_DIMS } from '../src/index/embed.ts';
import type { Embed } from '../src/index/embed.ts';
import { quickCandidates, quickDiscover, registrable } from '../src/search/quick.ts';
import type { SiteFound } from '../src/search/quick.ts';
import { buildIndexPackage } from '../src/search/package.ts';
import { discoverSite } from '../src/crawl/site.ts';
import { HostLimiter } from '../src/crawl/polite.ts';
import { CrawlStore } from '../src/db/crawl.ts';
import { fakeD1, fakeR2 } from './helpers.ts';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: 'data:text/javascript,export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { default: worker } = await import('../src/index.ts');

type Call = { url: string; body: any; auth: string | null };

// A Jev stand-in: answers each question with `answer(id, question)`, records the calls.
function fakeJev(answer: (id: string, q: JevQuestion, body: any) => unknown, o: { status?: number[]; tokens?: [number, number] } = {}) {
  const calls: Call[] = [];
  const statuses = [...(o.status ?? [])];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body, auth: new Headers(init.headers).get('authorization') });
    const status = statuses.shift() ?? 200;
    if (status !== 200) return new Response(JSON.stringify({ error: 'x' }), { status });
    const answers = Object.fromEntries(Object.entries(body.questions as Record<string, JevQuestion>).map(([id, q]) => [id, answer(id, q, body)]));
    const [input, output] = o.tokens ?? [300, 20];
    return Response.json({ model: 'jev-1.13.0', answers, usage: { input_tokens: input, output_tokens: output } });
  };
  return { calls, fetchImpl };
}
// A request that never answers until its signal aborts. AbortSignal.timeout's
// timer doesn't hold Node's event loop open, so this one does.
const hang = (init: RequestInit, message: string) => new Promise<Response>((_, reject) => {
  const keep = setTimeout(() => {}, 10_000);
  init.signal!.addEventListener('abort', () => { clearTimeout(keep); reject(new Error(message)); });
});
const choice = (c: string, p = 0.9) => ({ type: 'choice', choice: c, probabilities: { [c]: p }, confidence: p });
const noul = (p: number) => ({ type: 'noul', noul: p });

// ---- The client -----------------------------------------------------------------

test('askJev: one POST with Bearer key, model jev-latest and every question; tokens summed', async () => {
  const jev = fakeJev((id) => (id === 'yes' ? noul(0.9) : choice('b')));
  const r = await askJev('state text', {
    yes: { type: 'noul', instructions: 'yes?' },
    pick: { type: 'choice', instructions: 'which?', criteria: { a: null, b: 'the b one' } },
  }, { apiKey: 'k1', fetchImpl: jev.fetchImpl });
  assert.equal(jev.calls.length, 1);
  assert.equal(jev.calls[0].url, JEV_ENDPOINT);
  assert.equal(jev.calls[0].auth, 'Bearer k1');
  assert.equal(jev.calls[0].body.model, 'jev-latest');
  assert.equal(jev.calls[0].body.state, 'state text');
  assert.deepEqual(Object.keys(jev.calls[0].body.questions), ['yes', 'pick']);
  assert.equal(r.tokens, 320);
  assert.equal(r.model, 'jev-1.13.0');
  assert.equal((r.answers.pick as any).choice, 'b');
  assert.equal(jevCostUsd(1_000_000, 0.5), 0.5);
  assert.equal(usdPerMTok(undefined), 0);
  assert.equal(usdPerMTok('-1'), 0);
  assert.equal(usdPerMTok('0.25'), 0.25);
});

test('askJev: one retry on 529/429/5xx and on a timeout, none on 401 or 422; an answer that is not an option is an error', async () => {
  const q = { ok: { type: 'noul', instructions: 'x' } } as Record<string, JevQuestion>;
  const retried = fakeJev(() => noul(0.5), { status: [529] });
  assert.equal((await askJev('s', q, { apiKey: 'k', fetchImpl: retried.fetchImpl })).tokens, 320);
  assert.equal(retried.calls.length, 2);

  const twice = fakeJev(() => noul(0.5), { status: [503, 503] });
  await assert.rejects(askJev('s', q, { apiKey: 'k', fetchImpl: twice.fetchImpl }), (e: unknown) => e instanceof JevError && e.status === 503);
  assert.equal(twice.calls.length, 2);

  const auth = fakeJev(() => noul(0.5), { status: [401] });
  await assert.rejects(askJev('s', q, { apiKey: 'k', fetchImpl: auth.fetchImpl }), /401/);
  assert.equal(auth.calls.length, 1);

  let n = 0;
  const slow = async (_u: string, init: RequestInit) => {
    n++;
    return hang(init, 'timed out');
  };
  const t = Date.now();
  await assert.rejects(askJev('s', q, { apiKey: 'k', fetchImpl: slow, timeoutMs: 30 }), /timed out/);
  assert.equal(n, 2);
  assert.ok(Date.now() - t < 2000);

  const bad = fakeJev(() => ({ type: 'choice', choice: 'z', probabilities: {}, confidence: 1 }));
  await assert.rejects(askJev('s', { c: { type: 'choice', instructions: 'x', criteria: { a: null } } }, { apiKey: 'k', fetchImpl: bad.fetchImpl }), /not an option/);
});

// ---- The devtool gate ---------------------------------------------------------------

const signals = pageSignals('', 'https://tool.example.dev/', 'text/html').signals;

function gateAi(over: Partial<GateAi> = {}) {
  const spent: [number, number | undefined][] = [];
  const ai: GateAi = { capReached: async () => false, addCost: async (usd, tok) => { spent.push([usd, tok]); }, ...over };
  return { ai, spent };
}

test('gate: Jev accepts on is_devtool_docs >= 0.7 and category devtool-docs, in one request; tokens and their cost recorded', async () => {
  const jev = fakeJev((id) => (id === 'is_devtool_docs' ? noul(0.92) : choice('devtool-docs', 0.85)));
  const { ai, spent } = gateAi({ jev: { apiKey: 'k', fetchImpl: jev.fetchImpl, usdPerMTok: 1 } });
  const v = await aiVerdict('<site url="https://tool.example.dev/">title: Tool docs</site>', ai, signals);
  assert.equal(jev.calls.length, 1);
  assert.deepEqual(Object.keys(jev.calls[0].body.questions), ['is_devtool_docs', 'category']);
  assert.equal(jev.calls[0].body.questions.category.type, 'choice');
  assert.ok('devtool-docs' in jev.calls[0].body.questions.category.criteria);
  assert.equal(v.decision, 'crawl');
  assert.equal(v.category, 'devtool-docs');
  assert.equal(v.method, 'ai');
  assert.equal(v.confidence, 0.92);
  assert.equal(v.jevTokens, 320);
  assert.match(v.reason, /^Jev: developer docs 0\.92, category devtool-docs/);
  assert.deepEqual(spent, [[320 / 1e6, 320]]);

  for (const [p, cat] of [[MIN_JEV_DEVTOOL - 0.01, 'devtool-docs'], [0.95, 'devtool-marketing-only']] as const) {
    const j = fakeJev((id) => (id === 'is_devtool_docs' ? noul(p) : choice(cat)));
    const r = await jevVerdict('s', { apiKey: 'k', fetchImpl: j.fetchImpl, usdPerMTok: 0 }, signals);
    assert.equal(r.decision, 'reject', `${p} ${cat}`);
    assert.equal(r.category, cat);
  }
});

test('gate: OpenRouter only when Jev fails; Jev failing with no OpenRouter key throws (the step retries)', async () => {
  const jev = fakeJev(() => noul(1), { status: [500, 500] });
  const openrouter: string[] = [];
  const orFetch = async (url: string) => {
    openrouter.push(url);
    return Response.json({ choices: [{ message: { content: '{"isDevtool":true,"category":"devtool-docs","confidence":0.9,"reason":"API docs"}' } }], usage: { cost: 0.001 } });
  };
  const { ai, spent } = gateAi({ jev: { apiKey: 'k', fetchImpl: jev.fetchImpl, usdPerMTok: 0 }, apiKey: 'or', fetchImpl: orFetch });
  const v = await aiVerdict('s', ai, signals);
  assert.equal(jev.calls.length, 2); // the try and its one retry
  assert.equal(openrouter.length, 1);
  assert.equal(v.decision, 'crawl');
  assert.equal(v.reason, 'API docs');
  assert.deepEqual(spent, [[0.001, undefined]]);

  const ok = fakeJev((id) => (id === 'is_devtool_docs' ? noul(0.9) : choice('devtool-docs')));
  const both = gateAi({ jev: { apiKey: 'k', fetchImpl: ok.fetchImpl, usdPerMTok: 0 }, apiKey: 'or', fetchImpl: orFetch });
  await aiVerdict('s', both.ai, signals);
  assert.equal(openrouter.length, 1, 'Jev answered: no OpenRouter call');

  const down = fakeJev(() => noul(1), { status: [500, 500] });
  await assert.rejects(aiVerdict('s', gateAi({ jev: { apiKey: 'k', fetchImpl: down.fetchImpl, usdPerMTok: 0 } }).ai, signals), /gate classifier unavailable/);
});

// ---- Page classification ---------------------------------------------------------------

test('topic path from the URL: docs prefixes, versions, locales and extensions dropped; hash routes kept', () => {
  assert.deepEqual(urlTopicSegments('https://hono.dev/docs/api/routing'), ['api', 'routing']);
  assert.deepEqual(urlTopicSegments('https://docs.python.org/3.12/library/asyncio-task.html'), ['library', 'asyncio-task']);
  assert.deepEqual(urlTopicSegments('https://rtd.example.dev/en/stable/howto/index.html'), ['howto']);
  assert.deepEqual(urlTopicSegments('https://docsify.js.org/#/deploy'), ['deploy']);
  assert.deepEqual(urlTopicSegments('https://docs.astral.sh/uv/'), ['uv']);
  assert.deepEqual(urlTopicSegments('https://ex.com/'), []);
  assert.deepEqual(urlTopicSegments('https://ex.com/Getting%20Started/Install.md'), ['getting-started', 'install']);

  assert.deepEqual(topicPathFor(['uv', 'guides', 'integration', 'bazel', 'more'], 'Bazel', null), ['uv', 'guides', 'integration', 'bazel']);
  assert.deepEqual(topicPathFor(['uv'], 'Getting started', null), ['uv', 'getting-started']);
  assert.deepEqual(topicPathFor(['uv'], 'uv', null), ['uv', 'overview']);
  assert.deepEqual(topicPathFor([], 'Hono', null), ['hono', 'overview']);
  assert.deepEqual(topicPathFor([], 'Welcome', 'guides'), ['guides', 'welcome']);
  assert.deepEqual(topicPathFor(['faq'], 'FAQ', 'guides'), ['guides', 'faq']);

  assert.equal(urlAmbiguous([], ['api', 'guides']), true);
  assert.equal(urlAmbiguous(['faq'], ['api', 'guides']), true);
  assert.equal(urlAmbiguous(['api'], ['api', 'guides']), false);
  assert.equal(urlAmbiguous(['api', 'x'], ['api', 'guides']), false);
  assert.equal(urlAmbiguous([], ['api']), false, 'one topic is no choice');
});

test('summary: the first real paragraph, outside front matter, code, headings and lists, cut at a sentence', () => {
  const md = [
    '---', 'title: X', '---', '# Routing', '', '[Edit this page](https://x)', '', '```ts', 'app.get("/", (c) => c.text("hi"))', '```', '',
    '- a list item that is long enough to be a paragraph if it were one',
    '', 'Routing in **Hono** is flexible and intuitive: you register [handlers](./h) for paths and methods. Let us take a look at it.', '',
  ].join('\n');
  assert.equal(firstParagraph(md), 'Routing in Hono is flexible and intuitive: you register handlers for paths and methods. Let us take a look at it.');
  assert.equal(firstParagraph('# T\n\n> A tool for doing things with other things, quickly.\n'), 'A tool for doing things with other things, quickly.');
  const long = `# T\n\n${'This sentence is fine. '.repeat(40)}`;
  assert.ok(firstParagraph(long).length <= 400);
  assert.ok(firstParagraph(long).endsWith('.'));
  assert.equal(firstParagraph('# Only a heading\n'), '');
});

test('entities by pattern: endpoints, SDK calls, config keys, env vars, error codes, CLI commands; files and hosts are not', () => {
  const md = [
    'Call `POST /v1/charges` with `stripe.webhooks.constructEvent()` and set `STRIPE_API_KEY`.',
    'Set `compilerOptions.strict` and read `package.json` at `example.com`; on `ERR_INVALID_ARG` retry.',
    'Run `npm install hono` or:',
    '```bash', '$ uv add ruff', 'cd project', '```',
    '```http', 'GET /v1/customers/{id}', '```',
    '`just text`',
  ].join('\n');
  assert.deepEqual(codeEntities(md), [
    { kind: 'endpoint', name: 'POST /v1/charges' },
    { kind: 'sdk-method', name: 'stripe.webhooks.constructEvent' },
    { kind: 'env-var', name: 'STRIPE_API_KEY' },
    { kind: 'config-key', name: 'compilerOptions.strict' },
    { kind: 'error-code', name: 'ERR_INVALID_ARG' },
    { kind: 'cli-command', name: 'npm install' },
    { kind: 'cli-command', name: 'uv add' },
    { kind: 'endpoint', name: 'GET /v1/customers/{id}' },
  ]);
  assert.equal(codeEntities(Array.from({ length: 40 }, (_, i) => `\`VAR_${i}\``).join(' ')).length, 15);
});

const PAGE = { url: 'https://docs.example.dev/', title: 'Example', markdown: '# Example\n\nExample is a toolkit for building web APIs that run on any JavaScript runtime.\n\n## Install\n\n`npm install example`\n' };

test('classifyWithJev: slot from Jev; a URL that places the page asks nothing else; an ambiguous one picks a top-level topic in the same request', async () => {
  const jev = fakeJev((id) => (id === 'slot' ? choice('install') : choice('guides', 0.8)));
  const o = { apiKey: 'k', fetchImpl: jev.fetchImpl, usdPerMTok: 2 };
  const placed = await classifyWithJev({ ...PAGE, url: 'https://docs.example.dev/docs/guides/install', topics: ['guides', 'api'] }, o);
  assert.deepEqual(Object.keys(jev.calls[0].body.questions), ['slot']);
  assert.equal(jev.calls[0].body.questions.slot.type, 'choice');
  assert.equal(Object.keys(jev.calls[0].body.questions.slot.criteria).length, 14);
  assert.equal(jev.calls[0].body.state.url, 'https://docs.example.dev/docs/guides/install');
  assert.deepEqual(placed.classification, {
    slot: 'install',
    topic_path: ['guides', 'install'],
    summary: 'Example is a toolkit for building web APIs that run on any JavaScript runtime.',
    tasks: [],
    entities: [{ kind: 'cli-command', name: 'npm install' }],
  });
  assert.equal(placed.model, 'jev:jev-1.13.0');
  assert.equal(placed.jevTokens, 320);
  assert.equal(placed.costUsd, 320 * 2 / 1e6);

  const root = await classifyWithJev({ ...PAGE, topics: ['guides', 'api'] }, o);
  assert.deepEqual(Object.keys(jev.calls[1].body.questions), ['slot', 'topic']);
  assert.deepEqual(Object.keys(jev.calls[1].body.questions.topic.criteria), ['guides', 'api', 'none of these']);
  assert.deepEqual(root.classification!.topic_path, ['guides', 'example']);

  // Unsure or "none of these": the URL and title decide.
  const unsure = fakeJev((id) => (id === 'slot' ? choice('concepts') : choice('api', 0.4)));
  const r2 = await classifyWithJev({ ...PAGE, topics: ['guides', 'api'] }, { ...o, fetchImpl: unsure.fetchImpl });
  assert.deepEqual(r2.classification!.topic_path, ['example', 'overview']);

  const down = fakeJev(() => null, { status: [500, 500] });
  await assert.rejects(classifyWithJev(PAGE, { ...o, fetchImpl: down.fetchImpl }), (e: unknown) => e instanceof ClassifyUnavailable);
});

test('CLASSIFIER: Jev by default, OpenRouter only when chosen, none without the chosen key', () => {
  assert.notEqual(pageClassifier({ JEV_API_KEY: 'j' } as Env), null);
  assert.equal(pageClassifier({ OPENROUTER_API_KEY: 'o' } as Env), null);
  assert.notEqual(pageClassifier({ CLASSIFIER: 'openrouter', OPENROUTER_API_KEY: 'o' } as Env), null);
  assert.equal(pageClassifier({ CLASSIFIER: 'openrouter', JEV_API_KEY: 'j' } as Env), null);
});

test('indexing with Jev: the site\'s top-level topics are offered; tokens land in index_run_costs, crawl_runs and index_costs', async () => {
  const { d1, raw } = fakeD1();
  const { r2 } = fakeR2();
  const store = new CrawlStore(d1, r2);
  const runId = 'cr_01JEVJEVJEVJEVJEVJEVJEVJEV';
  await store.createRun(runId, 'docs.example.dev', 'https://docs.example.dev/');
  const hash = 'a'.repeat(64);
  await r2.put(pageKey(hash), PAGE.markdown);
  raw.prepare(`INSERT INTO pages (url, site, source_url, source_kind, content_hash, bytes, fetched_at, changed_at, run_id) VALUES (?, 'docs.example.dev', ?, 'page-md', ?, 1, 'x', 'x', ?)`)
    .run(PAGE.url, PAGE.url, hash, runId);
  raw.prepare(`INSERT INTO topics (site, path, count) VALUES ('docs.example.dev', 'guides', 5), ('docs.example.dev', 'api', 3), ('docs.example.dev', 'api/auth', 1)`).run();
  const jev = fakeJev((id) => (id === 'slot' ? choice('quickstart') : choice('guides')), { tokens: [400, 25] });
  const deps: IndexDeps = {
    db: d1,
    bucket: r2,
    vectors: { upsert: async () => ({}) as never, deleteByIds: async () => ({}) as never, getByIds: async () => [] },
    embed: async (texts) => texts.map(() => new Array(EMBED_DIMS).fill(0)),
    classify: (page) => classifyWithJev(page, { apiKey: 'k', fetchImpl: jev.fetchImpl, usdPerMTok: 0 }),
    dailyCapUsd: 2,
    totalCapUsd: 10,
  };
  const out = await indexPage(deps, { site: 'docs.example.dev', url: PAGE.url, contentHash: hash, runId });
  assert.equal(out.status, 'indexed');
  assert.deepEqual(Object.keys(jev.calls[0].body.questions.topic.criteria), ['guides', 'api', 'none of these']);
  assert.deepEqual((out as any).topicPath, ['guides', 'example']);
  assert.equal(raw.prepare('SELECT jev_tokens FROM index_run_costs WHERE run_id = ?').get(runId)!.jev_tokens, 425);
  assert.equal(raw.prepare('SELECT jev_tokens FROM crawl_runs WHERE id = ?').get(runId)!.jev_tokens, 425);
  assert.deepEqual(raw.prepare(`SELECT site, jev_tokens FROM index_costs ORDER BY site`).all().map((r) => ({ ...r })), [
    { site: '*', jev_tokens: 425 }, { site: 'docs.example.dev', jev_tokens: 425 },
  ]);
  const pi = raw.prepare('SELECT model, slot, summary FROM page_index WHERE url = ?').get(PAGE.url)!;
  assert.deepEqual({ ...pi }, { model: 'jev:jev-1.13.0', slot: 'quickstart', summary: 'Example is a toolkit for building web APIs that run on any JavaScript runtime.' });
});

// ---- Throughput: one embedding call for a batch of pages ---------------------------------

test('coalesceEmbed: concurrent callers share calls and get their own vectors back; a failed shared call falls back to one call each', async () => {
  const calls: string[][] = [];
  const base: Embed = async (texts) => {
    calls.push(texts);
    if (texts.includes('poison')) throw new Error('3010: bad input');
    return texts.map((t) => [t.length]);
  };
  const shared = coalesceEmbed(base, 5);
  const [a, b, c] = await Promise.all([shared(['x', 'yy'], 'document'), shared(['zzz'], 'document'), shared([], 'document')]);
  assert.deepEqual([a, b, c], [[[1], [2]], [[3]], []]);
  assert.deepEqual(calls, [['x', 'yy', 'zzz']]);

  calls.length = 0;
  const results = await Promise.allSettled([shared(['ok'], 'document'), shared(['poison'], 'document'), shared(['q'], 'query')]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual((results[0] as PromiseFulfilledResult<number[][]>).value, [[2]]);
  assert.deepEqual(calls, [['ok', 'poison'], ['ok'], ['poison'], ['q']]);
});

// ---- GET /v1/quick ---------------------------------------------------------------------------

test('quick candidates: llms files at the first path segment, docs.<registrable> and the host; the page\'s .md twins', () => {
  assert.equal(registrable('www.example.co.uk'), 'example.co.uk');
  assert.equal(registrable('api.hono.dev'), 'hono.dev');
  assert.deepEqual(quickCandidates('https://hono.dev/docs/api/routing').map((c) => c.url), [
    'https://hono.dev/docs/llms.txt', 'https://hono.dev/docs/llms-full.txt',
    'https://docs.hono.dev/llms.txt', 'https://docs.hono.dev/llms-full.txt',
    'https://hono.dev/llms.txt', 'https://hono.dev/llms-full.txt',
    'https://hono.dev/docs/api/routing.md', 'https://hono.dev/docs/api/routing/index.md',
  ]);
  // A docs host is its own docs.<registrable>; a .md page is its own twin.
  assert.deepEqual(quickCandidates('https://docs.example.dev/a.md').map((c) => c.url), [
    'https://docs.example.dev/llms.txt', 'https://docs.example.dev/llms-full.txt', 'https://docs.example.dev/a.md',
  ]);
});

const txt = (body: string, type = 'text/plain') => () => new Response(body, { headers: { 'content-type': type } });
function quickSite(routes: Record<string, () => Response>) {
  const hits: string[] = [];
  const fetchImpl = async (url: string) => {
    hits.push(url);
    return (routes[url] ?? (() => new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } })))();
  };
  return { hits, fetchImpl };
}

test('quickDiscover: every candidate in parallel, labels and sizes, Jev picks the overview; the llms files are cached per site', async () => {
  const llms = `# Hono\n\n> Web framework.\n\n${'- [Doc](https://hono.dev/docs/x.md)\n'.repeat(5)}`;
  const page = `# Routing\n\n${'Routing text. '.repeat(10)}`;
  const site = quickSite({
    'https://hono.dev/llms.txt': txt(llms),
    'https://hono.dev/llms-full.txt': txt('# Hono full\n' + 'x'.repeat(70_000)),
    'https://hono.dev/docs/api/routing.md': txt(page, 'text/markdown'),
    'https://hono.dev/docs/api/routing': txt('<html><head><title>Routing - Hono</title></head><body><nav><a href="/docs">Docs</a></nav><p>Routing</p></body></html>', 'text/html'),
  });
  const jev = fakeJev((_id, q) => (q.type === 'noul' ? noul(0.9) : choice('s1')));
  const cache = new Map<string, SiteFound>();
  const siteCache = { get: async (k: string) => cache.get(k) ?? null, put: async (k: string, v: SiteFound) => { cache.set(k, v); } };
  const d = await quickDiscover('https://hono.dev/docs/api/routing', { fetchImpl: site.fetchImpl, jev: { apiKey: 'k', fetchImpl: jev.fetchImpl }, siteCache });
  assert.deepEqual(d.sources, [
    { kind: 'llms-txt', url: 'https://hono.dev/llms.txt', label: 'Hono (llms.txt)', bytes: new TextEncoder().encode(llms).length },
    { kind: 'page-md', url: 'https://hono.dev/docs/api/routing.md', label: 'This page: Routing', bytes: page.length },
    { kind: 'llms-full', url: 'https://hono.dev/llms-full.txt', label: 'Hono full (llms-full.txt)', bytes: null },
  ]);
  assert.equal(jev.calls.length, 1);
  // llms-full.txt is offered only when there is nothing lighter.
  assert.deepEqual(Object.keys(jev.calls[0].body.questions.overview.criteria), ['s0', 's1']);
  assert.equal(d.overview, 'https://hono.dev/docs/api/routing.md');
  assert.equal(d.jevTokens, 320);
  // The 8 candidates, robots.txt, and the page itself (for isDevDocs, robots.txt allowing).
  assert.equal(site.hits.length, 10);
  assert.ok(site.hits.includes('https://hono.dev/robots.txt'));
  assert.ok(site.hits.includes('https://hono.dev/docs/api/routing'));
  assert.deepEqual(d.isDevDocs, { verdict: 'yes', method: 'jev', score: 0.9 });
  // llms-full.txt here has no link: found, but not a verified index (reported apart from llms.txt).
  assert.deepEqual(d.llms, { url: 'https://hono.dev/llms.txt', verified: true, fullUrl: 'https://hono.dev/llms-full.txt', fullVerified: false });

  // Another page of the same site: only its own twins (and itself) are fetched.
  site.hits.length = 0;
  const other = await quickDiscover('https://hono.dev/docs/api/context', { fetchImpl: site.fetchImpl, jev: null, siteCache });
  assert.deepEqual(site.hits.sort(), ['https://hono.dev/docs/api/context', 'https://hono.dev/docs/api/context.md', 'https://hono.dev/docs/api/context/index.md', 'https://hono.dev/robots.txt']);
  // Without Jev: the most specific llms.txt.
  assert.equal(other.overview, 'https://hono.dev/llms.txt');

  // Jev down: the rule decides, within the budget.
  const down = fakeJev(() => null, { status: [500] });
  const r = await quickDiscover('https://hono.dev/docs/api/routing', { fetchImpl: site.fetchImpl, jev: { apiKey: 'k', fetchImpl: down.fetchImpl } });
  assert.equal(r.overview, 'https://hono.dev/llms.txt');
  assert.equal(down.calls.length, 1, 'no retry inside the 1.5 s budget');

  const none = await quickDiscover('https://nothing.example/', { fetchImpl: quickSite({}).fetchImpl });
  assert.deepEqual(none, {
    sources: [], overview: null, isDevDocs: { verdict: 'unknown', method: 'signals', score: 0 },
    docs: { found: false, root: null, via: 'none', verdict: 'unknown', method: 'signals' }, llms: null, agentInstructions: [], jevTokens: 0,
  });
});

test('quickDiscover: private addresses are never fetched, and a slow host is cut off by the budget', async () => {
  const site = quickSite({});
  await quickDiscover('https://hono.dev/', { fetchImpl: async (url: string, init: RequestInit) => {
    assert.ok(!/169\.254|localhost|127\./.test(url));
    return site.fetchImpl(url);
  } });
  const t = Date.now();
  const slow = (_u: string, init: RequestInit) => hang(init, 'timeout');
  const r = await quickDiscover('https://slow.example/docs/a', { fetchImpl: slow, budgetMs: 200 });
  assert.equal(r.sources.length, 0);
  assert.ok(Date.now() - t < 1000);
});

// ---- HTTP -------------------------------------------------------------------------------------------

function env(over: Partial<Env> = {}) {
  const { d1, raw } = fakeD1();
  const { r2 } = fakeR2();
  const e = {
    DB: d1,
    SKILLS: r2,
    CRAWL: r2,
    READ_LIMITER: { limit: async () => ({ success: true }) },
    SEARCH_LIMITER: { limit: async () => ({ success: true }) },
    TELEMETRY_QUEUE: { send: async () => {} },
    TELEMETRY_INGEST: 'off',
    RATE_KEY: 'test-rate-key',
    ENVIRONMENT: 'production',
    ...over,
  } as unknown as Env;
  return { env: e, raw };
}

async function call(e: Env, path: string, headers: Record<string, string> = {}) {
  const res = await worker.fetch(new Request(`https://api.scoop.md${path}`, { headers: { 'cf-connecting-ip': '203.0.113.50', ...headers } }), e);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, headers: res.headers, json, text };
}

// A Cache API stand-in on globalThis, for one test.
function withCaches() {
  const store = new Map<string, Response>();
  (globalThis as { caches?: unknown }).caches = {
    default: {
      match: async (r: Request) => store.get(r.url)?.clone(),
      put: async (r: Request, res: Response) => { store.set(r.url, res.clone()); },
    },
  };
  return { store, done: () => { delete (globalThis as { caches?: unknown }).caches; } };
}

function seed(raw: ReturnType<typeof fakeD1>['raw']) {
  const page = raw.prepare(`INSERT INTO page_index (url, site, content_hash, title, slot, model, cost_usd, indexed_at) VALUES (?, ?, 'h', ?, 'guide', 'm', 0, '2026-10-12')`);
  const chunk = raw.prepare(`INSERT INTO chunks (id, url, site, ord, heading_path, title, text) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const profile = raw.prepare(`INSERT INTO site_profiles (site, status, updated_at, source, approved) VALUES (?, ?, '2026-10-12', ?, ?)`);
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  page.run('https://docs.example.dev/a', 'docs.example.dev', 'Page A');
  page.run('https://docs.example.dev/b', 'docs.example.dev', 'Page B');
  chunk.run(`${A}-0`, 'https://docs.example.dev/a', 'docs.example.dev', 0, 'Page A', 'Page A', 'Alpha zero.');
  chunk.run(`${A}-1`, 'https://docs.example.dev/a', 'docs.example.dev', 1, 'Page A > Two', 'Page A', 'Alpha one ```` fence.');
  chunk.run(`${B}-0`, 'https://docs.example.dev/b', 'docs.example.dev', 0, 'Page B', 'Page B', 'Beta zero.');
  profile.run('docs.example.dev', 'ready', 'admin', 1);
  page.run('https://asked.example/x', 'asked.example', 'Requested');
  chunk.run(`${'c'.repeat(32)}-0`, 'https://asked.example/x', 'asked.example', 0, 'Requested', 'Requested', 'Gamma.');
  profile.run('asked.example', 'ready', 'requested', 0);
  page.run('https://shop.example/x', 'shop.example', 'Shop');
  profile.run('shop.example', 'not_devtool', 'admin', 1);
  // Rejected after a user's crawl request: never published (it would reveal what users browse).
  profile.run('visited.example', 'not_devtool', 'requested', 0);
  // Indexed by an admin with no profile (POST /v1/admin/index): listed.
  page.run('https://manual.example/x', 'manual.example', 'Manual');
  raw.prepare(`INSERT INTO link_status (url, ok, status, final_url, checked_at, source) SELECT url, 1, 200, url, '2026-10-12', 'crawl' FROM page_index`).run();
  return { A, B };
}

test('GET /v1/sites/index: approved indexed sites with page counts, ETag and 304, cached an hour; requested sites only once approved', async () => {
  const { env: e, raw } = env();
  seed(raw);
  const r = await call(e, '/v1/sites/index');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.sites, [{ site: 'docs.example.dev', pages: 2 }, { site: 'manual.example', pages: 1 }]);
  // notDocs: the rejected site and the denylist's hosts.
  for (const h of ['shop.example', 'amazon.com', 'www.amazon.com', 'amazon.co.uk', 'google.com', 'www.google.com', 'ebay.com']) assert.ok(r.json.notDocs.includes(h), h);
  assert.ok(!r.json.notDocs.some((h: string) => h.includes('*')), 'no patterns');
  assert.ok(!r.json.notDocs.includes('docs.example.dev'));
  assert.ok(!r.json.notDocs.includes('visited.example'), 'requested rejections stay private');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=3600');
  assert.match(r.headers.get('etag')!, /^"[0-9a-f]{32}"$/);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-expose-headers')!, /etag/);
  const again = await call(e, '/v1/sites/index', { 'if-none-match': `W/${r.headers.get('etag')}` });
  assert.equal(again.status, 304);
  assert.equal(again.text, '');

  raw.prepare(`UPDATE site_profiles SET approved = 1 WHERE site = 'asked.example'`).run();
  const approved = await call(e, '/v1/sites/index', { 'if-none-match': r.headers.get('etag')! });
  assert.equal(approved.status, 200);
  assert.deepEqual(approved.json.sites.map((s: any) => s.site), ['asked.example', 'docs.example.dev', 'manual.example']);

  // Served from the Cache API for an hour.
  const c = withCaches();
  try {
    const first = await call(e, '/v1/sites/index');
    raw.prepare(`DELETE FROM page_index`).run();
    const cached = await call(e, '/v1/sites/index');
    assert.deepEqual(cached.json, first.json);
    assert.equal(cached.headers.get('etag'), first.headers.get('etag'));
  } finally {
    c.done();
  }
  // Not the skills route for a site called "index".
  assert.equal((await call(e, '/v1/sites/index.example')).status, 404);
});

test('GET /v1/search hits carry the chunk id and no full text; GET /v1/packages?chunks= builds exactly those chunks, in order', async () => {
  const { env: e, raw } = env();
  const { A, B } = seed(raw);
  const s = await call(e, '/v1/search?q=alpha&site=docs.example.dev');
  assert.equal(s.status, 200);
  assert.ok(s.json.hits.length > 0);
  for (const h of s.json.hits) {
    assert.match(h.id, /^[0-9a-f]{32}-\d+$/);
    assert.equal(h.text, undefined);
  }

  const p = await call(e, `/v1/packages?site=docs.example.dev&chunks=${A}-1,${B}-0,${A}-0,${A}-1`);
  assert.equal(p.status, 200);
  assert.match(p.headers.get('content-type')!, /^text\/markdown/);
  const md = p.text;
  assert.match(md, /^# docs\.example\.dev docs for selected sections \(via scoop\.md\)\n> Reference copied/);
  const order = ['Alpha one', 'Beta zero', 'Alpha zero'].map((t) => md.indexOf(t));
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), `order ${order}`);
  assert.equal(md.split('Alpha one').length, 2, 'a repeated id is used once');
  // A chunk that doesn't start its page says where it is; the fence outruns the text's backticks.
  assert.match(md, /`````markdown\n## Two\n\nAlpha one ```` fence\.\n`````/);
  // Page A, then B, then A again: a section each time, with the page's URL.
  assert.equal((md.match(/^## Page A\nhttps:\/\/docs\.example\.dev\/a$/gm) ?? []).length, 2);
  assert.ok((await call(e, `/v1/packages?site=docs.example.dev&chunks=${A}-0,${A}-1,${B}-0&budget=2000`)).text.length <= 2000);

  const errors = [
    [`/v1/packages?site=docs.example.dev&chunks=${'c'.repeat(32)}-0`, 400, 'site_mismatch'],
    [`/v1/packages?site=docs.example.dev&chunks=not-an-id`, 400, 'invalid_request'],
    [`/v1/packages?site=docs.example.dev&chunks=`, 400, 'invalid_request'],
    [`/v1/packages?site=docs.example.dev&chunks=${Array.from({ length: 31 }, (_, i) => `${A}-${i}`).join(',')}`, 400, 'invalid_request'],
    [`/v1/packages?site=docs.example.dev&chunks=${A}-0&q=x`, 400, 'invalid_request'],
    [`/v1/packages?site=docs.example.dev&chunks=${A}-9`, 404, 'not_found'],
  ] as const;
  for (const [path, status, code] of errors) {
    const r = await call(e, path);
    assert.equal(r.status, status, path);
    assert.equal(r.json.error.code, code, path);
  }
  assert.equal((await call(e, `/v1/packages?site=docs.example.dev&chunks=${Array.from({ length: 30 }, (_, i) => `${A}-${i}`).join(',')}`)).status, 200);
});

test('GET /v1/quick: sources and overview with the index state; cached; private and malformed URLs refused', async () => {
  const { env: e, raw } = env({ JEV_API_KEY: 'k' });
  seed(raw);
  const llms = `# Example docs\n\n${'- [A](https://docs.example.dev/a.md)\n'.repeat(5)}`;
  const site = quickSite({ 'https://docs.example.dev/llms.txt': txt(llms), 'https://docs.example.dev/a.md': txt(`# A\n\n${'text '.repeat(20)}`) });
  const jev = fakeJev((_id, q) => (q.type === 'noul' ? noul(0.9) : choice('s0')));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return url === JEV_ENDPOINT ? jev.fetchImpl(url, init!) : site.fetchImpl(url);
  }) as typeof fetch;
  const c = withCaches();
  try {
    const r = await call(e, `/v1/quick?url=${encodeURIComponent('https://docs.example.dev/a')}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      site: 'docs.example.dev',
      sources: [
        { kind: 'llms-txt', url: 'https://docs.example.dev/llms.txt', label: 'Example docs (llms.txt)', bytes: llms.length },
        { kind: 'page-md', url: 'https://docs.example.dev/a.md', label: 'This page: A', bytes: 3 + 1 + 100 + 1 },
      ],
      overview: 'https://docs.example.dev/llms.txt',
      indexed: true,
      pages: 2,
      // The page itself 404s here: no facts to judge it by.
      isDevDocs: { verdict: 'unknown', method: 'signals', score: 0 },
      llms: { url: 'https://docs.example.dev/llms.txt', verified: true, fullUrl: null, fullVerified: false },
      // A docs host whose own root llms.txt is verified: the docs are right here.
      docs: { found: true, root: 'https://docs.example.dev', via: 'llms', verdict: 'yes', method: 'llms' },
      agentInstructions: [],
    });
    assert.equal(r.headers.get('x-scoop-cache'), 'miss');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(jev.calls.length, 1);
    assert.equal(raw.prepare(`SELECT jev_tokens FROM index_costs WHERE site = 'docs.example.dev'`).get()!.jev_tokens, 320);
    const before = site.hits.length;
    const again = await call(e, `/v1/quick?url=${encodeURIComponent('https://docs.example.dev/a')}`);
    assert.equal(again.headers.get('x-scoop-cache'), 'hit');
    assert.deepEqual(again.json.sources, r.json.sources);
    assert.equal(site.hits.length, before, 'nothing fetched from cache');
  } finally {
    c.done();
    globalThis.fetch = realFetch;
  }
  for (const bad of ['http://169.254.169.254/latest', 'http://localhost:8787/x', 'not a url', '']) {
    const r = await call(e, `/v1/quick?url=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400, bad);
  }
});

// ---- Discovery: a requested page that redirects out of its scope ----------------------------------

test('discovery: a scope whose page is gone and that the requested page redirects out of becomes the whole site; sitemap-index.xml is found', async () => {
  const html = (title: string, links: string[]) => () => new Response(
    `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${'Biome formats and lints your code quickly. '.repeat(20)}</p>${links.map((l) => `<a href="${l}">${l}</a>`).join('')}</main></body></html>`,
    { headers: { 'content-type': 'text/html' } },
  );
  const site = quickSite({
    'https://biome.example/guides/getting-started/': () => new Response(null, { status: 301, headers: { location: '/installation/quick-start' } }),
    'https://biome.example/installation/quick-start': html('Quick start', ['/formatter/', '/linter/']),
    'https://biome.example/sitemap-index.xml': txt('<?xml version="1.0"?><sitemapindex><sitemap><loc>https://biome.example/sitemap-0.xml</loc></sitemap></sitemapindex>', 'application/xml'),
    'https://biome.example/sitemap-0.xml': txt('<?xml version="1.0"?><urlset><url><loc>https://biome.example/formatter/</loc></url><url><loc>https://biome.example/linter/</loc></url><url><loc>https://biome.example/reference/cli/</loc></url></urlset>', 'application/xml'),
  });
  const d = await discoverSite('https://biome.example/guides/', { state: 'missing', text: '' }, {
    fetchImpl: site.fetchImpl, limiter: new HostLimiter({ intervalMs: 0 }), priorityUrl: 'https://biome.example/guides/getting-started/',
  });
  assert.equal(d.docsRoot, '/');
  assert.equal(d.sitemapUrlsCount, 3);
  assert.deepEqual(d.plan.map((p) => p.url), [
    'https://biome.example/guides/getting-started/',
    'https://biome.example/installation/quick-start',
    'https://biome.example/formatter/',
    'https://biome.example/linter/',
    'https://biome.example/reference/cli/',
  ]);
});
