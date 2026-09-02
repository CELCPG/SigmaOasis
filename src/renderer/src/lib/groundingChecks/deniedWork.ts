// Split out of lib/toolGrounding.ts (v2.4): the "deniedWork" section. Behaviour-neutral —
// every declaration is the one that lived there, moved. lib/toolGrounding.ts re-exports
// all of them, so callers and tests are unchanged.

import type { ToolCallRecord } from '../../types'
import { OUTCOME_NOTE, callOutcome, type CallOutcome } from '../grounding'
import { CLAIM_WINDOW, bareToolPattern, toolNamePattern } from './claimedTools'



// ---- work the reply says it has not done (v2.2) --------------------------------

/**
 * v2.3: the reply's account of the application, read in the DENIAL direction.
 *
 * `unrunToolClaims` catches a reply that says it *used* a tool that never ran.
 * Measured, blind, round 11, in **both** builds and on more than one task, the
 * mirror image shipped and every rung stayed silent:
 *
 *     "No documents were used in that response — it came entirely from general
 *      knowledge already in my training data. I did not call any search or
 *      reference lookup tools."
 *
 * sitting directly under `✓ ⚙️ reference_lookup` three times over and the app's
 * own footer reading `📖 From the library: 17 passages from 3 lookups — the
 * answer cites [1] [5]`. And on another task:
 *
 *     "I'd need to consult additional sources beyond what's in your library.
 *      Would you like me to search for current guidance on that?"
 *
 * against `✓ 🔍 web_search` with three results already returned.
 *
 * The two directions are not the same failure with the sign flipped. A
 * fabricated call inflates the reply's authority, and the reader who doubts it
 * can look at the tool blocks — the evidence that settles it is on screen. A
 * denied call tells the reader those blocks are meaningless, and there is
 * nothing on screen to check *that* against. It is the direction that teaches a
 * reader to distrust evidence sitting in front of them, which is the one thing
 * this whole ladder exists to prevent.
 *
 * **What this rung settles, and the three neighbours it will not touch.** Only
 * the *act*: whether a call the records hold happened. Three claims one rung
 * over are left alone because no artifact here settles them, and a rung built
 * on a fact the app cannot establish is worse than the gap it closes —
 *
 * - **Where the answer's content came from.** "It came entirely from general
 *   knowledge" is a claim about the model's reasoning over passages it was
 *   handed. The records show the passages arriving; nothing shows whether a
 *   sentence was written out of them. Only the act sentence beside it is
 *   checkable, and only that one is checked.
 * - **How long the turn took.** `run.json`'s `record.beyondAnyRecord` names a
 *   self-timed figure as the type case of what nothing here can settle: a
 *   record of it is the same number written down twice, agrees by construction,
 *   and is evidence of nothing. "It took essentially zero time" is qualitative
 *   besides — the threshold that makes it false would be invented by this file,
 *   which is exactly the guess `describeCoverage` refuses to make about which
 *   measurement a reply is *about*.
 * - **What shape the sources were.** `record.library` does name the installed
 *   packs, and it is a **bench** artifact: the harness reads `libraryList()`
 *   after the turn, from outside the app. This pass is synchronous, runs in the
 *   renderer, and holds the turn's records and nothing else.
 */

/**
 * A call that HAPPENED, in the vocabulary the tool rows already use.
 *
 * A declined call never reached its handler and a running one has not finished,
 * so a reply saying either did not run is telling the truth. An errored call
 * ran — which is `unrunToolClaims`' own rule ("a tool that ran and errored *did*
 * run") read in the mirror, and it has to be the same rule in both directions
 * or the app contradicts itself about one record.
 */
function callHappened(record: ToolCallRecord): boolean {
  const outcome = callOutcome(record)
  return outcome !== 'declined' && outcome !== 'running'
}

/** A negated auxiliary: `did not`, `didn't`, `have not`, `never`. */
const NEGATED = String.raw`(?:did|do|have|has|had|was|were)(?:n[’']t|[ \t]+not)|never`

/** The act itself, in the words a reply denies it in. */
const DENIED_ACT =
  'used?|calls?|called|runs?|ran|invoked?|quer(?:y|ied|ies)|consults?|consulted|' +
  'searche?[sd]?|executed?|performs?|performed|access(?:ed|es)?|touch(?:ed)?'

/**
 * A plain, unhedged, first-person denial of the act, ending within reach of the
 * tool's name — `CLAIM_LEAD`'s mirror, anchored the same way.
 *
 * Modals are absent on purpose and it is the single most important omission in
 * this file. "I could not use web_search to find their number" is, far more
 * often than not, a sentence about what the results contained rather than about
 * whether the call went; so is "I would need to search for that". Faulting
 * those is round 4's cry-wolf in a new coat, and the cost of leaving them out
 * is a miss on a shape nobody has recorded.
 */
const DENIAL_LEAD = new RegExp(
  `\\b(?:i|we)[ \\t]+(?:${NEGATED})[ \\t]+(?:actually|really|ever|in[ \\t]+fact)?[ \\t]*` +
    `(?:${DENIED_ACT})\\b[^\\n]{0,48}$`,
  'i'
)

/**
 * The reply affirming, anywhere, that this same tool DID run — and the reason
 * this rung does not fire on `.h2h-runs/B3/VC3-20260824-171623`.
 *
 * That reply says both things: "I did use reference_lookup for your cooked
 * chicken question" and, two lines down, "I did not use reference_lookup for
 * the cooking temperature part". One lookup ran, so read alone the second
 * sentence is a denial of a call the records hold — and it is nothing of the
 * kind. The reply is dividing one call between two halves of a question, which
 * is a claim about *what the passages covered*, and this pass cannot adjudicate
 * that any more than it can decide which measurement a reply is about.
 *
 * A reply that affirms and denies the same tool has therefore said nothing this
 * rung can fault, and the whole tool goes quiet. Deliberately not
 * `unrunToolClaims`' `CLAIM_LEAD`: that pattern is a *detector*, and widening it
 * would change what that rung reports. This one is a *suppressor*, so it is
 * written wider — "I did use", which `CLAIM_LEAD` does not match — and every
 * gap in it costs a miss rather than a false accusation.
 *
 * Modals stay out of the filler list on purpose, and that is what keeps the
 * recorded failures flagged: all four of them end by offering to run the tool
 * ("I can run `reference_lookup` right now"), and an offer is not an affirmation
 * that it already happened.
 */
const AFFIRMED_ACT =
  'use[ds]?|calls?|called|ran|run|invoke[ds]?|quer(?:y|ied|ies)|consults?|consulted|' +
  'searche?[sd]?|checks?|checked|retrieve[ds]?'

const AFFIRMED_LEAD = new RegExp(
  `\\b(?:i|we)(?:[’']ve|[’']d)?[ \\t]+(?:(?:did|do|have|had|just|already|then|also)[ \\t]+){0,3}` +
    `(?:${AFFIRMED_ACT})\\b[^\\n]{0,48}$`,
  'i'
)

/** `no <tool>` immediately before the name… */
const NO_BEFORE = /\bno[ \t]*$/i
/** …and `ran` / `was used` immediately after it. Tight on both sides so that a
 * sentence about the *results* ("no results were used from web_search") cannot
 * be read as a denial that the call went. */
const RAN_AFTER = /^[ \t]*(?:calls?[ \t]+)?(?:ran\b|(?:was|were)[ \t]+(?:run|used|called|made|invoked)\b)/i

export /**
 * A hedge is not a denial.
 *
 * "I may not have searched", "I don't think I called reference_lookup", "if I
 * did not use it" — a model unsure of its own process is saying something
 * strictly weaker than "it did not happen", and this rung's whole licence to
 * exist is that it stays quiet on those. Over-broad on purpose: every word here
 * costs a miss and none of them can manufacture a finding.
 */
const HEDGED =
  /\b(?:may|might|maybe|perhaps|possibly|probably|apparently|seems?|seemed|appears?|appeared|think|thought|believe|recall|remember|sure|certain|unclear|unsure|assume[ds]?|assuming|suppose[ds]?|if|whether|unless|can|could|would|should|will|shall|must)\b/i

/**
 * A back-reference puts the sentence outside what these records can judge, and
 * the recorded failure carries one of each. "No documents were used in **that
 * response**" points somewhere this pass never sees; the sentence after it — "I
 * did not call any search or reference lookup tools" — points at this turn.
 * Only the second is this turn's to fault, and the first is a true negative in
 * the suite for exactly that reason.
 */
const ABOUT_ANOTHER_TURN =
  /\b(?:earlier|previously|last[ \t]+turn|before|above|already|that[ \t]+(?:response|answer|reply|message|turn)|the[ \t]+previous|my[ \t]+(?:last|first)|first[ \t]+draft)\b/i

/**
 * The denial that names nothing: "I did not use any tools", "no tools were
 * used", "no tools ran". The records settle it outright — something ran or it
 * did not — and it is half of the sentence the recorded reply actually shipped.
 */
const BLANKET_DENIAL = new RegExp(
  `(?:\\b(?:i|we)[ \\t]+(?:${NEGATED})[ \\t]+(?:${DENIED_ACT})[ \\t]+(?:any[ \\t]+)?` +
    `(?:[\\w-]+[ \\t]+|or[ \\t]+){0,4}?tools?\\b` +
    `|\\bno[ \\t]+tools?[ \\t]+(?:were|was)[ \\t]+(?:used|called|run|made|invoked)\\b` +
    `|\\bno[ \\t]+tools?[ \\t]+ran\\b)`,
  'i'
)

/**
 * The work a reply offers to begin, in the words it offers it in.
 *
 * Four entries, deliberately. An act vocabulary is a guess about language, and
 * every entry that is not unmistakably *this tool's* work is a way to fault a
 * reply for a sentence about something else. `web_search`'s act stands down
 * when the sentence goes on to name a different corpus: a library search
 * offered while a web search ran is an offer to do something that did not
 * happen.
 */
const OFFERED_ACT: readonly (readonly [name: string, act: RegExp])[] = [
  [
    'web_search',
    /\b(?:search|google|look[ \t]+(?:it|this|that|them)[ \t]+up)\b(?![^.?!\n]{0,32}\b(?:librar|reference|packs?\b|notes?\b|memor|files?\b|attach)\w*)/i
  ],
  [
    'reference_lookup',
    /\b(?:search|check|consult|look)\b[^.?!\n]{0,32}\b(?:librar(?:y|ies)|references?|packs?)\b/i
  ],
  ['deep_research', /\bresearch\b/i],
  [
    'fetch_webpage',
    /\b(?:open|fetch|read|pull[ \t]+up|visit)\b[^.?!\n]{0,32}\b(?:pages?|urls?|links?|sites?|articles?)\b/i
  ]
]

/** The sentence is an offer, not a report: "would you like me to…", "I can…". */
const OFFER_LEAD =
  /\b(?:would[ \t]+you[ \t]+like|do[ \t]+you[ \t]+want|shall[ \t]+i|want[ \t]+me[ \t]+to|like[ \t]+me[ \t]+to|i[ \t]+can|i[ \t]+could|happy[ \t]+to|let[ \t]+me[ \t]+know[ \t]+if|say[ \t]+the[ \t]+word|if[ \t]+you(?:[’']d|[ \t]+would)?[ \t]+like)\b/i

/**
 * An offer to do it AGAIN is not an offer to begin it, and the brief this rung
 * was built to is explicit that it must produce silence. Every word here
 * concedes that a first pass happened.
 *
 * The second line is `.h2h-runs/A7/TTU1-20260825-021621`, which the first
 * version of this list flagged and should not have. A web search had run; the
 * reply said the packs it got back do not cover replacement intervals, that it
 * would need "a **fresh** web search", and offered "a **targeted** web search".
 * Every one of those adjectives concedes the first pass as plainly as "again"
 * does, and the reply is doing the honest thing — saying what it has is not
 * enough. Naming the qualifier that distinguishes a second search from a first
 * is not a hedge word; it is the concession itself.
 */
const OFFER_IS_A_REPEAT =
  /\b(?:again|another|a[ \t]+second|second|further|additional|more|deeper|broader|wider|elsewhere|else|other|others|different|instead|also|too|as[ \t]+well|follow[- \t]?up|expand|extend|refine|narrow|re-?run|re-?search|re-?check|beyond|next)\b|\b(?:fresh|targeted|new|separate|dedicated|specific|supplementary|proper)\b/i

/**
 * The reply reporting, in the past tense, that work was done — the *shape* of an
 * acknowledgment, with no opinion about which tool did it.
 *
 * An offer beside an acknowledgment is a next step. "I searched and found the
 * hours; would you like me to search for the menu?" is an honest sentence, and
 * the app cannot tell one subject from another — see `describeCoverage` for why
 * it must not try. An offer with nothing acknowledging that work is an offer to
 * begin. Written generously, because it suppresses: every pattern here costs a
 * miss and none of them can produce a finding.
 */
const REPORTED_PAST_WORK =
  /\b(?:i|we)[ \t]+(?:just[ \t]+|already[ \t]+|then[ \t]+|also[ \t]+)?(?:searched|looked|found|checked|ran|used|called|consulted|queried|retrieved|fetched|pulled|read)\b|\b(?:searche?s?|lookups?|results?|sources?|passages?|documents?|materials?|references?|pages?)[ \t]+(?:above|below|returned|return|showed?|found|gave|came[ \t]+back|says?|mentions?|mention|directs?|direct|provides?|provide|covers?|cover)\b|\b(?:the|these|those)[ \t]+(?:referenced|retrieved|returned)[ \t]/i

/**
 * Whose corpus a sentence is talking about — and the whole reason the
 * acknowledgment gate is per tool rather than per reply.
 *
 * `.h2h-runs/A11/TTU1-20260828-123018` is the round-11 offer failure in full,
 * and it is richer than the excerpt: `✓ 🔍 web_search` **and**
 * `✓ ⚙️ reference_lookup` both ran, the reply cites `[1] [2] [3]`, says "The
 * passages mention…" and "The references do direct you…", and then closes
 *
 *     "I'd need to consult additional sources beyond what's in your library.
 *      Would you like me to search for current guidance on that?"
 *
 * Every acknowledgment in it is scoped to the **library**, and the offer is
 * scoped explicitly *beyond* the library — to the web search that had already
 * run and returned. An answer-wide gate read those library acknowledgments as
 * covering the web search and went silent on the exact failure this rung was
 * built for. An acknowledgment has to be an acknowledgment *of the tool being
 * offered*.
 *
 * A generic acknowledgment — "the results above", "I searched", a bare `[1]` —
 * still counts for a tool, because with one tool returning there is nothing
 * else it could be about. It stops counting only when the sentence names a
 * **different** tool's corpus, and only when that other tool actually ran.
 */
const TOOL_CORPUS: readonly (readonly [name: string, words: RegExp])[] = [
  ['web_search', /\b(?:search\w*|results?|web|online|internet|google\w*)\b/i],
  [
    'reference_lookup',
    /\b(?:librar\w*|references?|referenced|packs?|passages?|documents?|docs?|notes?)\b/i
  ],
  ['deep_research', /\b(?:research\w*|reports?|briefs?)\b/i],
  ['fetch_webpage', /\b(?:pages?|urls?|links?|sites?|articles?)\b/i]
]

/** A bare citation marker is a reply showing its retrieved evidence. */
const CITED = /\[\d{1,3}\]/

/**
 * Does this reply acknowledge, anywhere, that `name`'s work happened?
 *
 * A sentence qualifies when it reports past work and is not scoped to some
 * *other* tool that ran. Naming the tool outright counts too — that is the
 * least ambiguous acknowledgment there is.
 */
function acknowledges(sentences: string[], name: string, ran: Iterable<string>): boolean {
  const own = TOOL_CORPUS.find(([n]) => n === name)?.[1]
  const others = TOOL_CORPUS.filter(([n]) => n !== name && [...ran].includes(n))
  const bare = bareToolPattern(name)
  return sentences.some((sentence) => {
    // It has to BE an acknowledgment before whose it is can matter. Testing the
    // name first would let the offer sentence itself — "would you like me to run
    // web_search" — clear the very offer it is making.
    if (!REPORTED_PAST_WORK.test(sentence) && !CITED.test(sentence)) return false
    if (bare.test(sentence) || own?.test(sentence)) return true
    return !others.some(([, words]) => words.test(sentence))
  })
}

/** One tool, and how the reply's account of this turn contradicts the records. */
export interface ContradictedToolAccount {
  name: string
  /**
   * `denied` — the reply says the call did not happen. `offered` — the reply
   * puts the work forward as something it could do next.
   */
  kind: 'denied' | 'offered'
  /**
   * Calls that actually happened. For `offered` this counts only calls that
   * came back with something: a search that errored or found nothing is work
   * genuinely still on the table, and offering it again is honest.
   */
  ran: number
}

function timesRan(n: number): string {
  return n === 1 ? 'ran once' : `ran ${n} times`
}

/** One finding, as the badge and the correction prompt both print it. */
export function describeToolAccount(finding: ContradictedToolAccount): string {
  return finding.kind === 'denied'
    ? `${finding.name} ${timesRan(finding.ran)} and this reply says it did not run`
    : `${finding.name} ${timesRan(finding.ran)} and this reply offers to run it`
}

export /** The sentence a match sits in, split out around it. */
function around(answer: string, at: number, length: number): {
  lead: string
  tail: string
  sentence: string
} {
  const lead = (answer.slice(Math.max(0, at - CLAIM_WINDOW), at).split(/[.?!\n]/).pop() ?? '')
  const tail = (answer.slice(at + length, at + length + CLAIM_WINDOW).split(/[.?!\n]/)[0] ?? '')
  return { lead, tail, sentence: `${lead}${answer.slice(at, at + length)}${tail}` }
}

/** A sentence that is neither hedged nor pointed at some other turn. */
function speaksAboutThisTurn(sentence: string): boolean {
  return !HEDGED.test(sentence) && !ABOUT_ANOTHER_TURN.test(sentence)
}

/**
 * Tools this turn ran that the reply denies running, and tools it offers to run
 * that have already run and returned something.
 *
 * Both readings walk the same records `unrunToolClaims` walks, so the two can
 * never both speak about one sentence: `NOT_A_CLAIM` throws out every negation,
 * and this rung requires one.
 */
export function contradictedToolAccounts(
  answer: string,
  records: ToolCallRecord[]
): ContradictedToolAccount[] {
  const happened = new Map<string, number>()
  const returned = new Map<string, number>()
  for (const r of records) {
    if (!callHappened(r)) continue
    happened.set(r.name, (happened.get(r.name) ?? 0) + 1)
    if (callOutcome(r) === 'ok') returned.set(r.name, (returned.get(r.name) ?? 0) + 1)
  }
  if (happened.size === 0) return []
  const sentences = answer.split(/[.?!\n]/)

  // A tool the reply says elsewhere that it DID use. Collected first, because it
  // silences both readings below: a reply that affirms and denies the same tool
  // is dividing one call between parts of a question, not denying the call.
  const affirmed = new Set<string>()
  for (const name of happened.keys()) {
    for (const m of answer.matchAll(toolNamePattern(name))) {
      if (!AFFIRMED_LEAD.test(around(answer, m.index, m[0].length).lead)) continue
      affirmed.add(name)
      break
    }
  }

  const denied = new Set<string>()
  const deny = (name: string): void => {
    if (!affirmed.has(name)) denied.add(name)
  }
  // The denial that names nothing speaks for every call the turn made — that is
  // what "no tools" denotes — and it is checked per sentence so that the guards
  // apply to the sentence doing the denying rather than to the whole reply.
  for (const sentence of sentences) {
    if (!BLANKET_DENIAL.test(sentence) || !speaksAboutThisTurn(sentence)) continue
    for (const name of happened.keys()) deny(name)
    break
  }
  for (const name of happened.keys()) {
    if (denied.has(name) || affirmed.has(name)) continue
    for (const m of answer.matchAll(toolNamePattern(name))) {
      const { lead, tail, sentence } = around(answer, m.index, m[0].length)
      if (!speaksAboutThisTurn(sentence)) continue
      if (!DENIAL_LEAD.test(lead) && !(NO_BEFORE.test(lead) && RAN_AFTER.test(tail))) continue
      deny(name)
      break
    }
  }

  const offered = new Set<string>()
  for (const [name, act] of OFFERED_ACT) {
    // A tool already faulted for being denied gets one line, not two: the
    // denial is the stronger statement and the offer is what it leads to.
    if (!returned.has(name) || denied.has(name)) continue
    // An acknowledgment OF THIS TOOL clears its offers, whichever sentence
    // carries it. One scoped to a different tool's corpus does not.
    if (acknowledges(sentences, name, happened.keys())) continue
    for (const sentence of sentences) {
      if (!OFFER_LEAD.test(sentence) || !act.test(sentence)) continue
      if (OFFER_IS_A_REPEAT.test(sentence) || ABOUT_ANOTHER_TURN.test(sentence)) continue
      offered.add(name)
      break
    }
  }

  return [
    ...[...denied].map(
      (name): ContradictedToolAccount => ({ name, kind: 'denied', ran: happened.get(name) ?? 0 })
    ),
    ...[...offered].map(
      (name): ContradictedToolAccount => ({ name, kind: 'offered', ran: returned.get(name) ?? 0 })
    )
  ].sort((a, b) => a.name.localeCompare(b.name))
}

export function contradictedToolAccountLines(
  answer: string,
  records: ToolCallRecord[]
): string[] {
  return contradictedToolAccounts(answer, records).map(describeToolAccount)
}
