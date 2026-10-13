import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibrary, libraryUrl, DEFAULT_LIBRARY, LLMS_TIMEOUT_MS } from '../extension/lib/library.js';

const ID = '3f2c8a1e-9b4d-4c6e-8f1a-2b3c4d5e6f70';

test('GET /v1/llms: the page URL, the client header, no install ID, no cookies', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ site: 'stripe.com', prompt: 'P' }), { status: 200 });
  };
  const lib = createLibrary({ baseUrl: 'https://api.scoop.md/v1/', installId: ID, client: 'extension/0.6.0', fetchImpl });
  const res = await lib.llms('https://stripe.com/docs');
  assert.equal(calls[0].url, 'https://api.scoop.md/v1/llms?url=https%3A%2F%2Fstripe.com%2Fdocs');
  assert.equal(calls[0].init.headers['x-scoop-install'], undefined);
  assert.equal(calls[0].init.headers['x-scoop-client'], 'extension/0.6.0');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.deepEqual(res, { ok: true, status: 200, data: { site: 'stripe.com', prompt: 'P' } });
});

test('library errors, timeouts and outages resolve instead of throwing', async () => {
  const refuse = async () => new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }), { status: 429 });
  const down = async () => { throw new TypeError('Failed to fetch'); };
  const slow = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const lib = (fetchImpl) => createLibrary({ baseUrl: 'https://api.scoop.md/v1', installId: ID, client: 't', fetchImpl });
  assert.equal((await lib(refuse).llms('https://x.dev/')).error.code, 'rate_limited');
  assert.equal((await lib(down).llms('https://x.dev/')).error.code, 'offline');
  const started = Date.now();
  const keepAlive = setTimeout(() => {}, 10_000); // AbortSignal.timeout's timer doesn't hold Node open
  assert.equal((await lib(slow).llms('https://x.dev/')).error.code, 'timeout');
  clearTimeout(keepAlive);
  assert.ok(Date.now() - started < LLMS_TIMEOUT_MS + 5000);
  assert.equal((await createLibrary({ baseUrl: '' }).llms('https://x.dev/')).ok, false);
});

test('GET /v1/sites/index sends If-None-Match and reads 304 as unchanged', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers['if-none-match']);
    return init.headers['if-none-match'] === '"v1"' ? new Response(null, { status: 304 }) : new Response(JSON.stringify({ sites: [], llms: { 'hono.dev': 1 } }), { status: 200, headers: { etag: '"v1"' } });
  };
  const lib = createLibrary({ baseUrl: 'https://api.scoop.md/v1', installId: ID, client: 't', fetchImpl });
  const first = await lib.sitesIndex(null);
  assert.deepEqual(first.data.llms, { 'hono.dev': 1 });
  assert.equal(first.etag, '"v1"');
  assert.equal((await lib.sitesIndex('"v1"')).notModified, true);
  assert.deepEqual(seen, [undefined, '"v1"']);
});

test('the library URL is fixed; only unpacked installs honour devLibraryUrl', async () => {
  const fake = (installType, local = {}) => ({
    management: { getSelf: async () => { if (!installType) throw new Error('no management'); return { installType }; } },
    storage: { local: { get: async () => local }, sync: { remove: async () => {} } },
  });
  const dev = { devLibraryUrl: 'http://localhost:8787/v1' };
  assert.equal(await libraryUrl(fake('development', dev)), 'http://localhost:8787/v1');
  assert.equal(await libraryUrl(fake('development')), DEFAULT_LIBRARY);
  for (const store of ['normal', 'admin', 'sideload', 'other', null]) {
    assert.equal(await libraryUrl(fake(store, dev)), DEFAULT_LIBRARY, String(store));
  }
});
