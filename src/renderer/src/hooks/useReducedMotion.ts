import { useEffect, useState } from 'react'

/**
 * The OS "reduce motion" preference, live. Lifted out of OasisRipple (v3.0) so
 * the VIBE lagoon reads the same switch the thinking indicator does: when the
 * reader has asked for stillness, every moving layer of the app goes still
 * together, not one component at a time.
 */
export function useReducedMotion(): boolean {
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
