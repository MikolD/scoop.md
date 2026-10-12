// Test doubles: D1 over node:sqlite (running the real migrations) and an
// in-memory R2, so store and rate-limit SQL is exercised without workerd.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

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

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(MIGRATIONS + f, 'utf8'));
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

export function fakeR2() {
  const objects = new Map<string, string>();
  const r2 = {
    async put(key: string, value: string) { objects.set(key, value); },
    async get(key: string) {
      const v = objects.get(key);
      if (v === undefined) return null;
      return { size: Buffer.byteLength(v), body: new Response(v).body, json: async () => JSON.parse(v), text: async () => v };
    },
    async head(key: string) { return objects.has(key) ? {} : null; },
    async delete(key: string) { objects.delete(key); },
  };
  return { r2: r2 as unknown as R2Bucket, objects };
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
