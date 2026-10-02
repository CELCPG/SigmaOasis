import type { ModelConfig, ToolSchema, ToolToggles } from '../types'
import { TOOL_SCHEMAS } from '../../../shared/tools'
import { BRIDGE_EXCLUDED } from '../../../shared/codeSdk'
import { isSmallTalk } from './quickReply'

/**
 * Per-role tool allowlists (strategy Layer 1a).
 *
 * Small models degrade sharply as the tool list grows, and a role that never
 * touches the terminal should never hold it. `ModelConfig.tools` is the
 * allowlist; this is the one place its semantics live:
 *
 * - absent / not an array → all globally-enabled tools (legacy behavior, so
 *   existing settings migrate untouched)
 * - an explicit array — even empty → only the named tools that are *also*
 *   globally enabled (a global toggle-off always wins)
 *
 * Unknown names in the allowlist are ignored rather than erroring: the
 * toolbox changes across versions and a stale name must not break a slot.
 */
export function toolsForSlot(
  slot: Pick<ModelConfig, 'tools' | 'codeMode'>,
  available: ToolSchema[]
): ToolSchema[] {
  const listed = !Array.isArray(slot.tools) ? available : available.filter((t) => new Set(slot.tools).has(t.function.name))
  // v2.7 Code Mode: native slots never see run_code; a code slot sees only
  // run_code (its program reaches the rest through the bridge, which checks
  // this same list at call time); both is both.
  const mode = slot.codeMode ?? 'native'
  if (mode === 'native') {
    // The same array back when nothing was stripped: callers compare by identity.
    const stripped = listed.filter((t) => t.function.name !== 'run_code')
    return stripped.length === listed.length ? listed : stripped
  }
  if (mode === 'code') return listed.filter((t) => t.function.name === 'run_code')
  return listed
}

/** What a program may call through the bridge: the slot's list, minus the sandbox's own tools. */
export function bridgeToolsForSlot(slot: Pick<ModelConfig, 'tools' | 'codeMode'>, available: ToolSchema[]): ToolSchema[] {
  const listed = !Array.isArray(slot.tools) ? available : available.filter((t) => new Set(slot.tools).has(t.function.name))
  return listed.filter((t) => !BRIDGE_EXCLUDED.has(t.function.name))
}

/**
 * The schemas a slot may put on the wire, computed in the renderer.
 *
 * The same two filters main/ipc/tools.ts applies to `tools:list` — the global
 * Settings → Tools toggles, then the slot's own allowlist — but synchronous,
 * because the composer's context meter re-reads it on every keystroke and an
 * IPC round trip per keystroke is not a meter. The wire list is still whatever
 * `tools:list` returns; this is a prediction of it, and the only thing it is
 * used for is counting tokens.
 */
export function schemasAvailableTo(
  slot: Pick<ModelConfig, 'tools'> | undefined,
  toggles: ToolToggles | undefined
): ToolSchema[] {
  if (!slot || !toggles) return []
  const enabled = TOOL_SCHEMAS.filter((t) => toggles[t.function.name as keyof ToolToggles])
  return toolsForSlot(slot, enabled)
}

/**
 * Tell the model, in the tool description, how many times it may call the tool
 * this turn.
 *
 * v1.4.5. The per-turn budgets are enforced but were never disclosed, so the
 * model could only discover them by being refused. Measured on a route-planning
 * turn: five `web_search` calls issued at once against a budget of three, then
 * three `fetch_webpage` against a budget of two, then two more searches — seven
 * of twelve calls rejected across three wasted rounds and about two minutes,
 * and the answer that followed filled the resulting gaps from memory.
 *
 * Budgets before work, disclosed before the stop rather than only at it — the
 * same principle the refusal message already follows, moved earlier.
 */
export function withBudgetNotes(
  tools: ToolSchema[],
  budgets: Record<string, number>
): ToolSchema[] {
  return tools.map((t) => {
    const budget = budgets[t.function.name]
    if (!budget) return t
    return {
      ...t,
      function: {
        ...t.function,
        description:
          `${t.function.description}\n` +
          `Budget: at most ${budget} call${budget === 1 ? '' : 's'} per turn. Plan for that — ` +
          `calls beyond it are refused, and the refusal is not a source.`
      }
    }
  })
}

/**
 * Always-on tools (strategy Layer 1b): cheap, zero-argument, and useful on
 * almost any turn, so they ride every turn regardless of embedding rank.
 * Derived from the tool table (each tool's `alwaysOn`, with its rationale —
 * see date_calculator's v1.4.6 note); re-exported here so callers keep one
 * import site.
 */
import { ALWAYS_ON_TOOLS } from '../../../shared/tools'
export { ALWAYS_ON_TOOLS } from '../../../shared/tools'

/** Total tools sent per turn after subsetting — always-on plus top matches. */
export const TURN_TOOL_CAP = 6

/**
 * v4.4 (G4): a turn that names a local file ranks the file tools first — the
 * switch, off until measured (ROADMAP-v4.4).
 *
 * The ranking reads meaning, and a file name is a lexical fact it blurs. With
 * the app's own ranking (each description alone, nomic-embed-text-v1.5) "read
 * the file notes/todo.md and summarize it" gave the two ranked places to
 * read_note (0.622) and list_directory (0.609), read_file fourth at 0.603;
 * "save this shopping list to a file called groceries.txt" put write_file
 * ninth (0.554), behind reference_lookup, list_notes and read_note. The notes
 * tools' descriptions say "file" in their *Do not use* lines, and an embedding
 * does not read a "not". 4.3's wire record (E5) showed the same miss.
 */
export const FILE_TOOLS_FIRST = false

/** The file tools a named file promotes, in the order they take the ranked places. */
export const FILE_TOOLS: readonly string[] = ['read_file', 'write_file', 'propose_patch']

/**
 * Document and data extensions only: code extensions are product names as
 * often as files ("the latest version of node.js"). A code file is still
 * caught by its path ("read src/app.js").
 */
const DOC_EXTENSION = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|xml|log|pdf|docx?|xlsx?|pptx?|rtf|odt|ods|ini|toml|cfg|conf|html?)$/i

/**
 * Does the text name a local file? A path with an extension (notes/todo.md,
 * ~/a/b.py, C:\x\y.txt), or a bare file name with a document or data
 * extension (groceries.txt). A web address is not a local file; a folder
 * path with no file in it is list_directory's, which the ranking already
 * finds ("what's in my ~/Downloads folder?" ranks it first).
 */
export function namesLocalFile(text: string | undefined): boolean {
  for (const raw of (text ?? '').split(/\s+/)) {
    const token = raw.replace(/^[("'`[<]+|[)"'`\]>,;:!?.]+$/g, '')
    if (!token || /^[a-z][a-z0-9+.-]*:\/\//i.test(token) || /^www\./i.test(token)) continue
    if (/[\\/]/.test(token) && /[\\/][^\\/]*\.\w{1,5}$/.test(token)) return true
    if (/^[\w-]+(\.[\w-]+)*$/.test(token) && DOC_EXTENSION.test(token)) return true
  }
  return false
}

/** v4.4 (G4): the tools this turn's ranking puts first, before the scores are read. */
export function promotedTools(text: string | undefined): readonly string[] {
  return namesLocalFile(text) ? FILE_TOOLS : []
}

/**
 * Per-turn subsetting: always-on tools plus the top-scoring matches by
 * embedding cosine, capped at TURN_TOOL_CAP, in the original wire order.
 *
 * `scores === null` means "no ranking available" (no embedding model, an
 * endpoint error) and returns the full list — subsetting is an optimization,
 * never a gate. Tools missing a score rank as zero.
 *
 * v4.4 (G4): `promoted` tools (the file tools, when the turn names a file and
 * FILE_TOOLS_FIRST is on) take the ranked places first, in their order, when
 * the slot has them; the scores fill what is left.
 */
export function selectTurnTools(
  available: ToolSchema[],
  scores: Record<string, number> | null,
  cap: number = TURN_TOOL_CAP,
  promoted: readonly string[] = []
): ToolSchema[] {
  if (scores === null || available.length <= cap) return available

  const alwaysOn = new Set(ALWAYS_ON_TOOLS)
  const chosen = new Set<string>()
  for (const t of available) {
    if (alwaysOn.has(t.function.name)) chosen.add(t.function.name)
  }
  for (const name of promoted) {
    if (chosen.size >= cap) break
    if (available.some((t) => t.function.name === name)) chosen.add(name)
  }
  const ranked = available
    .filter((t) => !chosen.has(t.function.name))
    .map((t) => ({ name: t.function.name, score: scores[t.function.name] ?? 0 }))
    .sort((a, b) => b.score - a.score)
  for (const r of ranked) {
    if (chosen.size >= cap) break
    chosen.add(r.name)
  }

  return available.filter((t) => chosen.has(t.function.name))
}

/**
 * Below this spread across the top candidates, the ranking is noise.
 *
 * Measured against nomic-embed-text-v1.5 on 2026-08-12, cosine similarity
 * between real user turns and the tool descriptions:
 *
 *   "1"                          spread 0.014   top pick: web_search
 *   "lets flush out next steps"  spread 0.025   top pick: finance_calculator
 *   "yes"                        spread 0.056   top pick: memory_search
 *   sales-presentation request   spread 0.088   top pick: finance_calculator
 *   "what is the weather..."     spread 0.091   top pick: get_current_datetime
 *   "email campaign copy"        spread 0.184   top pick: deep_research
 *   "read the file at ~/notes"   spread 0.191   top pick: read_file
 *
 * The bottom three are indistinguishable from a coin flip — the winners are
 * separated by less than a rounding error, and a different one wins each turn.
 * That was visible in a measured session as `list_notes`, then `list_directory`,
 * then `create_note` riding three consecutive turns of a conversation about a
 * sales deck: tools nothing in the conversation called for, and a tool list
 * that moved every turn. Chat templates render tools into the leading block, so
 * each reshuffle also discarded the prompt cache for the whole conversation.
 */
const MIN_RANK_SPREAD = 0.07

/**
 * Did the ranking actually discriminate? Compares the best score against the
 * one at the cut line, which is the comparison that decides whether the subset
 * changes at all.
 */
export function rankingIsDecisive(
  scores: Record<string, number> | null,
  cap: number = TURN_TOOL_CAP
): boolean {
  if (scores === null) return false
  const ranked = Object.values(scores).sort((a, b) => b - a)
  if (ranked.length <= cap) return true
  return ranked[0] - ranked[cap - 1] >= MIN_RANK_SPREAD
}

/**
 * v3.1 (S5): may this turn's ranking move the conversation's toolbox?
 *
 * Only a decisive ranking of words that ask for something. Small talk
 * (lib/quickReply.ts) never needs a tool, but the spread above is a property
 * of the scores, not of the words, and it calls some greetings decisive.
 * Measured 2026-09-28 with nomic-embed-text-v1.5 against the owner's 20-tool
 * Assistant slot: 3 of 25 everyday pleasantries cleared it — "thanks!" and
 * "thank you" reaching for reference_lookup, "lol" for memory_search — and
 * each such turn could swap a tool and spend the conversation's prompt cache.
 * None of the 268 user prompts in the eval fixtures (test/fixtures) is small
 * talk, so no tool-choice or answer suite can see this rule.
 */
export function rankingMayMove(scores: Record<string, number> | null, text: string | undefined): boolean {
  return rankingIsDecisive(scores) && !isSmallTalk(text)
}

/**
 * v1.5: hold the subset steady across turns of the same conversation.
 *
 * Per-turn ranking is good for accuracy and bad for latency, because chat
 * templates render the tool list inside the system block — so a subset that
 * reshuffles every turn moves the prompt's first bytes every turn, and the
 * server re-processes the whole conversation instead of reusing its KV cache.
 * That undoes the v1.5 work on the system prompt itself (lib/grounding.ts) for
 * anyone running the default toolbox, which is well over the cap.
 *
 * The rule keeps both properties: when this turn's ranking is already covered
 * by what the last turn carried, the last turn's list is reused verbatim and
 * the prefix survives. When the ranking reaches for something the previous
 * subset does not hold — a genuine change of subject — the new selection wins
 * and the prefix is spent on a turn that needed it.
 *
 * `previousNames` is rebuilt against `available` rather than trusted as-is, so
 * a tool disabled since the last turn cannot be reintroduced by the cache.
 */
export function stabilizeTurnTools(
  available: ToolSchema[],
  selected: ToolSchema[],
  previousNames: readonly string[] | undefined
): ToolSchema[] {
  if (!previousNames || previousNames.length === 0) return selected
  const held = new Set(previousNames)
  const previous = available.filter((t) => held.has(t.function.name))
  if (previous.length === 0) return selected
  const covered = selected.every((t) => held.has(t.function.name))
  return covered ? previous : selected
}

/**
 * The subset a conversation's turn carries: this turn's selection, held to the
 * last turn's where the ranking gives no reason to move.
 *
 * v3.1: an indecisive ranking keeps the incumbent outright. v1.4.5 said so —
 * "an indecisive ranking must not be allowed to move anything" — but passed
 * the incumbent to `stabilizeTurnTools`, which takes the new selection
 * whenever the incumbent does not cover it, exactly as for a decisive one. So
 * a coin flip still swapped a tool and spent the conversation's prefix.
 * Replayed on 2026-09-28 against nomic-embed-text-v1.5 and a 20-tool slot:
 * "yo whats up?" then "just testing out your new vibe mode and its super
 * cool", both indecisive, and the second swapped `list_directory` for
 * `reference_lookup`. LM Studio's log for that turn shows the prompt re-read
 * from its system block, 2,325 tokens in 27 s on a 9B that was partly on the
 * CPU, where the turn before had reused everything up to the new message.
 *
 * With nothing to hold to yet, this turn's selection becomes the incumbent.
 */
export function holdTurnTools(
  available: ToolSchema[],
  selected: ToolSchema[],
  previousNames: readonly string[] | undefined,
  decisive: boolean
): ToolSchema[] {
  if (!decisive && previousNames && previousNames.length > 0) {
    const held = new Set(previousNames)
    const previous = available.filter((t) => held.has(t.function.name))
    if (previous.length > 0) return previous
  }
  return stabilizeTurnTools(available, selected, previousNames)
}

/**
 * v4.4 (G2, ROADMAP-v4.3 F6): forced tools on top of the cap — the switch, off
 * (4.0.1's cap) until measured on the default toolset beside a same-day control.
 */
export const FORCED_TOOLS_ON_TOP = false

/**
 * v1.6: guarantee named tools are in the turn's set. When the app has just
 * profiled a data file and told the model "compute with run_python", the tool
 * must be on the wire — measured: the embedding rank dropped run_python for
 * "which region had the highest revenue" and a 9B model spent five minutes
 * reasoning that it had no way to compute. Forced tools take the place of the
 * lowest-ranked non-always-on picks so the cap still holds; wire order is kept.
 *
 * v4.4 (G2): "lowest-ranked" was the comment's and not the code's — it dropped
 * picks from the end of the wire order. With the turn's `scores` it now drops
 * the lowest-scored first (ties, and a turn with no ranking, from the end of
 * the wire order as before). The chat forces the web pair together or not at
 * all, and two forced tools take both ranked places whatever their order, so
 * no tool-choice fixture's wire moves (eval:tools counts it: 0 of 28).
 *
 * `onTop` (FORCED_TOOLS_ON_TOP, ROADMAP-v4.3 F6): forced tools ride on top of
 * the cap instead of evicting the ranked picks — 8 tools on a turn the web
 * pair is forced onto, where the cap leaves "what time is it right now?" with
 * no get_current_datetime.
 */
export function withForcedTools(
  available: ToolSchema[],
  selected: ToolSchema[],
  forced: readonly string[],
  cap: number = TURN_TOOL_CAP,
  opts: { onTop?: boolean; scores?: Record<string, number> | null } = {}
): ToolSchema[] {
  const want = forced.filter((n) => available.some((t) => t.function.name === n))
  if (want.length === 0) return selected
  const names = new Set(selected.map((t) => t.function.name))
  const alwaysOn = new Set(ALWAYS_ON_TOOLS)
  for (const n of want) names.add(n)
  if (opts.onTop ?? FORCED_TOOLS_ON_TOP) return available.filter((t) => names.has(t.function.name))
  // Over the cap: drop optional picks (not always-on, not forced), the
  // lowest-scored first, until it fits. sort() is stable: equal scores keep
  // wire order, and pop() takes the last of them first, as before.
  const optional = selected.map((t) => t.function.name).filter((n) => !alwaysOn.has(n) && !want.includes(n))
  const scores = opts.scores
  if (scores) optional.sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))
  while (names.size > cap && optional.length > 0) names.delete(optional.pop()!)
  return available.filter((t) => names.has(t.function.name))
}

/**
 * v4.1 (S5): tools that stay on a conversation's wire once they have ridden it.
 *
 * The web pair is forced onto a factual turn (lib/grounding.ts
 * `webToolsForTurn`) and not onto the chatty turn after it, so a conversation
 * that alternates swapped its toolbox turn by turn — and chat templates render
 * the tools ahead of the history, so every swap re-read the whole prompt. Kept
 * once used, a factual → chatty → factual run sends one tool list throughout.
 */
export const STICKY_TOOLS: readonly string[] = ['web_search', 'fetch_webpage']

/** The sticky tools the conversation's previous turn carried, by name. */
export function stickyTools(previousNames: readonly string[] | undefined): string[] {
  return (previousNames ?? []).filter((n) => STICKY_TOOLS.includes(n))
}

/**
 * v4.1 (S5): the subset when the ranking is unavailable — no embedding model,
 * an endpoint error.
 *
 * Through 4.0 that was the whole allowlist: up to ~8k tokens of schemas, ~25 s
 * of cold prefill on the 9B, on a turn that had carried six tools the turn
 * before — and back to six on the next, so the prefix moved twice. With a
 * previous turn to go on, its tools stand, plus the always-on ones and this
 * turn's forced ones. With none, the whole list as before: there is nothing
 * better to send, and no prefix to keep.
 */
export function fallbackTurnTools(
  available: ToolSchema[],
  previousNames: readonly string[] | undefined,
  forced: readonly string[] = []
): ToolSchema[] {
  if (!previousNames || previousNames.length === 0) return available
  const names = new Set([...previousNames, ...ALWAYS_ON_TOOLS, ...forced])
  const kept = available.filter((t) => names.has(t.function.name))
  return kept.length > 0 ? kept : available
}
