// Cost per crawl (migrations/0007_run_costs.sql): indexing spend charged to
// the run that queued each page, idempotent under redelivery, the daily
// reclassify job kept apart, the per-site caps untouched, and the averages
// the Costs page and the crawl runner show.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawlCosts } from '../src/admin/queries.ts';
import { CrawlStore, runCosts } from '../src/db/crawl.ts';
import { DEFAULT_E2B_DAILY_CAP_USD, e2bDailyCap } from '../src/crawl/e2b.ts';
import type { CrawlRunRow } from '../src/db/crawl.ts';
import type { Classified } from '../src/index/classify.ts';
import { estimateTokens } from '../src/index/chunk.ts';
import { parseMessage } from '../src/index/consumer.ts';
import { embedCostUsd, EMBED_NEURONS_PER_M_TOKENS, USD_PER_1000_NEURONS } from '../src/index/embed.ts';
import { ALL_SITES, indexPage, pageKey, RECLASSIFY_RUN, spentToday } from '../src/index/indexer.ts';
import type { IndexDeps, IndexMessage } from '../src/index/indexer.ts';
import { reclassify } from '../src/index/reclassify.ts';
import { sha256Hex } from '../src/lib/ids.ts';
import { refreshCosts, summary, table } from '../scripts/crawl-seeds.mjs';
import type { Result } from '../scripts/crawl-seeds.mjs';
import { fakeD1, fakeR2 } from './helpers.ts';

const NOW = new Date('2026-10-12T10:00:00Z');
const RUN = 'cr_01AAAAAAAAAAAAAAAAAAAAAAAA';
const MD = (n: number) => `# Webhooks ${n}\n\nVerify the signature header before trusting the payload. ${'Words to embed. '.repeat(40)}\n\n## Retries\n\nDeliveries are retried for three days.\n`;
const cls = (costUsd: number): Classified => ({
  classification: { slot: 'webhooks-events', topic_path: ['webhooks'], summary: 's', tasks: [], entities: [] },
  model: 'qwen/qwen3.7-flash',
  costUsd,
});

function setup(results: (Classified | null)[] = []) {
  const { d1, raw } = fakeD1();
  const { r2, objects } = fakeR2();
  const embedded: string[] = [];
  let n = 0;
  const deps: IndexDeps = {
    db: d1,
    bucket: r2,
    vectors: { upsert: async () => ({}), deleteByIds: async () => ({}), getByIds: async () => [] } as unknown as IndexDeps['vectors'],
    embed: async (texts) => { embedded.push(...texts); return texts.map(() => [1, 0]); },
    classify: async () => {
      const r = results[n++];
      if (!r) throw new Error('no classification left');
      return r;
    },
    dailyCapUsd: 2,
    totalCapUsd: 10,
    now: () => NOW,
  };
  raw.prepare(`INSERT INTO crawl_runs (id, site, start_url, started_at, status, path, pages_new, cost_usd, gate_cost_usd) VALUES (?, 'docs.stripe.com', 'https://docs.stripe.com/', ?, 'complete', 'markdown', 2, 0.01, 0.002)`)
    .run(RUN, NOW.toISOString());
  const put = async (url: string, md: string, runId?: string): Promise<IndexMessage> => {
    const contentHash = await sha256Hex(md);
    objects.set(pageKey(contentHash), md);
    return { site: 'docs.stripe.com', url, contentHash, ...(runId ? { runId } : {}) };
  };
  const run = () => raw.prepare('SELECT classify_cost_usd, embed_cost_usd, pages_indexed FROM crawl_runs WHERE id = ?').get(RUN) as { classify_cost_usd: number; embed_cost_usd: number; pages_indexed: number };
  const ledger = () => raw.prepare('SELECT run_id, url, classify_cost_usd, embed_tokens, embed_cost_usd, indexed FROM index_run_costs ORDER BY run_id, url').all().map((r) => ({ ...r }));
  return { deps, raw, d1, put, run, ledger, embedded };
}

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test('embedding price: 1,075 neurons per million tokens at $0.011 per 1,000 neurons', () => {
  assert.equal(EMBED_NEURONS_PER_M_TOKENS, 1075);
  assert.equal(USD_PER_1000_NEURONS, 0.011);
  close(embedCostUsd(1_000_000), 0.011825);
  assert.equal(embedCostUsd(0), 0);
});

test('a crawl page\'s classification and embedding are charged to its run', async () => {
  const { deps, put, run, ledger, embedded } = setup([cls(0.0004), cls(0.0006)]);
  await indexPage(deps, await put('https://docs.stripe.com/a', MD(1), RUN));
  await indexPage(deps, await put('https://docs.stripe.com/b', MD(2), RUN));
  const tokens = embedded.reduce((n, t) => n + estimateTokens(t), 0);
  const r = run();
  close(r.classify_cost_usd, 0.001);
  close(r.embed_cost_usd, embedCostUsd(tokens));
  assert.equal(r.pages_indexed, 2);
  assert.deepEqual(ledger().map((l: any) => [l.run_id, l.url, l.indexed]), [[RUN, 'https://docs.stripe.com/a', 1], [RUN, 'https://docs.stripe.com/b', 1]]);
});

test('redelivery never double-counts; the daily caps are unchanged', async () => {
  const { deps, d1, put, run, ledger } = setup([cls(0.0004)]);
  const msg = await put('https://docs.stripe.com/a', MD(1), RUN);
  await indexPage(deps, msg);
  const once = { run: run(), ledger: ledger() };
  // The same message again (an ack that got lost): the page is indexed already.
  assert.deepEqual(await indexPage(deps, msg), { status: 'unchanged' });
  assert.deepEqual(await indexPage(deps, msg), { status: 'unchanged' });
  assert.deepEqual(run(), once.run);
  assert.deepEqual(ledger(), once.ledger);
  // index_costs (what the caps read) got the classification once, as before.
  close(await spentToday(d1, 'docs.stripe.com', NOW), 0.0004);
  close(await spentToday(d1, ALL_SITES, NOW), 0.0004);
});

test('a cached classification costs the run nothing; content already indexed still counts as indexed', async () => {
  const { deps, raw, put, run } = setup([cls(0.0004)]);
  const RUN2 = 'cr_01BBBBBBBBBBBBBBBBBBBBBBBB';
  raw.prepare(`INSERT INTO crawl_runs (id, site, start_url, started_at, status, pages_new) VALUES (?, 'docs.stripe.com', 'https://docs.stripe.com/', ?, 'complete', 2)`).run(RUN2, NOW.toISOString());
  await indexPage(deps, await put('https://docs.stripe.com/a', MD(1), RUN));
  // Same content at another URL: the classification comes from the R2 cache.
  await indexPage(deps, await put('https://docs.stripe.com/copy', MD(1), RUN2));
  // A page a later run queued that is already indexed at this content.
  await indexPage(deps, await put('https://docs.stripe.com/a', MD(1), RUN2));
  const r2 = raw.prepare('SELECT classify_cost_usd, embed_cost_usd, pages_indexed FROM crawl_runs WHERE id = ?').get(RUN2) as any;
  assert.equal(r2.classify_cost_usd, 0);
  assert.ok(r2.embed_cost_usd > 0); // the copy was still embedded
  assert.equal(r2.pages_indexed, 2);
  close(run().classify_cost_usd, 0.0004);
});

test('the reclassify cron is its own per-day bucket; manual indexing is "manual"', async () => {
  const { deps, d1, put, run, ledger } = setup([cls(0.0007)]);
  // Indexed unclassified by the crawl (cap reached), classified later by the cron.
  const capped = { ...deps, classify: null };
  const msg = await put('https://docs.stripe.com/a', MD(1), RUN);
  await indexPage(capped, msg);
  assert.equal(run().classify_cost_usd, 0);
  assert.equal(run().pages_indexed, 1);
  const sent: { body: IndexMessage }[] = [];
  assert.equal(await reclassify(d1, { sendBatch: async (b: { body: IndexMessage }[]) => { sent.push(...b); } } as never, { totalCapUsd: 10, dailyCapUsd: 2, now: NOW }), 1);
  assert.equal(sent[0].body.runId, RECLASSIFY_RUN);
  assert.equal((await indexPage(deps, parseMessage(sent[0].body))).status, 'reclassified');
  // The run's totals didn't move; the cron's day did.
  assert.equal(run().classify_cost_usd, 0);
  const rows = ledger() as any[];
  assert.deepEqual(rows.map((r) => r.run_id), [RUN, 'reclassify:2026-10-12']);
  close(rows[1].classify_cost_usd, 0.0007);
  // No run on the message: 'manual'.
  await indexPage(capped, await put('https://docs.stripe.com/m', MD(9)));
  assert.ok((ledger() as any[]).some((r) => r.run_id === 'manual' && r.url === 'https://docs.stripe.com/m'));
});

test('parseMessage keeps a crawl run ID or the reclassify marker, nothing else', () => {
  const base = { site: 'docs.stripe.com', url: 'https://docs.stripe.com/a', contentHash: 'a'.repeat(64) };
  assert.equal(parseMessage({ ...base, runId: RUN }).runId, RUN);
  assert.equal(parseMessage({ ...base, runId: RECLASSIFY_RUN }).runId, RECLASSIFY_RUN);
  assert.equal(parseMessage({ ...base, runId: 'manual' }).runId, undefined);
  assert.equal(parseMessage({ ...base, runId: "x'; DROP" }).runId, undefined);
  assert.deepEqual(Object.keys(parseMessage(base)).sort(), ['contentHash', 'site', 'url']);
});

test('runCosts: breakdown, total, per stored page, indexing done', () => {
  const row = { cost_usd: 0.01, gate_cost_usd: 0.002, classify_cost_usd: 0.003, embed_cost_usd: 0.001, pages_new: 3, pages_changed: 1, pages_indexed: 3, costs_tracked: 1 } as CrawlRunRow;
  const c = runCosts(row);
  close(c.totalUsd, 0.016);
  close(c.perPageUsd!, 0.004);
  assert.equal(c.pagesStored, 4);
  assert.equal(c.indexingDone, false);
  assert.equal(runCosts({ ...row, pages_indexed: 4 }).indexingDone, true);
  const rejected = runCosts({ ...row, cost_usd: 0, classify_cost_usd: 0, embed_cost_usd: 0, pages_new: 0, pages_changed: 0, pages_indexed: 0 });
  assert.equal(rejected.perPageUsd, null);
  assert.equal(rejected.indexingDone, true);
  // From before cost tracking: never final.
  const old = runCosts({ ...row, pages_indexed: 4, costs_tracked: 0 });
  assert.deepEqual([old.tracked, old.indexingDone], [false, false]);
});

test('crawlCosts: averages per crawl, per page and by path over runs whose indexing is done', async () => {
  const { d1, raw } = fakeD1();
  const add = (id: string, path: string | null, status: string, stored: number, indexed: number, browser: number, gate: number, classify: number, embed: number, day = '2026-10-12') =>
    raw.prepare(`INSERT INTO crawl_runs (id, site, start_url, started_at, status, path, pages_new, pages_indexed, cost_usd, gate_cost_usd, classify_cost_usd, embed_cost_usd)
      VALUES (?, 'x.dev', 'https://x.dev/', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, `${day}T08:00:00.000Z`, status, path, stored, indexed, browser, gate, classify, embed);
  add('cr_1', 'markdown', 'complete', 10, 10, 0, 0, 0.01, 0.0001);
  add('cr_2', 'markdown', 'complete', 30, 30, 0, 0, 0.03, 0.0003);
  add('cr_3', 'browser', 'complete', 20, 20, 0.05, 0.001, 0.02, 0.0002);
  add('cr_4', 'html', 'complete', 10, 4, 0, 0, 0.004, 0); // still indexing: left out of averages
  add('cr_5', null, 'rejected', 0, 0, 0, 0.0005, 0, 0);
  add('cr_6', 'markdown', 'running', 5, 0, 0, 0, 0, 0); // not finished
  add('cr_7', 'markdown', 'complete', 10, 10, 0, 0, 1, 0, '2026-09-01'); // outside the window
  add('cr_8', 'markdown', 'complete', 10, 0, 0, 0, 0, 0);
  raw.prepare(`UPDATE crawl_runs SET costs_tracked = 0 WHERE id = 'cr_8'`).run(); // from before cost tracking: listed, not averaged
  raw.prepare(`INSERT INTO index_run_costs (run_id, url, content_hash, site, classify_cost_usd, embed_cost_usd, indexed, updated_at) VALUES ('reclassify:2026-10-11', 'u', 'h', 'x.dev', 0.002, 0.00001, 1, '2026-10-11T04:17:00Z')`).run();
  const c = await crawlCosts(d1, 14, new Date('2026-10-12T12:00:00Z'));
  assert.deepEqual(c.runs.map((r) => r.id).sort(), ['cr_1', 'cr_2', 'cr_3', 'cr_4', 'cr_5', 'cr_8']);
  const o = c.averages.overall;
  assert.equal(o.runs, 5);
  assert.equal(o.finalRuns, 4);
  assert.equal(o.pendingRuns, 1);
  close(o.totalUsd, 0.0101 + 0.0303 + 0.0712 + 0.0005);
  assert.equal(o.pages, 60);
  close(o.perCrawlUsd!, o.totalUsd / 4);
  close(o.perPageUsd!, o.totalUsd / 60);
  const by = Object.fromEntries(c.averages.byPath.map((g) => [g.path, g]));
  close(by.markdown.perCrawlUsd!, (0.0101 + 0.0303) / 2);
  close(by.markdown.perPageUsd!, 0.0404 / 40);
  close(by.browser.perPageUsd!, 0.0712 / 20);
  assert.equal(by.html.finalRuns, 0);
  assert.equal(by.html.perCrawlUsd, null);
  close(by.rejected.perCrawlUsd!, 0.0005);
  assert.equal(by.rejected.perPageUsd, null);
  const r3 = c.runs.find((r) => r.id === 'cr_3')!;
  close(r3.total_cost_usd, 0.0712);
  close(r3.cost_per_page!, 0.0712 / 20);
  assert.equal(c.runs.find((r) => r.id === 'cr_4')!.indexing_done, 0);
  assert.deepEqual(c.reclassify.map((r) => [r.day, r.pages]), [['2026-10-11', 1]]);
});

const result = (over: Partial<Result>): Result => ({
  name: 'x', site: 'x.dev', startUrl: 'https://x.dev/', maxPages: 10, runId: 'cr_1', status: 'complete', path: 'markdown',
  pages: { new: 4, changed: 0, unchanged: 0, failed: 0, skipped: 0 }, gate: null, forced: false, costUsd: 0, costs: null, error: null,
  attempts: 1, startedAt: null, finishedAt: null, ...over,
});
const costs = (total: number, stored: number, indexed: number) => ({
  browserUsd: 0, gateUsd: 0, classifyUsd: total, embedUsd: 0, totalUsd: total, pagesStored: stored, pagesIndexed: indexed,
  perPageUsd: stored ? total / stored : null, indexingDone: indexed >= stored, tracked: true,
});

test('crawl runner: per-run total and per page once indexed, "indexing" until then; refreshCosts waits for it', async () => {
  let indexed = 2;
  const fetchImpl = async () => Response.json({ run: { costs: costs(0.004, 4, indexed) } });
  const results = [result({ runId: 'cr_1', costs: costs(0.001, 4, 0), costUsd: 0.001 }), result({ runId: 'cr_2', site: 'y.dev', status: 'rejected', pages: { new: 0, changed: 0, unchanged: 0, failed: 0, skipped: 0 }, costs: costs(0.0005, 0, 0), costUsd: 0.0005 })];
  await refreshCosts(results, { api: 'https://api.test', token: 't', fetchImpl });
  assert.equal(results[0].costs!.pagesIndexed, 2);
  assert.match(table(results), /x\.dev .* 0\.00400\s+indexing 2\/4/);
  assert.match(summary(results), /per page: indexing pending in 1 runs/);
  // Waiting: polls until indexing is done.
  let t = 0;
  const later = async () => { indexed = 4; t += 10_000; };
  await refreshCosts(results, { api: 'https://api.test', token: 't', fetchImpl, waitMs: 60_000, pollMs: 10_000, sleep: later, now: () => t });
  assert.equal(results[0].costs!.indexingDone, true);
  assert.match(table(results), /x\.dev .* 0\.00400\s+0\.00100/);
  assert.match(summary(results), /cost: \$0\.00450 /);
  assert.match(summary(results), /per page: \$0\.00100 over 4 pages in 1 fully indexed runs/);
});

test('E2B daily cap: a browser crawl reserves its worst case, and one over the cap is refused', async () => {
  const { d1, raw } = fakeD1();
  const store = new CrawlStore(d1, fakeR2().r2);
  const at = '2026-10-12T09:00:00.000Z';
  const run = (id: string, cost = 0, started = at) =>
    raw.prepare(`INSERT INTO crawl_runs (id, site, start_url, started_at, status, cost_usd) VALUES (?, 'x.dev', 'https://x.dev/', ?, 'running', ?)`).run(id, started, cost);
  run('cr_old', 5, '2026-10-11T23:00:00.000Z'); // yesterday: doesn't count
  run('cr_done', 1.5);
  run('cr_a');
  run('cr_b');
  assert.deepEqual(await store.reserveBrowser('cr_a', 0.4, 2, NOW), { ok: true, spentUsd: 1.9 });
  assert.equal((raw.prepare(`SELECT cost_usd FROM crawl_runs WHERE id = 'cr_a'`).get() as any).cost_usd, 0.4);
  // 1.5 + 0.4 + 0.4 > 2: refused, nothing written.
  assert.deepEqual(await store.reserveBrowser('cr_b', 0.4, 2, NOW), { ok: false, spentUsd: 1.9 });
  assert.equal((raw.prepare(`SELECT cost_usd FROM crawl_runs WHERE id = 'cr_b'`).get() as any).cost_usd, 0);
  // A retried step re-reserves its own run without counting itself twice.
  assert.equal((await store.reserveBrowser('cr_a', 0.4, 2, NOW)).ok, true);
  assert.equal(e2bDailyCap({}), DEFAULT_E2B_DAILY_CAP_USD);
  assert.equal(DEFAULT_E2B_DAILY_CAP_USD, 2);
  assert.equal(e2bDailyCap({ E2B_DAILY_CAP_USD: '5' }), 5);
  assert.equal(e2bDailyCap({ E2B_DAILY_CAP_USD: 'nope' }), 2);
});
