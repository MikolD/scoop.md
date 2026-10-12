// D1 reads behind /v1/sites/:site/topics and topic packages.

import type { PackageChunk } from './package.ts';

export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// Chunks read for one topic package, before the size budget trims them.
const TOPIC_CHUNKS = 400;

export async function siteTopics(db: D1Database, site: string): Promise<{ pages: number; rows: { path: string; count: number }[] }> {
  const [pages, topics] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM page_index WHERE site = ?').bind(site),
    db.prepare('SELECT path, count FROM topics WHERE site = ?').bind(site),
  ]);
  return { pages: Number((pages.results[0] as { n: number } | undefined)?.n ?? 0), rows: topics.results as { path: string; count: number }[] };
}

// Chunks of the pages filed under a topic or anything below it, page by page in document order.
export async function topicChunks(db: D1Database, site: string, topic: string): Promise<PackageChunk[]> {
  // LIKE with %, _ and \ escaped. (substr would compare SQLite's character count with JS's
  // UTF-16 length.) Topics are lowercase, so LIKE ignoring ASCII case changes nothing.
  const prefix = `${likeEscape(topic)}/%`;
  const { results } = await db
    .prepare(
      `SELECT c.url, c.title, c.ord, c.heading_path, c.text
       FROM page_index pi JOIN chunks c ON c.url = pi.url
       WHERE pi.site = ? AND (pi.topic = ? OR pi.topic LIKE ? ESCAPE '\\')
       ORDER BY pi.topic, pi.url, c.ord LIMIT ${TOPIC_CHUNKS}`,
    )
    .bind(site, topic, prefix)
    .all<PackageChunk>();
  return results;
}
