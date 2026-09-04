import { ipcMain } from 'electron'
import type { PatchStats } from '../../shared/patch'

/**
 * v2.8: the review a proposed patch waits on. The tool handler hands the
 * diff to the renderer that owns the turn; the reader sees it in the chat
 * with Apply and Discard; the answer comes back by id. No window, no
 * answer, and a review nobody answers times out as a discard — the model is
 * told either way and nothing is written until Apply.
 */

export interface PatchReview {
  reviewId: string
  /** The tool call this review belongs to, so the block renders under it. */
  callId?: string
  path: string
  isNew: boolean
  diff: string
  stats: PatchStats
}

const reviews = new Map<string, (approved: boolean) => void>()
let counter = 0
export const PATCH_REVIEW_TIMEOUT_MS = 10 * 60_000

export function requestPatchReview(sender: Electron.WebContents, review: Omit<PatchReview, 'reviewId'>): Promise<boolean> {
  if (sender.isDestroyed()) return Promise.resolve(false)
  const reviewId = `patch-${++counter}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      reviews.delete(reviewId)
      resolve(false)
    }, PATCH_REVIEW_TIMEOUT_MS)
    reviews.set(reviewId, (approved) => {
      clearTimeout(timer)
      reviews.delete(reviewId)
      resolve(approved)
    })
    sender.send('patch:review', { reviewId, ...review })
  })
}

export function registerPatchReviewHandlers(): void {
  ipcMain.handle('patch:decide', (_e, reviewId: unknown, approved: unknown) => {
    const done = reviews.get(String(reviewId ?? ''))
    if (!done) return { ok: false, error: 'No such review, or it already ended.' }
    done(approved === true)
    return { ok: true }
  })
}
