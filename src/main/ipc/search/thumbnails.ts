import { nativeImage } from 'electron'
import { fetchWithTimeout, proxyRefusalHint, readCappedBytes, USER_AGENT } from './http'
import { assertPublicHost } from './ssrf'

// ---- Thumbnail proxying --------------------------------------------------------

/** Largest body we will pull off the wire before deciding it is not a thumbnail. */
const MAX_THUMBNAIL_BYTES = 256 * 1024
/** Largest data URL we will keep, after downscaling. See `downscaleThumbnail`. */
export const MAX_STORED_THUMBNAIL_BYTES = 48 * 1024
const THUMBNAIL_WIDTH = 320
const THUMBNAIL_TIMEOUT_MS = 10_000
const MAX_THUMBNAIL_REDIRECTS = 2
/** Raster formats only — SVG can carry script and is refused outright. */
const THUMBNAIL_TYPES = /^image\/(jpeg|png|gif|webp|avif)$/

export interface ThumbnailOutcome {
  ok: boolean
  dataUrl?: string
  error?: string
}

/**
 * Shrink a fetched image to gallery size.
 *
 * This is not cosmetic. A tool-call record is persisted verbatim with its
 * conversation, and every conversation file is re-read and parsed at launch —
 * so a full-size image here is megabytes of base64 that the app pays for on
 * every start, forever. 320px wide is already more than the three-column grid
 * renders.
 *
 * `nativeImage` decodes PNG and JPEG only; WebP, AVIF and GIF come back empty.
 * Those are kept unchanged when they are already under the stored cap and
 * refused when they are not — a stated limit rather than a silent blank tile.
 */
function downscaleThumbnail(bytes: Uint8Array, contentType: string): ThumbnailOutcome {
  const asDataUrl = (type: string, buffer: Buffer): ThumbnailOutcome => ({
    ok: true,
    dataUrl: `data:${type};base64,${buffer.toString('base64')}`
  })
  const tooBig = (size: number): ThumbnailOutcome => ({
    ok: false,
    error:
      `Thumbnail is ${Math.round(size / 1024)}KB after resizing, over the ` +
      `${Math.round(MAX_STORED_THUMBNAIL_BYTES / 1024)}KB limit.`
  })

  const source = Buffer.from(bytes)
  const image = nativeImage.createFromBuffer(source)
  if (image.isEmpty()) {
    // Undecodable here (WebP/AVIF/GIF, or a corrupt body). Pass it through only
    // if it is already small enough to store.
    if (source.byteLength <= MAX_STORED_THUMBNAIL_BYTES) return asDataUrl(contentType, source)
    return {
      ok: false,
      error:
        `Image is ${Math.round(source.byteLength / 1024)}KB and its format (${contentType}) ` +
        'cannot be resized locally.'
    }
  }

  const { width } = image.getSize()
  const resized =
    width > THUMBNAIL_WIDTH ? image.resize({ width: THUMBNAIL_WIDTH, quality: 'good' }) : image

  // PNG keeps transparency, which some product shots rely on — but PNG of a
  // photograph is far larger than JPEG, so fall back when it does not fit.
  if (contentType === 'image/png') {
    const png = resized.toPNG()
    if (png.byteLength <= MAX_STORED_THUMBNAIL_BYTES) return asDataUrl('image/png', png)
  }
  const jpeg = resized.toJPEG(72)
  if (jpeg.byteLength > MAX_STORED_THUMBNAIL_BYTES) return tooBig(jpeg.byteLength)
  return asDataUrl('image/jpeg', jpeg)
}

/**
 * Fetch one image through the audited egress path and return it as a data URL.
 *
 * The renderer's CSP allows `data:` images only, so a remote thumbnail cannot
 * be loaded by the chat UI directly. That is deliberate, and this is the
 * controlled way around it: the fetch goes through the SSRF guard, the egress
 * session (so a configured proxy actually covers it), and the network activity
 * log — and it carries no cookies, no referrer and no browser fingerprint.
 *
 * What it does not do is hide the user from the image host. Without a proxy the
 * host still sees the user's IP address, because the main process fetches from
 * the same machine. The gain over letting the renderer load the URL directly is
 * auditability, proxy coverage and a stripped request — not invisibility, and
 * the confirmation dialog says so before any of this runs.
 */
export async function fetchImageDataUrl(rawUrl: string): Promise<ThumbnailOutcome> {
  let url: URL
  try {
    url = new URL(String(rawUrl ?? ''))
  } catch {
    return { ok: false, error: 'Unparseable image URL.' }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: 'Refused: image URLs must be HTTPS.' }
  }

  try {
    for (let hop = 0; ; hop++) {
      await assertPublicHost(url)
      const res = await fetchWithTimeout(
        url.toString(),
        {
          redirect: 'manual',
          // JPEG and PNG first on purpose: those are the two formats
          // `downscaleThumbnail` can actually resize, so preferring them keeps
          // more results displayable rather than dropped for being too large.
          headers: { 'User-Agent': USER_AGENT, Accept: 'image/jpeg,image/png,image/*' },
          maxBytes: MAX_THUMBNAIL_BYTES
        },
        'image',
        THUMBNAIL_TIMEOUT_MS
      )

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) throw new Error(`Redirect (HTTP ${res.status}) without a Location header.`)
        if (hop >= MAX_THUMBNAIL_REDIRECTS) throw new Error('Too many redirects.')
        const next = new URL(location, url)
        if (next.protocol !== 'https:') throw new Error('Refused: redirect to a non-HTTPS URL.')
        url = next
        continue
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}${proxyRefusalHint(res.status)}`)
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (!THUMBNAIL_TYPES.test(contentType)) {
        throw new Error(`Not a supported image (${contentType || 'unknown content type'}).`)
      }
      // A capped body is a *partial* body: base64-encoding it produces a data
      // URL that looks valid and decodes to a broken image. Refuse instead.
      if (res.truncated) {
        throw new Error(
          `Image is larger than the ${Math.round(MAX_THUMBNAIL_BYTES / 1024)}KB fetch limit.`
        )
      }
      const bytes = await readCappedBytes(res, MAX_THUMBNAIL_BYTES)
      return downscaleThumbnail(bytes, contentType)
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
