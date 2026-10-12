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
  // Two index range scans on (site, topic): the topic itself, and [topic + '/',
  // topic + '0'), which holds exactly the topics below it ('0' follows '/').
  const select = `SELECT pi.topic AS topic, c.url AS url, c.title AS title, c.ord AS ord, c.heading_path AS heading_path, c.text AS text
       FROM page_index pi JOIN chunks c ON c.url = pi.url`;
  const { results } = await db
    .prepare(
      `${select} WHERE pi.site = ?1 AND pi.topic = ?2
       UNION ALL
       ${select} WHERE pi.site = ?1 AND pi.topic >= ?2 || '/' AND pi.topic < ?2 || '0'
       ORDER BY topic, url, ord LIMIT ${TOPIC_CHUNKS}`,
    )
    .bind(site, topic)
    .all<PackageChunk>();
  return results;
}
