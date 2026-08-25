import { dialog } from 'electron'
import { hostWindow } from '../hostWindow'
import { readWebpage, runImageSearch, runWebSearch, fetchImageDataUrl, MAX_IMAGE_RESULTS } from '../search'
import type { ThumbnailOutcome } from '../search'
import {
  DEFAULT_PASSAGES,
  EMPTY_RESULT_LEADS,
  MAX_PASSAGES,
  declinedCall,
  toolFailure
} from '../../../shared/tools'
import { provenanceNote, provenanceOf } from '../sourceTiers'
import { MAX_OUTPUT_CHARS, UNTRUSTED_HEADER, truncate } from './types'
import type { ToolHandler, ToolImage } from './types'

/** Web tools: web_search, image_search, fetch_webpage. */

/**
 * Total data-URL characters one gallery may carry.
 *
 * Tool records are saved with their conversation and re-parsed at every launch,
 * so this is the ceiling on what a single image search can add to that file for
 * good. Images past the cap are reported as not displayed rather than dropped
 * silently.
 */
const MAX_GALLERY_BYTES = 256 * 1024
/** Simultaneous thumbnail fetches. Low: these are third-party hosts, often via Tor. */
const THUMBNAIL_CONCURRENCY = 2
/** Chars of the MAX_OUTPUT_CHARS budget reserved for the passage-mode preamble. */
const PASSAGE_HEADER_ALLOWANCE = 800
/** Outbound links listed after a page's content. */
const MAX_LINKS_SHOWN = 25

/**
 * When confirmBeforeSearch is on, show the exact query before it leaves the
 * machine.
 *
 * `kind` matters because the two searches disclose different amounts. A web
 * search really does send the query and nothing else. An image search then
 * fetches thumbnails from whichever hosts the results point at, and each of
 * those hosts sees a request from this machine — so the dialog has to say that
 * before the user approves, not after. A consent prompt that understates what
 * follows it is worse than no prompt.
 */
async function confirmSearch(
  sender: Electron.WebContents,
  query: string,
  kind: 'web' | 'image' = 'web'
): Promise<boolean> {
  const win = hostWindow(sender)
  if (!win) return false // window closed — nobody to ask; decline
  const detail =
    kind === 'image'
      ? `"${query}"\n\n` +
        `Approving this also fetches up to ${MAX_IMAGE_RESULTS} thumbnails from the image ` +
        'hosts the results point at. Those hosts see a request from this machine — with no ' +
        'cookies, no referrer and no browser fingerprint, but with your IP address unless a ' +
        'proxy is configured under Settings → Connection. Every request is listed in the ' +
        'network activity log.'
      : `"${query}"\n\nThis is the only information that will leave your machine.`
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: kind === 'image' ? 'Confirm image search' : 'Confirm web search',
    message: 'A model wants to send this search query to your configured provider:',
    detail,
    buttons: ['Search', 'Cancel'],
    defaultId: 0,
    cancelId: 1
  })
  return response === 0
}

/**
 * Fetch each result's thumbnail, a couple at a time, preserving input order.
 *
 * Bounded rather than fanned out with Promise.all: every entry is a different
 * third-party host, and when the user has routed egress through Tor these all
 * share one circuit — the same reasoning behind deepResearch.ts's paced search
 * fan-out. Prefers the provider's thumbnail URL, which is already small.
 */
async function fetchThumbnails(
  images: { imageUrl: string; thumbnailUrl?: string }[]
): Promise<ThumbnailOutcome[]> {
  const results: ThumbnailOutcome[] = new Array(images.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      const image = images[index]
      if (!image) return
      results[index] = await fetchImageDataUrl(image.thumbnailUrl ?? image.imageUrl)
    }
  }
  await Promise.all(Array.from({ length: Math.min(THUMBNAIL_CONCURRENCY, images.length) }, worker))
  return results
}

/**
 * What the model is to do when a search does not come back. Split out of the
 * error string it used to be glued to: everything before it is what happened,
 * which is the reader's half and all the collapsed row shows.
 */
const SEARCH_FAILURE_GUIDANCE =
  'Tell the user plainly what you could not verify — never invent products, brands, ' +
  'prices, or sources to fill the gap.'

const IMAGE_FAILURE_GUIDANCE =
  'Tell the user you could not retrieve images — never describe pictures you cannot show.'

function redactionNoteFor(redactions: string[]): string {
  return redactions.length > 0
    ? `\n(Note: the query was sanitized before sending — redacted: ${redactions.join(', ')}.)`
    : ''
}

const webSearch: ToolHandler = async (args, { sender }) => {
  // Confirmation (when enabled) happens inside runWebSearch, after
  // sanitization but before anything is sent — the user approves the
  // exact query that leaves the machine.
  const outcome = await runWebSearch(String(args.query ?? ''), (q) => confirmSearch(sender, q))
  const redactionNote = redactionNoteFor(outcome.redactions)
  if (!outcome.ok) {
    // A provider that answered badly and a call that never went out are both
    // errors to the model and different facts to the reader, so the two are
    // composed apart. `declined` is the search layer's word, not this
    // handler's guess at one.
    const detail = `${outcome.error ?? 'Search failed.'}${redactionNote}`
    return {
      ok: false,
      error: outcome.declined
        ? declinedCall(outcome.declined, `${detail} ${SEARCH_FAILURE_GUIDANCE}`)
        : toolFailure(detail, SEARCH_FAILURE_GUIDANCE)
    }
  }
  if (outcome.results.length === 0) {
    // The lead is the tool table's, not this handler's — the badge check reads
    // it back off the record to tell "worked" from "supplied something".
    return {
      ok: true,
      output:
        `${EMPTY_RESULT_LEADS.get('web_search')!} "${outcome.sentQuery}" (${outcome.provider}).${redactionNote} ` +
        'Say plainly that the search found nothing usable; do not invent results.'
    }
  }
  // v1.5: mark what can be argued from the URL alone — the public record
  // at one end, search-bait at the other — and stay silent about the
  // middle. Unmarked is the common case and means exactly nothing.
  const lines = outcome.results.map((r, i) => {
    const { kind, why } = provenanceOf(r.url)
    const mark = kind === 'unknown' ? '' : `\n   [${kind}: ${why}]`
    return `${i + 1}. ${r.title}\n   ${r.url}${mark}\n   ${r.snippet}${r.published ? `\n   (${r.published})` : ''}`
  })
  const source = outcome.cached
    ? `from this session's cache — the query was not re-sent`
    : `via ${outcome.provider}`
  const shape = provenanceNote(outcome.results.map((r) => r.url))
  return {
    ok: true,
    output: truncate(
      `${UNTRUSTED_HEADER}\n\nSearch results for "${outcome.sentQuery}" ${source}:${redactionNote}\n\n` +
        `${lines.join('\n\n')}${shape ? `\n\n${shape}` : ''}`
    )
  }
}

const imageSearch: ToolHandler = async (args, { sender }) => {
  // Same confirmation hook as web_search, but with the image variant of
  // the dialog: the query is not the only thing that leaves once this is
  // approved, and the prompt has to say so.
  const outcome = await runImageSearch(
    String(args.query ?? ''),
    typeof args.max_results === 'number' ? args.max_results : MAX_IMAGE_RESULTS,
    (q) => confirmSearch(sender, q, 'image')
  )
  const redactionNote = redactionNoteFor(outcome.redactions)
  if (!outcome.ok) {
    const detail = `${outcome.error ?? 'Image search failed.'}${redactionNote}`
    return {
      ok: false,
      error: outcome.declined
        ? declinedCall(outcome.declined, `${detail} ${IMAGE_FAILURE_GUIDANCE}`)
        : toolFailure(detail, IMAGE_FAILURE_GUIDANCE)
    }
  }
  if (outcome.images.length === 0) {
    return {
      ok: true,
      output:
        `No images found for "${outcome.sentQuery}" (${outcome.provider}).${redactionNote} ` +
        'Say so plainly; do not describe images that were not found.'
    }
  }

  // Thumbnails go through the audited egress path and are inlined as data
  // URLs so the chat can show them under its data:-only CSP. Paced rather
  // than fanned out: these are third-party hosts, and six simultaneous
  // connections through one Tor circuit is both rude and slow — the same
  // discipline as deepResearch.ts's search fan-out.
  const thumbs = await fetchThumbnails(outcome.images)

  // The numbering the model is told to cite must be the numbering the
  // user sees. A failed thumbnail is not displayed, so it must not
  // consume a number — it is listed separately instead.
  const images: ToolImage[] = []
  const shown: string[] = []
  const notShown: string[] = []
  let storedBytes = 0
  outcome.images.forEach((img, i) => {
    const thumb = thumbs[i]
    const label = `${img.title || '(untitled)'}\n   page: ${img.pageUrl}\n   image: ${img.imageUrl}`
    if (thumb.ok && thumb.dataUrl && storedBytes + thumb.dataUrl.length <= MAX_GALLERY_BYTES) {
      storedBytes += thumb.dataUrl.length
      images.push({ title: img.title || img.pageUrl, pageUrl: img.pageUrl, dataUrl: thumb.dataUrl })
      shown.push(`${images.length}. ${label}`)
    } else {
      const why = thumb.ok ? 'gallery size limit reached' : (thumb.error ?? 'unknown')
      notShown.push(`- ${label}\n   (not displayed: ${why})`)
    }
  })

  const sections = [
    `${UNTRUSTED_HEADER}\n\nImage results for "${outcome.sentQuery}" via ${outcome.provider}:${redactionNote}`
  ]
  if (shown.length > 0) {
    sections.push(
      `Displayed to the user, numbered as they appear in the chat:\n\n${shown.join('\n\n')}`,
      `${shown.length} thumbnail(s) are shown. Refer to them by these numbers, and never ` +
        'claim visual details you cannot actually see.'
    )
  }
  if (notShown.length > 0) {
    sections.push(
      `Found but NOT shown to the user — do not number these, and do not describe them:\n\n${notShown.join('\n\n')}`
    )
  }
  if (shown.length === 0) {
    sections.push('Nothing is displayed; give the user the page links above.')
  }

  return { ok: true, images, output: truncate(sections.join('\n\n')) }
}

const fetchWebpage: ToolHandler = async (args) => {
  const query = String(args.query ?? '').trim()
  const requested = Number(args.max_passages)
  const maxPassages = Number.isFinite(requested)
    ? Math.min(MAX_PASSAGES, Math.max(1, Math.round(requested)))
    : DEFAULT_PASSAGES

  const outcome = await readWebpage(String(args.url ?? ''), query, maxPassages)
  if (!outcome.ok) {
    return { ok: false, error: outcome.error ?? 'Could not fetch that page.' }
  }

  const header = [
    UNTRUSTED_HEADER,
    '',
    `Page: ${outcome.title || '(no title)'}`,
    `URL: ${outcome.url}`,
    outcome.kind === 'pdf' ? '(PDF — text extracted from the document)' : '',
    outcome.cached ? '(reused from this session — no new network request was made)' : '',
    outcome.truncated ? '(page exceeded the size cap and was truncated)' : '',
    outcome.kind === 'html' && !outcome.mainContentFound
      ? '(no distinct article container was found, so the whole page is included — some site navigation may remain)'
      : '',
    outcome.renderNote ? `(${outcome.renderNote})` : '',
    outcome.hiddenTextRemoved > 0
      ? `(${outcome.hiddenTextRemoved} characters of text hidden from human readers were removed — ` +
        'hidden text is a common place to conceal instructions, so it is never shown to you)'
      : '',
    outcome.blockedOrigins.length > 0
      ? `(${outcome.blockedOrigins.length} third-party origin(s) were blocked while rendering)`
      : ''
  ].filter(Boolean)

  // Links let a model follow a citation without going back to the search
  // provider, which costs a round-trip and another query on the wire.
  const linkBlock =
    outcome.links.length > 0
      ? '\n\nOutbound links on this page (use fetch_webpage to follow one):\n' +
        outcome.links
          .slice(0, MAX_LINKS_SHOWN)
          .map((l) => `- ${l.text} → ${l.url}${l.sameSite ? '' : ' [external]'}`)
          .join('\n')
      : ''

  const retrieval = outcome.retrieval
  if (!retrieval) {
    // Whole-page mode: still the old head-of-document truncation, so tell
    // the model how to get the relevant part instead of the first part.
    if (outcome.text && outcome.text.length > MAX_OUTPUT_CHARS) {
      header.push(
        `This page is long (${outcome.totalChunks} passages) and only its beginning is shown. ` +
          'Call fetch_webpage again with a `query` argument to get the passages relevant to ' +
          'what you need — that costs no new network request.'
      )
    }
    return { ok: true, output: truncate(`${header.join('\n')}\n\n${outcome.text ?? ''}`) + linkBlock }
  }

  if (retrieval.passages.length === 0) {
    return { ok: true, output: `${header.join('\n')}\n\nThe page has no extractable text.${linkBlock}` }
  }

  // Fit whole passages into the output budget. Letting `truncate` do it
  // would cut the last passage mid-sentence and still claim to have
  // returned it, so passages are added only while one fits entirely.
  const budget = MAX_OUTPUT_CHARS - PASSAGE_HEADER_ALLOWANCE
  const blocks: string[] = []
  let used = 0
  for (const p of retrieval.passages) {
    const block =
      `--- passage ${blocks.length + 1} · ${Math.round(p.position * 100)}% into page · ` +
      `relevance ${p.score} ---\n${p.text}`
    if (blocks.length > 0 && used + block.length > budget) break
    blocks.push(block)
    used += block.length + 2
  }

  const ranking = retrieval.mode === 'hybrid' ? 'semantic + keyword ranking' : 'keyword ranking'
  header.push(
    `Showing ${blocks.length} of the ${retrieval.totalChunks} passage(s) in this page — the ` +
      `most relevant to "${query}" (${ranking}), in page order.`
  )
  if (blocks.length < retrieval.passages.length) {
    header.push(
      `Note: ${retrieval.passages.length - blocks.length} further relevant passage(s) did not ` +
        'fit in one response. Narrow the query to see them.'
    )
  }
  for (const note of retrieval.notes) header.push(`Note: ${note}`)

  return { ok: true, output: truncate(`${header.join('\n')}\n\n${blocks.join('\n\n')}`) + linkBlock }
}

export const webHandlers = {
  web_search: webSearch,
  image_search: imageSearch,
  fetch_webpage: fetchWebpage
} satisfies Record<string, ToolHandler>
