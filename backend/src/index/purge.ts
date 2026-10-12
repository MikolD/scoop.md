// Removes everything indexed for one site: its vectors, chunks (and their
// FTS rows, by trigger), entities, topics, page_index rows and stored page
// rows, so nothing re-indexes it. Used when an admin rejects a requested site.
// Page Markdown in R2 is content-addressed and may be shared; it stays.

const ID_BATCH = 500;

export async function purgeSiteIndex(db: D1Database, vectors: Pick<Vectorize, 'deleteByIds'> | undefined, site: string): Promise<{ chunks: number; pages: number }> {
  if (vectors) {
    for (let offset = 0; ; offset += ID_BATCH) {
      const { results } = await db.prepare('SELECT id FROM chunks WHERE site = ? ORDER BY id LIMIT ? OFFSET ?').bind(site, ID_BATCH, offset).all<{ id: string }>();
      if (!results.length) break;
      await vectors.deleteByIds(results.map((r) => r.id));
      if (results.length < ID_BATCH) break;
    }
  }
  const counts = await db
    .prepare('SELECT (SELECT COUNT(*) FROM chunks WHERE site = ?1) AS chunks, (SELECT COUNT(*) FROM pages WHERE site = ?1) AS pages')
    .bind(site)
    .first<{ chunks: number; pages: number }>();
  await db.batch([
    db.prepare('DELETE FROM chunks WHERE site = ?').bind(site),
    db.prepare('DELETE FROM entities WHERE site = ?').bind(site),
    db.prepare('DELETE FROM topics WHERE site = ?').bind(site),
    db.prepare('DELETE FROM page_index WHERE site = ?').bind(site),
    db.prepare('DELETE FROM pages WHERE site = ?').bind(site),
  ]);
  return { chunks: counts?.chunks ?? 0, pages: counts?.pages ?? 0 };
}
