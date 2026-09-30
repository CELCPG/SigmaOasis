# Code Mode

Part of the [evals index](../evals.md).

## Code Mode (v2.7)

`LMSTUDIO_EVAL=1 EVAL_SUITES=claims EVAL_CLAIMS_ARMS=bare,code npm run eval:answers -- <model>`
runs the fact-ledger fixtures — twenty questions answerable only from pages on loopback — with
a third arm. `bare` is the app: an app-run search, then the model with `web_search` and
`fetch_webpage`. `code` is Code Mode as a slot would see it: no app-run search and one tool,
`run_code`, whose Python program reaches the two web tools through the bridge — the same
handlers, allowlisted and counted, answered the way the renderer answers them. Scored the same
way: every expected pattern in the reply, searches counted wherever they came from, plus how
many programs the model wrote and how many calls they made.

qwen3.8-9b, one pass (2026-09-03, `.eval-results/answers-qwen3.8-9b-2026-09-03T13-56-29.json`):

| arm | ask 1 answered | ask 2 answered | searches per ask | programs per ask | s/ask |
| --- | --- | --- | --- | --- | --- |
| bare | 16/20 | 16/20 | 1.0 | — | 19–25 |
| code | 16/20 | 16/20 | 1.4 | 1.6 | 51–60 |

**A null result on correctness, and a cost.** The same sixteen cases answered in both arms
and the same four failed — a manual's URL, two dates, a tour length — on the reply's formatting
in both. Every case in the code arm did what the mode is for: the model wrote a program, the
program called `tools.web_search` (and, in eight cases, a second call or a second program),
the bridge charged the call and returned the page, the program printed the answer. What that
bought on these questions was nothing, at 2.7 times the time: one search answers each of them,
and a program that makes one call is a slower way to make it. The cases that ran two or three
programs (11, 12, 17, 18) are the model rewriting after a first program printed too little —
the tool loop's repair, at program cost. (Both arms' seconds are higher than the ledger run's
because this run shared the machine with the check suite for its first half; the arms shared
the contention alike.)

The default is **native**, as the strategy's prior said it would probably be: a 9B does not
orchestrate better by writing the orchestration down. The mode ships for the case this suite
does not contain — several tools whose results feed each other, where one program states the
method — and the switch says so.
