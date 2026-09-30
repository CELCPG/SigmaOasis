import type { ChatMessage } from '../types'
import { FITTING_RATE, slowReading, slowReadingAdvice, slowReadingFact } from '../lib/modelFit'
import { useAppStore } from '../stores/appStore'

/**
 * v3.1 (S6): a reply that waited long for its first word because the model
 * read its prompt slowly says so, and says what usually fixes it
 * (lib/modelFit.ts). Shown whether or not the stats line is — it is the answer
 * to "why is this so slow", which is not a statistic.
 */
export function SlowReadingLine({ stats, modelId }: { stats: ChatMessage['stats']; modelId?: string }): JSX.Element | null {
  const window = useAppStore((s) => s.availableModels.find((m) => m.id === modelId)?.loadedContextLength)
  const reading = slowReading(stats)
  if (!reading) return null
  return (
    <div className="mt-1.5 text-[11px] text-ink-secondary" title={slowReadingAdvice(window)} data-slow-reading="true">
      🐢 Slow start: this model {slowReadingFact(reading)}. {FITTING_RATE}
    </div>
  )
}
