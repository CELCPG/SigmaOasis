# ZIM packs

Part of the [evals index](../evals.md).

## ZIM packs (v2.8)

`LMSTUDIO_EVAL=1 EVAL_SUITES=library EVAL_ZIM=<path|fixture> npm run eval:answers -- <model>` runs
the library suite as it is with a Kiwix ZIM registered beside the curated packs, and adds one
number: how many cases retrieved at least one passage from the file. The gate the strategy set
was *no loss*: the 28 health and first-aid cases must not lose retrieval or gain unsupported
figures with the file present. `fixture` builds a three-article first-aid ZIM in the eval's
library, which proves the path — a title search, an article opened and chunked, a passage
ranked beside the packs' — and nothing about the catalogue; a WikiMed file proves the rest,
and needs a WikiMed file.

qwen3.8-9b, one pass each, same day (2026-09-04):

| run | retrieved | answered | cited | unsupported figure | from the ZIM | s/case |
| --- | --- | --- | --- | --- | --- | --- |
| with the fixture ZIM | 28/28 | 27/28 | 24/28 | 4/28 | 2/28 | 43 |
| control, no ZIM | 28/28 | 28/28 | 23/28 | 3/28 | — | 39 |

**No loss.** The two rows differ by one case each on answered, cited and unsupported — inside
the ±3 this suite has measured between identical runs — and in opposite directions. The two
cases that drew on the ZIM — the burn and the nosebleed, whose fixture articles the title
search found — answered and cited. None of the cases that missed in the ZIM row retrieved a
ZIM passage: the unsupported figures and the uncited replies are the suite's own shapes,
recorded before (the boil-water case among them), and the ZIM row's first case ran
keyword-only because the embedding call had not warmed up, a cold-start artifact seen before.
The file cost about four seconds a case in this run, which is the title search and the
opened articles' embedding on a machine that was also running the check suite. What the pack
*adds* — the 12-case general-knowledge set the strategy named — is a measurement for a real
file: a WikiMed ZIM on the machine, registered with `EVAL_ZIM=<path>`.
