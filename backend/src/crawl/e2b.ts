// BrowserCrawler on E2B, over its REST API and plain HTTPS to the sandbox (no
// SDK, so it runs in a Worker). The template's start command is the crawler's
// job server (crawler/server.js), already running when the sandbox boots:
//   1. POST {api}/v2/sandboxes  -> sandboxID, domain, trafficAccessToken
//   2. POST https://8080-<id>.<domain>/run { token, job }
//   3. GET  .../status until finished, then GET .../result (the Worker stores
//      it in R2 itself; an optional presigned upload can deliver it instead)
//   4. DELETE {api}/sandboxes/<id>, always
// Public traffic to the sandbox is off, so every call carries the traffic
// token; the per-job token stops pages inside the sandbox from using the
// job server through localhost.

import { assertFetchable } from '../lib/ssrf.ts';
import { readBytes } from './polite.ts';
import type { FetchImpl } from './polite.ts';
import type { BrowserCrawler, CrawlJob, RunHandle, RunState } from './runner.ts';

export const E2B_API = 'https://api.e2b.app';
const JOB_PORT = 8080;
// The crawler caps its own result at 20 MB (crawler/lib.js); the Worker reads
// at most 25 MB, whatever the sandbox claims or sends.
export const MAX_RESULT_BYTES = 25_000_000;
// 25 MB over the E2B proxy at a pessimistic ~1 MB/s, plus margin. Well under
// the collect step's 10-minute timeout.
const RESULT_TIMEOUT_MS = 60_000;
// Per call to the job server while starting: four tries fit comfortably in
// the browser-start step's timeout (create <= 30 s + 4 x 10 s + 3 x 2 s).
const RUN_TIMEOUT_MS = 10_000;
const RUN_ATTEMPTS = 4;
// Hobby plan sandboxes run for at most an hour.
export const MAX_SANDBOX_SECONDS = 3600;
// Template resources (crawler/package.json, template:build) and E2B's
// per-second prices: $0.000014 per vCPU, $0.0000045 per GiB of memory.
const VCPUS = 2;
const MEMORY_GIB = 2;
export const E2B_USD_PER_SECOND = VCPUS * 0.000014 + MEMORY_GIB * 0.0000045;
// Sandbox spend per UTC day (E2B_DAILY_CAP_USD); a browser crawl that would
// go over it fails before its sandbox starts (CrawlStore.reserveBrowser).
export const DEFAULT_E2B_DAILY_CAP_USD = 2;

export function e2bDailyCap(env: { E2B_DAILY_CAP_USD?: string }): number {
  const n = Number(env.E2B_DAILY_CAP_USD);
  return env.E2B_DAILY_CAP_USD && Number.isFinite(n) && n >= 0 ? n : DEFAULT_E2B_DAILY_CAP_USD;
}

export interface E2BOptions {
  apiKey: string;
  templateId: string;
  fetchImpl?: FetchImpl;
  apiBase?: string;
  sleep?: (ms: number) => Promise<void>;
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class E2BCrawler implements BrowserCrawler {
  o: Required<Omit<E2BOptions, 'fetchImpl'>> & { fetchImpl: FetchImpl };

  constructor(o: E2BOptions) {
    this.o = {
      apiBase: E2B_API,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...o,
      fetchImpl: o.fetchImpl ?? ((input, init) => fetch(input, init)),
    };
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    // Every outbound fetch goes through the SSRF guard, E2B's included.
    assertFetchable(url);
    return this.o.fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000), ...init });
  }

  private api(path: string, init: RequestInit = {}) {
    return this.call(`${this.o.apiBase}${path}`, {
      ...init,
      headers: { 'x-api-key': this.o.apiKey, 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    });
  }

  private job(h: RunHandle, path: string, init: RequestInit = {}) {
    const d = h.data!;
    return this.call(`https://${JOB_PORT}-${h.id}.${d.domain}${path}`, {
      ...init,
      headers: {
        'e2b-traffic-access-token': d.traffic,
        authorization: `Bearer ${d.token}`,
        'content-type': 'application/json',
        ...(init.headers as Record<string, string>),
      },
    });
  }

  // `tag` (the crawl run ID) goes into the sandbox metadata, so stopTagged()
  // can find and kill every sandbox a run created, including orphans from a
  // retried step.
  async start(job: CrawlJob, tag = ''): Promise<RunHandle> {
    const timeout = Math.min(MAX_SANDBOX_SECONDS, Math.ceil(job.budget.maxMinutes * 60) + 180);
    const res = await this.api('/v2/sandboxes', {
      method: 'POST',
      body: JSON.stringify({
        templateID: this.o.templateId,
        timeout,
        autoPause: false,
        secure: true,
        network: { allowPublicTraffic: false },
        metadata: { purpose: 'scoop-crawl', site: job.site, runId: tag },
      }),
    });
    if (!res.ok) throw new Error(`E2B create failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const sb = (await res.json()) as { sandboxID: string; domain?: string | null; trafficAccessToken?: string | null };
    const handle: RunHandle = {
      id: sb.sandboxID,
      startedAt: Date.now(),
      data: { domain: sb.domain || 'e2b.app', traffic: sb.trafficAccessToken ?? '', token: randomToken() },
    };
    try {
      // The job server is snapshotted as running, but the proxy route can take
      // a moment to appear after create.
      let last = '';
      for (let attempt = 0; attempt < RUN_ATTEMPTS; attempt++) {
        if (attempt) await this.o.sleep(2000);
        try {
          const r = await this.job(handle, '/run', {
            method: 'POST',
            body: JSON.stringify({ token: handle.data!.token, job }),
            signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
          });
          if (r.status === 202) return handle;
          last = `HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
          if (r.status === 400 || r.status === 409) break;
        } catch (e) {
          last = (e as Error).message;
        }
      }
      throw new Error(`crawler did not accept the job: ${last}`);
    } catch (e) {
      await this.stop(handle);
      throw e;
    }
  }

  // Auth failures (401/403 from E2B's API or proxy) throw: retrying won't fix
  // a revoked key or a wrong traffic token, and 'running' would poll forever.
  async poll(h: RunHandle): Promise<RunState> {
    let r: Response | null = null;
    try {
      r = await this.job(h, '/status');
    } catch {
      // network trouble: ask the API whether the sandbox still exists
    }
    if (r) {
      if (r.ok) {
        const s = (await r.json()) as { state: string };
        return s.state === 'finished' || s.state === 'failed' ? 'finished' : 'running';
      }
      await r.body?.cancel();
      if (r.status === 401 || r.status === 403) throw new Error(`E2B refused the job server call: HTTP ${r.status}`);
    }
    const info = await this.api(`/sandboxes/${encodeURIComponent(h.id)}`);
    await info.body?.cancel();
    if (info.status === 401 || info.status === 403) throw new Error(`E2B refused the API key: HTTP ${info.status}`);
    return info.status === 404 ? 'gone' : 'running';
  }

  // Kills every live sandbox whose metadata carries this run ID. Returns how
  // many were killed.
  async stopTagged(tag: string): Promise<number> {
    const q = new URLSearchParams({ metadata: `runId=${tag}`, state: 'running,paused' });
    const r = await this.api(`/v2/sandboxes?${q}`);
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error(`E2B list failed: HTTP ${r.status}`);
    }
    const list = (await r.json()) as { sandboxID: string; metadata?: Record<string, string> }[];
    let n = 0;
    for (const sb of list) {
      if (sb.metadata?.runId !== tag) continue; // never trust a filter we can check
      await this.stop({ id: sb.sandboxID, startedAt: 0 });
      n++;
    }
    return n;
  }

  // Status details for logs and errors.
  async status(h: RunHandle): Promise<{ state: string; pages: number; error: string | null; uploaded: boolean } | null> {
    try {
      const r = await this.job(h, '/status');
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  // The crawl result, read from the job server: streamed with a byte cap and
  // its own timeout, so a hostile or broken sandbox can't exhaust the Worker.
  async result(h: RunHandle): Promise<string | null> {
    const r = await this.job(h, '/result', { signal: AbortSignal.timeout(RESULT_TIMEOUT_MS) });
    if (!r.ok || !r.body) {
      await r.body?.cancel();
      return null;
    }
    if (!/^application\/json\b/i.test(r.headers.get('content-type') ?? '')) {
      await r.body.cancel();
      throw new Error('crawl result is not application/json');
    }
    if (Number(r.headers.get('content-length')) > MAX_RESULT_BYTES) {
      await r.body.cancel();
      throw new Error(`crawl result is over ${MAX_RESULT_BYTES} bytes`);
    }
    const { bytes, over } = await readBytes(r, MAX_RESULT_BYTES);
    if (over) throw new Error(`crawl result is over ${MAX_RESULT_BYTES} bytes`);
    return new TextDecoder().decode(bytes);
  }

  async stop(h: RunHandle): Promise<void> {
    const r = await this.api(`/sandboxes/${encodeURIComponent(h.id)}`, { method: 'DELETE' });
    await r.body?.cancel();
    if (!r.ok && r.status !== 404) throw new Error(`E2B kill failed: HTTP ${r.status}`);
  }
}
