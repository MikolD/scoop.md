// Client for the shared library (api.scoop.md/v1, docs/BACKEND.md §5). Calls
// never throw: the copy must work even when the library is down, slow or says
// no, so every call resolves to { ok, status, data, error }.

export const DEFAULT_LIBRARY = 'https://api.scoop.md/v1';
export const BEST_TIMEOUT_MS = 3_000;
export const SHARE_TIMEOUT_MS = 25_000; // the server fetches every source to verify it
export const VOTE_TIMEOUT_MS = 8_000;
export const STATUS_TIMEOUT_MS = 3_000;
export const CRAWL_TIMEOUT_MS = 8_000;
export const PACKAGE_TIMEOUT_MS = 10_000;
export const QUICK_TIMEOUT_MS = 2_500;
export const SEARCH_TIMEOUT_MS = 5_000;
export const INDEX_TIMEOUT_MS = 15_000;

// telemetry: false sends X-Scoop-Telemetry: off, so the library doesn't record
// these requests in its usage statistics either.
export function createLibrary({ baseUrl, installId, client, telemetry = true, fetchImpl = fetch }) {
  const base = (baseUrl || '').replace(/\/+$/, '');

  // as: 'text' reads a successful body as text (GET /packages answers Markdown).
  async function call(method, path, body, timeoutMs, as = 'json') {
    if (!base) return { ok: false, status: 0, error: { code: 'offline', message: 'No library configured' } };
    const headers = { 'x-scoop-client': client };
    if (!telemetry) headers['x-scoop-telemetry'] = 'off';
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      headers['x-scoop-install'] = installId;
    }
    try {
      const res = await fetchImpl(base + path, {
        method,
        headers,
        credentials: 'omit',
        // /skills/best is cacheable (max-age=30, s-maxage=60). Revalidating skips
        // the browser's copy, so a scoop right after "It worked" doesn't get the
        // cached "no skill yet"; a CDN may still serve its copy for up to 60 s.
        cache: 'no-cache',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok && as === 'text') return { ok: true, status: res.status, data: await res.text() };
      const data = await res.json().catch(() => null);
      if (res.ok) return { ok: true, status: res.status, data };
      const retryAfter = Number(res.headers?.get?.('retry-after')) || undefined;
      return { ok: false, status: res.status, retryAfter, error: data?.error ?? { code: res.status === 429 ? 'rate_limited' : 'internal', message: `HTTP ${res.status}` } };
    } catch (e) {
      const code = e?.name === 'TimeoutError' ? 'timeout' : 'offline';
      return { ok: false, status: 0, error: { code, message: String(e?.message || e) } };
    }
  }

  return {
    best: (site) => call('GET', `/skills/best?site=${encodeURIComponent(site)}`, undefined, BEST_TIMEOUT_MS),
    share: (skill) => call('POST', '/skills', skill, SHARE_TIMEOUT_MS),
    feedback: (id, worked) => call('POST', `/skills/${encodeURIComponent(id)}/feedback`, { worked }, VOTE_TIMEOUT_MS),
    report: (skillId, reason) => call('POST', '/reports', { skillId, reason }, VOTE_TIMEOUT_MS),
    // The docs index (lib/crawl.js): whether a site is indexed or being crawled,
    // asking for a crawl, following one, and a package anchored on a page.
    siteStatus: (site) => call('GET', `/sites/${encodeURIComponent(site)}/status`, undefined, STATUS_TIMEOUT_MS),
    requestCrawl: (url) => call('POST', '/crawl-requests', { url }, CRAWL_TIMEOUT_MS),
    crawlRequest: (id) => call('GET', `/crawl-requests/${encodeURIComponent(id)}`, undefined, VOTE_TIMEOUT_MS),
    pagePackage: (site, url, { timeoutMs = PACKAGE_TIMEOUT_MS } = {}) => call('GET', `/packages?site=${encodeURIComponent(site)}&url=${encodeURIComponent(url)}`, undefined, timeoutMs, 'text'),
    // Instant: what the server finds for a page right away (llms.txt files and
    // the page's .md twin, also on docs.<domain>), without crawling.
    quick: (url) => call('GET', `/quick?url=${encodeURIComponent(url)}`, undefined, QUICK_TIMEOUT_MS),
    // Search tab and Overview tab, for indexed sites.
    search: (site, q, limit = 20) => call('GET', `/search?site=${encodeURIComponent(site)}&q=${encodeURIComponent(q)}&limit=${limit}`, undefined, SEARCH_TIMEOUT_MS),
    queryPackage: (site, q) => call('GET', `/packages?site=${encodeURIComponent(site)}&q=${encodeURIComponent(q)}`, undefined, PACKAGE_TIMEOUT_MS, 'text'),
    // The package for exactly these search-result chunks (≤30), in this order.
    chunksPackage: (site, ids) => call('GET', `/packages?site=${encodeURIComponent(site)}&chunks=${ids.slice(0, 30).map(encodeURIComponent).join(',')}`, undefined, PACKAGE_TIMEOUT_MS, 'text'),
    // Which of these link addresses work ({ ok, bad, unknown }), for local packages (lib/links.js).
    checkLinks: (urls, { timeoutMs = 2_000 } = {}) => call('POST', '/links/check', { urls: urls.slice(0, 200) }, timeoutMs),
    topics: (site) => call('GET', `/sites/${encodeURIComponent(site)}/topics`, undefined, SEARCH_TIMEOUT_MS),
    // Every indexed site with its page count, for the toolbar badge. With the
    // ETag of the copy we have, an unchanged list answers 304 and isn't sent again.
    async sitesIndex(etag) {
      if (!base) return { ok: false, status: 0 };
      try {
        const res = await fetchImpl(`${base}/sites/index`, {
          headers: { 'x-scoop-client': client, ...(telemetry ? {} : { 'x-scoop-telemetry': 'off' }), ...(etag ? { 'if-none-match': etag } : {}) },
          credentials: 'omit',
          cache: 'no-cache',
          signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
        });
        if (res.status === 304) return { ok: true, status: 304, notModified: true, etag };
        if (!res.ok) return { ok: false, status: res.status };
        return { ok: true, status: res.status, data: await res.json(), etag: res.headers.get('etag') };
      } catch {
        return { ok: false, status: 0 };
      }
    },
  };
}

// The library URL is fixed. Only an unpacked (development) install may point
// at a local server, via chrome.storage.local `devLibraryUrl`, which has no UI.
// The URL setting of older versions is deleted.
export async function libraryUrl(chromeApi) {
  try { await chromeApi.storage.sync.remove('libraryUrl'); } catch {}
  try {
    const { installType } = await chromeApi.management.getSelf();
    if (installType !== 'development') return DEFAULT_LIBRARY;
    const { devLibraryUrl } = await chromeApi.storage.local.get('devLibraryUrl');
    return devLibraryUrl || DEFAULT_LIBRARY;
  } catch {
    return DEFAULT_LIBRARY;
  }
}

// The request body for POST /v1/skills.
export function shareBody(scoop) {
  return {
    site: scoop.site,
    pageUrl: scoop.pageUrl,
    title: scoop.title,
    sections: scoop.sections.map(({ kind, label, url, content, bytes }) => ({
      kind, label, url, content: content ?? null, bytes: content == null ? bytes : null,
    })),
    relatedLinks: scoop.relatedLinks.slice(0, 100).map(({ url, text }) => ({ url, text: String(text ?? '').slice(0, 120) })),
  };
}

// The library refuses a section URL whose query string is long or reads like
// prose. For the page's own HTML section the page without its query is the
// next best source. Returns the body to retry once with, or null.
export function withoutSectionQuery(body, error) {
  if (error?.code !== 'invalid_request') return null;
  const i = Number(error.message?.match(/^sections\[(\d+)\]\.url has a query string/)?.[1]);
  const section = body.sections[i];
  if (section?.kind !== 'page-html') return null;
  const u = new URL(section.url);
  if (!u.search) return null;
  u.search = '';
  return { ...body, sections: body.sections.map((s, j) => (j === i ? { ...s, url: u.href } : s)) };
}

const SOURCE_NAMES = {
  'page-md': "the page's .md file",
  llms: 'llms.txt',
  'llms-full': 'llms-full.txt',
  'page-html': 'this page',
};

// One short sentence for why a share was refused, naming the section when the
// server says which one failed ("Section 2 (https://…) …").
export function notSharedReason(error, sections = []) {
  const n = Number(error?.message?.match(/^Section (\d+)/)?.[1]);
  const what = SOURCE_NAMES[sections[n - 1]?.kind] ?? 'a source';
  switch (error?.code) {
    case 'source_mismatch':
      return sections[n - 1]?.kind === 'page-html'
        ? 'the library sees different text on this page than scoop.md extracted.'
        : `${what} changed while scooping.`;
    case 'source_unreachable': return `the library couldn't fetch ${what}.`;
    case 'site_mismatch': return `${what} redirects to another site.`;
    case 'rate_limited': return 'sharing limit reached. Try again later.';
    case 'too_large': return 'too large to share.';
    case 'invalid_request': return 'the library rejected it as invalid.';
    case 'timeout': return 'the library took too long to answer.';
    case 'offline': return "the library couldn't be reached.";
    default: return 'the library had an error.';
  }
}
