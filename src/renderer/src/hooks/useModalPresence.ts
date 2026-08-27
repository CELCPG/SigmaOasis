import { useEffect, useRef, useState } from 'react'

/**
 * How long a modal stays mounted after it is closed, so its exit animation
 * can run. Deliberately a shade longer than the 150ms of
 * .modal-backdrop.is-leaving / .modal-panel.is-leaving in index.css: this
 * clock starts on the state change, while the animation starts on the frame
 * after it, so an exact match unmounts the panel one frame early — measured
 * at ~18% opacity, i.e. a visible clip. The surplus is spent fully
 * transparent. Do not shorten it below the CSS duration.
 */
export const MODAL_EXIT_MS = 175

/**
 * Keeps a modal mounted through its own dismissal.
 *
 * Every modal in the app was `if (!open) return null`, which cannot animate
 * out: by the time the state says closed the DOM is already gone. This holds
 * the subtree one exit's worth of time longer and reports which phase it is
 * in, so the same component can render both.
 *
 * `leaving` is the class hook (and the reason the backdrop stops taking
 * clicks — a fading overlay that still swallows them reads as a frozen app).
 * Reopening mid-exit cancels the unmount rather than queuing a second one.
 *
 * Reduced motion unmounts immediately: there is no animation to wait for, and
 * waiting would only add a delay to a preference that asked for less motion.
 */
export function useModalPresence(open: boolean): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open)
  const [leaving, setLeaving] = useState(false)
  // Read once per transition rather than held in state: the preference can
  // change between two openings, and nothing here needs to re-render on it.
  const reduceMotion = useRef(false)
  reduceMotion.current =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      setLeaving(false)
      return
    }
    if (!mounted) return
    if (reduceMotion.current) {
      setMounted(false)
      return
    }
    setLeaving(true)
    const timer = setTimeout(() => {
      setMounted(false)
      setLeaving(false)
    }, MODAL_EXIT_MS)
    return () => clearTimeout(timer)
  }, [open, mounted])

  return { mounted, leaving }
}

/** Class names for a modal's backdrop and panel in the phase it is in. */
export function modalClasses(leaving: boolean): { backdrop: string; panel: string } {
  const state = leaving ? ' is-leaving' : ''
  return { backdrop: `modal-backdrop${state}`, panel: `modal-panel${state}` }
}
