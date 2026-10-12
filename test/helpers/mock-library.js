// A stand-in for the library's docs-index endpoints (status, crawl requests,
// page packages) plus the few library calls the popup makes, following the
// contract the backend implements. Used by test/popup-ux.test.js and, for the
// real-Chrome check, by scripts run against it by hand.
//
// sites: { [site]: { indexed, status, crawling, request, pages,
//   crawl: 'ok' | 'complete' | 'rejected' | 'failed' | '429', steps: [...], hold, packageText,
//   quick: [{ kind, url, label, bytes }], overview, topics: [...], hits: [...],
//   isDevDocs: { verdict, method, score }, quickDevDocs, agentInstructions: [{ text, url }],
//   docs: { found, root, via, verdict } (/quick's docs field), llms: { url, verified, fullUrl, fullVerified },
//   notDocs: true (listed in /sites/index notDocs) } }
// GET /sites/index lists indexed sites and notDocs hosts with an ETag (304 for If-None-Match).
// A crawl request moves one step per GET /crawl-requests/:id; at "complete"
// the site becomes indexed. hold: true stays at the last step before it.

import { createServer } from 'node:http';

export const DEFAULT_STEPS = [
  { state: 'queued', phase: 'gate', etaSeconds: 40 },
  { state: 'running', phase: 'gate' },
  { state: 'running', phase: 'discover', pagesFound: 0 },
  { state: 'running', phase: 'fetch', pagesFound: 12 },
  { state: 'indexing', phase: 'index', pagesFound: 12, pagesIndexed: 6 },
  { state: 'complete', phase: 'done', pagesFound: 12, pagesIndexed: 12 },
];

export function packageFor(site, url) {
  return `# ${site} documentation (via scoop.md docs index)\n\nAnchored on ${url}\n\n## This page\n\nIndexed text for ${url}.\n\n## Related pages\n\n- ${new URL('/docs/other', url).href}\n`;
}

// links: { [url]: 'ok' | 'bad' } answers POST /links/check (anything else: unknown).
export async function startMockLibrary({ sites = {}, skill = null, requests = {}, onRequest, links = {} } = {}) {
  const log = [];
  let next = 1;
  const site = (name) => {
    sites[name] ??= {};
    return sites[name];
  };

  function statusOf(name) {
    const s = site(name);
    const req = Object.values(requests).find((r) => r.site === name && !['complete', 'rejected', 'failed'].includes(r.view().state));
    return {
      site: name,
      indexed: Boolean(s.indexed),
      status: s.status ?? (s.indexed ? 'ready' : 'new'),
      crawling: Boolean(s.crawling || req),
      pages: s.indexed ? s.pages ?? 12 : 0,
      isDevDocs: s.isDevDocs ?? null,
      lastCrawledAt: s.indexed ? '2026-10-12T09:00:00.000Z' : null,
      request: s.request ?? (req ? (({ id, state, phase, pagesFound, pagesIndexed }) => ({ id, state, phase, pagesFound, pagesIndexed }))(req.view()) : null),
    };
  }

  function newRequest(name, url, s) {
    const id = `cr_${next++}`;
    const steps = s.steps ?? DEFAULT_STEPS;
    let i = 0;
    const view = () => ({ id, site: name, path: new URL(url).pathname, reason: null, pagesFound: 0, pagesIndexed: 0, etaSeconds: null, ...steps[i] });
    requests[id] = {
      site: name,
      view,
      advance() {
        const last = s.hold ? steps.length - 2 : steps.length - 1;
        if (i < last) i++;
        if (view().state === 'complete') s.indexed = true;
        return view();
      },
    };
    return requests[id];
  }

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    const entry = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: body ? JSON.parse(body) : null, install: req.headers['x-scoop-install'] };
    log.push(entry);
    onRequest?.(entry);
    const json = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
    let m;
    if (req.method === 'GET' && u.pathname === '/v1/skills/best') return json(200, { skill });
    if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/sites\/([^/]+)\/status$/))) return json(200, statusOf(decodeURIComponent(m[1])));
    if (req.method === 'POST' && u.pathname === '/v1/crawl-requests') {
      const url = entry.body?.url;
      const name = new URL(url).hostname;
      const s = site(name);
      if (s.crawl === '429') return json(429, { error: { code: 'rate_limited', message: 'Too many crawl requests' } }, { 'retry-after': '60' });
      if (s.crawl === 'rejected') return json(200, { id: `cr_${next++}`, site: name, state: 'rejected', reason: 'not_devtool' });
      if (s.crawl === 'failed') return json(200, { id: `cr_${next++}`, site: name, state: 'failed', reason: 'fetch_failed' });
      if (s.crawl === 'complete') { s.indexed = true; return json(200, { id: `cr_${next++}`, site: name, state: 'complete' }); }
      // The server dedupes: a site already being crawled gets that request back.
      const running = Object.values(requests).find((r) => r.site === name && !['complete', 'rejected', 'failed'].includes(r.view().state));
      if (running) return json(200, { id: running.view().id, site: name, state: running.view().state });
      const r = newRequest(name, url, s);
      return json(202, { id: r.view().id, site: name, state: 'queued', etaSeconds: 40 });
    }
    if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/crawl-requests\/([^/]+)$/))) {
      const r = requests[decodeURIComponent(m[1])];
      if (!r) return json(404, { error: { code: 'not_found', message: 'No such crawl request' } });
      return json(200, r.advance());
    }
    if (req.method === 'GET' && u.pathname === '/v1/packages' && u.searchParams.has('chunks')) {
      const name = u.searchParams.get('site');
      if (site(name).noChunks) return json(400, { error: { code: 'invalid_request', message: 'chunks not supported' } });
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(`# ${name} documentation: selected chunks (via scoop.md)\n\nChunks: ${u.searchParams.get('chunks')}\n`);
    }
    if (req.method === 'GET' && u.pathname === '/v1/packages' && u.searchParams.has('q')) {
      const name = u.searchParams.get('site');
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(`# ${name} documentation: search "${u.searchParams.get('q')}" (via scoop.md)\n\nAll results.\n`);
    }
    if (req.method === 'GET' && u.pathname === '/v1/packages') {
      const name = u.searchParams.get('site');
      if (site(name).packages404Times > 0) {
        site(name).packages404Times--;
        return json(404, { error: { code: 'not_found', message: 'Nothing indexed matches' } });
      }
      if (!site(name).indexed || site(name).packages404) return json(404, { error: { code: 'not_indexed', message: `${name} is not indexed` } });
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(site(name).packageText ?? packageFor(name, u.searchParams.get('url')));
    }
    if (req.method === 'GET' && u.pathname === '/v1/quick') {
      const pageUrl = u.searchParams.get('url');
      const name = new URL(pageUrl).hostname;
      const s = site(name);
      return json(200, { site: name, sources: s.quick ?? [], overview: s.overview ?? null, indexed: Boolean(s.indexed), pages: s.indexed ? s.pages ?? 12 : 0, isDevDocs: s.quickDevDocs ?? s.isDevDocs ?? null, agentInstructions: s.agentInstructions ?? [], ...(s.docs ? { docs: s.docs } : {}), llms: s.llms ?? null });
    }
    if (req.method === 'GET' && u.pathname === '/v1/sites/index') {
      const list = Object.entries(sites).filter(([, s]) => s.indexed).map(([name, s]) => ({ site: name, pages: s.pages ?? 12 }));
      const notDocs = Object.entries(sites).filter(([, s]) => s.notDocs).map(([name]) => name);
      const etag = `"${list.map((x) => `${x.site}:${x.pages}`).join(',')}|${notDocs.join(',')}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
      return json(200, { sites: list, notDocs }, { etag });
    }
    if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/sites\/([^/]+)\/topics$/))) {
      const s = site(decodeURIComponent(m[1]));
      return json(200, { site: decodeURIComponent(m[1]), pages: s.pages ?? 12, topics: s.topics ?? [] });
    }
    if (req.method === 'GET' && u.pathname === '/v1/search') {
      const s = site(u.searchParams.get('site'));
      const q = u.searchParams.get('q');
      return json(200, { query: q, site: u.searchParams.get('site'), slot: null, hits: (s.hits ?? []).slice(0, Number(u.searchParams.get('limit') ?? 10)) });
    }
    if (req.method === 'POST' && u.pathname === '/v1/links/check') {
      const urls = entry.body?.urls ?? [];
      return json(200, { ok: urls.filter((x) => links[x] === 'ok'), bad: urls.filter((x) => links[x] === 'bad'), unknown: urls.filter((x) => !links[x]) });
    }
    if (req.method === 'POST' && u.pathname === '/v1/skills') return json(201, { id: 'sk_mock', status: 'verified', duplicate: false });
    if (req.method === 'POST' && /^\/v1\/skills\/[^/]+\/feedback$/.test(u.pathname)) return json(200, { worked: 1, failed: 0 });
    if (req.method === 'POST' && u.pathname === '/v1/events') return json(202, { accepted: 0, dropped: 0 });
    return json(404, { error: { code: 'not_found', message: 'Not found' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://localhost:${server.address().port}/v1`;
  return { url, log, sites, requests, newRequest: (name, pageUrl) => newRequest(name, pageUrl, site(name)), close: () => server.close() };
}
