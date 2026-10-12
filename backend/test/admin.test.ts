// The admin console (src/admin/): Basic auth, lockout, security headers, the
// same-origin check, host routing, every JSON endpoint against node:sqlite,
// and batch scheduling. Workflows, the rate limiter and the static assets are
// stand-ins; `cloudflare:workers` is stubbed so the Worker entry imports in Node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Env } from '../src/env.ts';
import { handleAdmin } from '../src/admin/app.ts';
import { credentialsValid, isAdminHost, LOCKOUT_SECONDS, parseBasic, sameOrigin } from '../src/admin/auth.ts';
import { BUSY_RETRY_MS, cancelBatch, createBatch, getBatch, MAX_START_ATTEMPTS, tickBatch } from '../src/admin/batch.ts';
import type { JobRow } from '../src/admin/batch.ts';
import { SEEDS, skillPackage } from '../src/admin/api.ts';
import { Store } from '../src/db/store.ts';
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
const { buildPackage, withCurrentPage } = await import('../../extension/lib/package.js');

const USER = 'admin';
const PASS = 'correct horse battery staple';
const ORIGIN = 'https://admin.scoop.md';
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
const GOOD = basic(USER, PASS);

function setup(over: Partial<Env> = {}) {
  const { d1, raw } = fakeD1();
  const skills = fakeR2();
  const crawlR2 = fakeR2();
  const created: { id: string; params: unknown }[] = [];
  const batches: { id: string; params: unknown }[] = [];
  const terminated: string[] = [];
  const workflowStatus = new Map<string, string>();
  const attempts = new Map<string, number>();
  const env = {
    DB: d1,
    SKILLS: skills.r2,
    CRAWL: {
      ...crawlR2.r2,
      list: async ({ prefix }: { prefix: string }) => ({ objects: [...crawlR2.objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
      delete: async (keys: string | string[]) => { for (const k of [keys].flat()) crawlR2.objects.delete(k); },
    },
    ASSETS: {
      fetch: async (req: Request) =>
        new URL(req.url).pathname === '/'
          ? new Response('<!doctype html><title>scoop.md admin</title>', { headers: { 'content-type': 'text/html', etag: '"abc"', 'cache-control': 'public, max-age=3600' } })
          : new Response('not found', { status: 404 }),
    },
    CRAWL_SITE: {
      create: async (o: { id: string; params: unknown }) => { created.push(o); workflowStatus.set(o.id, 'running'); },
      get: async (id: string) => {
        if (!workflowStatus.has(id)) throw new Error('instance.not_found');
        return { status: async () => ({ status: workflowStatus.get(id) }), terminate: async () => { terminated.push(id); workflowStatus.set(id, 'terminated'); } };
      },
    },
    CRAWL_BATCH: { create: async (o: { id: string; params: unknown }) => { batches.push(o); } },
    ADMIN_AUTH_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        const n = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, n);
        return { success: n <= 10 };
      },
    },
    READ_LIMITER: { limit: async () => ({ success: true }) },
    RATE_KEY: 'test-rate-key',
    ADMIN_UI_USER: USER,
    ADMIN_UI_PASSCODE: PASS,
    ENVIRONMENT: 'production',
    ...over,
  } as unknown as Env;
  return { env, raw, d1, skills, crawlR2, created, batches, terminated, workflowStatus, attempts };
}

function req(path: string, init: RequestInit & { auth?: string | null; host?: string } = {}) {
  const { auth = GOOD, host = 'admin.scoop.md', ...rest } = init;
  const headers = new Headers(rest.headers);
  if (auth) headers.set('authorization', auth);
  return new Request(`https://${host}${path}`, { ...rest, headers });
}

const post = (path: string, body: unknown, headers: Record<string, string> = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }) =>
  req(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

async function call(env: Env, r: Request, ip = '203.0.113.7') {
  const res = await handleAdmin(r, env, new URL(r.url), ip);
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, headers: res.headers, body };
}

// ---- Auth --------------------------------------------------------------------

test('isAdminHost: admin and admin-staging hosts only', () => {
  assert.ok(isAdminHost('admin.scoop.md'));
  assert.ok(isAdminHost('admin-staging.scoop.md'));
  assert.ok(isAdminHost('admin.localhost'));
  assert.ok(!isAdminHost('api.scoop.md'));
  assert.ok(!isAdminHost('api-staging.scoop.md'));
  assert.ok(!isAdminHost('notadmin.scoop.md'));
  assert.ok(!isAdminHost('scoop.md'));
});

test('parseBasic: UTF-8, colons in the passcode, junk', () => {
  assert.deepEqual(parseBasic(basic('ädmin', 'a:b:c')), { user: 'ädmin', pass: 'a:b:c' });
  assert.equal(parseBasic('Bearer x'), null);
  assert.equal(parseBasic('Basic !!!'), null);
  assert.equal(parseBasic(`Basic ${btoa('nocolon')}`), null);
  assert.equal(parseBasic(null), null);
});

test('Basic auth: missing gets the prompt, wrong is refused, right gets in', async () => {
  const { env } = setup();
  const missing = await call(env, req('/', { auth: null }));
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('www-authenticate'), 'Basic realm="scoop.md admin", charset="UTF-8"');
  assert.doesNotMatch(String(missing.body), /scoop\.md admin<\/title>/);

  const wrong = await call(env, req('/', { auth: basic(USER, 'nope') }));
  assert.equal(wrong.status, 401);
  assert.ok(wrong.headers.get('www-authenticate'));
  assert.equal((await call(env, req('/', { auth: basic('root', PASS) }))).status, 401);

  const right = await call(env, req('/'));
  assert.equal(right.status, 200);
  assert.match(String(right.body), /scoop\.md admin/);
  // Static files and the API are both behind it.
  assert.equal((await call(env, req('/api/overview', { auth: null }))).status, 401);
  assert.equal((await call(env, req('/api/overview'))).status, 200);
});

test('Basic auth fails closed when a secret is unset', async () => {
  for (const over of [{ ADMIN_UI_USER: undefined }, { ADMIN_UI_PASSCODE: undefined }, { ADMIN_UI_USER: '', ADMIN_UI_PASSCODE: '' }, { RATE_KEY: undefined }]) {
    const { env } = setup(over as Partial<Env>);
    assert.equal((await call(env, req('/api/overview'))).status, 401, JSON.stringify(over));
    assert.equal((await call(env, req('/api/overview', { auth: basic('', '') }))).status, 401, JSON.stringify(over));
    assert.equal((await call(env, req('/api/overview', { auth: basic('admin', '') }))).status, 401, JSON.stringify(over));
  }
  assert.equal(await credentialsValid(basic('', ''), {}), false);
});

test('failed attempts: 10 per minute per IP, then 429 and a lockout the right passcode cannot skip', async () => {
  const { env, raw, attempts } = setup();
  for (let i = 0; i < 10; i++) assert.equal((await call(env, req('/', { auth: basic(USER, `guess${i}`) }))).status, 401);
  const over = await call(env, req('/', { auth: basic(USER, 'guess10') }));
  assert.equal(over.status, 429);
  assert.equal(over.headers.get('retry-after'), String(LOCKOUT_SECONDS));
  assert.equal(over.headers.get('x-frame-options'), 'DENY');
  // Locked out: even the right passcode gets 429, without touching the limiter.
  const before = [...attempts.values()][0];
  assert.equal((await call(env, req('/'))).status, 429);
  assert.equal([...attempts.values()][0], before);
  // Another IP is unaffected; the lockout key is an HMAC, never the IP.
  assert.equal((await call(env, req('/'), '198.51.100.1')).status, 200);
  const keys = raw.prepare('SELECT key FROM admin_auth_lockouts').all() as { key: string }[];
  assert.equal(keys.length, 1);
  assert.match(keys[0].key, /^[0-9a-f]{64}$/);
  // Bare requests (the browser's first, before the prompt) don't count.
  const { env: env2, attempts: a2 } = setup();
  for (let i = 0; i < 20; i++) assert.equal((await call(env2, req('/', { auth: null }))).status, 401);
  assert.equal(a2.size, 0);
  // Once the lockout has passed, the right passcode works again.
  raw.prepare(`UPDATE admin_auth_lockouts SET until = '2000-01-01T00:00:00.000Z'`).run();
  assert.equal((await call(env, req('/'))).status, 200);
});

// ---- Headers, CSRF, routing --------------------------------------------------

test('security headers and no-store on every admin response', async () => {
  const { env } = setup();
  const cases = [
    await call(env, req('/', { auth: null })),
    await call(env, req('/')),
    await call(env, req('/nope.js')),
    await call(env, req('/api/overview')),
    await call(env, req('/api/nope')),
    await call(env, post('/api/crawl', {}, {})),
  ];
  for (const r of cases) {
    const csp = r.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('x-robots-tag') ?? '', /noindex/);
    assert.equal(r.headers.get('etag'), null);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  }
});

test('CSRF: state-changing requests must be same-origin', async () => {
  const { env, created } = setup();
  const body = { url: 'https://docs.stripe.com/', maxPages: 5 };
  assert.equal((await call(env, post('/api/crawl', body, {}))).status, 403);
  assert.equal((await call(env, post('/api/crawl', body, { 'sec-fetch-site': 'cross-site', origin: ORIGIN }))).status, 403);
  assert.equal((await call(env, post('/api/crawl', body, { 'sec-fetch-site': 'same-site' }))).status, 403);
  assert.equal((await call(env, post('/api/crawl', body, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await call(env, req('/api/skills/sk_x', { method: 'DELETE', headers: { origin: 'https://evil.example' } }))).status, 403);
  assert.equal(created.length, 0);
  // Origin alone (no Sec-Fetch-Site) is enough when it matches.
  assert.equal((await call(env, post('/api/crawl', body, { origin: ORIGIN }))).status, 202);
  assert.ok(sameOrigin(new Request(`${ORIGIN}/api/x`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }), new URL(`${ORIGIN}/api/x`)));
});

test('admin host routing leaves api.* untouched', async () => {
  const { env } = setup();
  const fetch = (r: Request) => worker.fetch(r, env);
  // api.scoop.md: the v1 API, CORS, no Basic auth, no console.
  const health = await fetch(new Request('https://api.scoop.md/v1/health', { headers: { origin: 'https://example.com' } }));
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), '*');
  assert.equal(health.headers.get('www-authenticate'), null);
  assert.equal((await fetch(new Request('https://api.scoop.md/api/overview', { headers: { authorization: GOOD } }))).status, 404);
  assert.equal((await fetch(new Request('https://api.scoop.md/', { headers: { authorization: GOOD } }))).status, 404);
  // admin.scoop.md: everything behind Basic auth, and no v1 API there.
  assert.equal((await fetch(new Request('https://admin.scoop.md/v1/health'))).status, 401);
  const v1 = await fetch(new Request('https://admin.scoop.md/v1/health', { headers: { authorization: GOOD } }));
  assert.equal(v1.status, 404);
  assert.equal(v1.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(new Request('https://admin-staging.scoop.md/api/overview', { headers: { authorization: GOOD } }))).status, 200);
});

// ---- Endpoints ---------------------------------------------------------------

const NOW = new Date();
const iso = (msAgo = 0) => new Date(NOW.getTime() - msAgo).toISOString();
const DAY = NOW.toISOString().slice(0, 10);
const HASH = 'a'.repeat(64);
const MD = '# Webhooks\n\nVerify the signature header before trusting the payload.\n';

// Two sites, three runs, one indexed page with chunks and topics, AI spend.
function seed(raw: ReturnType<typeof fakeD1>['raw'], objects: Map<string, string>) {
  const run = (id: string, site: string, status: string, extra = '') =>
    raw.prepare(`INSERT INTO crawl_runs (id, site, start_url, started_at, status, path, pages_new, browser_seconds, cost_usd, gate_decision, gate_method, gate_cost_usd${extra ? ', error' : ''})
      VALUES (?, ?, ?, ?, ?, 'markdown', 1, 12, 0.0005, ?, 'allowlist', 0.001${extra ? ', ?' : ''})`)
      .run(...[id, site, `https://${site}/`, iso(60_000), status, status === 'rejected' ? 'reject' : 'crawl', ...(extra ? [extra] : [])]);
  run('cr_01AAAAAAAAAAAAAAAAAAAAAAAA', 'docs.stripe.com', 'complete');
  run('cr_01BBBBBBBBBBBBBBBBBBBBBBBB', 'amazon.com', 'rejected', 'known ecommerce site');
  run('cr_01CCCCCCCCCCCCCCCCCCCCCCCC', 'docs.stripe.com', 'running');
  raw.prepare(`INSERT INTO site_profiles (site, status, crawl_state, last_run_id, updated_at, pages_fetched) VALUES ('docs.stripe.com', 'ready', 'crawling', 'cr_01CCCCCCCCCCCCCCCCCCCCCCCC', ?, 2)`).run(iso());
  raw.prepare(`INSERT INTO site_profiles (site, status, gate_category, gate_method, gate_reason, last_run_id, updated_at) VALUES ('amazon.com', 'not_devtool', 'ecommerce', 'denylist', 'known ecommerce site', 'cr_01BBBBBBBBBBBBBBBBBBBBBBBB', ?)`).run(iso(1000));
  const page = (url: string, hash: string, pending: number) =>
    raw.prepare(`INSERT INTO pages (url, site, source_url, source_kind, title, content_hash, bytes, fetched_at, changed_at, run_id, index_pending)
      VALUES (?, 'docs.stripe.com', ?, 'page-md', 'Webhooks', ?, 64, ?, ?, 'cr_01AAAAAAAAAAAAAAAAAAAAAAAA', ?)`).run(url, `${url}.md`, hash, iso(), iso(), pending);
  page('https://docs.stripe.com/webhooks', HASH, 0);
  page('https://docs.stripe.com/payments', 'b'.repeat(64), 1);
  objects.set(`pages/${HASH}.md`, MD);
  raw.prepare(`INSERT INTO page_index (url, site, content_hash, title, slot, topic, topic_path, summary, tasks, entities, model, cost_usd, indexed_at)
    VALUES ('https://docs.stripe.com/webhooks', 'docs.stripe.com', ?, 'Webhooks', 'guide', 'webhooks/signatures', '["webhooks","signatures"]', 'Verifying webhook signatures',
      '["verify a webhook"]', '[{"kind":"header","name":"Stripe-Signature"}]', 'none', 0.0002, ?)`).run(HASH, iso());
  raw.prepare(`INSERT INTO chunks (id, url, site, ord, heading_path, title, text) VALUES ('c1', 'https://docs.stripe.com/webhooks', 'docs.stripe.com', 0, 'Webhooks', 'Webhooks', 'Verify the signature header before trusting the payload.')`).run();
  raw.prepare(`INSERT INTO topics (site, path, count) VALUES ('docs.stripe.com', 'webhooks', 1), ('docs.stripe.com', 'webhooks/signatures', 1)`).run();
  raw.prepare(`INSERT INTO index_costs (site, day, cost_usd) VALUES ('docs.stripe.com', ?, 0.5), ('*', ?, 0.75)`).run(DAY, DAY);
}

const skill = (content: string) => ({
  site: 'docs.stripe.com',
  pageUrl: 'https://docs.stripe.com/webhooks',
  title: 'Webhooks',
  sections: [
    { kind: 'page-md' as const, label: 'This page: Webhooks', url: 'https://docs.stripe.com/webhooks.md', content, bytes: null },
    { kind: 'llms' as const, label: 'Site documentation index (llms.txt)', url: 'https://docs.stripe.com/llms.txt', content: '# Stripe\n- [Webhooks](/webhooks.md)', bytes: null },
  ],
  relatedLinks: [{ url: 'https://docs.stripe.com/webhooks/test', text: 'Test webhooks' }],
});

test('overview: sites by status, content, backlog, runs, spend vs caps, E2B', async () => {
  const { env, raw, skills } = setup({ INDEX_DAILY_CAP_USD: '3', INDEX_DAILY_TOTAL_CAP_USD: '20' } as Partial<Env>);
  seed(raw, skills.objects);
  const { status, body: o } = await call(env, req('/api/overview'));
  assert.equal(status, 200);
  assert.deepEqual(o.sites, { total: 2, byStatus: { ready: 1, not_devtool: 1 }, crawling: 1 });
  assert.equal(o.pages, 2);
  assert.equal(o.indexed, 1);
  assert.equal(o.chunks, 1);
  assert.deepEqual(o.backlog, { indexPending: 1, awaitingIndex: 1, unclassified: 1, classifyFailed: 0 });
  assert.deepEqual(o.runs, { complete: 1, rejected: 1, running: 1 });
  assert.equal(o.aiSpend.totalUsd, 0.75);
  assert.equal(o.aiSpend.totalCapUsd, 20);
  assert.equal(o.aiSpend.siteCapUsd, 3);
  assert.deepEqual(o.aiSpend.bySite, [{ site: 'docs.stripe.com', costUsd: 0.5 }]);
  assert.equal(o.e2b.seconds, 36);
  assert.ok(Math.abs(o.e2b.costUsd - 0.0015) < 1e-9);
  assert.ok(Math.abs(o.gateCostUsd - 0.003) < 1e-9);
});

test('runs: paged list with filters, detail, cancel', async () => {
  const { env, raw, skills, crawlR2, terminated, workflowStatus } = setup();
  seed(raw, skills.objects);
  const all = (await call(env, req('/api/runs'))).body;
  assert.equal(all.runs.length, 3);
  assert.equal(all.next, null);
  assert.deepEqual((await call(env, req('/api/runs?status=rejected'))).body.runs.map((r: any) => r.site), ['amazon.com']);
  assert.deepEqual((await call(env, req('/api/runs?status=active'))).body.runs.map((r: any) => r.id), ['cr_01CCCCCCCCCCCCCCCCCCCCCCCC']);
  assert.equal((await call(env, req('/api/runs?site=docs.stripe.com'))).body.runs.length, 2);
  const rejected = all.runs.find((r: any) => r.site === 'amazon.com');
  assert.deepEqual(rejected.gate, { decision: 'reject', category: null, method: 'allowlist', reason: null, costUsd: 0.001 });
  assert.equal(rejected.error, 'known ecommerce site');

  const detail = (await call(env, req('/api/runs/cr_01AAAAAAAAAAAAAAAAAAAAAAAA'))).body;
  assert.equal(detail.run.status, 'complete');
  assert.equal(detail.workflow, null);
  assert.equal(detail.pages.length, 2);
  assert.equal((await call(env, req('/api/runs/cr_01ZZZZZZZZZZZZZZZZZZZZZZZZ'))).status, 404);

  // Cancel: terminate the Workflow, mark the run failed, keep the site's outcome, clear working files.
  workflowStatus.set('cr_01CCCCCCCCCCCCCCCCCCCCCCCC', 'running');
  crawlR2.objects.set('crawl-results/cr_01CCCCCCCCCCCCCCCCCCCCCCCC/plan.json', '[]');
  const c = await call(env, post('/api/runs/cr_01CCCCCCCCCCCCCCCCCCCCCCCC/cancel', {}));
  assert.equal(c.status, 200);
  assert.deepEqual(c.body, { terminated: true, sandboxes: 0, marked: true, notes: [] });
  assert.deepEqual(terminated, ['cr_01CCCCCCCCCCCCCCCCCCCCCCCC']);
  const run = raw.prepare(`SELECT status, error, finished_at FROM crawl_runs WHERE id = 'cr_01CCCCCCCCCCCCCCCCCCCCCCCC'`).get() as any;
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'cancelled by an admin');
  assert.ok(run.finished_at);
  assert.deepEqual({ ...(raw.prepare(`SELECT status, crawl_state FROM site_profiles WHERE site = 'docs.stripe.com'`).get() as object) }, { status: 'ready', crawl_state: 'idle' });
  assert.equal(crawlR2.objects.size, 0);
  // A finished run: nothing to terminate or mark.
  const again = await call(env, post('/api/runs/cr_01AAAAAAAAAAAAAAAAAAAAAAAA/cancel', {}));
  assert.equal(again.body.marked, false);
  assert.equal(again.body.terminated, false);
});

test('cancel kills the run\'s tagged E2B sandboxes', async () => {
  const { env, raw, skills } = setup({ E2B_API_KEY: 'e2b-test' } as Partial<Env>);
  seed(raw, skills.objects);
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/v2/sandboxes?')) return Response.json([{ sandboxID: 'sb1', metadata: { runId: 'cr_01CCCCCCCCCCCCCCCCCCCCCCCC' } }, { sandboxID: 'sb2', metadata: { runId: 'other' } }]);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    const c = await call(env, post('/api/runs/cr_01CCCCCCCCCCCCCCCCCCCCCCCC/cancel', {}));
    assert.equal(c.body.sandboxes, 1);
    assert.ok(calls.some((x) => x.startsWith('GET https://api.e2b.app/v2/sandboxes?') && x.includes('runId%3Dcr_01CCCCCCCCCCCCCCCCCCCCCCCC')));
    assert.ok(calls.includes('DELETE https://api.e2b.app/sandboxes/sb1'));
    assert.ok(!calls.some((x) => x.includes('sb2')));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('start crawl: one URL with maxPages and force; 409 while one runs; bad input', async () => {
  const { env, created } = setup();
  const r = await call(env, post('/api/crawl', { url: 'https://docs.stripe.com/webhooks', maxPages: 7, force: true }));
  assert.equal(r.status, 202);
  assert.equal(r.body.site, 'docs.stripe.com');
  assert.equal(r.body.maxPages, 7);
  assert.equal(r.body.forced, true);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].params, { runId: r.body.runId, site: 'docs.stripe.com', startUrl: 'https://docs.stripe.com/webhooks', maxPages: 7, maxMinutes: 10, force: true });
  assert.equal((await call(env, post('/api/crawl', { url: 'https://docs.stripe.com/' }))).status, 409);
  assert.equal((await call(env, post('/api/crawl', {}))).status, 400);
  assert.equal((await call(env, post('/api/crawl', { url: 'not a url' }))).status, 400);
  assert.equal((await call(env, post('/api/crawl', { url: 'https://example.com/', maxPages: 5000 }))).status, 400);
  assert.equal((await call(env, post('/api/crawl', { url: 'http://127.0.0.1/' }))).status, 400);
  assert.equal((await call(env, req('/api/crawl'))).status, 405);
});

test('seeds: the seed list with each site\'s profile status', async () => {
  const { env, raw, skills } = setup();
  seed(raw, skills.objects);
  const { body } = await call(env, req('/api/seeds'));
  assert.equal(body.seeds.length, SEEDS.length);
  const node = body.seeds.find((s: any) => s.site === 'nodejs.org');
  assert.equal(node.status, null);
  assert.equal(node.maxPages, 200);
  raw.prepare(`INSERT INTO site_profiles (site, status, updated_at, pages_fetched) VALUES ('nodejs.org', 'ready', ?, 42)`).run(iso());
  const again = (await call(env, req('/api/seeds'))).body.seeds.find((s: any) => s.site === 'nodejs.org');
  assert.equal(again.status, 'ready');
  assert.equal(again.pagesFetched, 42);
});

test('sites: list with filters, detail with topics and history, pages with labels', async () => {
  const { env, raw, skills } = setup();
  seed(raw, skills.objects);
  const list = (await call(env, req('/api/sites'))).body;
  assert.deepEqual(list.sites.map((s: any) => s.site), ['docs.stripe.com', 'amazon.com']);
  const stripe = list.sites[0];
  assert.equal(stripe.pages, 2);
  assert.equal(stripe.indexed, 1);
  assert.equal(stripe.crawling, true);
  assert.equal(stripe.lastRun.status, 'running');
  assert.deepEqual((await call(env, req('/api/sites?status=not_devtool'))).body.sites.map((s: any) => s.site), ['amazon.com']);
  assert.deepEqual((await call(env, req('/api/sites?status=crawling'))).body.sites.map((s: any) => s.site), ['docs.stripe.com']);
  assert.deepEqual((await call(env, req('/api/sites?q=AMAZ'))).body.sites.map((s: any) => s.site), ['amazon.com']);
  assert.deepEqual((await call(env, req('/api/sites?q=%25'))).body.sites, []);

  const d = (await call(env, req('/api/sites/docs.stripe.com'))).body;
  assert.equal(d.profile.status, 'ready');
  assert.equal(d.counts.pages, 2);
  assert.equal(d.counts.indexPending, 1);
  assert.equal(d.topics[0].path, 'webhooks');
  assert.equal(d.topics[0].children[0].path, 'webhooks/signatures');
  assert.equal(d.runs.length, 2);
  const amazon = (await call(env, req('/api/sites/amazon.com'))).body;
  assert.equal(amazon.profile.status, 'not_devtool');
  assert.equal(amazon.profile.gate.category, 'ecommerce');
  assert.equal((await call(env, req('/api/sites/unknown.example'))).status, 404);

  const pages = (await call(env, req('/api/sites/docs.stripe.com/pages'))).body.pages;
  assert.equal(pages.length, 2);
  const hook = pages.find((p: any) => p.url.endsWith('/webhooks'));
  assert.deepEqual([hook.slot, hook.topic, hook.model, hook.current, hook.indexed], ['guide', 'webhooks/signatures', 'none', true, true]);
  const pay = pages.find((p: any) => p.url.endsWith('/payments'));
  assert.deepEqual([pay.indexed, pay.indexPending], [false, true]);
  const under = (await call(env, req('/api/sites/docs.stripe.com/pages?topic=webhooks'))).body.pages;
  assert.deepEqual(under.map((p: any) => p.url), ['https://docs.stripe.com/webhooks']);
  assert.equal((await call(env, req('/api/sites/docs.stripe.com/pages?topic=..%2F%3B'))).status, 400);
});

test('page detail: stored Markdown from R2, AI labels, chunks', async () => {
  const { env, raw, skills } = setup();
  seed(raw, skills.objects);
  const d = (await call(env, req(`/api/page?url=${encodeURIComponent('https://docs.stripe.com/webhooks')}`))).body;
  assert.equal(d.markdown, MD);
  assert.equal(d.markdownKey, `pages/${HASH}.md`);
  assert.deepEqual(d.labels.topicPath, ['webhooks', 'signatures']);
  assert.deepEqual(d.labels.tasks, ['verify a webhook']);
  assert.deepEqual(d.labels.entities, [{ kind: 'header', name: 'Stripe-Signature' }]);
  assert.equal(d.labels.current, true);
  assert.equal(d.chunks.length, 1);
  const missing = (await call(env, req(`/api/page?url=${encodeURIComponent('https://docs.stripe.com/payments')}`))).body;
  assert.equal(missing.markdown, null);
  assert.equal(missing.labels, null);
  assert.equal((await call(env, req('/api/page?url=https%3A%2F%2Fnope.example%2F'))).status, 404);
});

test('agent view: search and package preview, same as /v1/search and /v1/packages', async () => {
  const { env, raw, skills } = setup();
  seed(raw, skills.objects);
  const s = (await call(env, req('/api/search?site=docs.stripe.com&q=signature'))).body;
  assert.equal(s.hits.length, 1);
  assert.equal(s.hits[0].url, 'https://docs.stripe.com/webhooks');
  assert.match(s.hits[0].text, /signature header/);
  assert.equal((await call(env, req('/api/search?site=docs.stripe.com'))).status, 400);

  const viaV1 = await worker.fetch(new Request('https://api.scoop.md/v1/packages?site=docs.stripe.com&topic=webhooks'), env);
  const p = (await call(env, req('/api/package?site=docs.stripe.com&topic=webhooks'))).body;
  assert.equal(viaV1.status, 200);
  // Same builder, same input; only the date line could differ across midnight.
  assert.equal(p.markdown, await viaV1.text());
  assert.match(p.markdown, /signature header/);
  const byQuery = (await call(env, req('/api/package?site=docs.stripe.com&q=signature'))).body;
  assert.match(byQuery.markdown, /signature header/);
  assert.equal((await call(env, req('/api/package?site=docs.stripe.com&topic=nothing'))).status, 404);
  assert.equal((await call(env, req('/api/package?site=docs.stripe.com'))).status, 400);
});

test('shared library: sites, best and recent skills, the extension\'s exact package, reports, takedown', async () => {
  const { env, d1, skills } = setup();
  const store = new Store(d1, skills.r2);
  const { id } = await store.add(skill(MD), 'install-1');
  const { id: id2 } = await store.add(skill(`${MD}\nMore.`), 'install-2');
  await store.vote(id, 'install-3', true);
  await store.report({ skillId: id2, reason: 'wrong', details: 'outdated' }, 'install-4');

  const lib = (await call(env, req('/api/library'))).body;
  assert.equal(lib.sites.length, 1);
  assert.equal(lib.sites[0].site, 'docs.stripe.com');
  assert.equal(lib.sites[0].live, 2);
  assert.equal(lib.sites[0].best.id, id);
  assert.equal(lib.reports.length, 1);
  assert.equal(lib.reports[0].skillId, id2);

  const site = (await call(env, req('/api/library/docs.stripe.com'))).body;
  assert.equal(site.best.id, id);
  assert.equal(site.best.worked, 1);
  assert.deepEqual(site.recent.map((s: any) => s.id).sort(), [id, id2].sort());
  assert.equal(site.recent[0].sources.length, 2);

  // The package is extension/lib/package.js's output for the stored skill.
  const d = (await call(env, req(`/api/skills/${id}`))).body;
  const stored = (await store.load((await store.getRow(id))!))!;
  const expected = buildPackage({ site: stored.site, pageUrl: stored.pageUrl, sections: withCurrentPage(stored.sections, null, stored.pageUrl), relatedLinks: stored.relatedLinks });
  assert.equal(d.package, expected);
  assert.equal(skillPackage(stored, new Date('2026-01-02T00:00:00Z')), buildPackage({ ...stored, sections: stored.sections, now: new Date('2026-01-02T00:00:00Z') }));
  assert.match(d.package, /^# docs\.stripe\.com documentation \(via scoop\.md\)/);
  assert.match(d.package, /Related pages on this site/);
  assert.equal(d.skill.sections.length, 2);
  assert.deepEqual((await call(env, req(`/api/skills/${id2}`))).body.reports.map((r: any) => r.reason), ['wrong']);

  // Takedown: content gone, row kept, shown as removed.
  assert.equal((await call(env, req(`/api/skills/${id2}`, { method: 'DELETE', headers: { origin: ORIGIN } }))).status, 200);
  const gone = (await call(env, req(`/api/skills/${id2}`))).body;
  assert.ok(gone.skill.removedAt);
  assert.equal(gone.package, null);
  assert.ok(!skills.objects.has(`skills/${id2}.json`));
  assert.deepEqual((await call(env, req('/api/library/docs.stripe.com'))).body.removed.map((s: any) => s.id), [id2]);
  assert.equal((await call(env, req('/api/skills/sk_nope', { method: 'DELETE', headers: { origin: ORIGIN } }))).status, 404);
  assert.equal((await call(env, req('/api/reports'))).body.reports.length, 1);
});

test('costs: 14 days of AI, gate and E2B spend by day and site', async () => {
  const { env, raw, skills } = setup();
  seed(raw, skills.objects);
  raw.prepare(`INSERT INTO index_costs (site, day, cost_usd) VALUES ('docs.stripe.com', '2000-01-01', 9)`).run();
  const d = (await call(env, req('/api/costs'))).body;
  assert.equal(d.days.length, 14);
  assert.equal(d.days[0].day, DAY);
  assert.equal(d.days[0].aiUsd, 0.75);
  assert.deepEqual(d.days[0].sites, [{ site: 'docs.stripe.com', costUsd: 0.5 }]);
  assert.equal(d.days[0].runs, 3);
  assert.equal(d.days[0].browserSeconds, 36);
  assert.equal(d.days.reduce((n: number, x: any) => n + x.aiUsd, 0), 0.75);
  assert.equal(d.siteCapUsd, 2);
  assert.equal(d.totalCapUsd, 10);
  // Cost per crawl: the finished runs and their averages (the running one is left out).
  assert.deepEqual(d.crawls.runs.map((r: any) => r.id).sort(), ['cr_01AAAAAAAAAAAAAAAAAAAAAAAA', 'cr_01BBBBBBBBBBBBBBBBBBBBBBBB']);
  assert.equal(d.crawls.averages.overall.runs, 2);
  const run = (await call(env, req('/api/runs/cr_01AAAAAAAAAAAAAAAAAAAAAAAA'))).body.run;
  assert.deepEqual(Object.keys(run.costs).sort(), ['browserUsd', 'classifyUsd', 'embedUsd', 'gateUsd', 'indexingDone', 'pagesIndexed', 'pagesStored', 'perPageUsd', 'totalUsd', 'tracked']);
  assert.ok(Math.abs(run.costs.totalUsd - 0.0015) < 1e-9);
});

// ---- Batches -----------------------------------------------------------------

const jobs = (...sites: string[]) => sites.map((site, i) => ({ name: `${site}#${i}`, site, startUrl: `https://${site}/${i}`, maxPages: 5 }));

// A start function that records calls and inserts the run row like startCrawl would.
function starter(raw: ReturnType<typeof fakeD1>['raw'], busy = new Set<string>()) {
  const started: { site: string; runId: string; force: boolean }[] = [];
  const start = async (j: JobRow, runId: string, force: boolean) => {
    if (busy.has(j.site)) return null;
    raw.prepare(`INSERT INTO crawl_runs (id, site, start_url, started_at, status) VALUES (?, ?, ?, ?, 'queued')`).run(runId, j.site, j.start_url, new Date().toISOString());
    started.push({ site: j.site, runId, force });
    return runId;
  };
  return { start, started };
}

const finish = (raw: ReturnType<typeof fakeD1>['raw'], runId: string, status = 'complete') =>
  raw.prepare(`UPDATE crawl_runs SET status = ?, finished_at = ? WHERE id = ?`).run(status, new Date().toISOString(), runId);

test('batch: starts up to the concurrency, never two of one site, follows runs to the end', async () => {
  const { d1, raw } = fakeD1();
  await createBatch(d1, { id: 'cb_1', concurrency: 2, maxPages: null, force: true, jobs: jobs('a.dev', 'a.dev', 'b.dev', 'c.dev') });
  const { start, started } = starter(raw);
  const deps = { db: d1, start };

  let t = await tickBatch(deps, 'cb_1');
  assert.deepEqual(started.map((s) => s.site), ['a.dev', 'b.dev']); // the second a.dev waits for the first
  assert.ok(started.every((s) => s.force));
  assert.deepEqual([t.done, t.started, t.active], [false, 2, 2]);
  t = await tickBatch(deps, 'cb_1');
  assert.equal(t.started, 0); // full

  finish(raw, started[0].runId, 'rejected');
  t = await tickBatch(deps, 'cb_1');
  assert.deepEqual(started.map((s) => s.site), ['a.dev', 'b.dev', 'a.dev']);
  finish(raw, started[1].runId, 'failed');
  finish(raw, started[2].runId);
  t = await tickBatch(deps, 'cb_1');
  assert.deepEqual(started.map((s) => s.site), ['a.dev', 'b.dev', 'a.dev', 'c.dev']);
  finish(raw, started[3].runId);
  t = await tickBatch(deps, 'cb_1');
  assert.equal(t.done, true);
  const b = (await getBatch(d1, 'cb_1'))!;
  assert.equal(b.batch.status, 'complete');
  assert.ok(b.batch.finished_at);
  assert.deepEqual(b.jobs.map((j) => j.status), ['rejected', 'complete', 'failed', 'complete']);
  assert.deepEqual(b.jobs.map((j) => j.run_status), ['rejected', 'complete', 'failed', 'complete']);
  assert.equal((await tickBatch(deps, 'cb_1')).done, true);
});

test('batch: a busy site (409) waits and is retried, and gives up after MAX_START_ATTEMPTS', async () => {
  const { d1, raw } = fakeD1();
  await createBatch(d1, { id: 'cb_2', concurrency: 4, maxPages: 5, force: false, jobs: jobs('busy.dev', 'ok.dev') });
  const busy = new Set(['busy.dev']);
  const { start, started } = starter(raw, busy);
  let now = new Date('2026-10-12T00:00:00Z');
  const deps = { db: d1, start, now: () => now };
  await tickBatch(deps, 'cb_2');
  let b = (await getBatch(d1, 'cb_2'))!;
  assert.equal(b.jobs[0].status, 'waiting');
  assert.equal(b.jobs[0].attempts, 1);
  assert.equal(b.jobs[0].run_id, null);
  assert.match(b.jobs[0].error ?? '', /busy \(409\)/);
  assert.equal(b.jobs[0].not_before, new Date(now.getTime() + BUSY_RETRY_MS).toISOString());
  assert.deepEqual(started.map((s) => s.site), ['ok.dev']);
  // Not retried before not_before.
  await tickBatch(deps, 'cb_2');
  assert.equal((await getBatch(d1, 'cb_2'))!.jobs[0].attempts, 1);
  // Retried after; the site is free now.
  busy.delete('busy.dev');
  now = new Date(now.getTime() + BUSY_RETRY_MS);
  await tickBatch(deps, 'cb_2');
  b = (await getBatch(d1, 'cb_2'))!;
  assert.equal(b.jobs[0].status, 'running');
  assert.equal(b.jobs[0].attempts, 2);
  assert.equal(b.jobs[0].error, null);

  // Always busy: an error after MAX_START_ATTEMPTS, and the batch can still finish.
  const { d1: d2, raw: raw2 } = fakeD1();
  await createBatch(d2, { id: 'cb_3', concurrency: 1, maxPages: null, force: false, jobs: jobs('busy.dev') });
  const s2 = starter(raw2, new Set(['busy.dev']));
  let t2 = new Date('2026-10-12T00:00:00Z');
  for (let i = 0; i < MAX_START_ATTEMPTS; i++) {
    await tickBatch({ db: d2, start: s2.start, now: () => t2 }, 'cb_3');
    t2 = new Date(t2.getTime() + BUSY_RETRY_MS);
  }
  const b3 = (await getBatch(d2, 'cb_3'))!;
  assert.equal(b3.jobs[0].status, 'error');
  assert.equal(b3.jobs[0].attempts, MAX_START_ATTEMPTS);
  assert.equal(b3.batch.status, 'complete');
});

test('batch: a start that throws is an error; a claimed start a retried tick finds is running', async () => {
  const { d1 } = fakeD1();
  await createBatch(d1, { id: 'cb_4', concurrency: 2, maxPages: null, force: false, jobs: jobs('x.dev', 'y.dev') });
  const t = await tickBatch({ db: d1, start: async () => { throw new Error('Workflow could not be created'); } }, 'cb_4');
  assert.equal(t.started, 0);
  const b = (await getBatch(d1, 'cb_4'))!;
  assert.deepEqual(b.jobs.map((j) => [j.status, j.error]), [['error', 'Workflow could not be created'], ['error', 'Workflow could not be created']]);

  // A tick that died after claiming: the run row exists, so the job is running; without it, waiting again.
  const { d1: d2, raw: raw2 } = fakeD1();
  await createBatch(d2, { id: 'cb_5', concurrency: 2, maxPages: null, force: false, jobs: jobs('x.dev', 'y.dev') });
  raw2.prepare(`UPDATE crawl_batch_jobs SET status = 'starting', run_id = 'cr_01XXXXXXXXXXXXXXXXXXXXXXXX' WHERE ord = 0`).run();
  raw2.prepare(`UPDATE crawl_batch_jobs SET status = 'starting', run_id = 'cr_01YYYYYYYYYYYYYYYYYYYYYYYY' WHERE ord = 1`).run();
  raw2.prepare(`INSERT INTO crawl_runs (id, site, start_url, started_at, status) VALUES ('cr_01XXXXXXXXXXXXXXXXXXXXXXXX', 'x.dev', 'https://x.dev/0', ?, 'running')`).run(new Date().toISOString());
  const s = starter(raw2);
  await tickBatch({ db: d2, start: s.start }, 'cb_5');
  const b5 = (await getBatch(d2, 'cb_5'))!;
  assert.equal(b5.jobs[0].status, 'running');
  assert.equal(b5.jobs[0].run_id, 'cr_01XXXXXXXXXXXXXXXXXXXXXXXX');
  assert.equal(b5.jobs[1].status, 'running'); // y.dev lost its claim, went back to waiting, and was started
  assert.deepEqual(s.started.map((x) => x.site), ['y.dev']);
});

test('batch: cancel stops scheduling; running crawls are reported', async () => {
  const { d1, raw } = fakeD1();
  await createBatch(d1, { id: 'cb_6', concurrency: 1, maxPages: null, force: false, jobs: jobs('a.dev', 'b.dev', 'c.dev') });
  const { start, started } = starter(raw);
  await tickBatch({ db: d1, start }, 'cb_6');
  assert.deepEqual(await cancelBatch(d1, 'cb_6'), [started[0].runId]);
  assert.equal(await cancelBatch(d1, 'cb_6'), null);
  finish(raw, started[0].runId);
  assert.equal((await tickBatch({ db: d1, start }, 'cb_6')).done, true);
  assert.equal(started.length, 1);
  const b = (await getBatch(d1, 'cb_6'))!;
  assert.equal(b.batch.status, 'cancelled');
  assert.deepEqual(b.jobs.map((j) => j.status), ['running', 'cancelled', 'cancelled']);
  assert.equal(b.jobs[0].run_status, 'complete');
});

test('batch endpoints: create from seeds, list, detail, cancel with stopRuns', async () => {
  const { env, raw, batches, terminated, workflowStatus } = setup();
  const two = SEEDS.slice(0, 2).map((s) => s.startUrl);
  assert.equal((await call(env, post('/api/batches', { startUrls: two, concurrency: 9 }))).status, 400);
  assert.equal((await call(env, post('/api/batches', { startUrls: two, concurrency: 0 }))).status, 400);
  assert.equal((await call(env, post('/api/batches', { startUrls: ['https://not.a.seed/'] }))).status, 400);
  assert.equal((await call(env, post('/api/batches', { startUrls: [] }))).status, 400);
  assert.equal((await call(env, post('/api/batches', { maxPages: 0 }))).status, 400);
  assert.equal((await call(env, post('/api/batches', { startUrls: two }, {}))).status, 403);
  assert.equal(batches.length, 0);

  const r = await call(env, post('/api/batches', { startUrls: two, concurrency: 2, maxPages: 3 }));
  assert.equal(r.status, 202);
  assert.equal(r.body.jobs, 2);
  assert.deepEqual(batches, [{ id: r.body.batchId, params: { batchId: r.body.batchId } }]);
  const all = await call(env, post('/api/batches', { concurrency: 8 }));
  assert.equal(all.body.jobs, SEEDS.length);

  const list = (await call(env, req('/api/batches'))).body.batches;
  assert.equal(list.length, 2);
  const detail = (await call(env, req(`/api/batches/${r.body.batchId}`))).body;
  assert.deepEqual(detail.jobs.map((j: any) => j.max_pages), [3, 3]);
  assert.deepEqual(detail.jobs.map((j: any) => j.start_url), two);

  // One job in flight: cancel with stopRuns cancels its crawl too.
  raw.prepare(`INSERT INTO crawl_runs (id, site, start_url, started_at, status) VALUES ('cr_01DDDDDDDDDDDDDDDDDDDDDDDD', ?, ?, ?, 'running')`).run(SEEDS[0].site, SEEDS[0].startUrl, new Date().toISOString());
  raw.prepare(`UPDATE crawl_batch_jobs SET status = 'running', run_id = 'cr_01DDDDDDDDDDDDDDDDDDDDDDDD' WHERE batch_id = ? AND ord = 0`).run(r.body.batchId);
  workflowStatus.set('cr_01DDDDDDDDDDDDDDDDDDDDDDDD', 'running');
  const c = await call(env, post(`/api/batches/${r.body.batchId}/cancel`, { stopRuns: true }));
  assert.deepEqual(c.body, { cancelled: true, inFlight: 1, stopped: 1 });
  assert.deepEqual(terminated, ['cr_01DDDDDDDDDDDDDDDDDDDDDDDD']);
  assert.equal((await call(env, post(`/api/batches/${r.body.batchId}/cancel`, {}))).status, 409);
  assert.equal((await call(env, post('/api/batches/cb_01ZZZZZZZZZZZZZZZZZZZZZZZZ/cancel', {}))).status, 404);
});
