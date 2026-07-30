import { BrowserWindow, session } from 'electron'
import { originOfUrl, recordExternalRequest } from './net'
import { GENERIC_USER_AGENT } from './userAgent'
import { PAGE_EXTRACTION_SCRIPT } from './pageScript'
import type { ExtractedLink } from './extract'

/**
 * Headless page rendering for JavaScript-dependent sites.
 *
 * Documentation sites, SPAs and most news pages return an empty shell to a plain
 * HTTP fetch — the content arrives only after scripts run. This module renders
 * such a page in an offscreen Chromium window and extracts the resulting text.
 *
 * ## Why Electron's own Chromium, not Playwright/Puppeteer
 *
 * The app already ships Chromium. A second browser would add 100–300 MB, live
 * outside the audit path, and give *less* control over what it fetches.
 *
 * ## The privacy problem this must solve
 *
 * A browser bypasses `auditedFetch` completely: Chromium's network stack issues
 * its own subresource requests — trackers, CDN fonts, analytics beacons — none of
 * which would touch the egress allowlist or the activity log. Adding a browser
 * naively would silently break the promise the README makes.
 *
 * So every request the render session makes passes through `onBeforeRequest`,
 * which:
 *
 * 1. **Blocks every third-party request.** Only the target page's own origin is
 *    allowed. Ad and analytics domains become structurally unreachable — this is
 *    stricter than a normal browser, not a relaxation of it.
 * 2. **Blocks resource types that cannot contribute text** — images, media,
 *    fonts, websockets, beacons.
 * 3. **Records everything**, allowed and blocked, in the same activity log the
 *    user already reads.
 *
 * Beyond the filter: a fresh ephemeral session per page (no cookies, no cache,
 * no storage, destroyed afterwards), no preload and no Node integration, all
 * permissions denied, navigation away from the target blocked, and hard caps on
 * time and extracted size.
 */

export interface RenderedPage {
  ok: true
  url: string
  title: string
  text: string
  links: ExtractedLink[]
  /** Requests the filter refused, by origin — surfaced so blocking is visible. */
  blockedOrigins: string[]
  /** Text nodes dropped for being visually hidden (a prompt-injection vector). */
  hiddenTextRemoved: number
}

export interface RenderFailure {
  ok: false
  error: string
}

/** Wall-clock budget for load + settle + extract. */
const RENDER_TIMEOUT_MS = 20_000
/** Grace period after load for client-side rendering to populate the DOM. */
const SETTLE_MS = 700
/** Characters of extracted text kept. */
const MAX_TEXT_CHARS = 400_000
/** Offscreen viewport — big enough that responsive sites render desktop content. */
const VIEWPORT = { width: 1280, height: 1600 }

/**
 * Resource types that can carry text or are needed to produce it. Everything
 * else is refused: a page's prose never depends on its fonts or images.
 */
const ALLOWED_RESOURCE_TYPES = new Set(['mainFrame', 'subFrame', 'script', 'stylesheet', 'xhr'])

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/** Hosts compared ignoring a leading `www.`, so a site's own subdomain counts. */
function sameSiteHost(a: string, b: string): boolean {
  const strip = (h: string): string => h.replace(/^www\./i, '').toLowerCase()
  return strip(a) === strip(b)
}

/**
 * Should the render session be allowed to make this request?
 *
 * Exported for tests: this predicate *is* the privacy boundary, so it is worth
 * asserting directly rather than only through a live browser.
 */
export function shouldAllowRequest(
  requestUrl: string,
  resourceType: string,
  targetHost: string
): { allow: boolean; reason?: string } {
  let host: string
  let protocol: string
  try {
    const parsed = new URL(requestUrl)
    host = parsed.host
    protocol = parsed.protocol
  } catch {
    return { allow: false, reason: 'unparseable URL' }
  }

  // Only ordinary web requests; no ws:, wss:, file:, blob: or anything else.
  if (protocol !== 'https:' && protocol !== 'http:') {
    return { allow: false, reason: `blocked scheme ${protocol}` }
  }
  if (!sameSiteHost(host, targetHost)) {
    return { allow: false, reason: 'third-party request' }
  }
  if (!ALLOWED_RESOURCE_TYPES.has(resourceType)) {
    return { allow: false, reason: `resource type ${resourceType}` }
  }
  return { allow: true }
}

/**
 * Render `targetUrl` offscreen and extract its text.
 *
 * `assertPublicHost` must already have passed for this URL — search.ts runs it
 * before calling here. Note the residual difference from the static path,
 * documented in SECURITY.md: Chromium resolves DNS internally, so this cannot
 * pin the pre-connect resolution the way the static fetch does. Same-origin-only
 * filtering plus the cookieless ephemeral session reduce the payoff to near zero,
 * but it is not the identical guarantee.
 */
export async function renderPage(targetUrl: string): Promise<RenderedPage | RenderFailure> {
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return { ok: false, error: 'Unparseable URL.' }
  }
  if (target.protocol !== 'https:') {
    return { ok: false, error: 'Refused: the renderer only loads HTTPS URLs.' }
  }

  const partition = `sigma-render-${uid()}`
  const ses = session.fromPartition(partition, { cache: false })
  const blockedOrigins = new Set<string>()

  ses.setUserAgent(GENERIC_USER_AGENT)
  // Nothing in a rendered page may ask for anything.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)

  // THE chokepoint. Every request this session attempts arrives here first.
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*', 'ws://*/*', 'wss://*/*'] }, (details, cb) => {
    const { allow, reason } = shouldAllowRequest(details.url, details.resourceType, target.host)
    recordExternalRequest({
      purpose: 'render',
      origin: originOfUrl(details.url),
      method: details.method ?? 'GET',
      status: null,
      ok: allow,
      blocked: !allow,
      error: allow ? undefined : reason
    })
    if (!allow) blockedOrigins.add(originOfUrl(details.url))
    cb({ cancel: !allow })
  })

  const win = new BrowserWindow({
    show: false,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    webPreferences: {
      offscreen: true,
      partition,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      // No preload: window.api (and with it every agentic tool) must never be
      // reachable from a document loaded off the public web.
      preload: undefined,
      // Nothing in a fetched page should be able to run a plugin or open a window.
      plugins: false,
      webviewTag: false,
      backgroundThrottling: false
    }
  })

  const cleanup = async (): Promise<void> => {
    try {
      win.webContents.removeAllListeners()
      if (!win.isDestroyed()) win.destroy()
    } catch {
      // Already gone.
    }
    try {
      ses.webRequest.onBeforeRequest(null)
      await ses.clearStorageData()
      await ses.clearCache()
    } catch {
      // Best effort — the partition is discarded either way.
    }
  }

  try {
    win.webContents.setAudioMuted(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // A rendered page may not navigate anywhere: a redirect chain into another
    // origin would escape the same-origin filter built around the target host.
    win.webContents.on('will-navigate', (event, url) => {
      if (url !== target.toString()) event.preventDefault()
    })
    win.webContents.on('will-redirect', (event, url) => {
      try {
        if (!sameSiteHost(new URL(url).host, target.host)) event.preventDefault()
      } catch {
        event.preventDefault()
      }
    })

    const deadline = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Rendering timed out after ${RENDER_TIMEOUT_MS / 1000}s.`)),
        RENDER_TIMEOUT_MS
      )
    )

    const work = (async (): Promise<RenderedPage> => {
      await win.loadURL(target.toString())
      // Client-side frameworks paint after load; give them a moment, but not the
      // open-ended "network idle" wait a scraper would use.
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

      // Isolated world: our extraction code is kept out of the page's own
      // JavaScript context, so the page cannot observe or tamper with it.
      const raw = (await win.webContents.executeJavaScriptInIsolatedWorld(1, [
        { code: PAGE_EXTRACTION_SCRIPT }
      ])) as {
        title?: string
        text?: string
        links?: ExtractedLink[]
        hiddenTextRemoved?: number
      } | null

      if (!raw || typeof raw.text !== 'string') {
        throw new Error('The page produced no extractable content.')
      }

      return {
        ok: true,
        url: win.webContents.getURL() || target.toString(),
        title: (raw.title ?? '').slice(0, 300),
        text: raw.text.slice(0, MAX_TEXT_CHARS),
        links: Array.isArray(raw.links) ? raw.links : [],
        blockedOrigins: [...blockedOrigins],
        hiddenTextRemoved: raw.hiddenTextRemoved ?? 0
      }
    })()

    return await Promise.race([work, deadline])
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await cleanup()
  }
}
