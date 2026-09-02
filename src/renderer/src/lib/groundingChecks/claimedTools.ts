// Split out of lib/toolGrounding.ts (v2.4): the "claimedTools" section. Behaviour-neutral —
// every declaration is the one that lived there, moved. lib/toolGrounding.ts re-exports
// all of them, so callers and tests are unchanged.

import type { ToolCallRecord } from '../../types'
import { TOOL_DEFS } from '../../../../shared/tools'



// ---- claimed tools (v1.12.1) ---------------------------------------------------

/**
 * The reply's account of its own process, checked against the turn's records.
 *
 * Every other rung here checks what the answer says about the *world*. This one
 * checks what it says about *itself*: "I've used web_search to gather the
 * latest data" on a turn where web_search was never offered and never ran. The
 * sentence is not a figure, a link or an address, so nothing above contradicted
 * it — and it is the claim a reader most readily believes, because it is a
 * claim about the app they are looking at.
 *
 * The vocabulary is the shared tool table, never a copy: rename a tool and this
 * check follows it, rather than quietly going blind on the new name.
 */
const TOOL_NAMES: readonly string[] = TOOL_DEFS.map((d) => d.name)

export /**
 * The identifier as the reply might write it: `web_search`, optionally
 * backticked — or spelled out, but only as "the web search tool". Ungated
 * prose would report an ordinary sentence about market data as a tool claim,
 * and the phrase "tool" is what makes the spelled-out form a claim at all.
 */
function toolNamePattern(name: string): RegExp {
  return new RegExp(`\\b(?:${name}|${name.split('_').join('[ -]')}(?=\\s+tools?\\b))\\b`, 'gi')
}

/**
 * A first-person claim of having run something, in the same sentence and within
 * reach of the name: "I used X", "I've run X", "via X", "using X".
 */
const CLAIM_LEAD =
  /(?:\b(?:i|we)(?:'ve|'d| have| had)?\s+(?:just |already |then |also )?(?:used|ran|run|called|invoked|queried|executed|performed|checked)\b|\b(?:used|ran|called|invoked|queried|executed|performed|via|using)\b)[^\n]{0,32}$/i

/**
 * A tool the model is offering, declining or denying is not a tool it claims to
 * have run. "I can run web_search if you want", "I could not use web_search",
 * "no web_search is enabled" — all honest, none of them findings.
 */
const NOT_A_CLAIM =
  /\b(?:can|can't|cannot|could|should|would|will|may|might|try|trying|consider|recommend|suggest|if|unless|never|not|no|without|unable|instead|rather)\b|n't\b/i

/**
 * A claim about an earlier turn is outside what these records can judge — this
 * pass only ever sees the turn it is checking.
 */
const ANOTHER_TURN = /^[^.?!\n]{0,32}\b(?:earlier|previously|last turn|before|above|already)\b/i

export /** How much of the sentence around the name is read for the claim. */
const CLAIM_WINDOW = 120

/**
 * Tools the reply says it used that ran nowhere in this turn's records.
 *
 * Status is deliberately not consulted: a tool that ran and errored *did* run,
 * and the reply saying so is true. What is false — and what this reports — is
 * naming a tool the turn never called at all.
 */
export function unrunToolClaims(answer: string, records: ToolCallRecord[]): string[] {
  const ran = new Set(records.map((r) => r.name))
  const flagged: string[] = []
  for (const name of TOOL_NAMES) {
    if (ran.has(name)) continue
    for (const m of answer.matchAll(toolNamePattern(name))) {
      const before = answer.slice(Math.max(0, m.index - CLAIM_WINDOW), m.index)
      const sentence = before.split(/[.?!\n]/).pop() ?? ''
      if (!CLAIM_LEAD.test(sentence) || NOT_A_CLAIM.test(sentence)) continue
      if (ANOTHER_TURN.test(answer.slice(m.index + m[0].length))) continue
      flagged.push(name)
      break
    }
  }
  return flagged
}

export /**
 * A heading that opens the reply's own account of its tool use: "Tools used:",
 * "**Tools I used**", "### Tools called". Optional markdown furniture, and the
 * word "tool" is what makes it a disclosure rather than a sentence.
 */
const DISCLOSURE_HEADING =
  /^[ \t]*(?:[#>*_\-|]+[ \t]*)*\**[ \t]*tools?[ \t]+(?:i[ \t]+|we[ \t]+)?(?:used|use|called|ran|run|invoked|consulted)\b/im

/** A disclosure that says nothing ran is honest about naming no tool. */
const DISCLOSED_NOTHING = /\b(?:none|no tools?|nothing|without[ \t]+(?:any[ \t]+)?tools?)\b/i

export /** The identifier as a disclosure row might write it, claim lead not required. */
function bareToolPattern(name: string): RegExp {
  return new RegExp(`\\b(?:${name}|${name.split('_').join('[ -]')})\\b`, 'i')
}

/**
 * Tools that ran this turn which the reply's own "Tools used" section omits.
 *
 * The gap `unrunToolClaims` cannot see. That check scans for tool *names*, so
 * it only ever speaks when the reply names one — and a disclosure that names
 * none is invisible to it. Measured: a turn whose sole call was
 * `reference_lookup` answered under a heading reading "Tools used:" with a
 * two-row table whose rows were library *documents*, never mentioning the tool
 * at all. Every name in it was real, every quote in it checked out, and the
 * reader's question — which tools ran — was answered with something that was
 * not a tool. Nothing above had a name to fault, so nothing was said.
 *
 * A reply is free to describe its process in prose; this speaks only when it
 * sets up an explicit tools-used section and then fails to name a call the
 * turn actually made. The section is taken as the rest of the answer, which is
 * the lenient direction: naming the tool anywhere after the heading clears it.
 */
export function undisclosedToolRuns(answer: string, records: ToolCallRecord[]): string[] {
  const ran = [...new Set(records.map((r) => r.name))]
  if (ran.length === 0) return []
  const heading = DISCLOSURE_HEADING.exec(answer)
  if (!heading) return []
  const section = answer.slice(heading.index + heading[0].length)
  if (DISCLOSED_NOTHING.test(section)) return []
  const omitted = ran.filter((name) => !bareToolPattern(name).test(section))
  // A section that names some of the calls is an account with a gap in it, not
  // a fabricated one; only a section naming none of them is the measured shape.
  return omitted.length === ran.length ? omitted.sort() : []
}
