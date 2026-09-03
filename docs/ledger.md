# The fact ledger (v2.6)

Verification is the most expensive thing the app does, and until v2.6 it was thrown away: a
price confirmed against a page on Monday was searched for again on Tuesday as if Monday had not
happened. The fact ledger keeps what a turn verified, with its source and its date, and answers
from it next time — or, when the entry has passed its freshness window, re-checks it and says
what changed. This page is what that means in practice, what the app enforces, and what it
does not.

## What ships

- **A library pack the app writes.** The ledger is the pack `verified-claims`, kind `app`,
  under the same directory as your other packs. One document per claim: the sentence of the
  reply that carried it, the source URL, the date it was checked, the claim's class and value.
  Settings → Library lists it as *written by this app* with a purge control and nothing else;
  it cannot be embedded, updated from a folder, or exported as a curated pack.
- **What counts as a claim.** A price, a measurement, a street address, a phone number or email,
  a URL, a full date, or a year in a sentence that says what happened in it. A claim enters the
  ledger only when a source the turn retrieved — a search result, a fetched page, a library
  passage with a web source — states the same value in its own text. Presence, never derivation:
  a figure the model computed from a source has no line in any source to point at and is not
  kept. A claim the reply made from nowhere is the grounding pass's business, not the ledger's.
- **One writer.** Entries are written after the grounding pass, by the app, from what that
  pass could bind to a source. Models cannot write to the ledger; tools cannot; nothing arrives
  through a prompt. Ephemeral chats write nothing.
- **Typed freshness.** A price expires after a day. An address or a contact holds for six
  months. A measurement, a release date or a manual's URL for two years. A founding year never.
- **Recall before search.** On a factual question the ledger is consulted before the app-run
  web search. A fresh entry is handed to the model with its source and check date, and the
  search is skipped: the reply says it answered from what was verified earlier and when. An
  expired entry is handed over marked as such, the search runs, and the model is asked to say
  whether the value changed. Under the reply a line says which happened.
- **Contradiction, surfaced.** When a re-check binds a different value to the same claim, the
  entry is superseded and the reply carries a line: *changed since it was last verified: was X,
  now Y*. The old value is not silently replaced.
- **A switch.** Settings → Models, under the grounding checks: *Fact ledger* turns recall and
  capture off together.

## What the model sees

A fresh entry arrives in the turn notes as one line per claim: the sentence, the source, the
check date. The block says the web was not searched because these hold, and asks for the date
to be given. An expired entry arrives under a different lead that says the freshness window has
passed and asks for both values, with dates, if the re-check disagrees. Through
`reference_lookup` the ledger's documents read like any pack's, with a `checked:` line the
formatter prints from the machine date.

## What it will not do

- **Remember a claim without a source.** The ledger is a record of what a source said, not of
  what a model said.
- **Trust the source's tier.** The ledger records where a value was seen; it does not rank the
  source. The provenance marks the search tool prints ride the original result, not the entry.
- **Cross machines.** The pack lives in the app's data directory like everything else; nothing
  is sent anywhere.

## Measured

`LMSTUDIO_EVAL=1 EVAL_SUITES=claims EVAL_CLAIMS_ARMS=bare,ledger EVAL_PASSES=3 npm run eval:answers -- <model>`
asks twenty questions about six fictional entities twice each, in fresh conversations, against
a fixture corpus served on loopback; six price pages change between asks, and the second ask
happens "a day and two hours later" through a clock seam. The `bare` arm is the app without a
ledger; the `ledger` arm is this. The numbers that must move are searches and seconds on the
second ask; the number that must not is answered-correctly on either. Results are in
`docs/evals.md` and the release notes.
