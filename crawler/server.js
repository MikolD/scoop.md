// Job server inside the E2B sandbox. It is the template's start command, so it
// is already running (snapshotted) when a sandbox is created. The backend:
//   POST /run     { token, job }  start the one crawl this sandbox will do
//   GET  /status  (Bearer token)  { state, pages, error, uploaded }
//   GET  /result  (Bearer token)  the CrawlResult JSON (dev, when there is no upload URL)
//   GET  /health                  for the template's ready command
// The public URL also requires E2B's traffic token (allowPublicTraffic: false);
// the per-job token keeps pages rendered in this sandbox from driving the
// server through localhost.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { crawl } from './crawl.js';
import { upload } from './lib.js';

const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 1_000_000;

let token = null;
let state = 'idle'; // idle | running | finished | failed
let pages = 0;
let error = null;
let uploaded = false;
let result = null;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  const given = Buffer.from(req.headers.authorization || '');
  const want = Buffer.from(`Bearer ${token}`);
  return token !== null && given.length === want.length && timingSafeEqual(given, want);
}

function validJob(job) {
  return (
    job && typeof job.site === 'string' && Array.isArray(job.startUrls) && job.startUrls.length > 0 &&
    job.startUrls.every((u) => typeof u === 'string' && /^https?:\/\//.test(u)) &&
    Number.isInteger(job.budget?.maxPages) && job.budget.maxPages > 0 && job.budget.maxPages <= 1000 &&
    Number(job.budget?.maxMinutes) > 0 && job.budget.maxMinutes <= 55 &&
    (job.uploadUrl === null || job.uploadUrl === undefined || /^https:\/\//.test(job.uploadUrl))
  );
}

async function run(job) {
  state = 'running';
  try {
    result = await crawl(job, { onPage: (n) => { pages = n; } });
    if (job.uploadUrl) {
      await upload(result, job.uploadUrl);
      uploaded = true;
    }
    state = 'finished';
  } catch (e) {
    error = String(e?.message || e).slice(0, 500);
    state = 'failed';
  }
  console.log(JSON.stringify({ state, pages, uploaded, error }));
}

createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
  if (req.method === 'POST' && path === '/run') {
    if (token !== null) return send(res, 409, { error: 'already started' });
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { return send(res, 400, { error: 'bad json' }); }
      if (typeof msg.token !== 'string' || msg.token.length < 32 || !validJob(msg.job)) return send(res, 400, { error: 'bad job' });
      if (token !== null) return send(res, 409, { error: 'already started' });
      token = msg.token;
      run(msg.job);
      send(res, 202, { ok: true });
    });
    return;
  }
  if (!authorized(req)) return send(res, 404, { error: 'not found' });
  if (req.method === 'GET' && path === '/status') return send(res, 200, { state, pages, error, uploaded });
  if (req.method === 'GET' && path === '/result') {
    if (state !== 'finished') return send(res, 409, { error: `not finished (${state})` });
    return send(res, 200, result);
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`crawler job server on :${PORT}`));
