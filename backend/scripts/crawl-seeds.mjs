#!/usr/bin/env node
// Starts admin crawls for a seed list (seeds/devtools.json) or for URLs given
// on the command line, a few at a time, polls each run to the end and prints a
// live table, then a summary; --out writes the results as JSON.
//
//   npm run crawl:seeds -- --env staging [--only nodejs.org,react.dev] [--max-pages 50] [--concurrency 4] [--dry-run] [--out report.json]
//   npm run crawl:site  -- --env staging https://docs.example.com/
//
// The admin token comes from STAGING_ADMIN_TOKEN / PRODUCTION_ADMIN_TOKEN (or
// LOCAL_ADMIN_TOKEN with --env local) and is never printed. A site that
// already has a crawl running (409) is retried later.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APIS = { staging: 'https://api-staging.scoop.md', production: 'https://api.scoop.md', local: 'http://127.0.0.1:8787' };
const TOKEN_VARS = { staging: 'STAGING_ADMIN_TOKEN', production: 'PRODUCTION_ADMIN_TOKEN', local: 'LOCAL_ADMIN_TOKEN' };
export const DEFAULT_SEEDS = fileURLToPath(new URL('../seeds/devtools.json', import.meta.url));
export const FINAL = new Set(['complete', 'failed', 'rejected']);
const DEFAULT_MAX_PAGES = 200;

export class UsageError extends Error {}

const USAGE = `usage: crawl-seeds --env staging|production|local [options] [url ...]
  --only a,b         only these sites (from the seed file)
  --max-pages N      page budget per site (default: the seed's, else ${DEFAULT_MAX_PAGES})
  --concurrency N    crawls in flight at once (default 4)
  --force            skip the devtool gate
  --dry-run          list what would be crawled; no requests
  --out FILE         write the results as JSON
  --seeds FILE       seed file (default seeds/devtools.json)
  --api URL          API base (default per --env)
  --poll-seconds N   status poll interval (default 10)
  --timeout-minutes N  stop waiting for a run after this long (default 90; the crawl continues)`;

const normalizeSite = (host) => String(host).trim().toLowerCase().replace(/^www\./, '');

function positiveInt(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${name} must be a positive integer`);
  return n;
}

export function parseArgs(argv, env = process.env) {
  const o = {
    env: null, api: null, token: null, only: null, maxPages: null, concurrency: 4, force: false, dryRun: false,
    out: null, seeds: DEFAULT_SEEDS, urls: [], pollMs: 10_000, timeoutMs: 90 * 60_000,
  };
  const value = (i, name) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const take = () => {
      if (inline !== null) return inline;
      const v = value(i, flag);
      i++;
      return v;
    };
    switch (flag) {
      case '--env': o.env = take(); break;
      case '--api': o.api = take().replace(/\/+$/, ''); break;
      case '--only': o.only = take().split(',').map((s) => normalizeSite(s)).filter(Boolean); break;
      case '--max-pages': o.maxPages = positiveInt(take(), '--max-pages'); break;
      case '--concurrency': o.concurrency = positiveInt(take(), '--concurrency'); break;
      case '--poll-seconds': o.pollMs = positiveInt(take(), '--poll-seconds') * 1000; break;
      case '--timeout-minutes': o.timeoutMs = positiveInt(take(), '--timeout-minutes') * 60_000; break;
      case '--out': o.out = take(); break;
      case '--seeds': o.seeds = take(); break;
      case '--force': o.force = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--help': case '-h': throw new UsageError(USAGE);
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown option ${a}\n${USAGE}`);
        try {
          const u = new URL(a);
          if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
        } catch {
          throw new UsageError(`not a URL: ${a}`);
        }
        o.urls.push(a);
    }
  }
  if (!o.env || !(o.env in APIS)) throw new UsageError(`--env must be staging, production or local\n${USAGE}`);
  o.api ??= APIS[o.env];
  // The admin token goes in a header: only over HTTPS, except to a local dev server.
  let api;
  try { api = new URL(o.api); } catch { throw new UsageError(`--api is not a URL: ${o.api}`); }
  if (api.protocol !== 'https:' && o.env !== 'local') throw new UsageError('--api must be https:// (plain http only with --env local)');
  o.token = env[TOKEN_VARS[o.env]] ?? null;
  if (!o.token && !o.dryRun) throw new UsageError(`${TOKEN_VARS[o.env]} is not set`);
  return o;
}

export function loadSeeds(path) {
  const seeds = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(seeds)) throw new UsageError(`${path}: expected a JSON array`);
  for (const s of seeds) {
    if (!s || typeof s.startUrl !== 'string') throw new UsageError(`${path}: every seed needs a startUrl`);
  }
  return seeds;
}

// What to crawl: the URLs given, else the seeds (narrowed by --only).
export function selectJobs(seeds, o) {
  const fromUrls = o.urls.map((u) => ({ name: normalizeSite(new URL(u).hostname), site: normalizeSite(new URL(u).hostname), startUrl: u }));
  let jobs = fromUrls.length ? fromUrls : seeds.map((s) => ({ name: s.name ?? s.site, site: normalizeSite(s.site ?? new URL(s.startUrl).hostname), startUrl: s.startUrl, maxPages: s.maxPages }));
  if (o.only) {
    const missing = o.only.filter((site) => !jobs.some((j) => j.site === site));
    if (missing.length) throw new UsageError(`not in the seed file: ${missing.join(', ')}`);
    jobs = jobs.filter((j) => o.only.includes(j.site));
  }
  return jobs.map((j) => ({ ...j, maxPages: o.maxPages ?? j.maxPages ?? DEFAULT_MAX_PAGES }));
}

function blank(job) {
  return {
    name: job.name, site: job.site, startUrl: job.startUrl, maxPages: job.maxPages, runId: null, status: 'waiting', path: null,
    pages: { new: 0, changed: 0, unchanged: 0, failed: 0, skipped: 0 }, gate: null, forced: false, costUsd: 0, error: null,
    attempts: 0, startedAt: null, finishedAt: null,
  };
}

// Runs every job with at most `concurrency` crawls in flight and never two of
// the same site at once. A 409 (a crawl of the site is already running,
// perhaps started elsewhere) puts the job back to try again after retryMs.
export async function crawlAll(jobs, o) {
  const {
    api, token, fetchImpl = fetch, concurrency = 4, pollMs = 10_000, retryMs = 60_000, maxAttempts = 30, timeoutMs = 90 * 60_000,
    force = false, onUpdate = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(),
  } = o;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-scoop-client': 'crawl-seeds/1' };
  const results = jobs.map(blank);
  const queue = results.map((r, i) => ({ r, job: jobs[i], notBefore: 0 }));
  const activeSites = new Set();
  let inFlight = 0;
  let maxInFlight = 0;

  async function startRun(r, job) {
    const res = await fetchImpl(`${api}/v1/admin/crawl`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ site: job.site, startUrl: job.startUrl, maxPages: job.maxPages, ...(force ? { force: true } : {}) }),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 409) return 'busy';
    if (res.status !== 202 || !body?.runId) throw new Error(`POST /v1/admin/crawl answered ${res.status}: ${body?.error?.message ?? 'no run'}`);
    r.runId = body.runId;
    r.forced = Boolean(body.forced);
    return 'started';
  }

  async function follow(r) {
    const deadline = now() + timeoutMs;
    let errors = 0;
    while (!FINAL.has(r.status)) {
      if (now() > deadline) {
        r.status = 'timeout';
        r.error = 'stopped waiting; the crawl continues on the server';
        return;
      }
      await sleep(pollMs);
      try {
        const res = await fetchImpl(`${api}/v1/admin/crawl/${r.runId}`, { headers });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const { run, workflow } = await res.json();
        r.status = run.status;
        r.path = run.path;
        r.pages = { new: run.pagesNew, changed: run.pagesChanged, unchanged: run.pagesUnchanged, failed: run.pagesFailed, skipped: run.pagesSkipped };
        r.gate = run.gate ?? null;
        r.forced = Boolean(run.forced);
        r.costUsd = Number(((run.costUsd ?? 0) + (run.gate?.costUsd ?? 0)).toFixed(6));
        r.error = run.error;
        r.finishedAt = run.finishedAt;
        // The Workflow died without recording it (terminated, or errored before its fail step).
        if (!FINAL.has(r.status) && workflow && ['errored', 'terminated'].includes(workflow.status)) {
          r.status = 'failed';
          r.error = workflow.error?.message ?? workflow.error ?? `workflow ${workflow.status}`;
        }
        errors = 0;
      } catch (e) {
        if (++errors >= 5) {
          r.status = 'error';
          r.error = `polling failed: ${e.message}`;
          return;
        }
      }
      onUpdate(results);
    }
  }

  async function worker() {
    for (;;) {
      const t = now();
      const i = queue.findIndex((q) => q.notBefore <= t && !activeSites.has(q.job.site));
      if (i < 0) {
        if (!queue.length) return;
        // Everything left is waiting for a retry or for its site to be free.
        const next = Math.min(...queue.filter((q) => !activeSites.has(q.job.site)).map((q) => q.notBefore));
        await sleep(Number.isFinite(next) ? Math.max(250, next - t) : 250);
        continue;
      }
      const [q] = queue.splice(i, 1);
      const { r, job } = q;
      activeSites.add(job.site);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        r.attempts++;
        r.status = 'starting';
        onUpdate(results);
        const started = await startRun(r, job);
        if (started === 'busy') {
          if (r.attempts >= maxAttempts) {
            r.status = 'error';
            r.error = `a crawl of ${job.site} stayed busy (409) after ${r.attempts} attempts`;
          } else {
            r.status = 'busy';
            queue.push({ r, job, notBefore: now() + retryMs });
          }
        } else {
          r.status = 'queued';
          r.startedAt = new Date(now()).toISOString();
          onUpdate(results);
          await follow(r);
        }
      } catch (e) {
        r.status = 'error';
        r.error = e.message;
      } finally {
        inFlight--;
        activeSites.delete(job.site);
        onUpdate(results);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));
  return { results, maxInFlight };
}

// ---- Output --------------------------------------------------------------------

const pad = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
const COLS = [
  ['site', 28, (r) => r.site],
  ['status', 9, (r) => r.status],
  ['path', 8, (r) => r.path ?? ''],
  ['new', 5, (r) => String(r.pages.new)],
  ['chg', 5, (r) => String(r.pages.changed)],
  ['same', 5, (r) => String(r.pages.unchanged)],
  ['fail', 5, (r) => String(r.pages.failed)],
  ['skip', 5, (r) => String(r.pages.skipped)],
  ['gate', 34, (r) => (r.forced ? 'forced' : r.gate ? `${r.gate.decision} ${r.gate.category ?? '-'} (${r.gate.method})` : '')],
  ['cost $', 9, (r) => (r.costUsd ? r.costUsd.toFixed(4) : '')],
];

export function table(rows) {
  const line = (cells) => cells.join(' ').trimEnd();
  return [line(COLS.map(([h, w]) => pad(h, w))), ...rows.map((r) => line(COLS.map(([, w, f]) => pad(f(r), w))))].join('\n');
}

export function summary(results) {
  const by = (s) => results.filter((r) => r.status === s).length;
  const sum = (k) => results.reduce((n, r) => n + r.pages[k], 0);
  const cost = results.reduce((n, r) => n + r.costUsd, 0);
  return [
    `${results.length} sites: ${by('complete')} complete, ${by('rejected')} rejected (not devtools), ${by('failed')} failed, ` +
      `${by('error') + by('timeout')} not finished here`,
    `pages: ${sum('new')} new, ${sum('changed')} changed, ${sum('unchanged')} unchanged, ${sum('failed')} failed, ${sum('skipped')} skipped`,
    `cost: $${cost.toFixed(4)} (browser crawls and gate AI checks; page classification is billed to the index caps)`,
  ].join('\n');
}

const reasonLines = (results) =>
  results
    .filter((r) => r.error || r.status === 'rejected')
    .map((r) => `  ${r.site}: ${r.status === 'rejected' ? r.gate?.reason ?? r.error : r.error}`)
    .join('\n');

function liveView(results) {
  const done = results.filter((r) => FINAL.has(r.status) || r.status === 'error' || r.status === 'timeout');
  const active = results.filter((r) => ['starting', 'queued', 'running'].includes(r.status));
  const busy = results.filter((r) => r.status === 'busy').length;
  const head = `${done.length}/${results.length} done · ${active.length} running · ${busy} waiting for a busy site`;
  return `${head}\n${table([...active, ...done.slice(-8)])}`;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
  const jobs = selectJobs(o.urls.length ? [] : loadSeeds(o.seeds), o);

  if (o.dryRun) {
    // The gate's lists, as the Worker would apply them (no requests).
    const { listVerdict } = await import('../src/crawl/gate.ts');
    console.log(`dry run: ${jobs.length} crawls against ${o.api}${o.force ? ' (force)' : ''}, ${o.concurrency} at a time\n`);
    console.log(['site'.padEnd(28), 'max'.padEnd(5), 'gate list'.padEnd(10), 'start URL'].join(' '));
    for (const j of jobs) {
      const v = o.force ? null : listVerdict(j.startUrl);
      console.log([pad(j.site, 28), String(j.maxPages).padEnd(5), (v ? `${v.method === 'allowlist' ? 'allow' : 'DENY'}` : '-').padEnd(10), j.startUrl].join(' '));
    }
    const allowed = jobs.filter((j) => listVerdict(j.startUrl)?.method === 'allowlist').length;
    const denied = jobs.filter((j) => listVerdict(j.startUrl)?.method === 'denylist').length;
    console.log(`\n${allowed} on the allowlist, ${denied} on the denylist, ${jobs.length - allowed - denied} decided by signals (and AI if inconclusive)`);
    return;
  }

  const tty = process.stdout.isTTY;
  let drawn = 0;
  const seen = new Map();
  const onUpdate = (results) => {
    if (tty) {
      const view = liveView(results);
      process.stdout.write((drawn ? `\x1b[${drawn}F\x1b[J` : '') + view + '\n');
      drawn = view.split('\n').length;
      return;
    }
    for (const r of results) {
      const key = `${r.status}|${r.path}|${r.pages.new}|${r.pages.changed}`;
      if (seen.get(r.site + r.startUrl) === key || r.status === 'waiting') continue;
      seen.set(r.site + r.startUrl, key);
      console.log(`${new Date().toISOString().slice(11, 19)} ${table([r]).split('\n')[1]}`);
    }
  };
  console.log(`crawling ${jobs.length} sites on ${o.api}, ${o.concurrency} at a time${o.force ? ' (force: no gate)' : ''}`);
  const { results } = await crawlAll(jobs, { ...o, onUpdate });
  console.log(`\n${table(results)}\n\n${summary(results)}`);
  const reasons = reasonLines(results);
  if (reasons) console.log(`\nreasons:\n${reasons}`);
  if (o.out) {
    writeFileSync(o.out, JSON.stringify({ api: o.api, finishedAt: new Date().toISOString(), force: o.force, results }, null, 2) + '\n');
    console.log(`\nreport: ${o.out}`);
  }
  if (results.some((r) => r.status === 'error')) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
