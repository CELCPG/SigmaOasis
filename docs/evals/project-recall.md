# Project-wide recall

Part of the [evals index](../evals.md).

## Project-wide recall, measured (v1.11, qwen3.8-9b, nomic-embed-text-v1.5, temperature 0)

13 questions across 3 projects — 8 whose answer lives in a sibling chat, 5 whose answer is nowhere
in the project. Each asked in a fresh chat, both arms, temperature 0, **three passes**.

| arm | recall questions | control questions | control pulled off topic | s/question |
| --- | --- | --- | --- | --- |
| **recall** | **21/24** | 15/15 | 0/15 | 9.3 |
| bare | 3/24 | 15/15 | 0/15 | 13.1 |

Per pass: recall `[7, 7, 7]`, bare `[1, 1, 1]` — **zero flaky cases**, which matters here because
this project has been caught before by a ±3-case movement that was only the server's
nondeterminism. Retrieval was identical across all three: 24/24 fired, 15/15 quiet.

**Second family (mistral-7b-instruct-v0.3, 2026-08-23):** recall **7/8 vs bare 1/8**, controls
5/5 both arms with zero decoys stated, retrieval fired 8/8 and stayed quiet 5/5 — the same
numbers as qwen to the case, including the same single miss. The gate and the recall effect are
properties of the retrieval, not of the answering model.

The feature works, and by a wide margin: **7/8 against 1/8 every pass**. The one miss is a question whose
answer was retrieved and put in front of the model, which then answered around it — a model
failure, not a retrieval one, and visible as such because retrieval is scored separately.

Controls are unchanged between arms — 5/5 answered, zero decoys stated. Note what that does *not*
prove: it was measured on a model robust enough to ignore irrelevant context. The reason to keep
the gate tight is the model that is not.

### The gate did not work, and the eval is the only reason anyone knows

The first run reported `stayed quiet on 0/5 controls`. Recall fired on **every** control question:
three passages about freight and tariffs went in front of "what is 15% of 200?". The answers
survived it, so nothing user-visible was wrong — which is exactly why it would have gone unnoticed.

Three causes, each found by probing the two signals separately, and each fixed:

1. **The cosine floor was below the embedding model's own baseline.** 0.35 was inherited from
   `memory.ts`. With nomic-embed the *typical* similarity between a query and arbitrary project
   text is ~0.54, so the floor admitted everything.

   | | cosine | over the corpus mean by |
   | --- | --- | --- |
   | control questions | 0.485–0.584 | 0.023–**0.047** |
   | recall questions | 0.692–0.851 | **0.095**–0.196 |

   The absolute value is model-dependent and the margin over the corpus's own mean is much less so,
   because it cancels whatever baseline the model sits at. A z-score does *not* separate these
   (controls reach 1.70, recall drops to 1.40); the plain margin does, with room to spare.

2. **One incidental word counted as topical evidence.** Admission now needs two distinct selective
   terms, not one — "Which password hash?" has only one content word and is admitted by the
   semantic margin instead, which is the hybrid design covering for the half that cannot see it.

3. **Corpus-relative selectivity cannot see words that are uninformative in the language.** With
   1 and 2 in place, two controls still leaked, both admitted on the pair `what` + `number`: rare
   in these transcripts, so they looked selective, while agreeing about nothing. That is what
   stopword lists are for, and the shared tokenizer's minimal list omits interrogatives entirely.
   `projectRecall` applies its own admission-time list — canonical interrogatives and auxiliaries,
   not words collected from the fixtures — while ranking still sees every term.

Gate development, single pass (8 recall / 5 control questions):

| gate | fired on recall | stayed quiet on control |
| --- | --- | --- |
| as shipped in v1.10 | 8/8 | **0/5** |
| \+ cosine margin over corpus mean | 8/8 | 2/5 |
| \+ two selective terms required | 8/8 | 3/5 |
| \+ admission-time stopwords | **8/8** | **5/5** |

Recall never moved while the gate tightened, which is the result worth having: the leak was pure
noise, and removing it cost nothing.

### What this measurement does not cover

- **One model class.** qwen3.8-9b reasons internally. The second family (mistral-7b-instruct, the
  model where think-harder showed its effect in v1.9.1) would not load alongside it —
  "insufficient system resources" — so the *answer* numbers are single-family. The retrieval
  numbers do not depend on the answering model at all.
- **One embedding model.** The margin rule is designed to be less model-dependent than a floor,
  but it has been measured against nomic-embed-text-v1.5 only.
- **Small corpora.** These projects are 4–6 chunks. The selectivity rule needs a minimum document
  frequency before it will call a term uninformative, precisely because a share means nothing at
  that size — a two-chunk project made "budget" look universal and threw it out.
