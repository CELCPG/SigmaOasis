# The web trigger: when a turn reaches the web (v4.2)

Whether a chat turn needs the web used to be decided by word lists in `lib/grounding.ts`
(`LIVE_DOMAINS`, `FACT_DOMAINS`, `ASKS_FOR_WEB`, …) that grew one miss at a time — 4.0.1 missed
"weather for righmond va today", "s&p futures" and "the next miami heat game". 4.2 adds a
measured classifier and keeps the lists as overrides.

## What decides

- **The rules first.** A rule hit still forces the web (`looksLive`, `looksFactual`,
  `webToolsForTurn` return what 4.1 returned), and creative or coding intent (`CREATIVE_INTENT`)
  still vetoes — the classifier is not asked on such a turn.
- **Then the classifier** (`lib/webTrigger.ts`, `classifyWebNeed(text) → { label, p, probs }`),
  only when the rules said nothing. Labels: `live` (the answer changes by the hour or day —
  weather, scores, schedules, markets, news, latest versions, opening hours today), `web` (a
  checkable fact the model may not know or may have wrong), `none` (chat, writing, coding on the
  user's own code, maths, advice, questions about the conversation).
  - `p(live) ≥ 0.675` → live: the web tools ride the turn, the app searches, the fact ledger
    stays off it, the top result pages are read.
  - `p(web) + p(live) ≥ 0.925` → the web, unless the reference library covers the domain (as
    for the rules' factual path), or the turn only asks for the web by name ("try duck duck go")
    and so has no subject for the app to search.
- The model is multinomial logistic regression over hashed word unigrams and bigrams, the first
  two words, and character 3-grams inside words (typos: "righmond", "tmrw"), in 2^14 buckets —
  `lib/webTriggerFeatures.ts`. Pure, deterministic, no network; about 50 µs a message. Weights
  are `lib/webTrigger.model.json` (≈115 KB).

## Measured

Held-out split of `test/fixtures/webTrigger/labelled.jsonl`: 215 prompts (58 live, 64 web, 93
none), never trained on. `test/webTrigger.test.ts` prints this table on every run.
"web+live" counts a turn as reaching the web when the app searches (`looksFactual`) or puts the
web tools on the wire (`webToolsForTurn`); a false alarm is a `none` turn that does.

| system                        | precision | recall | false alarm |
| ----------------------------- | --------: | -----: | ----------: |
| live — rules (4.1)            |     75.0% |  10.3% |        1.3% |
| live — rules + classifier     |     93.2% |  70.7% |        1.9% |
| web+live — rules (4.1)        |     78.7% |  30.3% |       10.8% |
| web+live — rules + classifier |     87.6% |  75.4% |       14.0% |

The test asserts: recall no worse than the rules alone (it is 40+ points better on both), web+live
false alarms ≤ 18% of chat turns and no more than 6 points above the rules', live false alarms
≤ 5% of everything not live.

Of the 13 held-out chat turns that reach the web, 10 are the rules' own ("how does a stock market
work", "what should i name my variable that stores the last score") — as overrides they still
force. The classifier adds 3: "what is the speed of light", "what's the meaning of life", "what
day of the week was july 4 1976".

Caveats: the prompts were written for this set, not exported from traces, so the mix of classes
is not the app's traffic (real traffic is mostly `none`, where false alarms count most). The set
was grown once after a first held-out run showed chat openers with "today" read as live; the
additions were new prompts of that class, not edits to the held-out ones.

## Adding examples and retraining

1. Append lines to `test/fixtures/webTrigger/labelled.jsonl`, one JSON object each:
   `{"id":"wt-859","text":"…","label":"live|web|none","split":"train|test"}`. Ids are never
   reused or renumbered. The split is fixed by id (`isHeldOut` in `lib/webTriggerFeatures.ts`,
   about one in four); the test names the right value for a new id if it is wrong.
2. Write prompts as people type them: lowercase, typos, no question mark. Label by what the
   answer depends on, not by the words — "how does a stock market work" is `none`,
   "how's the stock market today" is `live`.
3. `bash scripts/train-web-trigger.sh` (add `--errors` to list the train-split prompts the
   cross-validated model gets wrong — where more examples help most). It trains on the `train`
   split only, picks the L2 strength by 5-fold cross-validation, picks the thresholds on the
   out-of-fold predictions (the classifier may flag at most 5% of chat turns; a live reading at
   most 5% of non-live and 3% of chat), and rewrites the model. Same file, same bytes.
4. Run `test/webTrigger.test.ts`: it fails until the committed model is the one the file trains
   (`trainedOn`), and prints the new table — copy it here.

Never tune on the held-out split: thresholds and hyperparameters come from cross-validation on
`train`, so the table above is a measurement, not a fit.
