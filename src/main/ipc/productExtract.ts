/**
 * Product extraction: prices and specifications from a retail or manufacturer
 * page, by mechanism rather than by model reading.
 *
 * ## Why a ladder
 *
 * Most retail pages carry schema.org `Product`/`Offer` data as JSON-LD, because
 * search engines require it for rich results. That is a machine-readable price,
 * and parsing it in code is both more accurate and more honest than asking a 7B
 * model to read a page and report a number — a model asked for a price will
 * always produce one, including from a "was $1,299" strike-through, a related
 * item, or its own training data.
 *
 * So extraction runs a ladder and **records which rung produced each value**:
 *
 *   1. JSON-LD  `<script type="application/ld+json">` Product/Offer
 *   2. microdata `itemprop="price"` / RDFa
 *   3. meta tags `og:price:amount`, `product:price:amount`
 *   4. model     (not here — the caller's fallback, always labeled)
 *
 * A value with no rung behind it is not returned. The caller renders rung 4
 * differently from rungs 1–3, which is the same disclosure logic as the
 * `unverified` badge and the memory-recall chips.
 *
 * ## Dark patterns are collected, not reported
 *
 * "Only 2 left!", countdown timers, and strike-through "was" prices are
 * frequently fictional and are engineered to compress a decision. They are
 * extracted into `urgencyClaims` so the caller can label them as retailer
 * marketing, and are never mixed into the factual fields.
 *
 * Pure: no network, no settings, no I/O.
 */

import { decodeEntities } from './extract'

export type ExtractionRung = 'json-ld' | 'microdata' | 'meta' | 'model'
export type Availability = 'in_stock' | 'out_of_stock' | 'preorder' | 'unknown'

export interface SpecValue {
  /** The text as the page stated it, kept so the user can check our reading. */
  raw: string
  /** Normalized magnitude in the canonical unit, when the shape was recognized. */
  value?: number
  unit?: string
  rung: ExtractionRung
}

export interface ExtractedProduct {
  url: string
  name?: string
  brand?: string
  price?: number
  currency?: string
  availability: Availability
  seller?: string
  /** Rung that produced `price`. null when no rung did — then `price` is absent. */
  priceRung: ExtractionRung | null
  specs: Record<string, SpecValue>
  /** Urgency/scarcity marketing found on the page. Never treated as fact. */
  urgencyClaims: string[]
}

// ---- primitive parsers -------------------------------------------------------

/** `"$1,299.00"` → 1299. Returns null rather than guessing at an unparseable string. */
export function parsePrice(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  // Strip currency symbols and spaces, then decide which separator is decimal.
  const cleaned = text.replace(/[^\d.,-]/g, '')
  if (!cleaned) return null
  const lastComma = cleaned.lastIndexOf(',')
  const lastDot = cleaned.lastIndexOf('.')
  let normalized = cleaned
  if (lastComma > lastDot) {
    // European: 1.299,00 → the comma is the decimal point.
    normalized = cleaned.replace(/\./g, '').replace(',', '.')
  } else {
    normalized = cleaned.replace(/,/g, '')
  }
  const value = Number.parseFloat(normalized)
  return Number.isFinite(value) && value >= 0 ? value : null
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '£': 'GBP',
  '€': 'EUR',
  '¥': 'JPY',
  '₹': 'INR'
}

export function parseCurrency(raw: unknown, fallbackText = ''): string | undefined {
  if (typeof raw === 'string' && /^[A-Za-z]{3}$/.test(raw.trim())) return raw.trim().toUpperCase()
  const symbol = Object.keys(CURRENCY_SYMBOLS).find((s) => fallbackText.includes(s))
  return symbol ? CURRENCY_SYMBOLS[symbol] : undefined
}

/** schema.org availability URLs and bare tokens → our four states. */
export function parseAvailability(raw: unknown): Availability {
  const text = String(raw ?? '').toLowerCase()
  if (!text) return 'unknown'
  if (/preorder|pre-order/.test(text)) return 'preorder'
  if (/(?:^|\/|\b)instock|in_stock|in stock|onlineonly|limitedavailability/.test(text)) {
    return 'in_stock'
  }
  if (/outofstock|out_of_stock|out of stock|soldout|sold out|discontinued|backorder/.test(text)) {
    return 'out_of_stock'
  }
  return 'unknown'
}

// ---- spec normalization ------------------------------------------------------

const MEMORY_UNITS: Record<string, number> = { mb: 1 / 1024, gb: 1, tb: 1024 }
const WEIGHT_UNITS: Record<string, number> = { kg: 1, g: 0.001, lb: 0.453592, lbs: 0.453592, oz: 0.0283495 }

/** `"16 GB"` / `"16384 MB"` / `"1 TB"` → gigabytes. */
export function parseCapacityGb(raw: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*(mb|gb|tb)\b/i.exec(raw)
  if (!m) return null
  const magnitude = Number.parseFloat(m[1].replace(',', '.'))
  const factor = MEMORY_UNITS[m[2].toLowerCase()]
  return Number.isFinite(magnitude) ? Math.round(magnitude * factor * 100) / 100 : null
}

/** `"2.8 lbs"` / `"1,24 kg"` → kilograms. */
export function parseWeightKg(raw: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*(kg|kilograms?|g|grams?|lbs?|pounds?|oz|ounces?)\b/i.exec(raw)
  if (!m) return null
  const magnitude = Number.parseFloat(m[1].replace(',', '.'))
  const unit = m[2].toLowerCase()
  const key = unit.startsWith('kg') || unit.startsWith('kilo')
    ? 'kg'
    : unit.startsWith('lb') || unit.startsWith('pound')
      ? 'lb'
      : unit.startsWith('oz') || unit.startsWith('ounce')
        ? 'oz'
        : 'g'
  const factor = WEIGHT_UNITS[key]
  return Number.isFinite(magnitude) ? Math.round(magnitude * factor * 1000) / 1000 : null
}

export function parseHours(raw: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*(?:h\b|hr|hrs|hours?)/i.exec(raw)
  if (!m) return null
  const value = Number.parseFloat(m[1].replace(',', '.'))
  return Number.isFinite(value) ? value : null
}

export function parseInches(raw: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*(?:"|”|inch(?:es)?|in\b)/i.exec(raw)
  if (!m) return null
  const value = Number.parseFloat(m[1].replace(',', '.'))
  return Number.isFinite(value) ? value : null
}

/**
 * Canonical spec keys and the label patterns that map onto them. The keys are
 * what requirements are written against, so this table is the contract between
 * a rubric's `spec: 'ram_gb'` and whatever a manufacturer called that row.
 */
const SPEC_MAP: { key: string; unit: string; label: RegExp; parse: (raw: string) => number | null }[] = [
  { key: 'ram_gb', unit: 'GB', label: /\b(?:ram|memory|installed memory|system memory)\b/i, parse: parseCapacityGb },
  { key: 'storage_gb', unit: 'GB', label: /\b(?:storage|ssd|hard drive|hard disk|capacity|internal storage)\b/i, parse: parseCapacityGb },
  { key: 'weight_kg', unit: 'kg', label: /\b(?:weight|item weight|shipping weight)\b/i, parse: parseWeightKg },
  { key: 'battery_h', unit: 'h', label: /\b(?:battery(?: life)?|runtime|playback time|usage time)\b/i, parse: parseHours },
  { key: 'screen_in', unit: 'in', label: /\b(?:screen|display|screen size|display size|diagonal)\b/i, parse: parseInches },
  { key: 'refresh_hz', unit: 'Hz', label: /\b(?:refresh rate|refresh)\b/i, parse: (raw) => {
    const m = /(\d+(?:[.,]\d+)?)\s*hz/i.exec(raw)
    return m ? Number.parseFloat(m[1].replace(',', '.')) : null
  } }
]

/** Free-text spec keys with no numeric magnitude — kept as strings. */
const TEXT_SPECS: { key: string; label: RegExp }[] = [
  { key: 'cpu', label: /\b(?:processor|cpu|chip)\b/i },
  { key: 'gpu', label: /\b(?:graphics|gpu|video card)\b/i },
  { key: 'os', label: /\b(?:operating system|os)\b/i }
]

/**
 * Map one `label: value` pair from a spec table onto a canonical key. Returns
 * null when the label matches nothing we know how to compare — an unmatched
 * spec is dropped rather than stored under a guessed key, because a requirement
 * checked against a guess is worse than one reported unverifiable.
 */
export function normalizeSpec(
  label: string,
  raw: string,
  rung: ExtractionRung
): { key: string; value: SpecValue } | null {
  const text = String(raw ?? '').trim()
  if (!text) return null

  for (const entry of SPEC_MAP) {
    if (!entry.label.test(label)) continue
    const value = entry.parse(text)
    if (value === null) continue
    return { key: entry.key, value: { raw: text, value, unit: entry.unit, rung } }
  }
  for (const entry of TEXT_SPECS) {
    if (entry.label.test(label)) return { key: entry.key, value: { raw: text, rung } }
  }
  return null
}

// ---- dark patterns -----------------------------------------------------------

const URGENCY_PATTERNS = [
  /only\s+\d+\s+left[^.!<]{0,30}/gi,
  /\d+\s+(?:people|others)\s+(?:are\s+)?(?:viewing|watching|bought)[^.!<]{0,30}/gi,
  /(?:hurry|selling fast|almost gone|going fast|limited time|ends in|deal ends)[^.!<]{0,40}/gi,
  /\d+\s*%\s*claimed/gi
]

export function findUrgencyClaims(text: string): string[] {
  const found = new Set<string>()
  for (const re of URGENCY_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const claim = m[0].replace(/\s+/g, ' ').trim()
      if (claim.length <= 80) found.add(claim)
    }
  }
  return [...found].slice(0, 5)
}

// ---- rung 1: JSON-LD ---------------------------------------------------------

/** Every `<script type="application/ld+json">` payload, parsed tolerantly. */
export function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = []
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  for (const match of html.matchAll(re)) {
    const body = match[1]
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^\s*\/\/<!\[CDATA\[|\]\]>\s*$/g, '')
      .trim()
    if (!body) continue
    try {
      blocks.push(JSON.parse(body))
    } catch {
      // Malformed JSON-LD is common. Skip the block rather than the page.
    }
  }
  return blocks
}

function typeOf(node: Record<string, unknown>): string[] {
  const raw = node['@type']
  if (typeof raw === 'string') return [raw]
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string')
  return []
}

/** Depth-first walk over JSON-LD, flattening `@graph` and arrays. */
function walkNodes(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) walkNodes(item, out)
    return out
  }
  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>
    out.push(node)
    for (const key of ['@graph', 'mainEntity', 'itemListElement', 'isSimilarTo']) {
      if (key in node) walkNodes(node[key], out)
    }
  }
  return out
}

function firstOffer(node: Record<string, unknown>): Record<string, unknown> | null {
  const offers = node.offers
  const candidates = walkNodes(offers)
  return candidates.find((o) => 'price' in o || 'lowPrice' in o) ?? candidates[0] ?? null
}

function extractJsonLd(html: string): Partial<ExtractedProduct> | null {
  const nodes = jsonLdBlocks(html).flatMap((block) => walkNodes(block))
  const product = nodes.find((n) => typeOf(n).some((t) => /^(?:Product|IndividualProduct|ProductModel|Vehicle|Book)$/i.test(t)))
  if (!product) return null

  const result: Partial<ExtractedProduct> = { specs: {} }
  if (typeof product.name === 'string') result.name = decodeEntities(product.name).trim()

  const brand = product.brand
  if (typeof brand === 'string') result.brand = brand
  else if (brand && typeof brand === 'object' && typeof (brand as Record<string, unknown>).name === 'string') {
    result.brand = String((brand as Record<string, unknown>).name)
  }

  const offer = firstOffer(product)
  if (offer) {
    const price = parsePrice(offer.price ?? offer.lowPrice)
    if (price !== null) {
      result.price = price
      result.priceRung = 'json-ld'
      result.currency = parseCurrency(offer.priceCurrency)
    }
    result.availability = parseAvailability(offer.availability ?? offer.itemCondition)
    const seller = offer.seller
    if (seller && typeof seller === 'object' && typeof (seller as Record<string, unknown>).name === 'string') {
      result.seller = String((seller as Record<string, unknown>).name)
    }
  }

  // `additionalProperty: [{ name, value }]` is where manufacturers put spec tables.
  const specs: Record<string, SpecValue> = {}
  for (const prop of walkNodes(product.additionalProperty)) {
    const name = typeof prop.name === 'string' ? prop.name : ''
    const raw = prop.value
    if (!name || raw === undefined || raw === null) continue
    const normalized = normalizeSpec(name, String(raw), 'json-ld')
    if (normalized) specs[normalized.key] = normalized.value
  }
  result.specs = specs
  return result
}

// ---- rung 2: microdata -------------------------------------------------------

/** Value of an `itemprop`, preferring an explicit `content` attribute over text. */
function itempropValue(html: string, prop: string): string | null {
  const tagRe = new RegExp(
    `<(\\w+)\\b[^>]*itemprop\\s*=\\s*["'][^"']*\\b${prop}\\b[^"']*["']([^>]*)>([\\s\\S]{0,200}?)</\\1>`,
    'i'
  )
  const match = tagRe.exec(html)
  if (match) {
    const contentAttr = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(match[2])
    if (contentAttr) return decodeEntities(contentAttr[1]).trim()
    const text = match[3].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    if (text) return decodeEntities(text)
  }
  // Void elements (<meta itemprop=… content=…>) have no closing tag.
  const voidRe = new RegExp(
    `<\\w+\\b[^>]*itemprop\\s*=\\s*["'][^"']*\\b${prop}\\b[^"']*["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`,
    'i'
  )
  const voidMatch = voidRe.exec(html)
  return voidMatch ? decodeEntities(voidMatch[1]).trim() : null
}

function extractMicrodata(html: string): Partial<ExtractedProduct> | null {
  const rawPrice = itempropValue(html, 'price')
  const price = parsePrice(rawPrice)
  if (price === null) return null
  return {
    price,
    priceRung: 'microdata',
    currency: parseCurrency(itempropValue(html, 'priceCurrency'), rawPrice ?? ''),
    availability: parseAvailability(itempropValue(html, 'availability')),
    name: itempropValue(html, 'name') ?? undefined,
    specs: {}
  }
}

// ---- rung 3: meta tags -------------------------------------------------------

function metaContent(html: string, names: string[]): string | null {
  for (const name of names) {
    const re = new RegExp(
      `<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${name.replace(/[:.]/g, '\\$&')}["'][^>]*>`,
      'i'
    )
    const tag = re.exec(html)?.[0]
    if (!tag) continue
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (content) return decodeEntities(content).trim()
  }
  return null
}

function extractMeta(html: string): Partial<ExtractedProduct> | null {
  const rawPrice = metaContent(html, ['product:price:amount', 'og:price:amount', 'twitter:data1'])
  const price = parsePrice(rawPrice)
  if (price === null) return null
  return {
    price,
    priceRung: 'meta',
    currency: parseCurrency(
      metaContent(html, ['product:price:currency', 'og:price:currency']),
      rawPrice ?? ''
    ),
    availability: parseAvailability(metaContent(html, ['product:availability', 'og:availability'])),
    name: metaContent(html, ['og:title']) ?? undefined,
    specs: {}
  }
}

// ---- spec tables -------------------------------------------------------------

/**
 * Two-column spec tables (`<tr><th>RAM</th><td>16 GB</td></tr>`) and definition
 * lists, which is where retailers put specifications that never make it into
 * structured data. Attributed to the rung of the page's structured data — or
 * 'microdata' when there was none, since a table in the HTML is still the page
 * asserting it, not a model reading it.
 */
export function extractSpecTables(html: string, rung: ExtractionRung): Record<string, SpecValue> {
  const specs: Record<string, SpecValue> = {}
  const cell = (raw: string): string =>
    decodeEntities(raw.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

  const rowRe = /<tr\b[^>]*>\s*<t[hd]\b[^>]*>([\s\S]{0,200}?)<\/t[hd]>\s*<t[hd]\b[^>]*>([\s\S]{0,200}?)<\/t[hd]>/gi
  for (const m of html.matchAll(rowRe)) {
    const normalized = normalizeSpec(cell(m[1]), cell(m[2]), rung)
    if (normalized && !(normalized.key in specs)) specs[normalized.key] = normalized.value
  }

  const dlRe = /<dt\b[^>]*>([\s\S]{0,200}?)<\/dt>\s*<dd\b[^>]*>([\s\S]{0,200}?)<\/dd>/gi
  for (const m of html.matchAll(dlRe)) {
    const normalized = normalizeSpec(cell(m[1]), cell(m[2]), rung)
    if (normalized && !(normalized.key in specs)) specs[normalized.key] = normalized.value
  }

  return specs
}

// ---- the ladder --------------------------------------------------------------

/**
 * Run the ladder. Higher rungs win: structured data beats a visible price,
 * because the visible one is as often a strike-through "was" price or a
 * related item as it is the thing being sold.
 *
 * Returns `priceRung: null` when no rung produced a price — the caller must
 * then either fall back to the model (labeled) or report the price as
 * unavailable. It must never invent one.
 */
export function extractProduct(html: string, url: string, pageText = ''): ExtractedProduct {
  const base: ExtractedProduct = {
    url,
    availability: 'unknown',
    priceRung: null,
    specs: {},
    urgencyClaims: findUrgencyClaims(pageText || html)
  }

  const rungs = [extractJsonLd(html), extractMicrodata(html), extractMeta(html)]
  const merged = rungs.reduce<ExtractedProduct>((acc, rung) => {
    if (!rung) return acc
    return {
      ...acc,
      name: acc.name ?? rung.name,
      brand: acc.brand ?? rung.brand,
      seller: acc.seller ?? rung.seller,
      price: acc.price ?? rung.price,
      currency: acc.currency ?? rung.currency,
      priceRung: acc.priceRung ?? rung.priceRung ?? null,
      availability: acc.availability !== 'unknown' ? acc.availability : (rung.availability ?? 'unknown'),
      specs: { ...rung.specs, ...acc.specs }
    }
  }, base)

  // Spec tables fill gaps structured data left, never overwrite it.
  const tableSpecs = extractSpecTables(html, merged.priceRung ?? 'microdata')
  for (const [key, value] of Object.entries(tableSpecs)) {
    if (!(key in merged.specs)) merged.specs[key] = value
  }

  return merged
}
