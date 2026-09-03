# Standing questions (v2.6)

`price_watch` was one instance of a general thing: a question the user wants re-asked. Settings →
Jobs is the general thing — a local scheduler that re-runs something you already ran once, on a
schedule, **while the app is open and only then**, and delivers each result as a message in a
conversation of its own. This page is what that means in practice, what the app enforces, and what
it does not.

## What ships

- **Four kinds of job.** Re-run a saved deep-research question (with a depth and the model it
  planned with); re-check a watched price (an item already on the `price_watch` list — the job
  fetches the page, reads the price the way the shopping tools do, and records the point, so the
  drop-against-target arithmetic the watchlist already knows runs for the first time on a
  schedule); re-check the verified claims past their freshness (each entry's own source is
  fetched again; one that still states the value is re-dated, one that does not is reported and
  stays expired); check the tracked pack folders for changes (a report, never an update — updating
  rewrites the pack and is yours to press).
- **A job never invents a request.** Its arguments are the ones you gave when you ran the thing
  the first time, fixed at creation. It never runs a tool that confirms — no terminal, no file
  write, no MCP call under `ask` — and a runner that would need one refuses and says so on the
  job's row. So a job never needs a standing grant and cannot mint one.
- **Hourly, daily or weekly**, with the first run on the next tick after you add it. The
  scheduler ticks once a minute while the app is open, runs one job at a time in due order, and is
  torn down when the app quits. Nothing runs while the app is closed; nothing listens on a port.
- **A digest conversation per job**, created on the first delivery and named after the job with a
  📬, one message per run. If no window is open when a run finishes (macOS keeps the app alive
  with every window closed), the digest is held and handed over on the next tick that has one.
- **Every run is in the audit log** under the digest conversation, as a tool call named
  `job:<kind>` with the outcome; every request a runner makes goes through the same audited
  fetch as a typed turn, under its own purpose, so it is in the network activity log.
- **Ten consecutive failures switch a job off**, with the reason on its row. A skipped run — the
  shopping proxy is required and none is set, research plans need confirmation — is not a
  failure and says why. Switching a job back on forgives its failures and runs it soon.

## What it will not do

- **Run while the app is closed.** A resident, menu-bar mode is a separate decision and would
  change nothing above.
- **Act on the world.** A job reads, records and reports. The one thing it writes is its own
  digest, and the re-dated check on a verified claim its own source still states.
- **Pick its own model.** A research job uses the model it was created with, or the first enabled
  slot if that one is gone.

## Measured

There is nothing here to measure with a model: a job composes tools that are measured on their
own. The node suite pins the scheduling arithmetic, the failure cap, the held digest, the
one-at-a-time guard and the store; the render and audit suites pin that a digest renders as a
chat message does and is audited as a tool call is.
