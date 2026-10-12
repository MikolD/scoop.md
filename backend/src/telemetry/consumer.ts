// Queue consumer for `telemetry-events`, writing to TELEMETRY_DB (never the
// library's DB). Each message is a batch of rows from ingest.ts. For a queue
// batch: events of deleted installs are dropped; the daily quotas decide what
// is kept (quota()); the kept rows are archived to R2 (one object per receive
// hour, without ip_hash); then each message is written to D1 in one
// transaction: the raw events (a known ID is ignored), the quota counters,
// the daily rollups, install days, the installs table, opt-out state and
// uninstalls. The consumer runs one batch at a time (max_concurrency 1), so
// the quotas are exact; a redelivered message can count twice toward them.

import { backoffSeconds } from '../index/consumer.ts';
import type { Env } from '../env.ts';
import { writeArchive } from './archive.ts';
import type { TelemetryMessage, TelemetryRow } from './ingest.ts';
import { LIFECYCLE } from './schema.ts';

export const RAW_RETENTION_DAYS = 180;
export const IP_HASH_RETENTION_DAYS = 30;

// Daily quotas (by received UTC day). Over a quota the event is dropped.
export const QUOTAS = {
  newInstallsPerIp: 20, // distinct install IDs per ip_hash
  eventsPerInstall: 2_000,
  eventsPerIp: 20_000,
};
export const DEFAULT_DAILY_MAX = 2_000_000; // all events; above it, lifecycle events only
export const LIFECYCLE_FACTOR = 3; // lifecycle events stop too at 3 × the daily ceiling
export const DEFAULT_API_DAILY_MAX = 200_000; // API usage rows

export const COLUMNS = [
  'id', 'source', 'name', 'ts', 'day', 'received_at', 'install_id', 'session_id', 'visitor_id', 'seq', 'site', 'path',
  'outcome', 'props', 'ext_version', 'browser', 'browser_version', 'os', 'arch', 'locale', 'timezone', 'ua_browser',
  'ua_os', 'country', 'region', 'continent', 'as_org', 'ip_hash',
] as const satisfies readonly (keyof TelemetryRow)[];

export function parseTelemetryMessage(body: unknown): TelemetryRow[] {
  const m = body as Partial<TelemetryMessage> | null;
  if (m?.v !== 1 || !Array.isArray(m.rows)) throw new Error('not a telemetry message');
  for (const r of m.rows) {
    if (typeof r?.id !== 'string' || typeof r.name !== 'string' || typeof r.ts !== 'string' || typeof r.received_at !== 'string') {
      throw new Error('telemetry row needs id, name, ts and received_at');
    }
  }
  return m.rows;
}

// Install IDs that asked for their data to be deleted.
async function deletedOf(db: D1Database, rows: TelemetryRow[]): Promise<Set<string>> {
  const ids = [...new Set(rows.map((r) => r.install_id).filter((x): x is string => Boolean(x)))];
  if (!ids.length) return new Set();
  const { results } = await db
    .prepare('SELECT install_id FROM telemetry_deletions WHERE install_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(ids))
    .all<{ install_id: string }>();
  return new Set(results.map((r) => r.install_id));
}

type Kind = 'ip_events' | 'install_events' | 'all_events' | 'api_rows';
const dayOf = (r: TelemetryRow) => r.received_at.slice(0, 10);
const k = (day: string, kind: Kind, subject: string) => `${day}|${kind}|${subject}`;

export interface QuotaState {
  counts: Map<string, number>;   // k(day, kind, subject) → count so far today
  ipInstalls: Map<string, Set<string>>; // `${day}|${ip_hash}` → install IDs seen
}

export interface Limits {
  dailyMax: number;
  apiDailyMax: number;
}

export const limitsOf = (env: Pick<Env, 'TELEMETRY_DAILY_MAX' | 'TELEMETRY_API_DAILY_MAX'>): Limits => {
  const n = (v: string | undefined, d: number) => (v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return { dailyMax: n(env.TELEMETRY_DAILY_MAX, DEFAULT_DAILY_MAX), apiDailyMax: n(env.TELEMETRY_API_DAILY_MAX, DEFAULT_API_DAILY_MAX) };
};

// Today's counters for every day, IP hash and install in the batch.
export async function loadQuotaState(db: D1Database, rows: TelemetryRow[]): Promise<QuotaState> {
  const days = [...new Set(rows.map(dayOf))];
  const installs = [...new Set(rows.map((r) => r.install_id).filter(Boolean))];
  const ips = [...new Set(rows.map((r) => r.ip_hash).filter(Boolean))];
  const [counters, seen] = await db.batch([
    db.prepare(
      `SELECT day, kind, subject, count FROM quota_counters WHERE day IN (SELECT value FROM json_each(?1)) AND (
         kind IN ('all_events', 'api_rows')
         OR (kind = 'install_events' AND subject IN (SELECT value FROM json_each(?2)))
         OR (kind = 'ip_events' AND subject IN (SELECT value FROM json_each(?3))))`,
    ).bind(JSON.stringify(days), JSON.stringify(installs), JSON.stringify(ips)),
    db.prepare('SELECT day, ip_hash, install_id FROM ip_installs WHERE day IN (SELECT value FROM json_each(?1)) AND ip_hash IN (SELECT value FROM json_each(?2))')
      .bind(JSON.stringify(days), JSON.stringify(ips)),
  ]);
  const counts = new Map<string, number>();
  for (const c of counters.results as { day: string; kind: Kind; subject: string; count: number }[]) counts.set(k(c.day, c.kind, c.subject), c.count);
  const ipInstalls = new Map<string, Set<string>>();
  for (const s of seen.results as { day: string; ip_hash: string; install_id: string }[]) {
    const key = `${s.day}|${s.ip_hash}`;
    ipInstalls.set(key, (ipInstalls.get(key) ?? new Set()).add(s.install_id));
  }
  return { counts, ipInstalls };
}

export type Cap = 'new_installs_per_ip' | 'events_per_install' | 'events_per_ip' | 'daily_max' | 'lifecycle_max' | 'api_daily_max';

export interface Kept {
  rows: TelemetryRow[];
  deltas: Map<string, number>;
  newIpInstalls: [string, string, string][]; // day, ip_hash, install_id
  dropped: number;
  caps: Set<string>; // `${day}|${cap}` for every cap that dropped an event
}

// Applies the quotas to one message's rows, in order, updating `state`.
export function quota(rows: TelemetryRow[], state: QuotaState, limits: Limits): Kept {
  const out: Kept = { rows: [], deltas: new Map(), newIpInstalls: [], dropped: 0, caps: new Set() };
  const drop = (day: string, cap: Cap) => {
    out.dropped++;
    out.caps.add(`${day}|${cap}`);
  };
  const get = (key: string) => (state.counts.get(key) ?? 0);
  const bump = (key: string) => {
    state.counts.set(key, get(key) + 1);
    out.deltas.set(key, (out.deltas.get(key) ?? 0) + 1);
  };
  for (const r of rows) {
    const day = dayOf(r);
    if (r.source === 'api') {
      if (get(k(day, 'api_rows', '')) >= limits.apiDailyMax) { drop(day, 'api_daily_max'); continue; }
      bump(k(day, 'api_rows', ''));
      out.rows.push(r);
      continue;
    }
    const all = get(k(day, 'all_events', ''));
    if (all >= limits.dailyMax * LIFECYCLE_FACTOR) { drop(day, 'lifecycle_max'); continue; }
    if (all >= limits.dailyMax && !LIFECYCLE.has(r.name)) { drop(day, 'daily_max'); continue; }
    if (r.install_id && get(k(day, 'install_events', r.install_id)) >= QUOTAS.eventsPerInstall) { drop(day, 'events_per_install'); continue; }
    if (r.ip_hash && get(k(day, 'ip_events', r.ip_hash)) >= QUOTAS.eventsPerIp) { drop(day, 'events_per_ip'); continue; }
    if (r.ip_hash && r.install_id && r.source === 'extension') {
      const key = `${day}|${r.ip_hash}`;
      const seen = state.ipInstalls.get(key) ?? new Set<string>();
      if (!seen.has(r.install_id)) {
        if (seen.size >= QUOTAS.newInstallsPerIp) { drop(day, 'new_installs_per_ip'); continue; }
        seen.add(r.install_id);
        state.ipInstalls.set(key, seen);
        out.newIpInstalls.push([day, r.ip_hash, r.install_id]);
      }
    }
    bump(k(day, 'all_events', ''));
    if (r.install_id) bump(k(day, 'install_events', r.install_id));
    if (r.ip_hash) bump(k(day, 'ip_events', r.ip_hash));
    out.rows.push(r);
  }
  return out;
}

const ROLLING = `FROM events WHERE rolled = 0`;
const CLIENT = ['ext_version', 'browser', 'browser_version', 'os', 'arch', 'locale', 'timezone', 'country'];
const TOGGLES = `('telemetry_opt_out', 'telemetry_opt_in')`;

// One transaction: rows in, quota counters, everything derived from them, rows marked rolled.
export async function writeRows(db: D1Database, kept: Pick<Kept, 'rows' | 'deltas' | 'newIpInstalls'>): Promise<void> {
  const { rows } = kept;
  if (!rows.length) return;
  const json = JSON.stringify(rows.map((r) => Object.fromEntries(COLUMNS.map((c) => [c, r[c] ?? null]))));
  const deltas = [...kept.deltas].map(([key, n]) => [...key.split('|'), n]);
  // The latest event's value per install (by ts), not the largest string.
  const latest = (c: string) => `(SELECT l.${c} FROM events l WHERE l.rolled = 0 AND l.install_id = events.install_id AND l.source = 'extension' ORDER BY l.ts DESC, l.seq DESC LIMIT 1)`;
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO events (${COLUMNS.join(', ')})
       SELECT ${COLUMNS.map((c) => `json_extract(j.value, '$.${c}')`).join(', ')} FROM json_each(?1) j
       WHERE json_extract(j.value, '$.install_id') IS NULL
          OR json_extract(j.value, '$.install_id') NOT IN (SELECT install_id FROM telemetry_deletions)`,
    ).bind(json),
    db.prepare(
      `INSERT INTO quota_counters (day, kind, subject, count)
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?1) WHERE true
       ON CONFLICT (day, kind, subject) DO UPDATE SET count = count + excluded.count`,
    ).bind(JSON.stringify(deltas)),
    db.prepare(
      `INSERT OR IGNORE INTO ip_installs (day, ip_hash, install_id)
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?1)`,
    ).bind(JSON.stringify(kept.newIpInstalls)),
    db.prepare(
      `INSERT INTO events_daily (day, source, name, site, country, version, outcome, count)
       SELECT day, source, name, COALESCE(site, ''), COALESCE(country, ''), COALESCE(ext_version, ''), COALESCE(outcome, ''), COUNT(*)
       ${ROLLING} GROUP BY 1, 2, 3, 4, 5, 6, 7
       ON CONFLICT (day, source, name, site, country, version, outcome) DO UPDATE SET count = count + excluded.count`,
    ),
    // The day the server received it: a client clock can't put activity in the future.
    db.prepare(`INSERT OR IGNORE INTO install_days (install_id, day) SELECT DISTINCT install_id, substr(received_at, 1, 10) ${ROLLING} AND source = 'extension' AND install_id IS NOT NULL`),
    // The latest client details win, even when an older batch arrives late.
    db.prepare(
      `INSERT INTO installs (install_id, first_seen, last_seen, installed_at, ${CLIENT.join(', ')}, events, scoops, copies)
       SELECT install_id, MIN(ts), MAX(ts), MIN(CASE WHEN name = 'install' THEN ts END),
              ${CLIENT.map(latest).join(', ')},
              COUNT(*), SUM(name = 'scoop_result'), SUM(name = 'copy')
       ${ROLLING} AND source = 'extension' AND install_id IS NOT NULL GROUP BY install_id
       ON CONFLICT (install_id) DO UPDATE SET
         first_seen = MIN(installs.first_seen, excluded.first_seen),
         installed_at = COALESCE(installs.installed_at, excluded.installed_at),
         ${CLIENT.map((c) => `${c} = CASE WHEN excluded.last_seen >= installs.last_seen THEN COALESCE(excluded.${c}, installs.${c}) ELSE installs.${c} END`).join(',\n         ')},
         last_seen = MAX(installs.last_seen, excluded.last_seen),
         events = installs.events + excluded.events,
         scoops = installs.scoops + excluded.scoops,
         copies = installs.copies + excluded.copies`,
    ),
    // Opt-out state: the newest toggle wins, across batches (opted_changed_at).
    db.prepare(
      `UPDATE installs SET (opted_out, opted_out_at, opted_changed_at) = (
         SELECT e.name = 'telemetry_opt_out', CASE WHEN e.name = 'telemetry_opt_out' THEN e.ts END, e.ts
         FROM events e WHERE e.rolled = 0 AND e.install_id = installs.install_id AND e.name IN ${TOGGLES}
         ORDER BY e.ts DESC, e.seq DESC LIMIT 1)
       WHERE EXISTS (SELECT 1 FROM events e WHERE e.rolled = 0 AND e.install_id = installs.install_id AND e.name IN ${TOGGLES}
                     AND (installs.opted_changed_at IS NULL OR e.ts > installs.opted_changed_at))`,
    ),
    // From scoop.md/bye. Never creates an installs row: unknown IDs are kept apart (known = 0).
    db.prepare(
      `INSERT INTO uninstalls (install_id, uninstalled_at, reason, version, known)
       SELECT install_id, MIN(ts), MAX(CASE WHEN name = 'uninstall_reason' THEN outcome END), MAX(ext_version),
              EXISTS (SELECT 1 FROM installs i WHERE i.install_id = events.install_id)
       ${ROLLING} AND source = 'site' AND install_id IS NOT NULL AND name IN ('uninstall', 'uninstall_reason') GROUP BY install_id
       ON CONFLICT (install_id) DO UPDATE SET
         uninstalled_at = MIN(uninstalls.uninstalled_at, excluded.uninstalled_at),
         reason = COALESCE(excluded.reason, uninstalls.reason),
         known = MAX(uninstalls.known, excluded.known)`,
    ),
    db.prepare(
      `UPDATE installs SET
         uninstalled_at = (SELECT u.uninstalled_at FROM uninstalls u WHERE u.install_id = installs.install_id),
         uninstall_reason = (SELECT u.reason FROM uninstalls u WHERE u.install_id = installs.install_id)
       WHERE install_id IN (SELECT install_id ${ROLLING} AND source = 'site' AND name IN ('uninstall', 'uninstall_reason'))`,
    ),
    db.prepare('UPDATE events SET rolled = 1 WHERE rolled = 0'),
  ]);
}

export async function handleTelemetryBatch(batch: MessageBatch<unknown>, env: Pick<Env, 'TELEMETRY_DB' | 'TELEMETRY' | 'TELEMETRY_DAILY_MAX' | 'TELEMETRY_API_DAILY_MAX'>): Promise<void> {
  const queue = batch.queue;
  const db = env.TELEMETRY_DB;
  const parsed: { msg: Message<unknown>; rows: TelemetryRow[]; kept?: Kept }[] = [];
  for (const msg of batch.messages) {
    try {
      parsed.push({ msg, rows: parseTelemetryMessage(msg.body) });
    } catch (e) {
      console.error(JSON.stringify({ queue, status: 'dropped', error: e instanceof Error ? e.message : String(e) }));
      msg.ack();
    }
  }
  if (!parsed.length) return;

  let dropped = 0;
  const caps = new Set<string>();
  try {
    const deleted = await deletedOf(db, parsed.flatMap((p) => p.rows));
    for (const p of parsed) p.rows = p.rows.filter((r) => !r.install_id || !deleted.has(r.install_id));
    const state = await loadQuotaState(db, parsed.flatMap((p) => p.rows));
    const limits = limitsOf(env);
    for (const p of parsed) {
      p.kept = quota(p.rows, state, limits);
      dropped += p.kept.dropped;
      for (const c of p.kept.caps) caps.add(c);
    }
    const all = parsed.flatMap((p) => p.kept!.rows);
    if (all.length) await writeArchive(env.TELEMETRY, all);
  } catch (e) {
    // Nothing is in D1 yet: retry the whole batch.
    const attempts = Math.max(...parsed.map((p) => p.msg.attempts));
    console.error(JSON.stringify({ queue, status: 'retry', stage: 'archive', attempts, error: e instanceof Error ? e.message : String(e) }));
    for (const p of parsed) p.msg.retry({ delaySeconds: backoffSeconds(p.msg.attempts) });
    return;
  }

  let events = 0;
  for (const { msg, kept } of parsed) {
    try {
      await writeRows(db, kept!);
      events += kept!.rows.length;
      msg.ack();
    } catch (e) {
      console.error(JSON.stringify({ queue, status: 'retry', stage: 'd1', attempts: msg.attempts, error: e instanceof Error ? e.message : String(e) }));
      msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
    }
  }
  console.log(JSON.stringify({ queue, messages: parsed.length, events, overQuota: dropped }));
  await logCapHits(db, caps, limitsOf(env));
}

// One structured `telemetry_cap_hit` line per cap per UTC day (recorded in
// quota_counters as kind cap_logged, so other batches and isolates stay quiet).
export async function logCapHits(db: D1Database, caps: Set<string>, limits: Limits): Promise<number> {
  let logged = 0;
  for (const c of caps) {
    const [day, cap] = c.split('|');
    try {
      const first = await db
        .prepare(`INSERT OR IGNORE INTO quota_counters (day, kind, subject, count) VALUES (?, 'cap_logged', ?, 1) RETURNING count`)
        .bind(day, cap)
        .first();
      if (!first) continue;
      console.log(JSON.stringify({ event: 'telemetry_cap_hit', day, cap, dailyMax: limits.dailyMax, apiDailyMax: limits.apiDailyMax, quotas: QUOTAS }));
      logged++;
    } catch (e) {
      console.error(JSON.stringify({ event: 'telemetry_cap_hit', day, cap, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  return logged;
}

// Deletes in chunks of 5000 until a chunk comes back short (at most `rounds`).
async function chunked(db: D1Database, sql: string, param: string, rounds = 400): Promise<number> {
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    const n = (await db.prepare(sql).bind(param).run()).meta.changes ?? 0;
    total += n;
    if (n < 5000) break;
  }
  return total;
}

// Hourly cron: raw events past 180 days leave D1 (rollups, install days and
// the R2 archive stay); ip_hash is cleared after 30 days; day keys older than
// 48 hours and quota rows older than 2 days are deleted.
export async function pruneTelemetry(db: D1Database, now = new Date()) {
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const day = (days: number) => ago(days).slice(0, 10);
  const events = await chunked(db, 'DELETE FROM events WHERE id IN (SELECT id FROM events WHERE received_at < ? LIMIT 5000)', ago(RAW_RETENTION_DAYS));
  const ipHashes = await chunked(db, 'UPDATE events SET ip_hash = NULL WHERE id IN (SELECT id FROM events WHERE received_at < ? AND ip_hash IS NOT NULL LIMIT 5000)', ago(IP_HASH_RETENTION_DAYS));
  await db.batch([
    // Today's and yesterday's keys stay (requests near midnight); anything older goes.
    db.prepare('DELETE FROM day_keys WHERE day < ?').bind(day(1)),
    db.prepare('DELETE FROM quota_counters WHERE day < ?').bind(day(2)),
    db.prepare('DELETE FROM ip_installs WHERE day < ?').bind(day(2)),
  ]);
  return { events, ipHashes };
}
