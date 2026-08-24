REFERENCE ARM — captured from claude.ai in the user's own signed-in browser, on
their account and quota, with their explicit authorisation.

WHAT THIS IS AND IS NOT COMPARABLE ON
  This arm runs a very large cloud model with live web access. Sigma Oasis runs
  a 9B model with no network. Any judgement that rests on the ANSWER being more
  knowledgeable is measuring model size and is worthless here. Only judgements
  about the INTERFACE transfer: can a citation be activated, does a long token
  break the layout, how long until the reader can act, is a remembered URL
  distinguished from a retrieved one.

TASKS THAT DO NOT TRANSFER, AND WHY — these were deliberately NOT run:
  FR1, FR2, FR3   depend on Sigma Oasis's own LM Studio fixtures (a streamed
                  context-overflow frame, a stalled socket, an empty reviewer).
                  The reference app has no counterpart to inject.
  PT1, PT2, PT3   depend on Sigma Oasis's plan mode and its approval gate.
  TTU2            depends on Sigma Oasis's local Pyodide sandbox boot.
  V1, V3, TH1, TH3
                  depend on Sigma Oasis's local reference packs being the only
                  source in play. With live web search the question is a
                  different question.
  VC1             COULD NOT BE RUN: the prompt carries a 220-character base64
                  token by design, and the browser tool's safety classifier
                  refused to type it. Recorded as blocked, not as skipped.

SO THE REFERENCE ARM COVERS: V2, TH2, TTU1, TTU3.
