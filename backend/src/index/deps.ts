// Wires the indexer to the Worker's bindings.

import type { Env } from '../env.ts';
import { classifyPage } from './classify.ts';
import { workersAiEmbed } from './embed.ts';
import { DEFAULT_DAILY_CAP_USD, DEFAULT_TOTAL_CAP_USD } from './indexer.ts';
import type { IndexDeps } from './indexer.ts';

function usd(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function indexDeps(env: Env): IndexDeps {
  const apiKey = env.OPENROUTER_API_KEY;
  return {
    db: env.DB,
    bucket: env.SKILLS,
    vectors: env.VECTORS,
    embed: workersAiEmbed(env.AI),
    // Without a key, pages are indexed unclassified, as when the cap is reached.
    classify: apiKey ? (page) => classifyPage(page, { apiKey }) : null,
    dailyCapUsd: usd(env.INDEX_DAILY_CAP_USD, DEFAULT_DAILY_CAP_USD),
    totalCapUsd: usd(env.INDEX_DAILY_TOTAL_CAP_USD, DEFAULT_TOTAL_CAP_USD),
  };
}
