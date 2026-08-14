import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'

/**
 * The window hosting `contents`, or null when it is already gone.
 *
 * Every dialog in the app is parented to the window that asked for it, and a
 * window can close while a long agent turn still holds a pending confirmation
 * (a deep-research plan, a terminal confirm). The previous idiom —
 * `BrowserWindow.fromWebContents(sender)!` straight into a dialog — threw
 * inside the IPC handler in exactly that case. Callers treat null as "nobody
 * is there to ask": confirmations decline, pickers cancel, notices are
 * skipped. Never show a detached dialog instead — an approval prompt with no
 * owning window is how a background process trains users to click OK.
 */
export function hostWindow(contents: WebContents): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(contents)
  return win && !win.isDestroyed() ? win : null
}
