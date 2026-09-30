# The fact ledger

Part of the [evals index](../evals.md).

## The fact ledger: does verification compound? (v2.6)

`LMSTUDIO_EVAL=1 EVAL_SUITES=claims EVAL_CLAIMS_ARMS=bare,ledger npm run eval:answers -- <model>`
asks twenty questions about six fictional entities — a museum, a backpack, a notes app, a hot
spring, an EV charger, a rowing club — twice each, in fresh conversations, against pages served
on loopback through the research suite's fixture seam. Six of the questions are prices whose
page changes between asks; for those the second ask happens "a day and two hours later" through
a clock seam, past a price's freshness, and the search and page caches are cleared between asks
as time would clear them. The `bare` arm is the app without a ledger (an app-run search, then
the model with web tools); the `ledger` arm is v2.6 (the ledger provider ahead of the search,
the capture after the grounding pass). Scoring is mechanical: every expected pattern in the
reply; web searches counted, app-run and model-run together; the ledger's own disclosure read
off the reply; the contradiction read off the capture's supersession.

qwen3.8-9b, 8,192 context, temperature 0, one pass (2026-09-03, `.eval-results/answers-qwen3.8-9b-2026-09-03T02-27-22.json`):

| arm | ask 1 answered | ask 2 answered | ask 2 searched | ask 2 from a dated ledger entry (unchanged cases) | contradiction surfaced (changed cases) | ask 2 seconds |
| --- | --- | --- | --- | --- | --- | --- |
| bare | 16/20 | 16/20 | **20/20** | — | — | 8 |
| ledger | 17/20 | 17/20 | **9/20** | **14/14** | **6/6** | 12 |

What moved: the second ask searched in 9 cases instead of 20, and the 11 that did not search
answered from an entry the first ask had verified, with its date, disclosed under the reply.
The 9 that did are the six changed prices — re-checked by design, each of which superseded its
entry and surfaced *was X, now Y* — plus three where the model, handed a fresh entry and
reminded that the app had not searched, called `web_search` itself anyway (cases 12, 16, 19);
the app-run search was suppressed in all fourteen unchanged cases.

What did not move: answered-correctly, within one case (case 18 flipped in the ledger's
favour; three fixtures — a manual's URL and two dates — fail in both arms alike, on the reply's
formatting rather than its content, and are the suite's noise floor). And **seconds did not
fall**, which the table states rather than hides: against a loopback fixture server a search
costs nothing, so the arm that skips it saves nothing here, while the ledger arm pays a
keyword lookup, a longer prompt and, on the six re-checks, a search plus a fetch. The claim
this suite supports is the one about searches and about what the second ask says, not one
about time; a real search is one to three seconds of network the fixture cannot represent.

Two things the run shows that the design must own. First, the ledger accumulates across
cases as it would across days — by case 15 the first ask already found the backpack's weight
in an entry captured while answering about its price, and searched nothing — so "ask 1" in
the ledger arm is not a clean baseline; the bare arm is. Second, one pass, not three: the
mechanical rows (searched, from-ledger, contradiction) are app behaviour, not model
behaviour, and did not need a stability run to be read; the answered rows are within the
noise the other suites have measured at temperature 0.
