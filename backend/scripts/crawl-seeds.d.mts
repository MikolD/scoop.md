// Types for the tests (test/crawl-seeds.test.ts) of crawl-seeds.mjs.

export const APIS: Record<'staging' | 'production' | 'local', string>;
export const DEFAULT_SEEDS: string;
export const FINAL: Set<string>;
export class UsageError extends Error {}

export interface Options {
  env: 'staging' | 'production' | 'local';
  api: string;
  token: string | null;
  only: string[] | null;
  maxPages: number | null;
  concurrency: number;
  force: boolean;
  dryRun: boolean;
  out: string | null;
  seeds: string;
  urls: string[];
  pollMs: number;
  timeoutMs: number;
  waitIndexingMs: number;
}

export interface RunCosts {
  browserUsd: number;
  gateUsd: number;
  classifyUsd: number;
  embedUsd: number;
  totalUsd: number;
  pagesStored: number;
  pagesIndexed: number;
  perPageUsd: number | null;
  indexingDone: boolean;
  tracked: boolean;
}

export interface Seed {
  name?: string;
  site?: string;
  startUrl: string;
  maxPages?: number;
}

export interface Job {
  name: string;
  site: string;
  startUrl: string;
  maxPages: number;
}

export interface Result {
  name: string;
  site: string;
  startUrl: string;
  maxPages: number;
  runId: string | null;
  status: string;
  path: string | null;
  pages: { new: number; changed: number; unchanged: number; failed: number; skipped: number };
  gate: { decision: string; category: string | null; method: string; reason: string | null; costUsd: number } | null;
  forced: boolean;
  costUsd: number;
  costs: RunCosts | null;
  error: string | null;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export function parseArgs(argv: string[], env?: Record<string, string | undefined>): Options;
export function loadSeeds(path: string): Seed[];
export function selectJobs(seeds: Seed[], o: Pick<Options, 'urls' | 'only' | 'maxPages'>): Job[];
export function crawlAll(
  jobs: Job[],
  o: {
    api: string;
    token: string | null;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    concurrency?: number;
    pollMs?: number;
    retryMs?: number;
    maxAttempts?: number;
    timeoutMs?: number;
    force?: boolean;
    onUpdate?: (results: Result[]) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<{ results: Result[]; maxInFlight: number }>;
export function refreshCosts(
  results: Result[],
  o: {
    api: string;
    token: string | null;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    pollMs?: number;
    waitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<void>;
export function table(rows: Result[]): string;
export function summary(results: Result[]): string;
