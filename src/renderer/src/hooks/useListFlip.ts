import { useLayoutEffect, useRef, type RefObject } from 'react'

/** How long a row takes to travel to its new place. */
const FLIP_MS = 260

/**
 * Animates list rows from where they were to where they now are.
 *
 * The conversation list is sorted by last activity, so sending a message in
 * the fourth chat teleports it to the top and shoves three rows down a slot,
 * all between two frames. Nothing about that reads as movement — the list
 * simply is different afterwards, and the row you were looking at is
 * somewhere else.
 *
 * This is the standard invert-and-play: measure where each row is now,
 * compare with where it was, put it back with a transform, then release it.
 * The browser animates a transform on the compositor, so a list of any length
 * costs one layout read per render and nothing per frame.
 *
 * Positions are read with `offsetTop`, NOT getBoundingClientRect: the list
 * scrolls, scrolling does not re-render, and a viewport-relative measurement
 * would therefore fold whatever the user scrolled between two renders into
 * every row's delta — every row animating by the scroll distance, on a render
 * that moved nothing. offsetTop is relative to the offset parent and so is
 * unaffected.
 *
 * Rows appearing for the first time have nowhere to travel from; they are
 * left to their own entrance (.row-enter). Rows that leave are gone before
 * this runs, which is why the rows below them are the ones that need it.
 */
export function useListFlip(container: RefObject<HTMLElement>, dependency: unknown): void {
  const previous = useRef<Map<string, number>>(new Map())

  useLayoutEffect(() => {
    const root = container.current
    if (!root) return

    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-flip-key]'))
    const next = new Map<string, number>()
    for (const row of rows) {
      const key = row.dataset.flipKey
      if (key) next.set(key, row.offsetTop)
    }

    const reduceMotion =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
    if (reduceMotion) {
      previous.current = next
      return
    }

    const frames: number[] = []
    for (const row of rows) {
      const key = row.dataset.flipKey
      if (!key) continue
      const before = previous.current.get(key)
      const after = next.get(key)
      if (before === undefined || after === undefined) continue
      const delta = before - after
      // Sub-pixel shuffles are not movement worth animating.
      if (Math.abs(delta) < 1) continue
      row.style.transition = 'none'
      row.style.transform = `translateY(${delta}px)`
      frames.push(
        requestAnimationFrame(() => {
          row.style.transition = `transform ${FLIP_MS}ms var(--ease-settle)`
          row.style.transform = ''
        })
      )
    }

    previous.current = next
    return () => frames.forEach(cancelAnimationFrame)
    // `dependency` is whatever the caller changes the list by; the effect
    // re-measures on every render regardless, which is what keeps `previous`
    // honest when a row changes height without moving.
  }, [container, dependency])
}
