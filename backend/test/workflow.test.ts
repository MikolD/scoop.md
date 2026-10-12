// The CrawlSite Workflow's gate, run in Node: `cloudflare:workers` is stubbed
// with a module hook, steps run inline, D1 is node:sqlite, R2 is in memory and
// global fetch serves the sites. Checks that a rejected run fetches no pages
// (no discovery, no sandbox) and that `force` skips the gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import type { Env } from '../src/env.ts';
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
const { CrawlSite } = await import('../src/crawl/workflow.ts');

const shopPage = readFileSync(new URL('./fixtures/gate/shopify-product.html', import.meta.url), 'utf8');

function env(d1: D1Database) {
  const { r2: skills } = fakeR2();
  const crawl = fakeR2();
  const sent: unknown[] = [];
  return {
    sent,
    env: {
      DB: d1,
      SKILLS: skills,
      CRAWL: { ...crawl.r2, list: async () => ({ objects: [...crawl.objects.keys()].map((key) => ({ key })), truncated: false }) },
      INDEX_QUEUE: { sendBatch: async (b: unknown[]) => { sent.push(...b); } },
      ENVIRONMENT: 'dev',
    } as unknown as Env,
  };
}

async function run(e: Env, payload: Record<string, unknown>, routes: Record<string, string>) {
  const steps: string[] = [];
  const requests: string[] = [];
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      steps.push(name);
      return ((b ?? a) as () => Promise<unknown>)();
    },
    sleep: async () => {},
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    const body = routes[url];
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { headers: { 'content-type': url.endsWith('.txt') ? 'text/plain' : 'text/html' } });
  }) as typeof fetch;
  try {
    const wf = new CrawlSite({} as ExecutionContext, e);
    const out = await wf.run({ payload, timestamp: new Date(), instanceId: String(payload.runId) } as never, step as never);
    return { out, steps, requests };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('CrawlSite: a site the gate rejects ends the run before discovery; no page is fetched', async () => {
  const { d1, raw } = fakeD1();
  const { env: e, sent } = env(d1);
  const store = new CrawlStore(d1, e.SKILLS);
  await store.createRun('cr_shop', 'sheepish.example', 'https://sheepish.example/');
  const { out, steps, requests } = await run(
    e,
    { runId: 'cr_shop', site: 'sheepish.example', startUrl: 'https://sheepish.example/', maxPages: 50, maxMinutes: 5 },
    { 'https://sheepish.example/': shopPage },
  );
  assert.deepEqual(out, { runId: 'cr_shop', rejected: true, category: 'ecommerce', reason: (await store.getRun('cr_shop'))!.gate_reason });
  // A rejected run still frees the site for a waiting crawl request.
  assert.deepEqual(steps, ['start', 'robots', 'gate', 'gate-record', 'start-waiting']);
  // robots.txt, the start page and two llms.txt probes; no sitemap, no pages.
  assert.deepEqual(requests, [
    'https://sheepish.example/robots.txt',
    'https://sheepish.example/',
    'https://sheepish.example/docs/llms.txt',
    'https://sheepish.example/llms.txt',
  ]);
  const runRow = (await store.getRun('cr_shop'))!;
  assert.equal(runRow.status, 'rejected');
  assert.equal(runRow.gate_method, 'signals');
  assert.equal((await store.getProfile('sheepish.example'))!.status, 'not_devtool');
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n, 0);
  assert.equal(sent.length, 0);

  // A denylisted site: robots.txt is the only request.
  await store.createRun('cr_amzn', 'amazon.com', 'https://www.amazon.com/');
  const amzn = await run(e, { runId: 'cr_amzn', site: 'amazon.com', startUrl: 'https://www.amazon.com/', maxPages: 50, maxMinutes: 5 }, {});
  assert.deepEqual(amzn.requests, ['https://www.amazon.com/robots.txt']);
  assert.equal((await store.getRun('cr_amzn'))!.gate_method, 'denylist');
  assert.equal((await store.getProfile('amazon.com'))!.gate_category, 'ecommerce');
});

test('CrawlSite: force skips the gate and marks the verdict forced; an undecided gate fails the run and leaves the status alone', async () => {
  const { d1 } = fakeD1();
  const { env: e } = env(d1);
  const store = new CrawlStore(d1, e.SKILLS);
  await store.createRun('cr_forced', 'amazon.com', 'https://www.amazon.com/', new Date(), true);
  // robots.txt disallows everything, so the forced crawl ends at discovery (blocked).
  const forced = await run(
    e,
    { runId: 'cr_forced', site: 'amazon.com', startUrl: 'https://www.amazon.com/', maxPages: 5, maxMinutes: 5, force: true },
    { 'https://www.amazon.com/robots.txt': 'User-agent: *\nDisallow: /' },
  );
  assert.ok(!forced.steps.includes('gate'));
  assert.ok(forced.steps.includes('discover'));
  const row = (await store.getRun('cr_forced'))!;
  assert.equal(row.status, 'complete');
  assert.equal(row.path, 'blocked');
  assert.equal(row.forced, 1);
  assert.equal(row.gate_decision, null);
  const prof = (await store.getProfile('amazon.com'))!;
  assert.equal(prof.gate_method, 'forced');
  assert.equal(prof.gate_category, null);
  assert.match(prof.gate_reason!, /forced by an admin \(cr_forced\)/);

  await store.createRun('cr_landing', 'flowly.example', 'https://flowly.example/');
  const landing = readFileSync(new URL('./fixtures/gate/marketing.html', import.meta.url), 'utf8');
  await assert.rejects(
    run(e, { runId: 'cr_landing', site: 'flowly.example', startUrl: 'https://flowly.example/', maxPages: 5, maxMinutes: 5 }, { 'https://flowly.example/': landing }),
    /devtool gate: signals inconclusive and no Jev or OpenRouter key/,
  );
  const failed = (await store.getRun('cr_landing'))!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.gate_decision, null);
  // Undecided is not a verdict: a new site stays 'new' (not public), and not crawling.
  const flowly = (await store.getProfile('flowly.example'))!;
  assert.equal(flowly.status, 'new');
  assert.equal(flowly.crawl_state, 'idle');
});
