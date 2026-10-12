// Client for the shared library (api.scoop.md/v1, docs/BACKEND.md §5). Calls
// never throw: the copy must work even when the library is down, slow or says
// no, so every call resolves to { ok, status, data, error }.

export const DEFAULT_LIBRARY = 'https://api.scoop.md/v1';
export const BEST_TIMEOUT_MS = 3_000;
export const SHARE_TIMEOUT_MS = 25_000; // the server fetches every source to verify it
export const VOTE_TIMEOUT_MS = 8_000;

// telemetry: false sends X-Scoop-Telemetry: off, so the library doesn't record
// these requests in its usage statistics either.
export function createLibrary({ baseUrl, installId, client, telemetry = true, fetchImpl = fetch }) {
  const base = (baseUrl || '').replace(/\/+$/, '');

  async function call(method, path, body, timeoutMs) {
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
      const data = await res.json().catch(() => null);
      if (res.ok) return { ok: true, status: res.status, data };
      return { ok: false, status: res.status, error: data?.error ?? { code: 'internal', message: `HTTP ${res.status}` } };
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
