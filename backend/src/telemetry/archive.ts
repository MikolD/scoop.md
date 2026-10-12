// The permanent archive of raw telemetry in R2 (the TELEMETRY bucket,
// scoop-telemetry-<env>): gzipped NDJSON, one object per consumer batch and
// receive hour, at telemetry/raw/dt=YYYY-MM-DD/hour=HH/<uuid>.ndjson.gz.
// Objects are never rewritten: a deletion request leaves a tombstone,
// telemetry/tombstones/<install_id>.json, and every read through
// readArchive() skips tombstoned install IDs. A redelivered queue message can
// archive an event twice; dedupe on `id`.

import type { TelemetryRow } from './ingest.ts';

export const RAW_PREFIX = 'telemetry/raw/';
export const TOMBSTONE_PREFIX = 'telemetry/tombstones/';

export const archiveKey = (receivedAt: string, id: string = crypto.randomUUID()) =>
  `${RAW_PREFIX}dt=${receivedAt.slice(0, 10)}/hour=${receivedAt.slice(11, 13)}/${id}.ndjson.gz`;

async function pipe(data: Uint8Array | ArrayBuffer, stream: CompressionStream | DecompressionStream): Promise<ArrayBuffer> {
  return new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer();
}

export const gzip = async (text: string) => new Uint8Array(await pipe(new TextEncoder().encode(text), new CompressionStream('gzip')));
export const gunzip = async (data: ArrayBuffer | Uint8Array) => new TextDecoder().decode(await pipe(data, new DecompressionStream('gzip')));

// One object per receive hour in `rows`. Returns the keys written.
export async function writeArchive(bucket: R2Bucket, rows: TelemetryRow[]): Promise<string[]> {
  const byHour = new Map<string, TelemetryRow[]>();
  for (const r of rows) {
    const hour = r.received_at.slice(0, 13);
    byHour.set(hour, [...(byHour.get(hour) ?? []), r]);
  }
  const keys: string[] = [];
  for (const group of byHour.values()) {
    const key = archiveKey(group[0].received_at);
    const body = await gzip(group.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await bucket.put(key, body, {
      httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' },
      customMetadata: { events: String(group.length) },
    });
    keys.push(key);
  }
  return keys;
}

async function listAll(bucket: R2Bucket, prefix: string, max = 10_000): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && keys.length < max);
  return keys;
}

export async function writeTombstone(bucket: R2Bucket, installId: string, deletedAt: string): Promise<void> {
  await bucket.put(`${TOMBSTONE_PREFIX}${installId}.json`, JSON.stringify({ installId, deletedAt }), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function tombstones(bucket: R2Bucket): Promise<Set<string>> {
  const keys = await listAll(bucket, TOMBSTONE_PREFIX, 1_000_000);
  return new Set(keys.map((k) => k.slice(TOMBSTONE_PREFIX.length).replace(/\.json$/, '')));
}

export const MAX_ARCHIVE_DAYS = 31;
export const MAX_ARCHIVE_OBJECTS = 5000;

// Every archived row received between two UTC days (inclusive), tombstoned
// install IDs left out, as NDJSON lines.
export function readArchive(bucket: R2Bucket, from: string, to: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let keys: string[] | null = null;
  let skip: Set<string>;
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!keys) {
        skip = await tombstones(bucket);
        keys = [];
        for (let t = Date.parse(from); t <= Date.parse(to) && keys.length < MAX_ARCHIVE_OBJECTS; t += 86_400_000) {
          keys.push(...(await listAll(bucket, `${RAW_PREFIX}dt=${new Date(t).toISOString().slice(0, 10)}/`, MAX_ARCHIVE_OBJECTS)));
        }
        keys = keys.slice(0, MAX_ARCHIVE_OBJECTS);
      }
      // Skip objects that vanished or hold only deleted installs.
      while (i < keys.length) {
        const obj = await bucket.get(keys[i++]);
        if (!obj) continue;
        const lines = (await gunzip(await obj.arrayBuffer())).split('\n').filter((line) => {
          if (!line) return false;
          try {
            const id = (JSON.parse(line) as { install_id?: string | null }).install_id;
            return !id || !skip.has(id);
          } catch {
            return false;
          }
        });
        if (lines.length) {
          controller.enqueue(enc.encode(lines.join('\n') + '\n'));
          return;
        }
      }
      controller.close();
    },
  });
}
