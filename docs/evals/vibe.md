# VIBE

Part of the [evals index](../evals.md).

## VIBE: where the brevity line goes (v3.0)

VIBE asks for short replies and changes nothing else about a turn. The first build put that
request where every per-turn addition goes — the notes block on the turn's own user message —
because that keeps the cached prompt prefix identical with the mode on or off. It cost the mode
its tools, and that is the one thing the mode promises not to do.

The probe was the plainest question a tool exists for, asked in a fresh chat on the live app
(throwaway profile, LM Studio on this machine, 2026-09-28): *"What time is it right now?"*,
counting the turns that called `get_current_datetime`.

| model | where VIBE's line rode | wording | turns that called the tool |
| --- | --- | --- | --- |
| qwen3.8-9b | VIBE off (control) | — | 4/4 |
| qwen3.8-9b | notes block on the user message | three sentences ending "no mention of tools" | 0/1 |
| qwen3.8-9b | notes block on the user message | "use your tools whenever they would help" | 0/3 |
| qwen3.8-9b | notes block on the user message | "check it with your tools first — the current time, a calculation, a fact" | 0/4 |
| qwen3.8-9b | notes block on the user message | one sentence: "once you have what you need, answer in a few calm sentences" | 1/2 |
| qwen3.8-9b-distill | notes block on the user message | the same one sentence | 0/3 |
| qwen3.8-9b-distill | VIBE off (control) | — | 3/3 |
| qwen3.8-9b-distill | **system prompt**, after the project's instructions | the shipped line | **7/8** |

On the notes block, 1 turn in 13 called the tool across four wordings and two models; with VIBE
off, 7 in 7. The turns that skipped it did not decline it: the reasoning of one reads *"I need
to use get_current_datetime to find out the current local date and time"*, and the reply that
followed stated an invented time. Rewording barely moved it, so it is the notes block on the
user's message, not what the note said. The same kind of line in the system prompt, beside the
persona and the standing rules, leaves the call alone.

What the move costs is measured in the design rather than here: the system prompt now differs
between VIBE and the full view, so switching the mode mid-conversation re-reads that
conversation's history once on the next turn. Within the mode, the prefix is as stable as it
was.

**Caveats.** Small samples — eight runs on the shipped placement, not a suite. The server
stopped during the last batch: its final two runs, and the control runs queued after it,
all came back with nothing and the server was then found down, so none of them is counted. One of
the eight shipped-placement turns still answered from nothing; with VIBE off none did, so the
honest reading is "no measurable cost at this sample size", not "none". A wider tool-choice run
with VIBE on belongs in the next `eval:tools` pass.

Found along the way, and fixed for every turn, not only VIBE's: the system prompt stated the
**UTC** date (from 8 PM on the US east coast, tomorrow) with no weekday, and `get_current_datetime`
returned `9/28/2026, 12:13:00 PM` — so the model computed the weekday itself and got it wrong,
"Sunday" three times and "Tuesday" once for a Monday, once directly after reading the clock.
Both now state the local date with its weekday (`test/dateLine.test.ts`); after the change, the
same model named the day correctly in every run.

## VIBE's tool-choice arm (v3.1, M3)

`LMSTUDIO_EVAL=1 EVAL_SUBSET=1 EVAL_PASSES=3 EVAL_VIBE=1 npm run eval:tools -- <model>` runs the
tool-choice suite with VIBE's line in the system prompt, where the app puts it: after the persona,
ahead of the grounding block. Its results go to `vibe-toolchoice-*.json`, which the model picker's
score line never reads — that line is the full view's number, and the fold is newest-wins, so a
VIBE run it read would quietly replace it (`test/evalResults.test.ts`). 3.0 measured VIBE's
placement on one question, eight turns; this is the whole suite, beside the same suite without it.

qwen3.8-9b-distill (Q4_K_M, a 68,608-token window, fully on an RTX 5070), temperature 0, the app's
own six tools per fixture, three passes, 2026-09-28, the app closed and nothing else on the server:

| arm | clean per pass | correct-tool | spurious | stable-pass · stable-fail · flaky |
| --- | --- | --- | --- | --- |
| VIBE off | 21, 21, 21 of 24 | 54/63 · 86% | 0/9 | 21 · 3 · 0 |
| VIBE on, the 3.0 line | 20, 20, 20 | 51/63 · 81% | 0/9 | 20 · 4 · 0 |
| **VIBE on, the 3.1 line** | **21, 21, 21** | **54/63 · 86%** | **0/9** | **21 · 3 · 0** |

With no flaky case in either arm the noise floor is zero, so the one fixture between the first two
rows is the line's doing: **`13-memory-save` — "remember that my favorite band is Phish" — called
`memory_save` 3 times in 3 without VIBE and 0 in 3 with it.** The three stable failures shared by
every row (`03-write-file`, `05-web-search-fx`, `24-reference-own-docs`) are the model's without
VIBE too. The time question 3.0 was built on, `09-datetime`, passes in every row.

What the miss looked like, from one request at temperature 0: the model's reasoning read *"This is
a preference they want stored for future conversations, so I should use memory_save"*, and its
reply read **"I've saved that — your favorite band is Phish."** Nothing was saved. It is 3.0's time
question again — the reasoning names the tool, the answer skips it and states the outcome — and
here the invented outcome is an action the app did not take.

**Finding the line.** Three variants of the 3.0 line on the full suite left `13` at 0 in 3: with
a sentence added telling the model to use its tools as usual (and a list fixture went flaky),
without "no talk of tools or sources", and without "the user sees nothing but the conversation". A
probe then asked four wordings of a "remember" request plus the time question, one request each
with the eval's own per-prompt tool subset:

| wording | calls kept of 5 | the misses |
| --- | --- | --- |
| no VIBE | 5 | — |
| 3.0: "the user sees nothing but the conversation. Once you have what you need, answer in a few calm sentences…" | 3 | two "remember" requests, **both replies claiming the save** |
| the same without "the user sees nothing…" | 3 | a "remember" request (claimed), and the time question |
| "keep your final reply to a few calm sentences…" | 4 | a "remember" request (claimed) |
| "VIBE mode shapes only the words of your final reply…" | 4 | the time question |
| "First do whatever the request needs, calling any tool it takes; then answer…" | 5 | — |
| **"It changes only how your final reply reads: … Everything else, calling tools included, works as it always does."** | **5** | — |

The shipped line is the last: it says what VIBE changes — the reply's shape — and says in so many
words what it does not. On the full suite it matches the arm without VIBE fixture for fixture.

**It is still brief.** Reply length at temperature 0, no tools, the same model:

| | "explain dark matter" | "how do I get better at sleeping?" | "what should I know before adopting a dog?" | "write me a detailed step-by-step guide to brewing beer at home" |
| --- | --- | --- | --- | --- |
| no VIBE | 355 words, 19 heading/list lines | 278, 19 | 275, 25 | 975, 75 |
| the 3.0 line | 155, 0 | 159, 0 | 226, 0 | 707, 17 |
| the 3.1 line | 191, 0 | 206, 0 | 241, 0 | 771, 37 |

Prose without headings or lists where the question is open, a little longer than 3.0's; the long
piece still comes in full when it is asked for.

**Caveats.** One model: the 35B-A3B arm is owed, and on this card it is an hour or more of
server time that `eval:agent`'s baselines also need. The probes are one request per cell at
temperature 0 — they chose the candidate, the full suite judged it. The suite has no small talk
(none of its 24 prompts is, by S3's classifier), so S3's greeting fast path cannot move it, and did
not. The standing tool-choice numbers above (v2.5) were qwen3.8-9b at an 8,192-token window; that
model is gone from the bench, so this section's control arm is its own, on the distill.
