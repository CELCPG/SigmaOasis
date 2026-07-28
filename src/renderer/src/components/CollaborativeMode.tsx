import type { AppSettings, ModelConfig } from '../types'
import { ACCENT } from '../lib/colors'

interface Props {
  settings: AppSettings
  onChange: (pipeline: string[]) => void
}

/**
 * Pipeline editor (Settings → Pipeline). Tick enabled models to add them to
 * the collaborative chain; reorder the chain with the ◀ ▶ buttons.
 */
export function CollaborativeMode({ settings, onChange }: Props): JSX.Element {
  const enabledModels = settings.models.filter((m) => m.enabled)

  // The chain can hold ids for slots that no longer exist (a reset, an edited
  // config). Drop them here so the rendered list and the stored array stay
  // index-aligned — otherwise reordering swaps the wrong entries.
  const livePipeline = settings.pipeline.filter((id) => settings.models.some((m) => m.id === id))
  const ordered: ModelConfig[] = livePipeline.map(
    (id) => settings.models.find((m) => m.id === id) as ModelConfig
  )

  const toggle = (id: string): void => {
    onChange(
      livePipeline.includes(id) ? livePipeline.filter((p) => p !== id) : [...livePipeline, id]
    )
  }

  const move = (index: number, delta: -1 | 1): void => {
    const next = [...livePipeline]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  if (enabledModels.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        No model slots are enabled. Enable at least one model under{' '}
        <span className="font-medium">Settings → Models</span> first.
      </p>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 text-sm font-medium">Participating models</div>
        <div className="space-y-1.5">
          {enabledModels.map((m) => (
            <label
              key={m.id}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5"
            >
              <input
                type="checkbox"
                checked={livePipeline.includes(m.id)}
                onChange={() => toggle(m.id)}
                className="accent-accent"
              />
              <span className={`h-2.5 w-2.5 rounded-full ${ACCENT[m.color].dot}`} />
              {m.roleName}
              <code className="ml-auto text-xs text-neutral-400">{m.modelId || 'no model'}</code>
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 text-sm font-medium">Chain order</div>
        {ordered.length === 0 ? (
          <p className="text-sm text-neutral-500">Tick at least one model above.</p>
        ) : (
          <ol className="space-y-1.5">
            {ordered.map((m, idx) => (
              <li
                key={m.id}
                className="flex items-center gap-2 rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm"
              >
                <span className="w-5 text-center text-xs text-neutral-400">{idx + 1}</span>
                <span className={`h-2.5 w-2.5 rounded-full ${ACCENT[m.color].dot}`} />
                <span className="font-medium">{m.roleName}</span>
                <span className="ml-auto flex gap-1">
                  <button
                    type="button"
                    onClick={() => move(idx, -1)}
                    disabled={idx === 0}
                    className="rounded px-2 py-0.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30"
                    title="Move earlier"
                  >
                    ◀
                  </button>
                  <button
                    type="button"
                    onClick={() => move(idx, 1)}
                    disabled={idx === ordered.length - 1}
                    className="rounded px-2 py-0.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30"
                    title="Move later"
                  >
                    ▶
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-3 text-xs text-neutral-500">
          In collaborative mode your message flows through the chain in this order — each
          model sees the previous model&apos;s output and posts its own reply.
        </p>
      </div>
    </div>
  )
}
