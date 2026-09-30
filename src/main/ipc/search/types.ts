import type { SearchProviderId } from '../store'
import type { SearchRecency } from './providers'

export interface SearchResult {
  title: string
  url: string
  snippet: string
  /** Provider-reported publish age/date, when available. */
  published?: string
}

export interface WebSearchOutcome {
  ok: boolean
  provider: SearchProviderId
  results: SearchResult[]
  /** Parts of the query that were redacted before it left the machine. */
  redactions: string[]
  /** The exact query that was sent (after redaction). */
  sentQuery: string
  /** True when results came from the local cache — nothing left the machine. */
  cached?: boolean
  /** v4.1 (G2c): the recency filter the results were fetched under, when one held. */
  recency?: SearchRecency
  error?: string
  /**
   * Set when the app declined the call and nothing was contacted. Carries the
   * one clause a reader needs; `error` still carries the model's full text.
   * Nothing broke on this path, so the caller must not report it as breakage.
   */
  declined?: string
}

export interface ImageResult {
  title: string
  /** Full-size image URL. */
  imageUrl: string
  /** Provider-supplied thumbnail URL when there is one. */
  thumbnailUrl?: string
  /** Page the image appears on — where a click should lead. */
  pageUrl: string
}

export interface ImageSearchOutcome {
  ok: boolean
  provider: SearchProviderId
  images: ImageResult[]
  /** Parts of the query that were redacted before it left the machine. */
  redactions: string[]
  /** The exact query that was sent (after redaction). */
  sentQuery: string
  error?: string
  /** As WebSearchOutcome: set when the app declined and nothing was contacted. */
  declined?: string
}
