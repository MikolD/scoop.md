// scripts/crawl-seeds.mjs: argument parsing, the seed file, and crawlAll's
// concurrency, per-site exclusion and 409 retries against a mocked API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawlAll, DEFAULT_SEEDS, loadSeeds, parseArgs, selectJobs, summary, table, UsageError } from '../scripts/crawl-seeds.mjs';
import type { Job } from '../scripts/crawl-seeds.mjs';
import { listVerdict } from '../src/crawl/gate.ts';

const TOKENS = { STAGING_ADMIN_TOKEN: 'stg-secret', PRODUCTION_ADMIN_TOKEN: 'prod-secret' };

test('crawl-seeds: argument parsing', () => {
  const o = parseArgs(['--env', 'staging', '--only', 'React.dev,www.nodejs.org', '--max-pages=50', '--concurrency', '2', '--out', 'r.json', '--force'], TOKENS);
  assert.equal(o.api, 'https://api-staging.scoop.md');
  assert.equal(o.token, 'stg-secret');
  assert.deepEqual(o.only, ['react.dev', 'nodejs.org']);
  assert.equal(o.maxPages, 50);
  assert.equal(o.concurrency, 2);
  assert.equal(o.out, 'r.json');
  assert.equal(o.force, true);
  assert.equal(o.dryRun, false);

  const p = parseArgs(['--env', 'production', 'https://docs.example.com/guide/'], TOKENS);
  assert.equal(p.api, 'https://api.scoop.md');
  assert.equal(p.token, 'prod-secret');
  assert.deepEqual(p.urls, ['https://docs.example.com/guide/']);
  assert.equal(parseArgs(['--env', 'local', '--api', 'http://127.0.0.1:8797/', '--dry-run'], {}).api, 'http://127.0.0.1:8797');
  // The token is only sent over HTTPS, except to a local dev server.
  assert.throws(() => parseArgs(['--env', 'staging', '--api', 'http://api-staging.scoop.md'], TOKENS), /must be https/);
  assert.equal(parseArgs(['--env', 'staging', '--api', 'https://staging.example.dev/'], TOKENS).api, 'https://staging.example.dev');
  assert.throws(() => parseArgs(['--env', 'staging', '--api', 'nope'], TOKENS), /not a URL/);

  assert.throws(() => parseArgs([], TOKENS), /--env must be/);
  assert.throws(() => parseArgs(['--env', 'prod'], TOKENS), /--env must be/);
  assert.throws(() => parseArgs(['--env', 'staging'], {}), /STAGING_ADMIN_TOKEN is not set/);
  assert.throws(() => parseArgs(['--env', 'staging', '--concurrency', '0'], TOKENS), /positive integer/);
  assert.throws(() => parseArgs(['--env', 'staging', '--max-pages'], TOKENS), /needs a value/);
  assert.throws(() => parseArgs(['--env', 'staging', '--bogus'], TOKENS), UsageError);
  assert.throws(() => parseArgs(['--env', 'staging', 'not a url'], TOKENS), /not a URL/);
  // A dry run needs no token, and the token never appears in an error.
  assert.equal(parseArgs(['--env', 'staging', '--dry-run'], {}).token, null);
});

test('crawl-seeds: the seed file has about 100 docs sites, none on the denylist', () => {
  const seeds = loadSeeds(DEFAULT_SEEDS);
  assert.ok(seeds.length >= 90 && seeds.length <= 120, `${seeds.length} seeds`);
  for (const s of seeds) {
    const u = new URL(s.startUrl);
    assert.equal(u.protocol, 'https:', s.startUrl);
    assert.equal(s.site, u.hostname.replace(/^www\./, ''), s.startUrl);
    assert.equal(s.maxPages, 200);
    assert.notEqual(listVerdict(s.startUrl)?.decision, 'reject', s.startUrl);
  }
  assert.equal(new Set(seeds.map((s) => s.startUrl)).size, seeds.length);

  const jobs = selectJobs(seeds, { urls: [], only: ['react.dev', 'docs.stripe.com'], maxPages: 20 });
  assert.deepEqual(jobs.map((j) => [j.site, j.maxPages]), [['react.dev', 20], ['docs.stripe.com', 20]]);
  assert.throws(() => selectJobs(seeds, { urls: [], only: ['nope.example'], maxPages: null }), /not in the seed file/);
  assert.deepEqual(selectJobs(seeds, { urls: ['https://www.Example.com/docs'], only: null, maxPages: null }), [
    { name: 'example.com', site: 'example.com', startUrl: 'https://www.Example.com/docs', maxPages: 200 },
  ]);
});

// A fake admin API: each run is 'running' for `polls` status calls, then
// finishes with the given outcome. Sites in `busyOnce` answer 409 once.
function fakeApi({ polls = 2, busyOnce = [] as string[], outcome = (_site: string): string => 'complete' } = {}) {
  const runs = new Map<string, { site: string; left: number; status: string; forced: boolean }>();
  const posts: { site: string; force?: boolean; auth: string }[] = [];
  const busy = new Set(busyOnce);
  let active = 0;
  let maxActive = 0;
  const activeSites = new Set<string>();
  let overlap = false;
  let n = 0;
  const impl = async (url: string, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get('authorization') ?? '';
    if (init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posts.push({ site: body.site, force: body.force, auth });
      if (busy.delete(body.site)) return Response.json({ error: { code: 'conflict' } }, { status: 409 });
      if (activeSites.has(body.site)) overlap = true;
      activeSites.add(body.site);
      active++;
      maxActive = Math.max(maxActive, active);
      const runId = `cr_${String(++n).padStart(26, '0')}`;
      runs.set(runId, { site: body.site, left: polls, status: 'queued', forced: Boolean(body.force) });
      return Response.json({ runId, site: body.site, startUrl: body.startUrl, forced: Boolean(body.force) }, { status: 202 });
    }
    const runId = url.split('/').pop()!;
    const r = runs.get(runId)!;
    if (--r.left <= 0 && r.status !== 'done') {
      r.status = 'done';
      active--;
      activeSites.delete(r.site);
    }
    const status = r.status === 'done' ? outcome(r.site) : 'running';
    const rejected = status === 'rejected';
    return Response.json({
      run: {
        id: runId, status, path: rejected ? null : 'markdown', pagesNew: rejected ? 0 : 3, pagesChanged: 0, pagesUnchanged: 1, pagesFailed: 0, pagesSkipped: 2,
        costUsd: 0, error: rejected ? 'not developer docs: Shopify store' : null, finishedAt: null, forced: r.forced,
        gate: { decision: rejected ? 'reject' : 'crawl', category: rejected ? 'ecommerce' : 'devtool-docs', method: 'signals', reason: rejected ? 'not developer docs: Shopify store' : 'developer docs', costUsd: 0.0002 },
      },
      workflow: { status: 'running', error: null },
    });
  };
  return { impl, posts, stats: () => ({ maxActive, overlap }) };
}

const jobsFor = (sites: string[]): Job[] => sites.map((site) => ({ name: site, site, startUrl: `https://${site}/`, maxPages: 10 }));
const noSleep = async () => {};

test('crawlAll: at most `concurrency` crawls in flight, every run followed to the end', async () => {
  const api = fakeApi({ polls: 3, outcome: (s) => (s === 'shop.example' ? 'rejected' : 'complete') });
  const sites = ['a.dev', 'b.dev', 'c.dev', 'd.dev', 'e.dev', 'f.dev', 'g.dev', 'shop.example'];
  const updates: number[] = [];
  const { results, maxInFlight } = await crawlAll(jobsFor(sites), {
    api: 'https://api.test', token: 'tok', fetchImpl: api.impl, concurrency: 3, pollMs: 1, sleep: noSleep, onUpdate: (r) => updates.push(r.length),
  });
  assert.equal(maxInFlight, 3);
  assert.equal(api.stats().maxActive, 3);
  assert.equal(api.posts.length, sites.length);
  assert.ok(api.posts.every((p) => p.auth === 'Bearer tok' && p.force === undefined));
  assert.deepEqual(results.map((r) => r.status), ['complete', 'complete', 'complete', 'complete', 'complete', 'complete', 'complete', 'rejected']);
  const shop = results.at(-1)!;
  assert.equal(shop.gate?.category, 'ecommerce');
  assert.equal(shop.pages.new, 0);
  assert.equal(results[0].pages.new, 3);
  assert.equal(results[0].costUsd, 0.0002);
  assert.ok(updates.length > 0);
  assert.match(table(results), /shop\.example\s+rejected/);
  assert.match(summary(results), /8 sites: 7 complete, 1 rejected/);
  assert.match(summary(results), /pages: 21 new/);
});

test('crawlAll: a 409 is retried later; two seeds of the same site never run at once; force is sent', async () => {
  const api = fakeApi({ polls: 2, busyOnce: ['busy.dev'] });
  let clock = 0;
  const jobs = [...jobsFor(['busy.dev', 'cf.dev']), { name: 'cf.dev d1', site: 'cf.dev', startUrl: 'https://cf.dev/d1/', maxPages: 10 }];
  const { results } = await crawlAll(jobs, {
    api: 'https://api.test', token: 'tok', fetchImpl: api.impl, concurrency: 4, pollMs: 1, retryMs: 5000, force: true,
    sleep: async (ms) => { clock += ms; }, now: () => clock,
  });
  assert.deepEqual(results.map((r) => r.status), ['complete', 'complete', 'complete']);
  assert.equal(results[0].attempts, 2);
  assert.equal(api.posts.filter((p) => p.site === 'busy.dev').length, 2);
  assert.equal(api.stats().overlap, false);
  assert.ok(api.posts.every((p) => p.force === true));
  assert.ok(results.every((r) => r.forced));
});

test('crawlAll: a site that stays busy gives up; an API error is reported, not thrown', async () => {
  const api = fakeApi({ busyOnce: ['busy.dev'] });
  const { results } = await crawlAll(jobsFor(['busy.dev']), { api: 'https://api.test', token: 'tok', fetchImpl: api.impl, maxAttempts: 1, sleep: noSleep });
  assert.equal(results[0].status, 'error');
  assert.match(results[0].error!, /409/);

  const down = async () => Response.json({ error: { message: 'Not found' } }, { status: 404 });
  const { results: r2 } = await crawlAll(jobsFor(['a.dev']), { api: 'https://api.test', token: 'tok', fetchImpl: down, sleep: noSleep });
  assert.equal(r2[0].status, 'error');
  assert.match(r2[0].error!, /answered 404/);
  assert.ok(!JSON.stringify(r2).includes('tok'));
});
