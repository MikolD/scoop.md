// The browser crawler behind an interface, so E2B can be swapped for
// Cloudflare Containers or a VPS. A run is started, polled and stopped as
// separate calls (a Workflow sleeps between polls and never holds a
// connection); runCrawl() composes them for callers that can simply wait.

export interface CrawlBudget {
  maxPages: number;
  maxMinutes: number;
}

export interface CrawlJob {
  site: string;
  startUrls: string[];
  budget: CrawlBudget;
  // Where the crawler PUTs its CrawlResult JSON: a presigned, short-lived URL
  // for one object key. The crawler holds no other credentials.
  uploadUrl: string | null;
  docsRoot?: string; // stay under this path ('/' for the whole site)
  robotsTxt?: string; // the site's robots.txt, honoured by the crawler too
  intervalMs?: number; // at least this long between page loads
}

export interface CrawledPage {
  url: string;
  title: string;
  markdown: string;
}

// What the crawler uploads. Untrusted: the Workflow re-checks every field.
export interface CrawlResult {
  site: string;
  pages: CrawledPage[];
  startedAt: string;
  finishedAt: string;
  stoppedBy: 'done' | 'max-pages' | 'max-minutes';
  errors: number;
}

export interface RunHandle {
  id: string; // sandbox / container / job id
  startedAt: number; // ms
  // Implementation-specific data needed to poll or stop the run (no secrets).
  data?: Record<string, string>;
}

export type RunState = 'running' | 'finished' | 'gone';

export interface BrowserCrawler {
  // `tag` labels the run (the crawl run ID) so stopTagged() can find it.
  start(job: CrawlJob, tag?: string): Promise<RunHandle>;
  // 'finished' when the crawler has exited; 'gone' when the run no longer exists.
  poll(handle: RunHandle): Promise<RunState>;
  // Reads the result when the backend can hand it over directly (dev without
  // R2 credentials); null when it was uploaded to `uploadUrl` instead.
  result(handle: RunHandle): Promise<string | null>;
  // Always called, whatever happened. Must be idempotent.
  stop(handle: RunHandle): Promise<void>;
  // Stops every run carrying this tag, including ones whose handle was lost
  // (a step that started a run and then failed before returning it).
  stopTagged(tag: string): Promise<number>;
}

// For callers that can wait (Node scripts, tests): start, poll, read, stop.
export async function runCrawl(
  crawler: BrowserCrawler,
  job: CrawlJob,
  { pollMs = 5000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), readUploaded = async (): Promise<string | null> => null } = {},
): Promise<CrawlResult> {
  const handle = await crawler.start(job);
  try {
    const deadline = handle.startedAt + (job.budget.maxMinutes + 2) * 60_000;
    let state: RunState = 'running';
    while (state === 'running' && Date.now() < deadline) {
      await sleep(pollMs);
      state = await crawler.poll(handle);
    }
    const raw = (await crawler.result(handle)) ?? (await readUploaded());
    if (!raw) throw new Error(`crawl ${handle.id} ended (${state}) without a result`);
    return JSON.parse(raw) as CrawlResult;
  } finally {
    await crawler.stop(handle);
  }
}
