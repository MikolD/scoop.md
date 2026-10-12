// Wires the indexer to the Worker's bindings.

import type { Env } from '../env.ts';
import { CLASSIFY_BUDGET_MS, classifyPage } from './classify.ts';
import { workersAiEmbed } from './embed.ts';
import { classifyWithJev } from './jevclassify.ts';
import { usdPerMTok } from '../lib/jev.ts';
import { DEFAULT_DAILY_CAP_USD, DEFAULT_JEV_DAILY_TOKEN_CAP, DEFAULT_TOTAL_CAP_USD, jevAllowance } from './indexer.ts';
import type { IndexDeps } from './indexer.ts';

function usd(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : fallback;
}

// The page classifier: Jev with code heuristics by default, OpenRouter only
// when CLASSIFIER=openrouter. Null without the chosen one's key: pages are
// then indexed unclassified, as when the cap is reached.
export function pageClassifier(env: Env): IndexDeps['classify'] {
  if (env.CLASSIFIER === 'openrouter') {
    const apiKey = env.OPENROUTER_API_KEY;
    return apiKey ? (page) => classifyPage(page, { apiKey, signal: AbortSignal.timeout(CLASSIFY_BUDGET_MS) }) : null;
  }
  const apiKey = env.JEV_API_KEY;
  const price = usdPerMTok(env.JEV_USD_PER_MTOK);
  const allow = jevAllowance(env.DB, jevTokenCap(env));
  return apiKey ? (page) => classifyWithJev(page, { apiKey, usdPerMTok: price, allow }) : null;
}

export function jevTokenCap(env: Env): number {
  const n = Number(env.JEV_DAILY_TOKEN_CAP);
  return env.JEV_DAILY_TOKEN_CAP && Number.isFinite(n) && n >= 0 ? n : DEFAULT_JEV_DAILY_TOKEN_CAP;
}

export function indexDeps(env: Env): IndexDeps {
  return {
    db: env.DB,
    bucket: env.SKILLS,
    vectors: env.VECTORS,
    embed: workersAiEmbed(env.AI),
    classify: pageClassifier(env),
    dailyCapUsd: usd(env.INDEX_DAILY_CAP_USD, DEFAULT_DAILY_CAP_USD),
    totalCapUsd: usd(env.INDEX_DAILY_TOTAL_CAP_USD, DEFAULT_TOTAL_CAP_USD),
    jevTokenCap: jevTokenCap(env),
  };
}
