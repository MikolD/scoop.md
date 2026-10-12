// Pages not worth crawling or indexing: generated indexes, search and error
// pages, tag/category listings, and changelog archives older than the newest
// one. Plain URL patterns, so the same rules can run in the browser crawler
// (crawler/vendor/skip.ts is a copy of this file).

// Any file extension (.html, .md, …) after the name; a trailing slash too.
const LOW_VALUE = [
  /\/(genindex|py-modindex|modindex|np-modindex)(-[\w-]+)?(\.\w{1,5})?\/?$/i, // Sphinx generated indexes
  /\/search(\.\w{1,5})?\/?$/i, // search pages
  /\/(404|not-found)(\.\w{1,5})?\/?$/i, // error pages
  /\/(tags?|categor(y|ies))(\/|\.\w{1,5}$|$)/i, // tag and category listings
];

// Changelog / release-notes archives split by year or version:
// /changelog/2023, /release-notes/v1.2, /releases/2024-05.
const ARCHIVE = /\/(changelog|change-log|release-notes|releases|history)\/v?(\d+(?:[.-]\d+)*)(?:\/|\.\w+)?$/i;

export function lowValue(url: string): boolean {
  let path: string;
  try { path = new URL(url).pathname; } catch { return true; }
  return LOW_VALUE.some((re) => re.test(path));
}

// The archive's version as numbers (2024-05 → [2024, 5]), or null if the URL
// is not a changelog archive.
export function archiveVersion(url: string): number[] | null {
  let path: string;
  try { path = new URL(url).pathname; } catch { return null; }
  const m = ARCHIVE.exec(path);
  return m ? m[2].split(/[.-]/).map(Number) : null;
}

const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
};

// Drops low-value pages, and every changelog archive except the newest one per
// archive section. Returns the kept URLs (in order) and how many were dropped.
export function skipLowValue(urls: string[]): { kept: string[]; skipped: number } {
  const newest = new Map<string, { url: string; v: number[] }>();
  for (const u of urls) {
    const v = archiveVersion(u);
    if (!v) continue;
    const section = new URL(u).pathname.replace(ARCHIVE, '/$1');
    const cur = newest.get(section);
    if (!cur || newer(v, cur.v)) newest.set(section, { url: u, v });
  }
  const keepArchive = new Set([...newest.values()].map((n) => n.url));
  const kept = urls.filter((u) => !lowValue(u) && (archiveVersion(u) === null || keepArchive.has(u)));
  return { kept, skipped: urls.length - kept.length };
}
