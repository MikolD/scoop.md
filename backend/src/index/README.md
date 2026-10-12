# index

Queue consumer for `index-pages` and the indexing pipeline: classify
(`classify.ts`, OpenRouter) → chunk (`chunk.ts`) → embed (`embed.ts`, Workers
AI) → Vectorize + D1 (`indexer.ts`). Decisions are in
docs/BACKEND-DECISIONS.md, "Indexing and search (M4)".
