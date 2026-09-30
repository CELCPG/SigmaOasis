# Sigma Oasis v4.0.2 — five fixes from a review of 4.0.1

4.0.2 adds nothing. It fixes five bugs a read of the 4.0.1 code found on 2026-09-29: one in the
agent's worktrees, one in how a cut-off round ends a task, one in the agent's budgets, one in what
the fact ledger keeps, and one in how `browse` picks a passage. Pinned by 3,224 node checks and
every Electron check.

## The agent

- **A helper worked in the wrong folder.** With worktrees on (A9, an experiment), the task works
  in its own worktree, but a helper's toolbox was built on the folder the user looks at
  (`engine.ts`). A general helper edited the user's files, not the task's, and the A7 reviewer
  read the unchanged originals. The helper now works where the task works, with the task's
  experiments. `test/agentEngine.test.ts` fails on 4.0.1 and names the file.
- **A cut-off round ended the task as done.** A round that hit the output limit — a `write_file`
  whose file was longer than the round's 16K tokens, say — had its call dropped by the stream, and
  the round, now holding no call, ended the task as *completed* with nothing written. The loop now
  reads the stream's `truncated`: with no call left, the model is told it was cut off and asked to
  work in smaller parts; with calls that ran, it is told the rest did not. Twice per turn at most,
  then a cut-off round is accepted as it stands.
- **MCP tools had no budget in the agent.** A caller's own budget table replaced the MCP default,
  and the agent passes one, so an MCP server's tools (C8, an experiment) could be called without
  limit. The default now holds whenever a table does not name the tool; an empty table still
  turns budgets off.

## The fact ledger

- **It kept the live world.** Any number with a unit was a measurement, fresh for two years, and a
  search snippet counted as its source. A temperature a snippet stated could answer the next day's
  weather question and cancel that day's search. Now a live-world question — weather, a futures
  quote, a game (4.0.1's own test) — files nothing and is answered by no entry, and a claim needs a
  page the turn read, not a snippet: a snippet is a lead, not a source.
- **A price at the end of a sentence was not a price.** "Adult tickets cost $18.50." matched
  nothing, because the pattern refused any full stop after an amount; a page or a reply that ended
  a sentence on a price could never back it. Only a decimal point is refused now.

## Browse

- **"rain" scored on "training".** `browse` (C4, an experiment) ranked passages by substring, so
  an instruction's word counted inside any longer word. A word now matches at the start of a word:
  "rain" finds "raining", never "training".

## Measured

On Windows: `npm run typecheck` clean; the node suite 3,224 of 3,224 (4.0.1's 3,214 and ten new);
every Electron check — render 25, style 74 and 123, tab traversal 43, modal focus 179, field
contrast 22, settings kit 12, button names 20, plan accessibility 175, main bundle 20, markdown 62,
workbench 53, MCP secrets 19, transport 24. The helper test was run against the 4.0.1 engine and
fails there.

Not run live: no model was loaded for this release.

## Upgrade notes

- Ledger entries 4.0.1 wrote from snippets stay until they expire; new ones need a page.
- `ROADMAP-v4.1.md` is the plan for the next release.
