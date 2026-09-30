# Long documents

Part of the [evals index](../evals.md).

## Long documents: outline-then-fill (v2.6)

`LMSTUDIO_EVAL=1 EVAL_SUITES=longform EVAL_LONGFORM_ARMS=bare,outline npm run eval:answers -- <model>`
asks for twelve documents — a gardening guide, an onboarding handbook, a post-mortem template, a
grant proposal — each with an explicit length of 1,000 to 1,500 words and five to seven named
sections. The rubric is mechanical: every required section present as a heading; the length
reached; the token cap not hit; and *section redundancy*, the highest pairwise cosine between
two sections' texts under the app's own embedding model, reported as a number rather than
judged, because two sections of one document are close by construction and the threshold that
would call one a restatement of the other is not something this suite has established. No tools
ride, so there are no figures to trace. `bare` is one completion, the v2.5 app; `outline` asks
for a JSON outline and then writes one section per bounded completion.

qwen3.8-9b, 8,192 context, one pass (2026-09-03):

| arm | every section | long enough | hit the cap | mean redundancy | s/case |
| --- | --- | --- | --- | --- | --- |
| bare | 9/12 | 11/12 | **7/12** | 0.871 | 164 |
| outline, first build (900 tokens a section) | 2/12 finished | — | 2/2 | 0.891 | 593 |

The bare row is the reason A4 was scheduled: a 9B asked for 1,500 words writes them, names
the sections it was given nine times in twelve, and is cut off by the token cap seven times in
twelve — the reader gets a document that stops. The half-marathon plan (case 07) is the drift
the strategy described: three of six sections, 775 words, and the three "Weeks" sections
collapsed into one.

The first outlined build did not survive contact, and it took four more runs to learn why —
each of which is worth a line, because each is a fact about a 9B reasoning model that the app
now designs around:

1. **Sections had no length.** Every section was allowed 900 tokens and nothing told it how
   long to be; the two documents that finished wrote every section to the cap, 4,253 and 4,160
   words for 1,500-word asks. Fix: the section budget is the requested length over the section
   count, in tokens with a floor and a ceiling, and the section is told its word count.
2. **The timeout was the outline's, not the sections'.** Ten of twelve documents timed out at
   102 s, and after fix 1 still did. The call that timed out was the JSON outline, which had
   neither a token cap nor a timeout of its own.
3. **Under a JSON schema the model thinks first.** With the outline call capped at 400 tokens,
   all twelve documents failed with *the model spent its whole token budget on chain-of-thought
   and never began the answer*. The thinking-off switch sends only a template flag when a schema
   is attached — the closed-`<think>` prefill it uses elsewhere is withheld so the grammar can
   own the first token — and this model reasons at length before any JSON. Fix: every
   document-shaped request the app routes here names its sections or its length, so when it
   names sections the outline is **read off the request** and the model plans only when there is
   nothing to read, with a budget sized for its thinking.
4. **Sections reopen their thinking too**, despite the prefill, on four of twelve documents.
   Fix: a section that spent its budget on reasoning is asked once more with room for both.
5. **"Tools and access" is one heading.** The request parser split lists on "and" and lost two
   sections. Fix: "and" separates only the last pair of a comma list.

| arm | ran | every section | long enough | hit a cap | mean redundancy | s/case |
| --- | --- | --- | --- | --- | --- | --- |
| bare | 12/12 | 9/12 | 11/12 | 7/12 | 0.871 | 164 |
| outline, final build (fixes 1–4; run before fix 5) | 12/12 | 10/12 | 12/12 | 9/12 | 0.878 | 228 |

**A null result, and the default stays off.** Every-section moved by one case, which is inside
the noise every other suite has measured; length reached moved by one; redundancy did not move
at all — the outline does not make sections say different things; and the outlined document
takes 40% longer. The two "missing" sections in the final row are fix 5, found by the run: the
sections were written, under headings the parser had split. The one thing the rubric cannot
show is worth stating: the bare arm's seven cap hits are documents that *stop* — the reader
gets a guide that ends mid-sentence — while the outlined arm's nine are sections that ran to
their own cap inside a document that is otherwise complete. That is a different failure, and
a lesser one, but the gate the strategy set was the required-sections score, and it did not
move. The switch ships off; the numbers ship with it.
