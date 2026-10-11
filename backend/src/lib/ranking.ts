// "The most recent skill that worked" (docs/BACKEND.md §7). The predicate and
// order exist twice: as a pure function (portable, unit-tested) and as the SQL
// the D1 store runs. Keep them in step.

export interface Rankable {
  site: string;
  worked: number;
  failed: number;
  lastWorkedAt: string | null;
  createdAt: string;
  removedAt?: string | null;
}

export function qualifies(s: Rankable, site: string): boolean {
  return s.site === site && !s.removedAt && s.worked >= 1 && s.worked > s.failed;
}

export function byRank(a: Rankable, b: Rankable): number {
  return (b.lastWorkedAt ?? '').localeCompare(a.lastWorkedAt ?? '') || b.createdAt.localeCompare(a.createdAt);
}

export function best<T extends Rankable>(skills: T[], site: string): T | null {
  return skills.filter((s) => qualifies(s, site)).sort(byRank)[0] ?? null;
}

// SQL equivalents over the `skills` table (timestamps are ISO-8601 UTC, so text order is time order).
export const QUALIFIES_SQL = 'removed_at IS NULL AND worked >= 1 AND worked > failed';
export const RANK_ORDER_SQL = 'last_worked_at DESC, created_at DESC';
