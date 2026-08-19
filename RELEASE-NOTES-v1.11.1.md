# Sigma Oasis v1.11.1 — project recall, measured (and the gate it was missing)

v1.10 introduced recall across a project's chats and v1.11 shipped it. Neither release carried a
number, in a project whose notes are built on them. This one does — and the measurement found the
feature working well and its safety gate not working at all. Pinned by 1,449 node checks.

## It works: 21/24 against 3/24

13 questions across 3 projects, each asked in a **fresh** chat in that project, both arms,
temperature 0, three passes. The recall arm runs the app's own retrieval over the project's other
chats; the bare arm does not. Nothing else differs.

| arm | recall questions | control questions | control pulled off topic | s/question |
| --- | --- | --- | --- | --- |
| **recall** | **21/24** | 15/15 | 0/15 | 9.3 |
| bare | 3/24 | 15/15 | 0/15 | 13.1 |

Per pass: recall `[7, 7, 7]`, bare `[1, 1, 1]` — **zero flaky cases**. That matters here because
this project has been caught before by a ±3-case movement that turned out to be the server's
nondeterminism rather than a change; a result that repeats exactly three times is a different kind
of claim.

Nearly half those questions are **controls**: their answers are nowhere in the project — arithmetic,
a definition. They are the half that matters, because the risk of this feature was never that it
would fail to help. It was that stuffing other conversations into a small model's context would
drag it off the question it was actually asked.

## The gate was firing on everything, and only the eval knew

Because the suite scores **retrieval separately from the answer**, the first run reported something
the answer column could not: recall fired on **5 controls out of 5**. Three passages about freight
and tariffs went in front of *"what is 15% of 200?"*. The model ignored them and answered correctly,
so nothing looked wrong — which is exactly why it would have stayed unnoticed on the model that did
not ignore them.

Three causes, each probed on its own signal and fixed:

- **The similarity floor sat below the embedding model's own baseline.** 0.35 was borrowed from
  long-term memory, where it works. Embedding models sit at different baselines and
  nomic-embed's is about **0.54** — above the floor — so it admitted every passage for every
  question. Admission is now a *margin over the project corpus's own mean*, which cancels whatever
  baseline a model happens to sit at: measured, controls clear it by 0.023–0.047 and real recall
  questions by 0.095–0.196. (A z-score does not separate those two; the plain margin does.)
- **One incidental shared word counted as evidence of a topic.** Two selective terms are required
  now. A question with a single content word — "Which password hash did we pick?" — is admitted by
  the semantic margin instead, the hybrid design covering for the half that cannot see it.
- **Corpus-relative selectivity cannot see words that are uninformative in English.** Two controls
  still leaked, both admitted on the pair `what` + `number`: rare in those transcripts, so they
  looked informative, while agreeing about nothing. A small admission-time list of canonical
  interrogatives and auxiliaries fixes it — applied inside project recall rather than in the shared
  tokenizer, because it is one path's admission policy and not a change to how the app reads text
  everywhere. Ranking still sees every term.

| gate | fired on recall | stayed quiet on control |
| --- | --- | --- |
| as shipped in v1.10/v1.11 | 8/8 | **0/5** |
| \+ margin over the corpus mean | 8/8 | 2/5 |
| \+ two selective terms required | 8/8 | 3/5 |
| \+ admission-time stopwords | **8/8** | **5/5** |

**Recall never moved while the gate tightened.** That is the result worth having: everything the
gate was letting through was noise, and removing it cost nothing.

One more, found on the way: a share-based selectivity rule is meaningless on a tiny corpus, where
any term appearing twice looks universal. It threw out the word "budget" in a two-chunk project
about the budget. A term is only judged uninformative once enough chunks carry it for the share to
be evidence of anything.

## Also

- A new opt-in eval suite, `EVAL_SUITES=projects`, with the fixtures and the scoring. Retrieval and
  answer quality are reported separately, on purpose — they fail differently, and this release is
  what that separation is for.

## Caveats, which are real

- **One model class.** qwen3.8-9b reasons internally. The second family — mistral-7b-instruct, the
  model where think-harder showed its effect in v1.9.1 — would not load beside it ("insufficient
  system resources"), so the *answer* numbers are single-family. The retrieval numbers do not
  depend on the answering model at all.
- **One embedding model.** The margin rule is designed to be less model-dependent than a floor, but
  it has been measured against nomic-embed-text-v1.5 only.
- **Small corpora**, 4–6 chunks per project.

Everything above, including the failed intermediate gates, is in
[`docs/evals.md`](https://github.com/CELCPG/SigmaOasis/blob/v1.11.1/docs/evals.md).

## Upgrade notes

Auto-update from v1.11.0. No settings changed and no UI moved. If you use projects with recall on,
you should see the "🗂 From this project's other chats" line appear on fewer replies — on the ones
where the project genuinely has something to say, and no longer on questions it does not.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.11.0...v1.11.1
