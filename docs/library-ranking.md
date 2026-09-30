# How the reference library ranks passages

Reader: `src/main/ipc/library/lookup.ts` (the facade `src/main/ipc/library.ts` re-exports it).
The pack format is `docs/library-pack-format.md`; this page is what happens to a question.

## The default pipeline

1. **Keyword leg.** One BM25 index over every loaded chunk (plus a BM25 of their own for the
   articles a ZIM pack opened for this question).
2. **Semantic leg**, when the chunks in scope carry vectors for the loaded embedding model: the
   question is embedded and every embedded chunk is scored by cosine.
3. **Fusion.** Reciprocal-rank fusion of the lists, min-max scaled to 0..1.
4. **Relevance floor.** A passage must share two strong question words (or clear a cosine of
   0.55) — a lone weak hit otherwise reads as 1.00.
5. **Selection.** MMR against near-duplicates, then at most one passage per (document, section),
   topped up from unseen sections, then from the displaced twins.

## Re-rank by the answering model (v4.2, L2) — off by default

*Settings → Grounding & checks → Before the reply → Re-rank library passages.*

The failure it targets is the one the library eval kept finding
(`STRATEGY-capability-multipliers.md` §B2): a passage that shares the question's words but
answers a different question — the stinger-removal section for "what are the signs of a severe
allergic reaction", chlorination for a boiling question — ranks first and is quoted.

- **When:** the question falls in first aid, health, building/structural or finance — the
  grounding module's own `referenceDomains` detectors (`renderer/src/lib/grounding.ts`) — and
  the lookup is not of the app's own ledger pack.
- **What:** the top candidates after the floor, one per section, at most 15, each cut to 600
  characters and labelled `document › section`, go to the answering model (the slot's model for
  the app's prefetch and for the `reference_lookup` tool) with the question. It returns
  `{"answering": [numbers]}` — grammar-constrained JSON where LM Studio supports it, parsed
  tolerantly where not — thinking closed, temperature 0, `max_tokens` 80.
- **Then:** its picks lead, in its order; everything it left out is dropped, except that the
  fused order tops the list up to three passages (or `topK`, if smaller) so a model that
  under-picks cannot leave the reply one passage. Scores become rank-derived (1.0 down to 0.5).
  The lookup outcome says `rerank: 'applied'`.
- **Fallback:** a failed call, a 4-second deadline passing (the request is aborted), an empty
  list or nothing parseable leaves the fused order exactly as it was (`rerank: 'fallback'`).

**Cost.** One extra non-streaming call per high-stakes lookup, before the reply starts: about
2,500 prompt tokens (15 × 600 characters plus labels) and at most 80 output tokens. Not yet
measured on the reference models; the deadline caps the wait at 4 seconds whatever the model
does. On a server with one slot the call also queues behind anything else the model is doing.
That wait — on every health, first-aid, finance and building turn — is why it ships off.
