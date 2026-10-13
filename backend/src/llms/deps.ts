// What the llms.txt registry needs from the Worker's environment, for a
// request (src/api/v1.ts adds the request's own parts), the hourly cron and
// a crawl's `llms` step: Jev (within the daily token cap, its spend
// recorded) and the per-host probe budget, keyed on the docs host.

import type { Env } from '../env.ts';
import { jevTokenCap } from '../index/deps.ts';
import { addCost, jevAllowance } from '../index/indexer.ts';
import { jevCostUsd, usdPerMTok } from '../lib/jev.ts';
import type { LlmsDeps } from './registry.ts';

export function llmsBaseDeps(env: Env): LlmsDeps {
  return {
    db: env.DB,
    bucket: env.SKILLS,
    publicBase: env.LLMS_PUBLIC_BASE || undefined,
    allowLocalhost: env.ENVIRONMENT === 'dev' && env.ALLOW_LOCALHOST === '1',
    quick: { jev: env.JEV_API_KEY ? { apiKey: env.JEV_API_KEY, allow: jevAllowance(env.DB, jevTokenCap(env)) } : null },
    recordJev: (host, tokens) => addCost(env.DB, host, new Date(), jevCostUsd(tokens, usdPerMTok(env.JEV_USD_PER_MTOK)), tokens),
    probeHost: async (host) => !env.PROBE_HOST_LIMITER || (await env.PROBE_HOST_LIMITER.limit({ key: host })).success,
  };
}
