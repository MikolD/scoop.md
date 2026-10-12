// Queue consumer for `telemetry-events`. Each message is a batch of rows from
// ingest.ts. The whole queue batch is archived to R2 first (one object per
// receive hour), then each message is written to D1 in one transaction: the
// raw events (a known ID is ignored), the daily rollups, install days, the
// installs table, opt-out and uninstall state. Events of deleted installs are
// neither archived nor stored.

import { backoffSeconds } from '../index/consumer.ts';
import type { Env } from '../env.ts';
import { writeArchive } from './archive.ts';
import type { TelemetryMessage, TelemetryRow } from './ingest.ts';

export const RAW_RETENTION_DAYS = 180;

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
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT install_id FROM telemetry_deletions WHERE install_id IN (${chunk.map(() => '?').join(', ')})`)
      .bind(...chunk)
      .all<{ install_id: string }>();
    for (const r of results) out.add(r.install_id);
  }
  return out;
}

const ROLLING = `FROM events WHERE rolled = 0`;

// One transaction: rows in, everything derived from them, rows marked rolled.
export async function writeRows(db: D1Database, rows: TelemetryRow[]): Promise<void> {
  if (!rows.length) return;
  const json = JSON.stringify(rows.map((r) => Object.fromEntries(COLUMNS.map((c) => [c, r[c] ?? null]))));
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO events (${COLUMNS.join(', ')})
       SELECT ${COLUMNS.map((c) => `json_extract(j.value, '$.${c}')`).join(', ')} FROM json_each(?1) j
       WHERE json_extract(j.value, '$.install_id') IS NULL
          OR json_extract(j.value, '$.install_id') NOT IN (SELECT install_id FROM telemetry_deletions)`,
    ).bind(json),
    db.prepare(
      `INSERT INTO events_daily (day, source, name, site, country, version, outcome, count)
       SELECT day, source, name, COALESCE(site, ''), COALESCE(country, ''), COALESCE(ext_version, ''), COALESCE(outcome, ''), COUNT(*)
       ${ROLLING} GROUP BY 1, 2, 3, 4, 5, 6, 7
       ON CONFLICT (day, source, name, site, country, version, outcome) DO UPDATE SET count = count + excluded.count`,
    ),
    db.prepare(`INSERT OR IGNORE INTO install_days (install_id, day) SELECT DISTINCT install_id, day ${ROLLING} AND source = 'extension' AND install_id IS NOT NULL`),
    // The latest client details win, even when an older batch arrives late.
    db.prepare(
      `INSERT INTO installs (install_id, first_seen, last_seen, installed_at, ext_version, browser, browser_version, os, arch, locale, timezone, country, events, scoops, copies)
       SELECT install_id, MIN(ts), MAX(ts), MIN(CASE WHEN name = 'install' THEN ts END),
              MAX(ext_version), MAX(browser), MAX(browser_version), MAX(os), MAX(arch), MAX(locale), MAX(timezone), MAX(country),
              COUNT(*), SUM(name = 'scoop_result'), SUM(name = 'copy')
       ${ROLLING} AND source = 'extension' AND install_id IS NOT NULL GROUP BY install_id
       ON CONFLICT (install_id) DO UPDATE SET
         first_seen = MIN(installs.first_seen, excluded.first_seen),
         installed_at = COALESCE(installs.installed_at, excluded.installed_at),
         ${['ext_version', 'browser', 'browser_version', 'os', 'arch', 'locale', 'timezone', 'country']
           .map((c) => `${c} = CASE WHEN excluded.last_seen >= installs.last_seen THEN COALESCE(excluded.${c}, installs.${c}) ELSE installs.${c} END`)
           .join(',\n         ')},
         last_seen = MAX(installs.last_seen, excluded.last_seen),
         events = installs.events + excluded.events,
         scoops = installs.scoops + excluded.scoops,
         copies = installs.copies + excluded.copies`,
    ),
    // The last opt-out or opt-in decides.
    db.prepare(
      `UPDATE installs SET (opted_out, opted_out_at) = (
         SELECT e.name = 'telemetry_opt_out', CASE WHEN e.name = 'telemetry_opt_out' THEN e.ts END
         FROM events e WHERE e.rolled = 0 AND e.install_id = installs.install_id AND e.name IN ('telemetry_opt_out', 'telemetry_opt_in')
         ORDER BY e.ts DESC, e.seq DESC LIMIT 1)
       WHERE install_id IN (SELECT install_id ${ROLLING} AND name IN ('telemetry_opt_out', 'telemetry_opt_in'))`,
    ),
    // From the website's /bye page.
    db.prepare(
      `INSERT INTO installs (install_id, first_seen, last_seen, uninstalled_at, uninstall_reason, ext_version)
       SELECT install_id, MIN(ts), MIN(ts), MIN(ts), MAX(CASE WHEN name = 'uninstall_reason' THEN outcome END), MAX(ext_version)
       ${ROLLING} AND source = 'site' AND install_id IS NOT NULL AND name IN ('uninstall', 'uninstall_reason') GROUP BY install_id
       ON CONFLICT (install_id) DO UPDATE SET
         uninstalled_at = COALESCE(installs.uninstalled_at, excluded.uninstalled_at),
         uninstall_reason = COALESCE(excluded.uninstall_reason, installs.uninstall_reason)`,
    ),
    db.prepare('UPDATE events SET rolled = 1 WHERE rolled = 0'),
  ]);
}

export async function handleTelemetryBatch(batch: MessageBatch<unknown>, env: Pick<Env, 'DB' | 'TELEMETRY'>): Promise<void> {
  const queue = batch.queue;
  const parsed: { msg: Message<unknown>; rows: TelemetryRow[] }[] = [];
  for (const msg of batch.messages) {
    try {
      parsed.push({ msg, rows: parseTelemetryMessage(msg.body) });
    } catch (e) {
      console.error(JSON.stringify({ queue, status: 'dropped', error: e instanceof Error ? e.message : String(e) }));
      msg.ack();
    }
  }
  if (!parsed.length) return;

  let deleted: Set<string>;
  try {
    deleted = await deletedOf(env.DB, parsed.flatMap((p) => p.rows));
    const keep = (rows: TelemetryRow[]) => rows.filter((r) => !r.install_id || !deleted.has(r.install_id));
    for (const p of parsed) p.rows = keep(p.rows);
    const all = parsed.flatMap((p) => p.rows);
    if (all.length) await writeArchive(env.TELEMETRY, all);
  } catch (e) {
    // Nothing is in D1 yet: retry the whole batch.
    const attempts = Math.max(...parsed.map((p) => p.msg.attempts));
    console.error(JSON.stringify({ queue, status: 'retry', stage: 'archive', attempts, error: e instanceof Error ? e.message : String(e) }));
    for (const p of parsed) p.msg.retry({ delaySeconds: backoffSeconds(p.msg.attempts) });
    return;
  }

  let events = 0;
  for (const { msg, rows } of parsed) {
    try {
      await writeRows(env.DB, rows);
      events += rows.length;
      msg.ack();
    } catch (e) {
      console.error(JSON.stringify({ queue, status: 'retry', stage: 'd1', attempts: msg.attempts, error: e instanceof Error ? e.message : String(e) }));
      msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
    }
  }
  console.log(JSON.stringify({ queue, messages: parsed.length, events }));
}

// Daily cron: raw events older than 180 days leave D1 (rollups, install days
// and the R2 archive stay). Deletes in bounded chunks.
export async function pruneEvents(db: D1Database, now = new Date(), days = RAW_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const r = await db.prepare('DELETE FROM events WHERE id IN (SELECT id FROM events WHERE received_at < ? LIMIT 5000)').bind(cutoff).run();
    const n = r.meta.changes ?? 0;
    total += n;
    if (n < 5000) break;
  }
  return total;
}
