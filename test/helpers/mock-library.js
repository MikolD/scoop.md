// A stand-in for the library's docs-index endpoints (status, crawl requests,
// page packages) plus the few library calls the popup makes, following the
// contract the backend implements. Used by test/popup-ux.test.js and, for the
// real-Chrome check, by scripts run against it by hand.
//
// sites: { [site]: { indexed, status, crawling, request, pages,
//   crawl: 'ok' | 'complete' | 'rejected' | 'failed' | '429', steps: [...], hold, packageText } }
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

export async function startMockLibrary({ sites = {}, skill = null, requests = {}, onRequest } = {}) {
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
      const r = newRequest(name, url, s);
      return json(202, { id: r.view().id, site: name, state: 'queued', etaSeconds: 40 });
    }
    if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/crawl-requests\/([^/]+)$/))) {
      const r = requests[decodeURIComponent(m[1])];
      if (!r) return json(404, { error: { code: 'not_found', message: 'No such crawl request' } });
      return json(200, r.advance());
    }
    if (req.method === 'GET' && u.pathname === '/v1/packages') {
      const name = u.searchParams.get('site');
      if (!site(name).indexed) return json(404, { error: { code: 'not_indexed', message: `${name} is not indexed` } });
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(site(name).packageText ?? packageFor(name, u.searchParams.get('url')));
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
