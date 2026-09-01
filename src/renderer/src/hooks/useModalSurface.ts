import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Focus containment for a surface that covers the page.
 *
 * The defect this exists to stop. Round 8's bench walked 70 Tab stops with the
 * Settings panel open and found 24–30 of them `obscured: true` — the page's own
 * controls, still in the tab order, still drawing a focus ring, sitting behind
 * the panel where no click can reach them. Measured again against the shipped
 * v2.0.0 build it is worse than the bench reported: 55 of 70 with Settings or
 * the project editor open, 57 with the command palette, 67 with the setup
 * checklist, identical in both themes. A ring on a control the user cannot
 * activate is worse than no ring at all: it tells them they are somewhere they
 * are not.
 *
 * **What "the class" is, and why the vocabulary is `fixed inset-0`.** Rounds 3,
 * 4, 5 and 6 all lost to the same shape — a check whose vocabulary was narrower
 * than the class it guarded, defeated by a form that was not on the list. The
 * obvious list here is the four modals, or the `fixed inset-0 … z-50` string
 * the traversal instrument uses to name an overlay. Both are too narrow:
 * `BranchMenu` covers the whole page with a `fixed inset-0 z-40` click-catcher
 * and puts its menu above it, which makes every control on the page obscured
 * and tabbable while it is open, and which a `z-50` check cannot see. The class
 * is **any element that covers the viewport to take interaction away from what
 * is under it** — in this codebase, `fixed inset-0` — and `test/modalSurfaces.
 * test.ts` fails the build if a file grows one of those without coming through
 * here.
 *
 * **`inert`, not a Tab handler, not `aria-hidden`.**
 *
 * A focus-trap keydown handler has to answer "what is the first and last
 * tabbable thing inside the panel", which means re-implementing tabbability —
 * `disabled`, `tabindex="-1"`, `display:none`, a closed `<details>`, a
 * `visibility:hidden` ancestor, shadow content. That is an enumeration, and an
 * enumeration is what keeps losing. It also only covers Tab: a click on a
 * background control, find-in-page, and a screen reader's virtual cursor all
 * still reach the page behind the panel.
 *
 * `aria-hidden` on the background fixes only the screen-reader half. The
 * element stays focusable and stays hittable, so the exact measured defect —
 * a focus ring on a control the user cannot click — survives it untouched.
 * It is strictly weaker than what is needed.
 *
 * `inert` hands the whole question to the engine that owns the answer: the
 * subtree leaves the tab order, leaves hit-testing, and leaves the accessibility
 * tree, in one attribute. It is the inverse repair round 3 generalised — rather
 * than listing what to skip, name what is still live and let everything else
 * follow.
 *
 * What it costs. `inert` is Chromium 102+; this app ships Electron 31
 * (Chromium 126), so it is present, and on an engine without it the app
 * degrades to today's behaviour rather than breaking. It is stronger than a
 * tab trap in one visible way: text behind the panel can no longer be selected
 * or copied while the panel is open. That is the correct semantics for a modal
 * — and it is the semantics the app already claimed, since every one of these
 * surfaces already swallows background clicks with a scrim.
 *
 * **The stack.** Only the topmost surface is live; everything else is inert,
 * including a surface underneath it. Without that, ⌘K over an open Settings
 * panel would inert the palette and the palette would inert Settings, and the
 * user would be left with two panels and no way into either.
 */

interface Surface {
  node: HTMLElement
  /** Escape, and a background click, both end here. */
  dismiss: () => void
  /** Where focus was when this surface opened. */
  restoreTo: HTMLElement | null
}

/** Innermost last. Only the last entry is interactive. */
const stack: Surface[] = []

/**
 * The surface that most recently left the stack, kept so a surface it opened
 * can inherit where *it* was going to send focus back to.
 *
 * The case: picking "Setup Checklist" in the command palette closes the palette
 * and opens the setup panel in the same tick. The panel's opener is the
 * palette's own query field — an element that is unmounting — so restoring to
 * it lands on `<body>`, and from `<body>` the next Tab restarts at the top of
 * the document. What the panel should return to is what the *palette* would
 * have returned to. Measured before this: focus went to `body` on close, in
 * both themes, on both routes.
 */
let lastReleased: Surface | null = null

/**
 * Where a surface should send focus when it closes.
 *
 * An opener inside another surface is a handoff, not an origin: follow it to
 * that surface's own answer. Written as a walk rather than a single hop so a
 * palette opening a panel that opens a panel still ends at the control the
 * user actually left.
 */
function originOf(opener: HTMLElement | null): HTMLElement | null {
  let candidate = opener
  for (let hops = 0; candidate && hops < 8; hops++) {
    const host =
      stack.find((s) => s.node.contains(candidate)) ??
      (lastReleased && lastReleased.node.contains(candidate) ? lastReleased : undefined)
    if (!host) return candidate
    candidate = host.restoreTo
  }
  return candidate
}

/**
 * Exactly the elements this module made inert, so releasing never removes an
 * `inert` somebody else owns.
 */
const inerted = new Set<HTMLElement>()

function releaseInert(): void {
  for (const el of inerted) el.removeAttribute('inert')
  inerted.clear()
}

/**
 * Everything that is not on the topmost surface's ancestor path goes inert.
 *
 * Computed from the surface node upward rather than from a list of the app's
 * background containers: a new pane, rail or portal added anywhere in the tree
 * is covered the day it is added, because it is a sibling of something on the
 * path and nobody had to remember to add it.
 */
function applyInert(): void {
  releaseInert()
  const top = stack[stack.length - 1]
  if (!top || !top.node.isConnected) return
  for (let node: HTMLElement | null = top.node; node && node !== document.body; node = node.parentElement) {
    const container: HTMLElement | null = node.parentElement
    if (!container) break
    for (const sibling of Array.from(container.children) as Element[]) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue
      // Already inert for a reason of its own: leave it, and leave it alone on
      // the way out too.
      if (sibling.hasAttribute('inert')) continue
      sibling.setAttribute('inert', '')
      inerted.add(sibling)
    }
  }
}

/**
 * Escape leaves the topmost surface only.
 *
 * On `document` in the capture phase, so it settles the key before any of the
 * app's own `window` listeners see it: `InputBar` cancels a recording on
 * Escape, and a keystroke aimed at closing a panel must not also do that.
 * Before this, each modal listened on `window` for itself, which meant Escape
 * with two surfaces open closed the one underneath.
 */
function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  const top = stack[stack.length - 1]
  if (!top) return
  event.preventDefault()
  event.stopPropagation()
  top.dismiss()
}

function setListening(on: boolean): void {
  if (on) document.addEventListener('keydown', onKeyDown, true)
  else document.removeEventListener('keydown', onKeyDown, true)
}

/**
 * Focus goes to the dialog itself, not to its first control.
 *
 * Focusing the first control announces "Close, button" and never names the
 * thing that just opened. The dialog element carries `role`, `aria-modal` and
 * an accessible name, and is focusable only programmatically (`tabindex="-1"`),
 * so landing there announces "Settings, dialog" and the next Tab enters the
 * panel — which is what `dialog.showModal()` does natively.
 *
 * A surface that has already put focus somewhere inside itself keeps it: the
 * command palette's query field and a new project's name field are the point of
 * opening those, and a rule that asked "which modals autofocus?" would be one
 * more list to keep in step. Asking "did focus already land inside me?" cannot
 * fall out of date.
 */
function focusInside(surface: Surface): void {
  if (surface.node.contains(document.activeElement)) return
  const dialog = surface.node.querySelector<HTMLElement>('[data-modal-dialog]') ?? surface.node
  dialog.focus()
}

function restoreFocus(surface: Surface): void {
  const target = surface.restoreTo
  if (!target || !target.isConnected || typeof target.focus !== 'function') return
  target.focus()
}

/**
 * Puts a surface on top of the stack. Returns the release.
 *
 * `opener` is passed in rather than read here, and that is not a stylistic
 * choice — see `useModalSurface`. On the way out the stack is popped and the
 * background un-inerted *before* focus is restored, because focusing an inert
 * element does nothing at all.
 */
function enter(node: HTMLElement, dismiss: () => void, opener: HTMLElement | null): () => void {
  const origin = originOf(opener)
  const surface: Surface = {
    node,
    dismiss,
    restoreTo: origin && !node.contains(origin) ? origin : null
  }
  // Re-entry (React 18 StrictMode remounts every effect once in development)
  // must not leave a stale copy behind.
  const existing = stack.findIndex((s) => s.node === node)
  if (existing !== -1) {
    surface.restoreTo = stack[existing].restoreTo
    stack.splice(existing, 1)
  }
  stack.push(surface)
  if (stack.length === 1) setListening(true)
  applyInert()
  focusInside(surface)

  return () => {
    const index = stack.indexOf(surface)
    if (index === -1) return
    stack.splice(index, 1)
    lastReleased = surface
    if (stack.length === 0) setListening(false)
    applyInert()
    // Only the surface that was on top hands focus back; a lower one being
    // torn down under an open panel must not steal it out of that panel.
    if (index === stack.length) restoreFocus(surface)
  }
}

export interface ModalSurface {
  /** Attach to the element that covers the page (`fixed inset-0 …`). */
  surfaceRef: (node: HTMLElement | null) => void
  /**
   * Spread onto the panel inside it. Carries the role, the modal flag and the
   * programmatic-focus target; the caller still supplies `aria-label` or
   * `aria-labelledby`, because only the caller knows what the surface is called.
   */
  dialogProps: {
    role: 'dialog' | 'menu'
    'aria-modal': true | undefined
    tabIndex: -1
    'data-modal-dialog': ''
  }
}

/**
 * Contains focus in `node` while `active`, and gives it back afterwards.
 *
 * `onDismiss` is what Escape does. A surface with no way out is a worse defect
 * than the one this fixes, so every caller passes one.
 */
export function useModalSurface(
  active: boolean,
  options: { onDismiss: () => void; role?: 'dialog' | 'menu' }
): ModalSurface {
  // State, not a ref: the containment has to be keyed on the *node*, not only
  // on `active`. A surface that re-mounts its own root while staying open — the
  // project editor does exactly that, remounting on `key={project.id}` — would
  // otherwise leave the stack holding a detached element and quietly stop
  // containing anything.
  const [node, setNode] = useState<HTMLElement | null>(null)
  const dismissRef = useRef(options.onDismiss)
  dismissRef.current = options.onDismiss
  const role = options.role ?? 'dialog'

  // Who to give focus back to, read during *render* rather than in the effect.
  //
  // Measured, on the build that first had this fix: reading `activeElement`
  // from the effect sent focus to `<body>` on close for the command palette and
  // the project editor, and to the right control for the other two. The two
  // that failed are the two that put focus somewhere inside themselves — the
  // palette's query field via `autoFocus`, a new project's name field via the
  // editor's own effect — and both of those run during commit, which is
  // *before* a parent's effect. By the time the effect asked, the answer was
  // already an element inside the surface, so closing restored focus to a node
  // that had just been unmounted and the walk restarted from the top of the
  // document. Render runs before commit, so the opener is still focused here.
  const opener = useRef<HTMLElement | null>(null)
  const wasActive = useRef(false)
  if (active && !wasActive.current) {
    const focused = document.activeElement
    opener.current = focused instanceof HTMLElement && focused !== document.body ? focused : null
  }
  wasActive.current = active

  const surfaceRef = useCallback((next: HTMLElement | null) => {
    setNode(next)
  }, [])

  useEffect(() => {
    if (!node) return
    if (!active) {
      // Mounted but on the way out: the panel is fading and its backdrop has
      // already stopped taking clicks, so its controls must stop taking Tab in
      // the same instant. Without this the exit animation leaves ~175ms in
      // which a keyboard lands on a control that is disappearing.
      node.setAttribute('inert', '')
      return () => node.removeAttribute('inert')
    }
    node.removeAttribute('inert')
    return enter(node, () => dismissRef.current(), opener.current)
  }, [active, node])

  return {
    surfaceRef,
    dialogProps: {
      role,
      'aria-modal': role === 'dialog' ? true : undefined,
      tabIndex: -1,
      'data-modal-dialog': ''
    }
  }
}
