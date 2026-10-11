// Hourly write limits (docs/BACKEND.md §8). Cloudflare's rate limiting binding
// only supports 10 s and 60 s periods, so per-hour limits use fixed-window
// counters in D1. Subjects (install IDs, IPs) are hashed with the window, and
// past windows are deleted on every check, so no raw IP is ever stored.

import { ApiError } from '../lib/errors.ts';
import { sha256Hex } from '../lib/ids.ts';

const HOUR_MS = 3_600_000;

export interface HourlyLimit {
  bucket: string;   // e.g. 'share:install'
  subject: string;  // install ID or IP
  limit: number;
}

export async function checkHourly(db: D1Database, limits: HourlyLimit[], now = Date.now()): Promise<void> {
  const hour = Math.floor(now / HOUR_MS);
  const keys = await Promise.all(limits.map((l) => sha256Hex(`${l.bucket}:${hour}:${l.subject}`)));
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
