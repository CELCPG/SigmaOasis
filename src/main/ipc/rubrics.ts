/**
 * Requirements elicitation — the stage that never touches the network.
 *
 * When someone says "I need a new laptop," the app must not search. It has to
 * find out what they actually need first, and that is entirely local: no query
 * leaves the machine, no retailer learns anything, and it is the single
 * highest-value stage of the whole feature.
 *
 * ## Why a rubric table and not a prompt
 *
 * A model asked to invent requirements produces confident, plausible, subtly
 * wrong ones — "you'll want at least 64 GB" — and the user has no way to tell
 * an informed threshold from a fluent guess. A rubric is auditable, ships with
 * defaults someone can argue with, and carries the *reason* for every derived
 * requirement so a wrong one is visible before it drives four page fetches.
 *
 * The model's job is the categories this table does not cover, and phrasing.
 * It is not the source of truth about what a video editor needs. Derived
 * requirements are marked `origin: 'rubric'`; anything the model contributes is
 * marked `origin: 'model'` and rendered differently.
 *
 * ## The privacy rule
 *
 * A `RequirementSpec` never leaves the machine and never enters a search query.
 * `productQueryFrom()` builds a product-shaped query out of the *thresholds*,
 * discarding the free-text framing that carries who the user is. Enforcement is
 * in shopping.ts, in code, before egress — not in a prompt.
 *
 * Pure: no network, no settings, no I/O.
 */

export type RequirementKind = 'hard' | 'soft'
export type RequirementOrigin = 'user' | 'rubric' | 'model'
export type ComparisonOp = '>=' | '<=' | '==' | 'in'

export interface Requirement {
  /** Canonical spec key from productExtract's SPEC_MAP, e.g. 'ram_gb'. */
  spec: string
  /** Human phrasing shown in the card, e.g. '32 GB RAM or more'. */
  label: string
  op: ComparisonOp
  value: number | string | string[]
  kind: RequirementKind
  /** Why this requirement exists, shown next to it so it can be disagreed with. */
  why: string
  origin: RequirementOrigin
}

export interface RequirementSpec {
  category: string
  requirements: Requirement[]
  budgetCeiling?: { amount: number; currency: string }
  createdAt: number
}

export interface RubricQuestion {
  id: string
  ask: string
  /** Fixed choices. Absent means free text. */
  options?: string[]
  free?: boolean
}

interface DerivationRule {
  /** All answers listed must match for the rule to fire. */
  when: Record<string, string>
  requires: Omit<Requirement, 'origin'>[]
}

export interface Rubric {
  category: string
  /** Words in the user's message that select this rubric. */
  aliases: string[]
  questions: RubricQuestion[]
  derive: DerivationRule[]
  /** Requirements that apply to every purchase in this category. */
  baseline?: Omit<Requirement, 'origin'>[]
}

const req = (
  spec: string,
  label: string,
  op: ComparisonOp,
  value: number | string | string[],
  why: string,
  kind: RequirementKind = 'hard'
): Omit<Requirement, 'origin'> => ({ spec, label, op, value, why, kind })

export const RUBRICS: Rubric[] = [
  {
    category: 'laptop',
    aliases: ['laptop', 'notebook', 'macbook', 'ultrabook', 'chromebook'],
    questions: [
      {
        id: 'primary_use',
        ask: 'What will you mainly do on it?',
        options: [
          'everyday / web / office',
          'software development',
          'video or photo editing',
          'gaming',
          'data science or ML'
        ]
      },
      {
        id: 'portability',
        ask: 'How often will you carry it?',
        options: ['mostly at a desk', 'commute a few times a week', 'constant travel']
      },
      { id: 'os', ask: 'Any OS requirement?', options: ['macOS', 'Windows', 'Linux', 'no preference'] },
      { id: 'budget', ask: 'Rough budget ceiling?', free: true }
    ],
    derive: [
      {
        when: { primary_use: 'video or photo editing' },
        requires: [
          req('ram_gb', '32 GB RAM or more', '>=', 32, 'video editing — 4K timeline scrubbing'),
          req('storage_gb', '1 TB storage or more', '>=', 1000, 'video editing — media footprint'),
          req('gpu', 'discrete or Apple-silicon Pro/Max graphics', '==', 'discrete', 'video editing — encode/decode', 'soft')
        ]
      },
      {
        when: { primary_use: 'software development' },
        requires: [
          req('ram_gb', '16 GB RAM or more', '>=', 16, 'containers, language servers, browsers'),
          req('storage_gb', '512 GB storage or more', '>=', 512, 'toolchains and dependencies')
        ]
      },
      {
        when: { primary_use: 'data science or ML' },
        requires: [
          req('ram_gb', '32 GB RAM or more', '>=', 32, 'in-memory datasets'),
          req('gpu', 'discrete GPU', '==', 'discrete', 'local model training/inference')
        ]
      },
      {
        when: { primary_use: 'gaming' },
        requires: [
          req('gpu', 'discrete GPU', '==', 'discrete', 'gaming — integrated graphics will not do'),
          req('refresh_hz', '120 Hz display or higher', '>=', 120, 'gaming — frame pacing', 'soft')
        ]
      },
      {
        when: { primary_use: 'everyday / web / office' },
        requires: [req('ram_gb', '16 GB RAM or more', '>=', 16, 'browser tabs and office apps age badly at 8 GB')]
      },
      {
        when: { portability: 'constant travel' },
        requires: [
          req('weight_kg', 'under 1.6 kg', '<=', 1.6, 'carried daily'),
          req('battery_h', '8 hours battery or more', '>=', 8, 'working away from power')
        ]
      },
      {
        when: { portability: 'commute a few times a week' },
        requires: [req('weight_kg', 'under 2 kg', '<=', 2, 'regular commute', 'soft')]
      },
      { when: { os: 'macOS' }, requires: [req('os', 'macOS', '==', 'macos', 'stated OS requirement')] },
      { when: { os: 'Windows' }, requires: [req('os', 'Windows', '==', 'windows', 'stated OS requirement')] },
      { when: { os: 'Linux' }, requires: [req('os', 'Linux-compatible', '==', 'linux', 'stated OS requirement')] }
    ],
    baseline: [req('storage_gb', '256 GB storage or more', '>=', 256, 'below this, the OS alone crowds the disk')]
  },
  {
    category: 'phone',
    aliases: ['phone', 'smartphone', 'iphone', 'android', 'pixel', 'galaxy'],
    questions: [
      {
        id: 'primary_use',
        ask: 'What matters most to you?',
        options: ['camera', 'battery life', 'gaming performance', 'small and light', 'lowest price']
      },
      { id: 'os', ask: 'iOS or Android?', options: ['iOS', 'Android', 'no preference'] },
      { id: 'storage', ask: 'How much storage do you need?', options: ['128 GB', '256 GB', '512 GB or more', 'not sure'] },
      { id: 'budget', ask: 'Rough budget ceiling?', free: true }
    ],
    derive: [
      {
        when: { primary_use: 'battery life' },
        requires: [req('battery_h', '20 hours mixed use or more', '>=', 20, 'stated priority: battery')]
      },
      { when: { primary_use: 'small and light' }, requires: [req('screen_in', '6.2 inches or less', '<=', 6.2, 'stated priority: size')] },
      { when: { storage: '256 GB' }, requires: [req('storage_gb', '256 GB or more', '>=', 256, 'stated storage need')] },
      { when: { storage: '512 GB or more' }, requires: [req('storage_gb', '512 GB or more', '>=', 512, 'stated storage need')] },
      { when: { storage: '128 GB' }, requires: [req('storage_gb', '128 GB or more', '>=', 128, 'stated storage need')] },
      { when: { os: 'iOS' }, requires: [req('os', 'iOS', '==', 'ios', 'stated OS requirement')] },
      { when: { os: 'Android' }, requires: [req('os', 'Android', '==', 'android', 'stated OS requirement')] }
    ]
  },
  {
    category: 'headphones',
    aliases: ['headphones', 'headphone', 'earbuds', 'earphones', 'iem', 'headset'],
    questions: [
      { id: 'form', ask: 'What form factor?', options: ['over-ear', 'in-ear / earbuds', 'on-ear', 'no preference'] },
      {
        id: 'primary_use',
        ask: 'What will you mainly use them for?',
        options: ['commuting / flights', 'office calls', 'critical listening', 'exercise']
      },
      { id: 'wireless', ask: 'Wireless or wired?', options: ['wireless', 'wired', 'either'] },
      { id: 'budget', ask: 'Rough budget ceiling?', free: true }
    ],
    derive: [
      {
        when: { primary_use: 'commuting / flights' },
        requires: [
          req('anc', 'active noise cancelling', '==', 'yes', 'commuting — cabin and traffic noise'),
          req('battery_h', '20 hours battery or more', '>=', 20, 'long flights without charging')
        ]
      },
      { when: { primary_use: 'exercise' }, requires: [req('ip_rating', 'sweat resistant (IPX4 or better)', '==', 'yes', 'exercise — sweat exposure')] },
      { when: { primary_use: 'office calls' }, requires: [req('mic', 'dedicated call microphones', '==', 'yes', 'calls — mic quality is the whole job', 'soft')] }
    ]
  },
  {
    category: 'monitor',
    aliases: ['monitor', 'display', 'screen'],
    questions: [
      { id: 'primary_use', ask: 'What will you mainly do on it?', options: ['office / text', 'photo or video work', 'gaming', 'programming'] },
      { id: 'size', ask: 'What size are you after?', options: ['24 inch', '27 inch', '32 inch or larger', 'ultrawide'] },
      { id: 'budget', ask: 'Rough budget ceiling?', free: true }
    ],
    derive: [
      {
        when: { primary_use: 'photo or video work' },
        requires: [req('color_gamut', 'wide colour gamut (sRGB 99%+ or DCI-P3)', '==', 'yes', 'colour-accurate work')]
      },
      { when: { primary_use: 'gaming' }, requires: [req('refresh_hz', '144 Hz or higher', '>=', 144, 'gaming — frame pacing')] },
      { when: { primary_use: 'programming' }, requires: [req('screen_in', '27 inches or larger', '>=', 27, 'vertical text real estate', 'soft')] },
      { when: { size: '24 inch' }, requires: [req('screen_in', 'about 24 inches', '>=', 23, 'stated size')] },
      { when: { size: '27 inch' }, requires: [req('screen_in', 'about 27 inches', '>=', 26, 'stated size')] },
      { when: { size: '32 inch or larger' }, requires: [req('screen_in', '32 inches or larger', '>=', 31, 'stated size')] }
    ]
  }
]

/** Select the rubric a message is about, or null when no category matches. */
export function rubricFor(text: string): Rubric | null {
  const lower = String(text ?? '').toLowerCase()
  // Longest alias first so 'macbook' beats a generic match elsewhere.
  const ranked = RUBRICS.flatMap((r) => r.aliases.map((a) => ({ rubric: r, alias: a }))).sort(
    (a, b) => b.alias.length - a.alias.length
  )
  const hit = ranked.find(({ alias }) => new RegExp(`\\b${alias}s?\\b`, 'i').test(lower))
  return hit?.rubric ?? null
}

/** `"around $2000"` / `"2,000 USD"` → a ceiling, or undefined when unstated. */
export function parseBudget(answer: string): { amount: number; currency: string } | undefined {
  const text = String(answer ?? '')
  const match = /(\d[\d.,]*)\s*(k\b)?/i.exec(text.replace(/[^\dkK.,\s$£€]/g, ' '))
  if (!match) return undefined
  const raw = match[1].replace(/,/g, '')
  let amount = Number.parseFloat(raw)
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  if (match[2]) amount *= 1000
  const currency = text.includes('£') ? 'GBP' : text.includes('€') ? 'EUR' : 'USD'
  return { amount, currency }
}

/**
 * Apply the rubric's derivation rules to the user's answers.
 *
 * When two rules produce the same spec, the stricter threshold wins — a user
 * who wants 32 GB for editing and 16 GB for development needs 32. Merging by
 * strictness rather than by last-write means the order of the rules table
 * cannot silently change the outcome.
 */
export function deriveRequirements(rubric: Rubric, answers: Record<string, string>): RequirementSpec {
  const byKey = new Map<string, Requirement>()

  const add = (r: Omit<Requirement, 'origin'>, origin: RequirementOrigin): void => {
    const key = `${r.spec}:${r.op}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...r, origin })
      return
    }
    const a = typeof existing.value === 'number' ? existing.value : null
    const b = typeof r.value === 'number' ? r.value : null
    if (a === null || b === null) return
    const stricter = r.op === '>=' ? Math.max(a, b) : r.op === '<=' ? Math.min(a, b) : a
    if (stricter !== a) byKey.set(key, { ...r, origin })
  }

  for (const r of rubric.baseline ?? []) add(r, 'rubric')
  for (const rule of rubric.derive) {
    const fires = Object.entries(rule.when).every(([id, expected]) => answers[id] === expected)
    if (!fires) continue
    for (const r of rule.requires) add(r, 'rubric')
  }

  return {
    category: rubric.category,
    requirements: [...byKey.values()],
    budgetCeiling: answers.budget ? parseBudget(answers.budget) : undefined,
    createdAt: Date.now()
  }
}

/**
 * Build a product-shaped search query from a spec — thresholds and category
 * only.
 *
 * This is where the privacy rule becomes a mechanism: the query is *assembled*
 * from structured values rather than filtered from the user's prose, so there
 * is no path by which "for editing my wedding videos" reaches a search
 * provider. What cannot be constructed cannot leak.
 */
/**
 * Fixed emission order, so the same spec always produces the same query string
 * regardless of which derivation rule happened to fire first. A stable query is
 * also a cacheable one — a reordered query is a cache miss and therefore an
 * extra request that told a search provider the same thing twice.
 */
const QUERY_SPEC_ORDER = ['ram_gb', 'storage_gb', 'gpu', 'screen_in', 'refresh_hz', 'anc', 'os']

export function productQueryFrom(spec: RequirementSpec, extraTerms: string[] = []): string {
  const parts: string[] = [spec.category]
  const ordered = [...spec.requirements].sort((a, b) => {
    const ai = QUERY_SPEC_ORDER.indexOf(a.spec)
    const bi = QUERY_SPEC_ORDER.indexOf(b.spec)
    return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi)
  })
  for (const r of ordered) {
    if (r.kind !== 'hard') continue
    switch (r.spec) {
      case 'ram_gb':
        parts.push(`${r.value}GB RAM`)
        break
      case 'storage_gb':
        parts.push(typeof r.value === 'number' && r.value >= 1000 ? `${Number(r.value) / 1000}TB` : `${r.value}GB`)
        break
      case 'screen_in':
        parts.push(`${r.value} inch`)
        break
      case 'refresh_hz':
        parts.push(`${r.value}Hz`)
        break
      case 'os':
        parts.push(String(r.value))
        break
      case 'gpu':
        parts.push('discrete GPU')
        break
      case 'anc':
        parts.push('noise cancelling')
        break
      default:
        break
    }
  }
  for (const term of extraTerms) {
    const clean = term.trim()
    if (clean && !parts.includes(clean)) parts.push(clean)
  }
  if (spec.budgetCeiling) parts.push(`under ${Math.round(spec.budgetCeiling.amount)}`)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}
