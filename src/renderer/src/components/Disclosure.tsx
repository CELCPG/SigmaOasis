import { useEffect, useState, type ReactNode } from 'react'

/**
 * How long a disclosure takes to open or close. Must match the
 * grid-template-rows transition on .disclosure in index.css: this clock is
 * what keeps the body mounted long enough for the closing half to be seen.
 */
export const DISCLOSURE_MS = 220

/**
 * A body that opens and closes to its own height.
 *
 * Every disclosure in a message — a tool call's arguments, a reasoning trace,
 * a second opinion, a plan step — was `{open && <body/>}`, which cannot
 * animate: the body is either absent or full height, and everything below it
 * jumps by that height in one frame. Mid-reply, with several tool calls
 * landing in a row, that is most of what made a turn feel like it was being
 * assembled rather than arriving.
 *
 * The row is sized in `fr` rather than pixels, so it animates to the content's
 * own height with no measuring and no magic number. Two rules make that work:
 * the body is a grid item (so `1fr` resolves to its content height) and it
 * clips its overflow while it is shorter than that.
 *
 * The body is still mounted lazily, which is not only about weight: a
 * collapsed body that stayed in the DOM would keep its buttons and links in
 * the tab order, so keyboard focus would walk into a section nobody can see.
 * Opening therefore mounts first and expands on the next frame — a row that
 * does not exist at 0fr has no start value to animate from.
 */
export function Disclosure({
  open,
  children,
  className = ''
}: {
  open: boolean
  children: ReactNode
  /** Applied to the body, for the spacing the caller used to put on it. */
  className?: string
}): JSX.Element | null {
  const [mounted, setMounted] = useState(open)
  const [expanded, setExpanded] = useState(open)

  useEffect(() => {
    const reduceMotion =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)

    if (open) {
      setMounted(true)
      if (reduceMotion) {
        setExpanded(true)
        return
      }
      const frame = requestAnimationFrame(() => setExpanded(true))
      return () => cancelAnimationFrame(frame)
    }

    setExpanded(false)
    if (reduceMotion) {
      setMounted(false)
      return
    }
    const timer = setTimeout(() => setMounted(false), DISCLOSURE_MS)
    return () => clearTimeout(timer)
  }, [open])

  if (!mounted) return null
  return (
    <div className={`disclosure${expanded ? ' is-open' : ''}`}>
      <div className={`disclosure-body${className ? ` ${className}` : ''}`}>{children}</div>
    </div>
  )
}

/**
 * A block that grows into place the first time it appears, rather than
 * arriving at full height and shoving everything below it down in one frame.
 *
 * Same grid rows as Disclosure, and for the same reason it cannot be a plain
 * CSS entry animation: measured in Chromium, grid-template-rows does not
 * interpolate inside @keyframes — 0fr to 1fr snaps to the end value on frame
 * one — while the identical transition interpolates properly. So the row is
 * rendered closed and opened on the next frame, which is a transition.
 */
export function BlockEnter({ children }: { children: ReactNode }): JSX.Element {
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    const reduceMotion =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
    if (reduceMotion) {
      setEntered(true)
      return
    }
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div className={`disclosure block-enter${entered ? ' is-open' : ''}`}>
      <div className="disclosure-body">{children}</div>
    </div>
  )
}
