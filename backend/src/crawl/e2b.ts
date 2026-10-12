// BrowserCrawler on E2B, over its REST API and plain HTTPS to the sandbox (no
// SDK, so it runs in a Worker). The template's start command is the crawler's
// job server (crawler/server.js), already running when the sandbox boots:
//   1. POST {api}/v2/sandboxes  -> sandboxID, domain, trafficAccessToken
//   2. POST https://8080-<id>.<domain>/run { token, job }
//   3. GET  .../status until finished; GET .../result only when not uploading
//   4. DELETE {api}/sandboxes/<id>, always
// Public traffic to the sandbox is off, so every call carries the traffic
// token; the per-job token stops pages inside the sandbox from using the
// job server through localhost.

import { assertFetchable } from '../lib/ssrf.ts';
import type { FetchImpl } from './polite.ts';
import type { BrowserCrawler, CrawlJob, RunHandle, RunState } from './runner.ts';

export const E2B_API = 'https://api.e2b.app';
const JOB_PORT = 8080;
// Hobby plan sandboxes run for at most an hour.
export const MAX_SANDBOX_SECONDS = 3600;
// Template resources (crawler/package.json, template:build) and E2B's
// per-second prices: $0.000014 per vCPU, $0.0000045 per GiB of memory.
const VCPUS = 2;
const MEMORY_GIB = 2;
export const E2B_USD_PER_SECOND = VCPUS * 0.000014 + MEMORY_GIB * 0.0000045;

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

  async start(job: CrawlJob): Promise<RunHandle> {
    const timeout = Math.min(MAX_SANDBOX_SECONDS, Math.ceil(job.budget.maxMinutes * 60) + 180);
    const res = await this.api('/v2/sandboxes', {
      method: 'POST',
      body: JSON.stringify({
        templateID: this.o.templateId,
        timeout,
        autoPause: false,
        network: { allowPublicTraffic: false },
        metadata: { purpose: 'scoop-crawl', site: job.site },
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
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) await this.o.sleep(2000);
        try {
          const r = await this.job(handle, '/run', { method: 'POST', body: JSON.stringify({ token: handle.data!.token, job }) });
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

  async poll(h: RunHandle): Promise<RunState> {
    try {
      const r = await this.job(h, '/status');
      if (r.ok) {
        const s = (await r.json()) as { state: string };
        return s.state === 'finished' || s.state === 'failed' ? 'finished' : 'running';
      }
      await r.body?.cancel();
    } catch {
      // fall through to asking the API whether the sandbox still exists
    }
    const info = await this.api(`/sandboxes/${encodeURIComponent(h.id)}`);
    await info.body?.cancel();
    return info.status === 404 ? 'gone' : 'running';
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

  async result(h: RunHandle): Promise<string | null> {
    const r = await this.job(h, '/result');
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    return r.text();
  }

  async stop(h: RunHandle): Promise<void> {
    const r = await this.api(`/sandboxes/${encodeURIComponent(h.id)}`, { method: 'DELETE' });
    await r.body?.cancel();
    if (!r.ok && r.status !== 404) throw new Error(`E2B kill failed: HTTP ${r.status}`);
  }
}
