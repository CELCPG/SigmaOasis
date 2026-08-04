/**
 * Shopping research and purchase-decision support.
 *
 * The boundary, first, because everything else depends on it:
 *
 * > **Sigma Oasis researches purchases. It never makes them.** No login, no
 * > cart, no checkout, no stored payment method, no address autofill. No
 * > function in this module submits, authenticates, or pays, and none may be
 * > added. The moment the app holds a retailer credential, every privacy
 * > guarantee it makes collapses into "a browser with worse UX."
 *
 * What it does instead: turns a vague want into checkable requirements
 * (rubrics.ts, entirely local), finds candidates while excluding the affiliate
 * listicles that dominate product search (sourceTiers.ts), verifies each
 * requirement against structured page data rather than model reading
 * (productExtract.ts), and reports prices with a source and a timestamp.
 *
 * Three rules are enforced here in code rather than in a prompt, because a
 * 7B model will not hold them:
 *
 * 1. **Query minimization.** Only a product-shaped query may leave the
 *    machine. `assertProductShapedQuery` rejects the user's framing — the
 *    thing that says who they are — before egress, as a visible error rather
 *    than a silent rewrite.
 * 2. **The recommendation gate.** A candidate whose hard requirements are
 *    unverified is never recommended. "I could not verify what you need on any
 *    of these" is the correct output, and it is produced mechanically.
 * 3. **Refused categories.** Product research shades into regulated advice.
 *    Medical, financial, and age-restricted categories get guidance on what to
 *    look for and who to ask, never a ranking.
 */

import { getSettings } from './store'
import { proxyActive } from './proxy'
import { fetchWebpage, runWebSearch } from './search'
import { extractProduct, type ExtractedProduct, type ExtractionRung } from './productExtract'
import { authoritativeFor, isExcluded, isMarketplace, tierOf, type SourceTier } from './sourceTiers'
import { normalizeProductUrl } from './urlHygiene'
import {
  deriveRequirements,
  productQueryFrom,
  rubricFor,
  type Requirement,
  type RequirementSpec
} from './rubrics'

// ---- types -------------------------------------------------------------------

export type Verdict = 'confirmed' | 'contradicted' | 'unverifiable'

/**
 * How a value was established. The distinction between a manufacturer claiming
 * 18-hour battery life and a testing outlet measuring 11 is the most common
 * dishonesty in this product category, and flattening them into one number is
 * exactly what this field exists to prevent.
 */
export type Basis =
  | 'manufacturer-claimed'
  | 'independently-tested'
  | 'retailer-listed'
  | 'page-stated'
  | 'model-read'

export interface SpecVerdict {
  requirement: string
  verdict: Verdict
  /** What the source actually said, when anything did. */
  found?: string
  source?: string
  sourceTier: SourceTier
  basis: Basis
  kind: Requirement['kind']
}

export interface Offer {
  seller: string
  url: string
  price?: number
  currency?: string
  availability: ExtractedProduct['availability']
  priceRung: ExtractionRung | null
  tier: SourceTier
  /** Present when the fetch failed — the row is shown as blocked, never dropped. */
  blocked?: string
  fetchedAt: number
  marketplaceRisk: boolean
  urgencyClaims: string[]
  verdicts: SpecVerdict[]
  name?: string
}

export interface CompareOutcome {
  ok: boolean
  query: string
  offers: Offer[]
  /** Stated when a budget stopped the run, never reported after the fact. */
  budgetNote?: string
  excluded: { url: string; why: string }[]
  error?: string
}

// ---- refused categories ------------------------------------------------------

/**
 * Categories where a ranking would be regulated advice, a safety question, or
 * both. The app says what to look for and who is qualified to ask, in one
 * sentence, and stops. Not a lecture — a boundary.
 */
const REFUSED: { category: string; re: RegExp; guidance: string }[] = [
  {
    category: 'medical devices and health products',
    re: /\b(?:blood pressure monitor|glucose|glucometer|cpap|nebulizer|hearing aid|pulse oximeter|thermometer|defibrillator|orthotic|brace|medical device)\b/i,
    guidance:
      'Look for regulatory clearance (FDA 510(k), CE/UKCA marking) and validation against a clinical protocol — a pharmacist or your clinician can tell you which model is validated for your situation.'
  },
  {
    category: 'supplements and health claims',
    re: /\b(?:supplement|vitamins?|nootropic|creatine|testosterone booster|weight loss pill|detox|herbal remedy|melatonin)\b/i,
    guidance:
      'Look for third-party purity testing (USP, NSF, Informed Sport) and check interactions with anything you already take — a pharmacist is the right person to ask.'
  },
  {
    category: 'prescription and pharmacy items',
    re: /\b(?:prescription|pharmacy|antibiotic|insulin|inhaler|epipen|medication)\b/i,
    guidance: 'This needs a prescriber or pharmacist, not a price comparison.'
  },
  {
    category: 'financial and insurance products',
    re: /\b(?:life insurance|health insurance|annuity|mortgage|brokerage account|crypto|stocks?|etf|mutual fund|pension|401k|loan|credit card offer)\b/i,
    guidance:
      'Compare the total cost disclosure and the fee schedule, and check the provider is registered with your regulator — a licensed adviser can assess whether it fits your situation. Sigma Oasis does not give financial advice.'
  },
  {
    category: 'firearms, ammunition and weapons',
    re: /\b(?:firearm|handgun|rifle|shotgun|ammunition|ammo|silencer|suppressor|magazine capacity)\b/i,
    guidance: 'Purchases here are legally restricted and jurisdiction-specific; a licensed dealer is the right source.'
  },
  {
    category: 'age-restricted goods',
    re: /\b(?:vape|e-cigarette|nicotine|tobacco|cigar|alcohol|whisk(?:e)?y|vodka|cannabis|thc|cbd|kratom)\b/i,
    guidance: 'Age-restricted and jurisdiction-specific; not something to rank on price.'
  }
]

export function refusedCategory(text: string): { category: string; guidance: string } | null {
  const hit = REFUSED.find((r) => r.re.test(String(text ?? '')))
  return hit ? { category: hit.category, guidance: hit.guidance } : null
}

// ---- query minimization ------------------------------------------------------

/**
 * Shopping queries are the most commercially valuable queries a person makes,
 * and the framing around them ("for my flight to Lagos") is the part that
 * identifies the person rather than the product.
 *
 * Rejected rather than rewritten: a silent rewrite teaches nothing and hides
 * the fact that the model tried. The error names the fix, and the model — which
 * sees tool errors — reliably retries with a product-shaped query.
 */
const FIRST_PERSON = /\b(?:i|i'm|im|my|mine|me|we|our|us|myself|husband|wife|partner|kid|kids|son|daughter|mom|dad|birthday|anniversary|christmas|wedding|graduation)\b/i
const MAX_QUERY_TOKENS = 14

export function assertProductShapedQuery(
  raw: string
): { ok: true; query: string } | { ok: false; error: string } {
  const query = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!query) return { ok: false, error: 'Empty product query.' }

  const personal = FIRST_PERSON.exec(query)
  if (personal) {
    return {
      ok: false,
      error:
        `Refused: the query contains personal framing ("${personal[0]}") and would tell the search provider ` +
        'who is shopping, not what for. Search the product and its specifications only — ' +
        'e.g. "laptop 32GB RAM 1TB discrete GPU under 2000".'
    }
  }
  const tokens = query.split(' ').filter(Boolean)
  if (tokens.length > MAX_QUERY_TOKENS) {
    return {
      ok: false,
      error:
        `Refused: ${tokens.length}-word query reads as a sentence, not a product search (limit ${MAX_QUERY_TOKENS}). ` +
        'Send the product category plus its specifications and a price ceiling.'
    }
  }
  if (/\?$/.test(query)) {
    return {
      ok: false,
      error: 'Refused: a question, not a product query. Send the product and its specifications.'
    }
  }
  return { ok: true, query }
}

// ---- verification ------------------------------------------------------------

/** Tier plus extraction rung decide how a value may be described. */
export function basisFor(tier: SourceTier, rung: ExtractionRung | null): Basis {
  if (rung === 'model') return 'model-read'
  switch (tier) {
    case 'A':
      return 'manufacturer-claimed'
    case 'B':
      return 'independently-tested'
    case 'C':
      return 'retailer-listed'
    default:
      // An unrecognized source that published structured data still *stated*
      // the value. Calling that 'model-read' would smear a real distinction:
      // "we don't know this site" and "a language model read it off the page"
      // are different weaknesses, and only the second is our doing.
      return 'page-stated'
  }
}

function compare(op: Requirement['op'], found: number | string, want: Requirement['value']): boolean {
  if (op === '>=' && typeof found === 'number' && typeof want === 'number') return found >= want
  if (op === '<=' && typeof found === 'number' && typeof want === 'number') return found <= want
  if (op === '==') return String(found).toLowerCase().includes(String(want).toLowerCase())
  if (op === 'in' && Array.isArray(want)) {
    return want.some((w) => String(found).toLowerCase().includes(String(w).toLowerCase()))
  }
  return false
}

/**
 * Settle one requirement against one product.
 *
 * A spec the page does not state is `unverifiable` — never assumed absent and
 * never assumed present. This is the same rule the v1.2 claim check follows:
 * "search returned nothing useful" is a result, not a licence to guess.
 */
export function verifyRequirement(
  requirement: Requirement,
  product: ExtractedProduct,
  tier: SourceTier
): SpecVerdict {
  const spec = product.specs[requirement.spec]
  const base = {
    requirement: requirement.label,
    sourceTier: tier,
    kind: requirement.kind,
    source: product.url
  }
  if (!spec) {
    return { ...base, verdict: 'unverifiable', basis: basisFor(tier, null), source: product.url }
  }
  const found = spec.value ?? spec.raw
  const met = compare(requirement.op, found, requirement.value)
  return {
    ...base,
    verdict: met ? 'confirmed' : 'contradicted',
    found: spec.raw,
    basis: basisFor(tier, spec.rung)
  }
}

/**
 * The recommendation gate. A product may be recommended only when every *hard*
 * requirement is confirmed — an `unverifiable` blocker means the honest answer
 * is that we could not check, not that the product is fine.
 */
export function canRecommend(verdicts: SpecVerdict[]): boolean {
  const hard = verdicts.filter((v) => v.kind === 'hard')
  return hard.length > 0 && hard.every((v) => v.verdict === 'confirmed')
}

// ---- the compare run ---------------------------------------------------------

/** Hard ceiling regardless of what the caller asks for. */
const MAX_SELLERS_CEILING = 5

function sellerOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Search, tier-filter, fetch, extract, verify. One search plus at most
 * `maxSellers` page fetches, with the budget checked *before* each fetch and
 * disclosed when it stops the run — the same ledger discipline as deep
 * research, in code rather than in the prompt.
 */
export async function runShopCompare(args: {
  product: string
  requirements?: Requirement[]
  maxSellers?: number
  brands?: string[]
}): Promise<CompareOutcome> {
  const settings = getSettings().shopping
  const requirements = args.requirements ?? []
  const excluded: { url: string; why: string }[] = []

  const refused = refusedCategory(args.product)
  if (refused) {
    return {
      ok: false,
      query: '',
      offers: [],
      excluded,
      error:
        `Sigma Oasis does not rank or recommend ${refused.category}. ${refused.guidance}`
    }
  }

  const shaped = assertProductShapedQuery(args.product)
  if (!shaped.ok) return { ok: false, query: '', offers: [], excluded, error: shaped.error }

  // A privacy setting that silently does not cover the case that matters is
  // worse than not having it: refuse rather than fall back to a direct fetch.
  if (settings.requireProxy && !proxyActive()) {
    return {
      ok: false,
      query: shaped.query,
      offers: [],
      excluded,
      error:
        'Refused: shopping fetches contact retailers directly, and "Require proxy for shopping" is on ' +
        'while no proxy is active. Turn on Tor/VPN under Settings → Privacy, or turn the requirement off there.'
    }
  }

  const search = await runWebSearch(shaped.query)
  if (!search.ok) {
    return { ok: false, query: shaped.query, offers: [], excluded, error: search.error ?? 'Search failed.' }
  }

  const maxSellers = Math.min(Math.max(1, args.maxSellers ?? settings.maxSellers), MAX_SELLERS_CEILING)
  const seen = new Set<string>()
  const candidates: { url: string; tier: SourceTier }[] = []

  for (const result of search.results) {
    const url = normalizeProductUrl(result.url)
    const { tier, why } = tierOf(url, args.brands ?? [])
    if (settings.excludeTierX && isExcluded(tier)) {
      excluded.push({ url, why })
      continue
    }
    const host = sellerOf(url)
    if (seen.has(host)) continue
    seen.add(host)
    candidates.push({ url, tier })
  }

  const offers: Offer[] = []
  let budgetNote: string | undefined

  for (const candidate of candidates) {
    // Budget checked before the work, not after it.
    if (offers.length >= maxSellers) {
      budgetNote = `${offers.length} of ${candidates.length} candidate sellers checked — fetch budget reached (${maxSellers}).`
      break
    }

    const page = await fetchWebpage(candidate.url, 'shop')
    const fetchedAt = Date.now()
    if (!page.ok) {
      offers.push({
        seller: sellerOf(candidate.url),
        url: candidate.url,
        availability: 'unknown',
        priceRung: null,
        tier: candidate.tier,
        blocked: page.error ?? 'fetch failed',
        fetchedAt,
        marketplaceRisk: isMarketplace(candidate.url),
        urgencyClaims: [],
        verdicts: []
      })
      continue
    }

    const product = extractProduct(page.rawHtml ?? '', candidate.url, page.text)
    offers.push({
      seller: product.seller ?? sellerOf(candidate.url),
      url: candidate.url,
      name: product.name,
      price: product.price,
      currency: product.currency,
      availability: product.availability,
      priceRung: product.priceRung,
      tier: candidate.tier,
      fetchedAt,
      marketplaceRisk: isMarketplace(candidate.url),
      urgencyClaims: product.urgencyClaims,
      verdicts: requirements.map((r) => verifyRequirement(r, product, candidate.tier))
    })
  }

  return { ok: true, query: shaped.query, offers, budgetNote, excluded }
}

// ---- rendering ---------------------------------------------------------------

const VERDICT_MARK: Record<Verdict, string> = {
  confirmed: '✓',
  contradicted: '✗',
  unverifiable: '?'
}

function money(offer: Offer): string {
  if (offer.blocked) return '—'
  if (offer.price === undefined) return '— (no price in structured data)'
  const symbol = offer.currency === 'GBP' ? '£' : offer.currency === 'EUR' ? '€' : '$'
  return `${symbol}${offer.price.toFixed(2)}`
}

function age(fetchedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - fetchedAt) / 1000))
  if (seconds < 90) return 'just now'
  return `${Math.round(seconds / 60)} min ago`
}

/**
 * Format a compare run for the model and the user.
 *
 * The model receives the table already built. It writes the recommendation
 * *around* these numbers and never restates them — a price that passes through
 * a language model has lost its provenance, which is the whole point of having
 * extracted it mechanically.
 */
export function formatCompare(outcome: CompareOutcome, now = Date.now()): string {
  if (!outcome.ok) return outcome.error ?? 'Comparison failed.'
  if (outcome.offers.length === 0) {
    return `No sellers could be checked for "${outcome.query}".` +
      (outcome.excluded.length > 0
        ? ` ${outcome.excluded.length} result(s) excluded as affiliate/listicle sources.`
        : '')
  }

  const lines: string[] = [`Offers for "${outcome.query}" — prices extracted from page data, not read by a model.`, '']

  for (const offer of outcome.offers) {
    const header = `${offer.seller} — ${money(offer)}`
    lines.push(offer.blocked ? `${header}  [BLOCKED: ${offer.blocked}]` : header)
    if (offer.name) lines.push(`  ${offer.name}`)
    if (!offer.blocked) {
      lines.push(
        `  availability: ${offer.availability.replace('_', ' ')} · source tier ${offer.tier} ` +
          `(authoritative for ${authoritativeFor(offer.tier)}) · price from ${offer.priceRung ?? 'no structured data'} ` +
          `· checked ${age(offer.fetchedAt, now)}`
      )
      lines.push(`  ${offer.url}`)
      if (offer.marketplaceRisk) {
        lines.push('  ⚠ marketplace listing — third-party sellers; verify the seller before buying.')
      }
      if (offer.urgencyClaims.length > 0) {
        lines.push(`  ⚠ retailer marketing on this page (NOT fact): ${offer.urgencyClaims.join('; ')}`)
      }
      for (const v of offer.verdicts) {
        const found = v.found ? ` — ${v.found}` : ''
        lines.push(`  ${VERDICT_MARK[v.verdict]} ${v.requirement}${found} [${v.verdict}, ${v.basis}]`)
      }
      if (offer.verdicts.length > 0) {
        lines.push(
          canRecommend(offer.verdicts)
            ? '  → all hard requirements confirmed.'
            : '  → NOT recommendable: at least one hard requirement is unconfirmed.'
        )
      }
    }
    lines.push('')
  }

  if (outcome.excluded.length > 0) {
    lines.push(
      `${outcome.excluded.length} result(s) excluded as affiliate/listicle sources: ` +
        outcome.excluded.map((e) => sellerOf(e.url)).join(', ')
    )
  }
  if (outcome.budgetNote) lines.push(outcome.budgetNote)

  lines.push(
    'Prices were seen anonymously at the time shown; a logged-in or regional price may differ. ' +
      'Verify on the page before buying — Sigma Oasis does not transact.'
  )
  if (!outcome.offers.some((o) => canRecommend(o.verdicts))) {
    lines.push(
      'No candidate has every hard requirement confirmed. Say so plainly and name what could not be ' +
        'checked; do not pick one anyway.'
    )
  }
  return lines.join('\n')
}

// ---- requirements elicitation ------------------------------------------------

/**
 * Stage one: turn a want into questions, or answers into a spec. Entirely
 * local — nothing here reaches the network.
 */
export function runShopRequirements(args: {
  need: string
  answers?: Record<string, string>
}): { ok: boolean; output?: string; error?: string; spec?: RequirementSpec } {
  const refused = refusedCategory(args.need)
  if (refused) {
    return {
      ok: false,
      error: `Sigma Oasis does not rank or recommend ${refused.category}. ${refused.guidance}`
    }
  }

  const rubric = rubricFor(args.need)
  if (!rubric) {
    return {
      ok: true,
      output:
        `No built-in rubric covers "${args.need}". Ask the user at most 4 questions that would ` +
        'actually change which product fits — budget, primary use, hard constraints, deal-breakers — ' +
        'then state the requirements you derived and mark them as your inference, not established fact.'
    }
  }

  if (!args.answers || Object.keys(args.answers).length === 0) {
    const questions = rubric.questions
      .map((q, i) => `${i + 1}. ${q.ask}${q.options ? ` (${q.options.join(' / ')})` : ''} [id: ${q.id}]`)
      .join('\n')
    return {
      ok: true,
      output:
        `Category: ${rubric.category}. Ask the user these ${rubric.questions.length} questions together, ` +
        `in one message, and let them skip any:\n${questions}\n\n` +
        'Then call shop_requirements again with their answers keyed by id. Nothing has left the machine.'
    }
  }

  const spec = deriveRequirements(rubric, args.answers)
  if (spec.requirements.length === 0) {
    return {
      ok: true,
      spec,
      output:
        `No requirements could be derived for ${rubric.category} from those answers. Ask the user what ` +
        'would make a product unacceptable, and record that as the requirement.'
    }
  }

  const lines = spec.requirements.map(
    (r) => `  ${r.kind === 'hard' ? '[must]' : '[nice]'} ${r.label} — ${r.why} (${r.origin})`
  )
  const query = productQueryFrom(spec)
  return {
    ok: true,
    spec,
    output:
      `Requirements for ${rubric.category} (derived locally — nothing sent):\n${lines.join('\n')}\n` +
      (spec.budgetCeiling
        ? `  [must] under ${Math.round(spec.budgetCeiling.amount)} ${spec.budgetCeiling.currency} — stated budget (user)\n`
        : '') +
      `\nShow this list to the user and let them correct it BEFORE searching. ` +
      `When they approve, call shop_compare with product="${query}".`
  }
}
