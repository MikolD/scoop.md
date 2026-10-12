// Hybrid search: FTS5 bm25 over chunk text, heading trail and page title, plus
// a Vectorize query on the embedded question, merged with reciprocal-rank
// fusion. Exact identifiers (`constructEvent`) come through FTS5; paraphrases
// through the vectors. If the vector side fails, results are FTS5 only.

import type { Embed } from '../index/embed.ts';
import { rrf } from './rrf.ts';

export interface SearchParams {
  q: string;
  site?: string;
  slot?: string;
  limit: number;
  // Run full-text search first and skip the embedding and vector query when
  // it already found this many candidates.
  ftsEnough?: number;
  // At most this long for the vector side (embedding + Vectorize); past it
  // the results are full-text only, so a slow or cold vector side can't hold
  // up the answer.
  vectorBudgetMs?: number;
}

export interface ChunkHit {
  id: string;
  url: string;
  title: string;
  ord: number;
  heading_path: string;
  text: string;
  snippet: string;
  slot: string;
  topic_path: string[];
  score: number;
}

export interface SearchDeps {
  db: D1Database;
  vectors?: Pick<Vectorize, 'query'>;
  embed?: Embed;
}

// Candidates taken from each side before fusion.
const DEPTH = 50;
const MAX_TERMS = 16;
const STOPWORDS = new Set('a an and are as at be by can do does for from how i in is it my of on or the to what when where which with you your'.split(' '));

// A safe FTS5 query: words and identifiers only, each quoted, OR-ed so bm25
// ranks chunks by how many terms they hold. Operators in the input are just text.
export function ftsQuery(q: string): string {
  const terms = [...new Set((q.match(/[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase()))];
  const useful = terms.filter((t) => !STOPWORDS.has(t));
  return (useful.length ? useful : terms).slice(0, MAX_TERMS).map((t) => `"${t}"`).join(' OR ');
}

export const excerpt = (text: string, max = 240) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
};

async function ftsIds(db: D1Database, p: SearchParams): Promise<{ ids: string[]; snippets: Map<string, string> }> {
  const match = ftsQuery(p.q);
  if (!match) return { ids: [], snippets: new Map() };
  const where = ['chunks_fts MATCH ?'];
  const binds: (string | number)[] = [match];
  if (p.site) { where.push('c.site = ?'); binds.push(p.site); }
  // Cross-site: unapproved requested sites never take a candidate slot.
  else where.push('c.site NOT IN (SELECT site FROM site_profiles WHERE approved = 0)');
  if (p.slot) { where.push('pi.slot = ?'); binds.push(p.slot); }
  const { results } = await db
    .prepare(
      `SELECT c.id, snippet(chunks_fts, 0, '', '', '…', 40) AS snippet
       FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
       ${p.slot ? 'JOIN page_index pi ON pi.url = c.url' : ''}
       WHERE ${where.join(' AND ')}
       ORDER BY bm25(chunks_fts, 1.0, 3.0, 2.0) LIMIT ${DEPTH}`,
    )
    .bind(...binds)
    .all<{ id: string; snippet: string }>();
  return { ids: results.map((r) => r.id), snippets: new Map(results.map((r) => [r.id, r.snippet])) };
}

// Vectorize's $nin takes a bounded list; past it, the post-filter in search()
// still removes them (they can then take vector candidate slots).
const MAX_NIN = 100;

async function vectorIds(deps: SearchDeps, p: SearchParams, excluded: string[]): Promise<string[]> {
  if (!deps.vectors || !deps.embed) return [];
  try {
    const [vector] = await deps.embed([p.q], 'query');
    const filter: VectorizeVectorMetadataFilter = {};
    if (p.site) filter.site = p.site;
    else if (excluded.length && excluded.length <= MAX_NIN) filter.site = { $nin: excluded };
    if (p.slot) filter.slot = p.slot;
    const res = await deps.vectors.query(vector, { topK: DEPTH, filter, returnMetadata: 'none' });
    return res.matches.map((m) => m.id);
  } catch (e) {
    console.error(JSON.stringify({ search: 'vector', error: e instanceof Error ? e.message : String(e) }));
    return [];
  }
}

// llms-full.txt repeats a site's whole documentation in one file, so its chunks
// match nearly everything and would crowd out the pages they were copied from.
// They stay searchable, at 0.3 × their fused score.
export const LLMS_FULL_WEIGHT = 0.3;

export function sourceWeight(url: string): number {
  try {
    return /\/llms-full\.txt$/i.test(new URL(url).pathname) ? LLMS_FULL_WEIGHT : 1;
  } catch {
    return 1;
  }
}

async function unapprovedSites(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare('SELECT site FROM site_profiles WHERE approved = 0').all<{ site: string }>();
  return new Set(results.map((r) => r.site));
}

export async function search(deps: SearchDeps, p: SearchParams): Promise<ChunkHit[]> {
  // Cross-site search leaves out sites first crawled on a user's request that
  // an admin hasn't approved yet (site_profiles.approved), in the candidate
  // queries themselves and again on the fused hits; a site-scoped search
  // includes them.
  const unapproved = p.site ? new Set<string>() : await unapprovedSites(deps.db);
  let fts: Awaited<ReturnType<typeof ftsIds>>;
  let vec: string[];
  if (p.ftsEnough) {
    fts = await ftsIds(deps.db, p);
    vec = fts.ids.length >= p.ftsEnough ? [] : await vectorIds(deps, p, [...unapproved]);
  } else {
    const vecSide = vectorIds(deps, p, [...unapproved]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = p.vectorBudgetMs === undefined
      ? vecSide
      : Promise.race([vecSide, new Promise<string[]>((resolve) => { timer = setTimeout(() => resolve([]), p.vectorBudgetMs); })]);
    [fts, vec] = await Promise.all([ftsIds(deps.db, p), bounded]);
    clearTimeout(timer);
  }
  const fused = rrf([fts.ids, vec]);
  // Every fused candidate is read: vectors can point at chunks deleted since or
  // carry stale metadata, and down-weighted sources must make room for others.
  const wanted = fused.slice(0, DEPTH);
  if (!wanted.length) return [];
  const { results } = await deps.db
    .prepare(
      `SELECT c.id, c.url, c.site, c.title, c.ord, c.heading_path, c.text, pi.slot, pi.topic_path
       FROM chunks c LEFT JOIN page_index pi ON pi.url = c.url
       WHERE c.id IN (${wanted.map(() => '?').join(', ')})`,
    )
    .bind(...wanted.map((w) => w.id))
    .all<{ id: string; url: string; site: string; title: string; ord: number; heading_path: string; text: string; slot: string | null; topic_path: string | null }>();
  const rows = new Map(results.map((r) => [r.id, r]));
  const ranked = wanted
    .map(({ id, score }) => ({ id, score, r: rows.get(id) }))
    .filter((w) => w.r && (!p.site || w.r.site === p.site) && (!p.slot || w.r.slot === p.slot) && !unapproved.has(w.r.site))
    .map((w) => ({ ...w, score: w.score * sourceWeight(w.r!.url) }))
    .sort((a, b) => b.score - a.score);
  const hits: ChunkHit[] = [];
  for (const { id, score, r: row } of ranked) {
    const r = row!;
    hits.push({
      id,
      url: r.url,
      title: r.title,
      ord: r.ord,
      heading_path: r.heading_path,
      text: r.text,
      snippet: excerpt(fts.snippets.get(id) ?? r.text),
      slot: r.slot ?? 'other',
      topic_path: JSON.parse(r.topic_path ?? '[]'),
      score: Math.round(score * 1e5) / 1e5,
    });
    if (hits.length === p.limit) break;
  }
  return hits;
}
