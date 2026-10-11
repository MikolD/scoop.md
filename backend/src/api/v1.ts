// The v1 API (docs/BACKEND.md §5). Each route names its pattern for the request log.

import { checkHourly } from '../db/ratelimit.ts';
import { Store, summary } from '../db/store.ts';
import { ApiError, notFound } from '../lib/errors.ts';
import { safeEqual } from '../lib/ids.ts';
import { normalizeSite } from '../lib/ssrf.ts';
import { installId, validateFeedback, validateReport, validateSkill } from '../lib/validate.ts';
import { verifyAll } from '../lib/verify.ts';
import type { Env } from '../env.ts';
import { CACHE_BEST, CACHE_LIST, json, readJson } from './http.ts';

export const VERSION = '0.1.0';

// Limits from docs/BACKEND.md §8. Every write is limited by install ID and by IP.
const LIMITS = {
  shareInstall: 20,
  shareIp: 60,
  voteInstall: 120,
  voteIp: 600,
};

interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  params: string[];
  store: Store;
  ip: string;
}

type Handler = (c: Ctx) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  name: string;
  handler: Handler;
}

const allowLocalhost = (env: Env) => env.ALLOW_LOCALHOST === '1';

async function liveRow(store: Store, id: string) {
  const row = await store.getRow(id);
  if (!row) throw notFound('No such skill');
  if (row.removed_at) throw new ApiError('removed', 'This skill was removed', 410);
  return row;
}

async function requireAdmin(c: Ctx): Promise<void> {
  const token = c.env.ADMIN_TOKEN;
  const given = c.req.headers.get('authorization') ?? '';
  // Wrong or missing token looks exactly like an unknown route.
  if (!token || !(await safeEqual(given, `Bearer ${token}`))) throw notFound();
}

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/health$/,
    name: '/v1/health',
    handler: async ({ env }) => json(200, { ok: true, version: env.VERSION || VERSION }),
  },
  {
    method: 'GET',
    pattern: /^\/v1\/skills\/best$/,
    name: '/v1/skills/best',
    handler: async ({ url, store }) => {
      const row = await store.bestRow(normalizeSite(url.searchParams.get('site')));
      return json(200, { skill: row && (await store.load(row)) }, { 'cache-control': CACHE_BEST });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/skills\/([\w-]+)$/,
    name: '/v1/skills/:id',
    handler: async ({ params, store }) => json(200, { skill: await store.load(await liveRow(store, params[0])) }),
  },
  {
    method: 'POST',
    pattern: /^\/v1\/skills$/,
    name: '/v1/skills',
    handler: async ({ req, env, store, ip }) => {
      const install = installId(req.headers.get('x-scoop-install'));
      const skill = validateSkill(await readJson(req), allowLocalhost(env));
      // Limit before the expensive part: outbound verification fetches.
      await checkHourly(env.DB, [
        { bucket: 'share:install', subject: install, limit: LIMITS.shareInstall },
        { bucket: 'share:ip', subject: ip, limit: LIMITS.shareIp },
      ]);
      await verifyAll(skill.sections, skill.site, { allowLocalhost: allowLocalhost(env) });
      const { id, duplicate } = await store.add(skill, install);
      return json(duplicate ? 200 : 201, { id, status: 'verified', duplicate });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/skills\/([\w-]+)\/feedback$/,
    name: '/v1/skills/:id/feedback',
    handler: async ({ req, env, params, store, ip }) => {
      const install = installId(req.headers.get('x-scoop-install'));
      const worked = validateFeedback(await readJson(req));
      await checkHourly(env.DB, [
        { bucket: 'vote:install', subject: install, limit: LIMITS.voteInstall },
        { bucket: 'vote:ip', subject: ip, limit: LIMITS.voteIp },
      ]);
      await liveRow(store, params[0]);
      return json(200, await store.vote(params[0], install, worked));
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/sites$/,
    name: '/v1/sites',
    handler: async ({ url, store }) => {
      const limit = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get('limit'))) || 50));
      const offset = Math.max(0, Math.trunc(Number(url.searchParams.get('cursor'))) || 0);
      const { rows, more } = await store.sites(limit, offset);
      return json(
        200,
        { sites: rows.map((r) => ({ site: r.site, best: summary(r) })), next: more ? String(offset + limit) : null },
        { 'cache-control': CACHE_LIST },
      );
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/sites\/([^/]+)$/,
    name: '/v1/sites/:site',
    handler: async ({ params, store }) => {
      let raw: string;
      try { raw = decodeURIComponent(params[0]); } catch { throw notFound('No skills for this site'); }
      const site = normalizeSite(raw);
      if (!(await store.hasSite(site))) throw notFound('No skills for this site');
      const [best, recent] = await Promise.all([store.bestRow(site), store.recent(site)]);
      return json(200, { site, best: best && summary(best), recent: recent.map(summary) }, { 'cache-control': CACHE_LIST });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/reports$/,
    name: '/v1/reports',
    handler: async ({ req, env, store, ip }) => {
      const install = installId(req.headers.get('x-scoop-install'));
      const report = validateReport(await readJson(req));
      await checkHourly(env.DB, [
        { bucket: 'vote:install', subject: install, limit: LIMITS.voteInstall },
        { bucket: 'vote:ip', subject: ip, limit: LIMITS.voteIp },
      ]);
      if (!(await store.getRow(report.skillId))) throw notFound('No such skill');
      await store.report(report, install);
      return json(202, { ok: true });
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/admin\/skills\/([\w-]+)$/,
    name: '/v1/admin/skills/:id',
    handler: async (c) => {
      await requireAdmin(c);
      if (!(await c.store.getRow(c.params[0]))) throw notFound('No such skill');
      await c.store.remove(c.params[0]);
      return json(200, { ok: true });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/admin\/reports$/,
    name: '/v1/admin/reports',
    handler: async (c) => {
      await requireAdmin(c);
      return json(200, { reports: await c.store.openReports() });
    },
  },
];

export interface Matched {
  name: string;
  run: () => Promise<Response>;
}

// Finds the route for a request. Unknown routes (including admin routes hit with
// the wrong method) are a plain 404.
export function match(req: Request, env: Env, url: URL, ip: string): Matched | null {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    const store = new Store(env.DB, env.SKILLS);
    return { name: r.name, run: () => r.handler({ req, env, url, params: m.slice(1), store, ip }) };
  }
  return null;
}
