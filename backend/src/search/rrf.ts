// Reciprocal-rank fusion: each list adds 1 / (k + rank) for every ID it holds
// (rank from 1), so an ID found by both full-text and vector search outranks one
// found by either alone, without comparing bm25 scores to cosine similarities.

export const RRF_K = 60;

export function rrf(lists: string[][], k = RRF_K): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  // Ties keep first-seen order (Map iteration order, stable sort).
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
