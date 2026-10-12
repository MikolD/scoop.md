// Test doubles: D1 over node:sqlite (running the real migrations) and an
// in-memory R2, so store and rate-limit SQL is exercised without workerd.

import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';


type Param = string | number | null;

class Stmt {
  db: DatabaseSync;
  sql: string;
  params: Param[];

  constructor(db: DatabaseSync, sql: string, params: Param[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params: Param[]) {
    return new Stmt(this.db, this.sql, params);
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[] };
  }

  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(r.changes) } };
  }
}

// dir: 'migrations' (DB) or 'migrations-telemetry' (TELEMETRY_DB).
export function fakeD1(dir = 'migrations') {
  const migrations = fileURLToPath(new URL(`../${dir}/`, import.meta.url));
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(migrations + f, 'utf8'));
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    // D1 runs a batch as one transaction.
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => ({ results: db.prepare(s.sql).all(...s.params) }));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { d1: d1 as unknown as D1Database, raw: db };
}

// Values are kept as given (strings, or bytes for gzipped objects); list pages by key order.
export function fakeR2() {
  const objects = new Map<string, string | Uint8Array>();
  const meta = new Map<string, unknown>();
  const bytes = (v: string | Uint8Array) => (typeof v === 'string' ? new TextEncoder().encode(v) : v);
  const r2 = {
    async put(key: string, value: string | Uint8Array, opts?: unknown) { objects.set(key, value); meta.set(key, opts); },
    async get(key: string) {
      const v = objects.get(key);
      if (v === undefined) return null;
      const text = () => (typeof v === 'string' ? v : new TextDecoder().decode(v));
      return {
        size: bytes(v).byteLength,
        body: new Response(bytes(v)).body,
        json: async () => JSON.parse(text()),
        text: async () => text(),
        arrayBuffer: async () => bytes(v).slice().buffer,
      };
    },
    async head(key: string) { return objects.has(key) ? {} : null; },
    async delete(key: string) { objects.delete(key); },
    async list({ prefix = '', cursor, limit = 1000 }: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return { objects: page.map((key) => ({ key })), truncated, cursor: truncated ? String(start + limit) : undefined };
    },
  };
  return { r2: r2 as unknown as R2Bucket, objects, meta };
}

// A fetch stand-in serving fixed responses by URL; records each request's init.
export function fakeFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const route = routes[url];
    return route ? route() : new Response('not found', { status: 404 });
  };
  return { impl, calls };
}

// Linear-time check for scanners fed hostile input. Each is
// checked for linear scaling rather than against a fixed time, so a busy
// machine doesn't fail it: from 250 KB to 2 MB (8×) the time must grow less
// than 24×. Linear is 8× (alone these run 3.5 ms → 28 ms), quadratic 64×. The
// wide spread matters: from 1 MB to 2 MB, GC in a full test process pushed
// linear scanners past 3× (18 → 61 ms). Each size takes the best of 5 runs,
// alternating sizes, and a round that doesn't look linear is measured again,
// up to 3 rounds; noise only ever adds time. Times are this process's CPU
// time, so a busy machine can't stretch one run (with wall time, 12 busy
// processes pushed linear scanners to 30× growth). A 2 s ceiling at 2 MB is
// the backstop.
const SMALL = 250_000;
const TWO_MB = 2_000_000;
export const fillTo = (size: number, unit: string, tail = '') => unit.repeat(Math.ceil(size / unit.length)).slice(0, size) + tail;
const RUNS = 5;
const MAX_GROWTH = 24;
// Below this the small run is too short to compare; a quadratic scanner takes
// seconds at 2 MB, far above MAX_GROWTH × this.
const NOISE_MS = 5;
// CPU time of this process, not wall time: other processes taking the CPU
// (parallel test files, a busy machine) then can't make a run look slow.
const timed = (fn: () => unknown) => {
  const t = process.cpuUsage();
  fn();
  const d = process.cpuUsage(t);
  return (d.user + d.system) / 1000;
};
export function assertLinear(label: string, make: (size: number) => string, fn: (input: string) => unknown, ceilingMs = 2000) {
  const small = make(SMALL);
  const large = make(TWO_MB);
  const linear = (t1: number, t2: number) => t2 < MAX_GROWTH * Math.max(t1, NOISE_MS);
  let t1 = Infinity;
  let t2 = Infinity;
  for (let round = 0; round < 3; round++) {
    t1 = Infinity;
    t2 = Infinity;
    for (let i = 0; i < RUNS; i++) {
      t1 = Math.min(t1, timed(() => fn(small)));
      t2 = Math.min(t2, timed(() => fn(large)));
    }
    if (linear(t1, t2)) break;
  }
  assert.ok(linear(t1, t2), `${label}: ${t1.toFixed(1)} ms at 250 KB, ${t2.toFixed(1)} ms at 2 MB (not linear)`);
  assert.ok(t2 < ceilingMs, `${label}: ${t2.toFixed(0)} ms at 2 MB (ceiling ${ceilingMs} ms)`);
}
