import type { ContextProvider, ProviderIO, ProviderResult, TurnInput } from './types'
import type { TurnWait } from '../turnPhase'
import { autoSearchProvider } from './autoSearch'
import { libraryPassagesProvider } from './libraryPassages'
import { playbookProvider } from './playbook'
import { ledgerProvider } from './ledger'
import { shoppingPriceProvider } from './shoppingPrice'
import { memoryRecallProvider } from './memoryRecall'
import { projectRecallProvider } from './projectRecall'
import { attachmentPassagesProvider } from './attachmentPassages'
import { tabularProfileProvider } from './tabularProfile'

export type { ContextProvider, ProviderApi, ProviderIO, ProviderResult, ToolExecuteContext, TurnInput } from './types'

/**
 * Registry order IS block order in the turn notes — pinned by test, because
 * the notes are prompt surface (the response cache and the eval suites both
 * fingerprint them). The prefetch trio sits after shopping even though its
 * work starts first: material blocks (search, library) come before method
 * blocks (playbook), and recall lands last, exactly as the inline blocks
 * ordered themselves through v1.12.
 */
export const TURN_CONTEXT_PROVIDERS: readonly ContextProvider[] = [
  autoSearchProvider,
  libraryPassagesProvider,
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
  /** True when the turn was aborted mid-sequence; the caller returns. */
  aborted: boolean
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
  const fold = (result: ProviderResult | null): void => {
    if (!result) return
    if (result.blocks) blocks.push(...result.blocks)
    if (result.projectTokens?.recall) projectTokens.recall += result.projectTokens.recall
    if (result.projectTokens?.files) projectTokens.files += result.projectTokens.files
  }

  try {
    for (const p of providers) {
      if (p.phase === 'prefetch') {
        const pending = held.get(p.id)
        if (pending) fold(await pending)
        continue
      }
      if (!p.enabled(input, io)) continue
      // Announced before the await, cleared by the next provider — a name
      // that outlived its work would be worse than none.
      onWait(p.wait ?? null)
      fold(await p.gather(input, io).catch(() => null))
      if (input.signal.aborted) return { blocks, projectTokens, aborted: true }
    }
    return { blocks, projectTokens, aborted: false }
  } finally {
    onWait(null)
  }
}
