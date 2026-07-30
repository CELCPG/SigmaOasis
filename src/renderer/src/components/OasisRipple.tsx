import { useEffect, useMemo, useState } from 'react'
import {
  MAX_RIPPLES,
  THINKING_VISUAL,
  resolveMotion,
  type OasisState
} from '../lib/oasisRipple'

/**
 * The Oasis Ripple — the app's single thinking indicator. A glass pool disc:
 * ambient ripples while the model composes, a colored droplet + expanding
 * wave when a tool fires. All loading states (typing dots, spinners) funnel
 * through here; the state machine lives in lib/oasisRipple.ts.
 */

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  )
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const onChange = (): void => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

interface ToolEvent {
  id: string
  color: string
}

export function OasisRipple({ state, size = 64 }: { state: OasisState; size?: number }): JSX.Element | null {
  const reducedMotion = useReducedMotion()
  const motion = resolveMotion(reducedMotion)
  const [events, setEvents] = useState<ToolEvent[]>([])

  // A new running tool spawns one droplet event; the wave cleans itself up.
  useEffect(() => {
    if (state.mode !== 'tool' || !state.activeToolId || !state.tool) return
    const id = state.activeToolId
    const color = state.tool.color
    setEvents((prev) => {
      if (prev.some((e) => e.id === id)) return prev
      const next = [...prev, { id, color }]
      return next.length > MAX_RIPPLES ? next.slice(-MAX_RIPPLES) : next
    })
  }, [state.mode, state.activeToolId, state.tool])

  const visual = useMemo(
    () => (state.mode === 'tool' && state.tool ? state.tool : THINKING_VISUAL),
    [state.mode, state.tool]
  )

  if (state.mode === 'hidden') return null

  const scale = size / 64
  const label = state.mode === 'tool' && state.tool ? state.tool.label : THINKING_VISUAL.label
  const detail =
    state.mode === 'tool' && state.runningCount > 1 ? ` +${state.runningCount - 1}` : ''

  return (
    <div
      className="oasis-ripple"
      role="status"
      aria-live="polite"
      aria-label={`${label.toLowerCase()}${detail}`}
    >
      <div className="oasis-disc" style={{ width: size, height: size }}>
        <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
          <defs>
            <radialGradient id="oasis-pool" cx="0.5" cy="0.5" r="0.5">
              <stop offset="0%" stopColor="rgba(0,212,170,0.08)" />
              <stop offset="100%" stopColor="rgba(0,212,170,0.01)" />
            </radialGradient>
          </defs>
          <circle cx="32" cy="32" r="31" fill="url(#oasis-pool)" stroke="rgba(0,212,170,0.15)" strokeWidth="0.8" />
          <circle cx="32" cy="32" r="30" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="1.5" />
          <circle cx="32" cy="32" r="20" fill="none" stroke="rgba(0,212,170,0.06)" strokeWidth="0.5" />
          <ellipse cx="26" cy="22" rx="8" ry="5" transform="rotate(-30 26 22)" fill="rgba(255,255,255,0.06)" />
        </svg>

        {/* Ambient breathing ring while composing (motion permitting). */}
        {motion.animateAmbient && <span className="oasis-ambient-ring" />}

        {/* Center orb — the one element that always pulses, gently. */}
        <span className="oasis-orb" style={{ background: visual.color, boxShadow: `0 0 10px ${visual.color}` }} />

        {/* Tool droplet events: fall → impact → wave → splash → settle. */}
        {motion.animateDroplets &&
          events.map((e) => (
            <span key={e.id} className="oasis-event" style={{ transform: `scale(${scale})` }}>
              <span className="oasis-droplet" style={{ background: e.color }} />
              <span
                className="oasis-wave"
                style={{ borderColor: e.color }}
                onAnimationEnd={() => setEvents((prev) => prev.filter((x) => x.id !== e.id))}
              />
              <span className="oasis-wave oasis-wave--late" style={{ borderColor: e.color }} />
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className={`oasis-splash oasis-splash--${i}`} style={{ background: e.color }} />
              ))}
            </span>
          ))}
      </div>

      <div className="oasis-status">
        {state.mode === 'tool' && state.tool && (
          <span className="oasis-tool-pill" style={{ borderColor: `${visual.color}50`, boxShadow: `0 0 16px ${visual.color}30` }}>
            <span style={{ color: visual.color }}>{state.tool.icon}</span>
          </span>
        )}
        <span className="oasis-label" style={{ color: visual.color }}>
          {label}
          {detail && <span className="oasis-label-detail">{detail}</span>}
        </span>
      </div>
    </div>
  )
}
