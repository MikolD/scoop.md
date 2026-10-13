// Client for the scoop.md library (api.scoop.md/v1) as 0.6.0 uses it: a site's
// llms.txt (GET /llms) and the list behind the toolbar badge (GET /sites/index).
// Calls never throw: the popup must work even when the library is down or
// slow, so every call resolves to { ok, status, data, error }.

export const DEFAULT_LIBRARY = 'https://api.scoop.md/v1';
export const LLMS_TIMEOUT_MS = 5_000;
export const INDEX_TIMEOUT_MS = 15_000;

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
        cache: 'no-cache',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
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
    // The site's llms.txt as a short prompt: what the popup copies.
    llms: (url) => call('GET', `/llms?url=${encodeURIComponent(url)}`, undefined, LLMS_TIMEOUT_MS),
    // The sites with an llms.txt (llms: { host: 1 | 2 }), for the toolbar badge.
    // With the ETag of the copy we have, an unchanged list answers 304.
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
