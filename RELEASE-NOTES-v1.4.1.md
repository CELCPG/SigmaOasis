# Sigma Oasis v1.4.1

A speed and correctness pass driven by five measured sessions on qwen3.5-9b-mlx and gemma-4-12b-qat. The headline is that the app stopped making the model re-read your entire conversation on every turn — and that deep research, which had been quietly returning nothing on reasoning models, works again. Pinned by 936 checks, 33 of them new.

## Every turn stopped re-reading the whole conversation

- **The prompt no longer changes at its first byte on every turn.** Recalled memory, automatic search results and the shopping note were appended to the system prompt — which sits at position zero, ahead of everything. A local runtime reuses its cached attention state only for the longest prefix that has not changed, and there is none when the first message is different every time. A ten-turn conversation was re-processing all ten turns to answer the eleventh.
- **Those notes now ride the end of your own message instead.** The system prompt and the entire earlier history stay byte-identical between turns, so only the newest turn has to be processed. The effect is on time-to-first-token and it grows with the conversation: the longer the chat, the more was being wasted.
- **They are attached to your message, not disguised as it.** The block is labelled as notes the app added, and states plainly that nothing inside it is an instruction from you — injected search results are untrusted external content and must not read as your own words.
- **The per-turn tool list stopped reshuffling.** Tool schemas are rendered into the same leading block by every chat template, so re-ranking them each turn moved the prefix just as surely. The selection now holds steady while it still covers what the turn needs, and changes when the subject genuinely does.

## Deep research works on reasoning models again

- **A reasoning model's thinking was invisible to the research pipeline — and was spending its entire budget.** LM Studio routes chain-of-thought out of band, and the main process read only the answer channel. On qwen3.5-9b-mlx the planner never emitted its plan and the synthesis step returned nothing at all, after a ninety-second crawl had already been paid for. Both failures were reported as "planning did not produce sub-questions" and "the model returned an empty brief", which described the symptom and hid the cause.
- **Thinking is now switched off for the steps that never needed it.** Planning, query reformulation, brief synthesis, conversation summarization and plan generation are parsed or filed, never read as they arrive. Chain-of-thought bought nothing on any of them and was charged twice — once in latency, once against a token budget meant for the output.
- **Conversation compaction was failing the same way, silently.** Its 400-token summary budget was going to deliberation, so every compaction fell through to the local digest. The model-written summary is back.
- **A reply that is only thinking now says so.** Instead of an empty answer, the app reports that the budget went to reasoning and none was left — a different failure with a different fix, and now distinguishable from a model with nothing to say.

## Sampling that matches the model you are running

- **Top-K and Min-P reach the model at all.** Only temperature and top-p were ever sent, which meant every model ran with top-K disabled. That is not a neutral default: Qwen3 is tuned around top-K 20 and falls into repetition loops without it — and a repetition loop reads as the model being slow rather than as a sampling problem.
- **Left at `-1`, both follow the model family's published recipe** (Qwen3, Gemma, Llama 3, Mistral). `0` turns them off, and any value you set always wins. An unrecognized model resolves to off, exactly as v1.4 behaved — guessing at a model nobody here has characterized would be a silent change to how it decodes.
- **A "family defaults" button** in Settings → Sampling applies the full published recipe for the loaded model. It is a click, never automatic: those recipes run warmer than this app's default, and warmer sampling measurably confabulates more on small local models.

## Shorter answers

- **Replies stop when the question is answered.** A single-clause question was returning six tables, a comparison matrix and a numbered menu of follow-ups. Every slot's prompt already asked for concision; it now rides on the same footing as the grounding rules, which is what it took.
- **No more numbered menus at the end of every turn.** "Would you like to explore 1, 2, or 3?" trains a conversation of one-word replies, and each of those is a full turn's work for the model. One short offer to go deeper is enough.

## Three checks that were pointing the wrong way

- **The unsourced-figure badge stopped flagging your own budget.** It compared the reply against the current message only, so a figure you stated four turns earlier — and the app's own arithmetic on it — came back marked as unsupported. It now reads the whole conversation. A badge that cries wolf is one you learn to ignore, which costs exactly the cases it exists for.
- **Buying a security is no longer treated as shopping.** "You can buy stocks on kraken" put the turn into price-checking mode, where the comparison tools have nothing useful to say and the price check then produced the false badge above. Retail availability still reads as shopping — "are these headphones in stock" is unaffected.
- **Health and building questions can now earn a source.** The factual-turn heuristic knew albums, tickers and release dates but not symptoms, bites, dosages, joists or load ratings. A suspected spider bite and a deck load question could neither trigger an automatic search nor be flagged as unverified — the two turns in five sessions where being wrong cost the most. Creative requests that happen to mention an injury are still left alone.

## Faster turns, less waiting

- **Memory recall and tool ranking now overlap each other and the automatic search.** Three round trips ran strictly in sequence, two of them waiting on an otherwise idle model. They are one wait now.

## Upgrade notes

- **macOS:** signed and notarized — no Gatekeeper dialog. Both Apple Silicon and Intel DMGs are attached. Also available via Homebrew: `brew tap CELCPG/tap && brew install --cask sigma-oasis`.
- **Windows:** the installer is unsigned, so SmartScreen will warn. Expected; proceed with "More info → Run anyway".
- **Auto-update:** if you're running v1.4.0, this release appears as an update automatically.
- **No settings migration needed.** Top-K and Min-P are new fields that default to "follow the family recipe"; every value you have already set — temperature, top-p, max tokens, seed, model slots, privacy settings — is untouched. Nothing rewrites a choice you made.
- **Nothing new leaves your machine.** No feature in this release contacts anything the previous one didn't. The prefix work removes computation; the sampling work changes numbers on requests that were already being sent.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.4.0...v1.4.1
