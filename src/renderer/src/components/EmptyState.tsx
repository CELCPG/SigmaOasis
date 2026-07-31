import { useAppStore } from '../stores/appStore'
import { Logo } from './Logo'

interface Starter {
  icon: string
  title: string
  prompt: string
  /** CSS variable from the accent palette in assets/index.css. */
  accent: string
  /** Role this starter is written for, routed to only when that role is on. */
  role?: string
}

/**
 * Four ways in. Each one demonstrates something the app can do that a cloud
 * chatbot cannot do privately: run the numbers on your actual finances, read a
 * document off your disk, research without handing the query to anyone.
 */
const STARTERS: Starter[] = [
  {
    icon: '💵',
    title: 'Money, explained',
    prompt:
      'Walk me through building a monthly budget, and show the math on paying a credit card down faster.',
    accent: 'var(--accent-teal)',
    role: 'Finance Coach'
  },
  {
    icon: '🏺',
    title: 'Step into another era',
    prompt: 'What was daily life actually like for an ordinary person in Edo-period Japan?',
    accent: 'var(--accent-amber)'
  },
  {
    icon: '📄',
    title: 'Read what I drop in',
    prompt:
      "Summarize the document I'm about to attach and pull out every decision and deadline.",
    accent: 'var(--accent-lavender)'
  },
  {
    icon: '🔎',
    title: 'Dig into a question',
    prompt: 'Research this properly and show me the sources you actually used.',
    accent: 'var(--accent-coral)'
  }
]

interface Props {
  heading: string
  onPick: (prompt: string) => void
}

/**
 * The screen before the first message — shown both for an empty conversation
 * and for the cold start where none is selected yet.
 */
export function EmptyState({ heading, onPick }: Props): JSX.Element {
  const settings = useAppStore((s) => s.settings)

  /**
   * Prefix the @handle only when that role is actually enabled. Finance Coach
   * ships disabled, and an @mention for a disabled role silently fails to route
   * — worse than not offering the shortcut at all.
   */
  const promptFor = (starter: Starter): string => {
    const slot = settings?.models.find((m) => m.roleName === starter.role && m.enabled)
    return slot ? `@${slot.roleName.replace(/\s+/g, '')} ${starter.prompt}` : starter.prompt
  }

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-2xl text-center">
        <div className="oasis-enter mb-4 flex justify-center">
          <span className="oasis-logo-glow relative inline-flex">
            <Logo size={56} className="relative" />
          </span>
        </div>

        <h1
          className="oasis-heading oasis-enter text-[22px] font-semibold tracking-[-0.5px]"
          style={{ animationDelay: '60ms' }}
        >
          {heading}
        </h1>
        <p
          className="oasis-enter mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-secondary"
          style={{ animationDelay: '100ms' }}
        >
          Your files, your questions, your machine. Everything runs locally through LM Studio — no
          cloud, no telemetry, nothing to opt out of.
        </p>

        <div className="mt-6 grid gap-2 sm:grid-cols-2">
          {STARTERS.map((s, i) => (
            <button
              key={s.title}
              type="button"
              onClick={() => onPick(promptFor(s))}
              style={
                {
                  '--card-accent': s.accent,
                  animationDelay: `${140 + i * 60}ms`
                } as React.CSSProperties
              }
              className="glass-panel oasis-starter oasis-enter flex items-start gap-3 rounded-2xl p-3 text-left"
            >
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] text-sm"
                style={{
                  background: 'color-mix(in srgb, var(--card-accent) 16%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--card-accent) 28%, transparent)'
                }}
                aria-hidden="true"
              >
                {s.icon}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-ink-primary">{s.title}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-ink-tertiary">
                  {s.prompt}
                </span>
              </span>
            </button>
          ))}
        </div>

        <p
          className="oasis-enter mt-5 text-[11px] text-ink-muted"
          style={{ animationDelay: '400ms' }}
        >
          Route a message to a role with @RoleName · drop files to attach · hold 🎙️ to talk
        </p>
      </div>
    </div>
  )
}
