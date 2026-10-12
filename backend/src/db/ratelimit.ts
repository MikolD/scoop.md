// Hourly write limits (docs/BACKEND.md §8). Cloudflare's rate limiting binding
// only supports 10 s and 60 s periods, so per-hour limits use fixed-window
// counters in D1. Keys are HMAC-SHA256(RATE_KEY, bucket:hour:subject), so a
// stored key can't be brute-forced back to an IP without the secret, and past
// windows are deleted on every check.

import { ApiError } from '../lib/errors.ts';

const HOUR_MS = 3_600_000;

export interface HourlyLimit {
  bucket: string;   // e.g. 'share:install'
  subject: string;  // install ID, or ipSubject(ip)
  limit: number;
}

// What to count an IP as: IPv4 as itself, IPv6 by its /64 (one subscriber's
// allocation, so rotating addresses inside it doesn't reset the count).
export function ipSubject(ip: string): string {
  const addr = ip.trim().toLowerCase().replace(/%.*$/, '');
  if (!addr.includes(':')) return addr;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) return mapped[1];
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function checkHourly(db: D1Database, secret: string | undefined, limits: HourlyLimit[], now = Date.now()): Promise<void> {
  if (!secret) throw new Error('RATE_KEY is not set');
  const hour = Math.floor(now / HOUR_MS);
  const keys = await Promise.all(limits.map((l) => hmacHex(secret, `${l.bucket}:${hour}:${l.subject}`)));
  const results = await db.batch([
    db.prepare('DELETE FROM rate_counters WHERE hour < ?').bind(hour),
    ...keys.map((key) =>
      db
        .prepare('INSERT INTO rate_counters (key, hour, count) VALUES (?, ?, 1) ON CONFLICT (key, hour) DO UPDATE SET count = count + 1 RETURNING count')
        .bind(key, hour),
    ),
  ]);
  const over = limits.some((l, i) => ((results[i + 1].results as { count: number }[])[0]?.count ?? 0) > l.limit);
  if (over) {
    const err = new ApiError('rate_limited', 'Too many requests; try again later', 429);
    err.retryAfter = Math.ceil(((hour + 1) * HOUR_MS - now) / 1000);
    throw err;
  }
}
