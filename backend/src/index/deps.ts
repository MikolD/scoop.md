// Wires the indexer to the Worker's bindings.

import type { Env } from '../env.ts';
import { classifyPage } from './classify.ts';
import { workersAiEmbed } from './embed.ts';
import { DEFAULT_DAILY_CAP_USD } from './indexer.ts';
import type { IndexDeps } from './indexer.ts';

export function indexDeps(env: Env): IndexDeps {
  const cap = Number(env.INDEX_DAILY_CAP_USD);
  return {
    db: env.DB,
    bucket: env.SKILLS,
    vectors: env.VECTORS,
    embed: workersAiEmbed(env.AI),
    classify: (page) => {
      if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');
      return classifyPage(page, { apiKey: env.OPENROUTER_API_KEY });
    },
    dailyCapUsd: env.INDEX_DAILY_CAP_USD && Number.isFinite(cap) && cap >= 0 ? cap : DEFAULT_DAILY_CAP_USD,
  };
}
