import type { ContextProvider, ProviderIO, ProviderResult, TurnInput } from './types'
import type { TurnWait } from '../turnPhase'
import type { AttachmentFileRef } from '../../types'
import { factLedgerProvider } from './factLedger'
import { autoSearchProvider } from './autoSearch'
import { skillProvider } from './skill'
import { libraryPassagesProvider } from './libraryPassages'
import { playbookProvider } from './playbook'
import { ledgerProvider } from './ledger'
import { shoppingPriceProvider } from './shoppingPrice'
import { memoryRecallProvider } from './memoryRecall'
import { projectRecallProvider } from './projectRecall'
import { attachmentPassagesProvider } from './attachmentPassages'
import { tabularProfileProvider } from './tabularProfile'

export type { ContextProvider, ProviderApi, ProviderIO, ProviderResult, RunToolOptions, ToolExecuteContext, TurnInput } from './types'

/**
 * v4.1 (S2): the app-run search stops holding the turn after this long.
 *
 * Measured: auto search spent 8.8 s before the model was asked anything on the
 * recorded TTU1 runs (lib/turnCost.ts). Past the deadline the model is asked
 * without the results and can still call web_search itself: a factual turn
 * carries the web tools whatever the ranking says, unless the library covers
 * its domain (lib/grounding.ts `webToolsForTurn`).
 */
export const AUTO_SEARCH_SOFT_DEADLINE_MS = 3500

/**
 * Registry order IS block order in the turn notes — pinned by test, because
 * the notes are prompt surface (the response cache and the eval suites both
 * fingerprint them). The prefetch trio sits after shopping even though its
 * work starts first: material blocks (search, library) come before method
 * blocks (playbook), and recall lands last, exactly as the inline blocks
 * ordered themselves through v1.12.
 *
 * v4.1 (S2): the library lookup is a prefetch too. It is local and never
 * depends on the ledger or the search, so it runs beside the ledger → search
 * chain instead of after it; its block still lands in its registry slot.
 */
export const TURN_CONTEXT_PROVIDERS: readonly ContextProvider[] = [
  // v2.6: ahead of the search it can suppress.
  factLedgerProvider,
  // v4.1 (S2): given its deadline here, so the provider module stays as it was.
  { ...autoSearchProvider, softDeadlineMs: AUTO_SEARCH_SOFT_DEADLINE_MS },
  libraryPassagesProvider,
  // v2.7: a user's skill takes the method slot and stands the playbook down.
  skillProvider,
  playbookProvider,
  ledgerProvider,
  shoppingPriceProvider,
  memoryRecallProvider,
  projectRecallProvider,
  attachmentPassagesProvider,
  tabularProfileProvider
]

export interface GatheredContext {
  blocks: string[]
  projectTokens: { recall: number; files: number }
  /** v2.7: files a provider asked the turn's tools to be able to stage (a skill's helpers). */
  attachments: AttachmentFileRef[]
  /** True when the turn was aborted mid-sequence; the caller returns. */
  aborted: boolean
}

/**
 * A provider's effects once the turn has stopped waiting on it: tool results
 * are discarded (RunToolOptions), and a late record or patch never lands.
 */
function deadlineIO(io: ProviderIO, late: AbortSignal): ProviderIO {
  return {
    ...io,
    runTool: (name, args, options) => io.runTool(name, args, { ...options, discardAfter: late }),
    recordSyntheticCall: (name, args, output) => {
      if (!late.aborted) io.recordSyntheticCall(name, args, output)
    },
    patch: (p) => {
      if (!late.aborted) io.patch(p)
    }
  }
}

/**
 * Await a provider's result for at most `ms`. On the deadline `late` fires and
 * the result is null, as if the provider had contributed nothing; the gather
 * itself runs on, and deadlineIO keeps what it does from reaching the turn.
 */
async function withinSoftDeadline(
  pending: Promise<ProviderResult | null>,
  ms: number,
  late: AbortController
): Promise<ProviderResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      late.abort()
      resolve(null)
    }, ms)
  })
  try {
    return await Promise.race([pending, expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run the providers: kick every enabled prefetch gather() first (their
 * embedding calls overlap the serial providers' network waits — deliberate
 * since v1.5), then walk the registry in order, awaiting serial providers in
 * place and collecting each prefetch result at its registry position. An
 * abort is checked after each serial await (prefetch collections deliberately
 * do not abort-check, matching the old inline blocks). A provider failure —
 * rejection or throw — contributes nothing and never breaks the turn.
 *
 * `onWait` is told which serial provider the turn is currently blocked on, by
 * name, and is cleared however the walk ends — this whole sequence happens
 * before the model is asked anything, in front of an empty bubble.
 */
export async function gatherTurnContext(
  providers: readonly ContextProvider[],
  input: TurnInput,
  io: ProviderIO,
  onWait: (wait: TurnWait | null) => void = () => {}
): Promise<GatheredContext> {
  const held = new Map<string, Promise<ProviderResult | null>>()
  for (const p of providers) {
    if (p.phase === 'prefetch' && p.enabled(input, io)) {
      held.set(p.id, p.gather(input, io).catch(() => null))
    }
  }

  const blocks: string[] = []
  const projectTokens = { recall: 0, files: 0 }
  // v2.6: a result may name later providers it makes unnecessary (the fact
  // ledger answering suppresses the app-run search). Only providers after
  // the one that asked can be suppressed — a prefetch already running is
  // folded as it always was.
  const suppressed = new Set<string>()
  const attachments: AttachmentFileRef[] = []
  const fold = (result: ProviderResult | null): void => {
    if (!result) return
    if (result.blocks) blocks.push(...result.blocks)
    if (result.projectTokens?.recall) projectTokens.recall += result.projectTokens.recall
    if (result.projectTokens?.files) projectTokens.files += result.projectTokens.files
    for (const id of result.suppress ?? []) suppressed.add(id)
    if (result.attachments) attachments.push(...result.attachments)
  }

  try {
    for (const p of providers) {
      if (p.phase === 'prefetch') {
        const pending = held.get(p.id)
        if (pending) {
          // v4.1: a prefetch that declares a wait (the library lookup) can
          // still be running when the walk reaches it; name it for as long.
          if (p.wait) onWait(p.wait)
          fold(await pending)
        }
        continue
      }
      if (suppressed.has(p.id) || !p.enabled(input, io)) continue
      // Announced before the await, cleared by the next provider — a name
      // that outlived its work would be worse than none.
      onWait(p.wait ?? null)
      if (p.softDeadlineMs !== undefined) {
        const late = new AbortController()
        fold(await withinSoftDeadline(p.gather(input, deadlineIO(io, late.signal)).catch(() => null), p.softDeadlineMs, late))
      } else {
        fold(await p.gather(input, io).catch(() => null))
      }
      if (input.signal.aborted) return { blocks, projectTokens, attachments, aborted: true }
    }
    return { blocks, projectTokens, attachments, aborted: false }
  } finally {
    onWait(null)
  }
}
