// D1 reads behind /v1/sites/:site/topics and topic packages.

import type { PackageChunk } from './package.ts';

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
  const prefix = `${topic}/`;
  const { results } = await db
    .prepare(
      `SELECT c.url, c.title, c.ord, c.heading_path, c.text
       FROM page_index pi JOIN chunks c ON c.url = pi.url
       WHERE pi.site = ? AND (pi.topic = ? OR substr(pi.topic, 1, ?) = ?)
       ORDER BY pi.topic, pi.url, c.ord LIMIT ${TOPIC_CHUNKS}`,
    )
    // substr counts characters; [...s] counts code points, as SQLite does (JS length counts UTF-16 units).
    .bind(site, topic, [...prefix].length, prefix)
    .all<PackageChunk>();
  return results;
}
