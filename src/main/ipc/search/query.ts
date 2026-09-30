import { homedir } from 'os'
import { getSettings } from '../store'

// ---- Query hygiene -----------------------------------------------------------

/**
 * Patterns that should never leave the machine inside a search query. The
 * model composes queries from conversation context, which may contain personal
 * data or secrets; redact the obvious shapes before anything is sent.
 */
const SENSITIVE_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'email address', re: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { label: 'API-key-like token', re: /\b(?:sk|pk|api|key|token|secret|bearer)[-_][A-Za-z0-9_-]{16,}\b/gi },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  { label: 'long hex secret', re: /\b[0-9a-f]{32,}\b/gi },
  // Home-rooted paths: `~/…` or a real user-data root, with at least two
  // segments below it. The segment floor is what separates `/home/colin/notes`
  // (a leak) from `/home/dashboard` (a web route someone is asking about).
  {
    label: 'home directory path',
    re: /(?<![\w.:/-])(?:~|\/(?:Users|home|Volumes|mnt|media|srv))(?:\/[\w .+-]+){2,}/g
  },
  // Classic system paths, where even one segment is meaningful (`/etc/passwd`).
  {
    label: 'system file path',
    re: /(?<![\w.:/-])\/(?:etc|var|tmp|usr|opt|root|proc|sys|dev|private)(?:\/[\w .+-]+)+/g
  },
  { label: 'Windows file path', re: /\b[A-Za-z]:\\(?:[\w .+-]+\\)*[\w .+-]+/g },
  { label: 'private IP address', re: /\b(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}\b/g },
  { label: 'credit-card-like number', re: /\b(?:\d[ -]?){13,19}\b/g }
]

/** Escape a literal string for embedding in a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The user's own home and working directories, redacted by exact match.
 *
 * This is the precise version of the path rules above: whatever shape those
 * heuristics miss, an actual local path is still caught because we know what it
 * looks like on this machine. Longest first, so the working directory is
 * replaced before the home directory it usually sits under.
 */
function localPathPatterns(): RegExp[] {
  const roots = [getSettings().workingDirectory.trim(), homedir()]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  // Windows and macOS paths are case-insensitive in practice; matching that way
  // avoids a trivially-cased miss.
  return roots.map((root) => new RegExp(escapeRegExp(root), 'gi'))
}

export function sanitizeQuery(query: string): {
  query: string
  redactions: string[]
  /** Set when the query was framing rather than terms; see minimizeQuery. */
  refusal?: string
  /** The same refusal in one clause, for the row. See minimizeQuery. */
  refusalReason?: string
} {
  const redactions = new Set<string>()
  let cleaned = query

  for (const re of localPathPatterns()) {
    cleaned = cleaned.replace(re, () => {
      redactions.add('local path')
      return '[redacted]'
    })
  }
  for (const { label, re } of SENSITIVE_PATTERNS) {
    cleaned = cleaned.replace(re, () => {
      redactions.add(label)
      return '[redacted]'
    })
  }
  // Collapse whitespace and cap length — queries are requests, not documents.
  cleaned = cleaned.replace(/\s+/g, ' ').trim().slice(0, 400)
  const minimized = minimizeQuery(cleaned)
  if (minimized.dropped) redactions.add('conversational framing')
  return {
    query: minimized.query,
    redactions: [...redactions],
    refusal: minimized.refusal,
    refusalReason: minimized.refusalReason
  }
}

// ---- Query minimization ------------------------------------------------------

/**
 * First-person framing: the part of a query that describes the *asker* rather
 * than the thing being looked up.
 */
const FIRST_PERSON = /\b(?:i|i'm|im|i've|ive|i'd|my|mine|me|myself|we|we're|our|ours|us)\b/i

/**
 * Openers that introduce a request rather than a subject. Applied repeatedly
 * from the front, longest-lived first — one giant alternation is unreadable
 * and, worse, silently stops matching when a clause is phrased slightly
 * differently.
 */
const PREAMBLES: RegExp[] = [
  /^(?:hi|hey|hello|ok(?:ay)?|so|well|actually|please)\b[\s,]*/i,
  /^(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:help\s+me\s+)?/i,
  /^(?:i|we)\s*(?:'m|'ve|'d|m|ve|am|have|was|were)?\s*(?:just|really|currently)?\s*(?:need|want|look|looking|try|trying|hop(?:e|ing)|wonder(?:ing)?|search(?:ing)?|shop(?:ping)?|would\s+like|like)\b/i,
  /^(?:to|for|if|up|out|about)\b\s*/i,
  /^(?:find|search|look\s*up|show\s+me|tell\s+me(?:\s+about)?|get\s+me|help\s+me)\b\s*/i,
  /^(?:a|an|the|some|any)\b\s+/i
]

/** Trailing clauses that attach the asker's situation to a subject. */
const TRAILING_CONTEXT =
  /\s+(?:for\s+(?:my|our|me|us)\b|because\b|since\b|so\s+(?:i|we)\b|as\s+(?:i|we)\b|before\s+(?:i|we)\b|while\s+(?:i|we)\b|when\s+(?:i|we)\b).*$/i

/**
 * v4.1 (G2a): subjects whose answer depends on where — and, for the live ones,
 * when. Only after one of these does a place or a day inside the cut personal
 * clause belong to the subject rather than to the asker.
 *
 * Measured on the 4.0.1 session: "what's the weather like for my run in
 * Richmond today" went out as "what's the weather like" — the trailing clause
 * took the city and the day with the run. The design doc's own example is the
 * other side of the same line: "headphones for my flight to Lagos" must not
 * send Lagos, because headphones are the same everywhere. So a place is kept
 * only when the subject is bound to one.
 */
const PLACE_BOUND_SUBJECT =
  /\b(?:weather|forecast|temperature|rain(?:ing)?|snow(?:ing)?|storms?|humidity|wind|air quality|pollen|sunrise|sunset|tides?|traffic|road conditions|events?|things to do|restaurants?|cafes?|bars?|hotels?|stores?|shops?|opening hours|hours|open|time zone|local time|news|games?|schedule|concerts?|shows?|gas prices?)\b/i

/** v4.1 (G2a): the live subjects among them — for these a day is part of the subject too. */
const TIME_BOUND_SUBJECT =
  /\b(?:weather|forecast|temperature|rain(?:ing)?|snow(?:ing)?|storms?|humidity|wind|air quality|pollen|sunrise|sunset|tides?|traffic|road conditions|events?|news|games?|schedule|open|hours)\b/i

/** A place phrase in the cut clause: a preposition and up to four words after it. */
const PLACE_PHRASE = /\b(in|near|around|at|to)\s+([A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*){0,3})/gi

/** The day words a live subject keeps. Months stay out: a trip's dates are the asker's. */
const DAY_PHRASE =
  /\b(?:today|tonight|tomorrow(?: (?:morning|afternoon|evening|night))?|this (?:morning|afternoon|evening|week|weekend)|right now)\b/i

/**
 * Words that end a place phrase: the asker ("my"), a day, a clause joint, or a
 * place that is only the asker's ("at home", "at work"). A place is proper
 * words, so a digit or any of these stops it.
 */
const PLACE_STOP = new Set(
  (
    'i me my mine we us our ours you your he she they them his her their ' +
    'today tonight tomorrow this next last right now morning afternoon evening night week weekend ' +
    'and or but so because since when while before after if then for with on by from of to in at ' +
    'near around is are was were will would can could should be am ' +
    'home work school office house gym job place run runs walk ride trip flight drive commute ' +
    'january february march april may june july august september october november december ' +
    'monday tuesday wednesday thursday friday saturday sunday'
  ).split(' ')
)

/**
 * v4.1 (G2a): what of a cut personal clause is the subject's, not the asker's.
 * The clause is dropped as before; its place and day come back only when the
 * subject left standing is bound to a place (and, for a day, to a time).
 */
export function subjectFromContext(head: string, clause: string): string[] {
  if (!PLACE_BOUND_SUBJECT.test(head)) return []
  const kept: string[] = []
  const phrases = new RegExp(PLACE_PHRASE.source, PLACE_PHRASE.flags)
  for (let m = phrases.exec(clause); m; m = phrases.exec(clause)) {
    // Resume just past the preposition: "in May to Rome" stops at "May", and
    // the "to Rome" inside the same match is a phrase of its own.
    phrases.lastIndex = m.index + m[1].length
    const words: string[] = []
    for (const w of m[2].split(/\s+/)) {
      const bare = w.replace(/[^\w'-]/g, '').toLowerCase()
      if (!bare || PLACE_STOP.has(bare) || /^\d/.test(bare)) break
      words.push(w.replace(/[.,;:!?]+$/, ''))
    }
    // "at the office" stops at "office" and leaves only the article.
    while (words.length > 0 && /^(?:the|a|an)$/i.test(words[words.length - 1])) words.pop()
    if (words.length === 0) continue
    // "to Tokyo" is a destination; the provider wants the place, not the trip.
    const phrase = m[1].toLowerCase() === 'to' ? words.join(' ') : `${m[1].toLowerCase()} ${words.join(' ')}`
    if (!head.toLowerCase().includes(words.join(' ').toLowerCase()) && !kept.includes(phrase)) kept.push(phrase)
  }
  if (TIME_BOUND_SUBJECT.test(head)) {
    const day = DAY_PHRASE.exec(clause)?.[0]
    if (day && !head.toLowerCase().includes(day.toLowerCase())) kept.push(day.toLowerCase())
  }
  return kept
}

/** Above this, a query has stopped being search terms and become a paragraph. */
const MAX_QUERY_WORDS = 16

/**
 * Words that cannot be the subject of a search on their own: question frames,
 * determiners, auxiliaries, prepositions, and the generic nouns and adjectives
 * a request is built out of. Nothing here is a thing anyone looks up.
 *
 * Only ever consulted about a query stripping has already shortened — an
 * untouched query is the model's own phrasing and is left alone.
 */
const GENERIC_TERMS = new Set(
  (
    'what which who whom whose where when why how ' +
    'a an the this that these those some any each every no ' +
    'is are was were be been being am do does did done ' +
    'can could will would shall should may might must have has had ' +
    'to of in on at by for from with about into onto over under as and or but than then ' +
    'there here it its out up off near around between ' +
    'way ways thing things stuff option options choice choices idea ideas tip tips advice ' +
    'best better good great top nice cheap cheapest easy easiest fast fastest quick quickest ' +
    'most more less least much many very really just ' +
    'get getting go going make making take taking use using find finding ' +
    'need needs want help please ok okay info information detail details recommendation ' +
    'recommendations suggestion suggestions'
  ).split(' ')
)

/** True when every word left is scaffolding — there is no subject to look up. */
function hasNoSubject(text: string): boolean {
  const words = wordsOf(text).map((w) => w.replace(/[^\w'-]/g, '').toLowerCase()).filter(Boolean)
  return words.length === 0 || words.every((w) => GENERIC_TERMS.has(w))
}

export interface MinimizedQuery {
  query: string
  /** True when framing was stripped, for the redaction note. */
  dropped: boolean
  /**
   * Set when the query is not salvageable as search terms. The caller refuses
   * the search and hands this back to the model to try again.
   */
  refusal?: string
  /**
   * The same refusal in one clause, for the collapsed tool row.
   *
   * `refusal` is written for the model — it has to say what a good query looks
   * like and give an example, which is a paragraph. Nothing was contacted, so
   * there is no provider error the row can quote instead: if the guard does not
   * state its objection briefly, the row has nothing to say. Set with `refusal`
   * and never without it.
   */
  refusalReason?: string
}

const wordsOf = (text: string): string[] => text.split(/\s+/).filter(Boolean)

/**
 * Reduce a search query to its subject, or refuse it.
 *
 * `sanitizeQuery` removes what is *secret*. This removes what is merely nobody
 * else's business: that the person asking is planning a business trip, shopping
 * for themselves, or in a hurry. A provider needs the subject terms to answer;
 * the rest is disclosure with nothing bought by it.
 *
 * Two mechanisms, because one is not enough:
 *
 * 1. **Strip** leading request framing and trailing personal context. This
 *    handles the common, recoverable case ("i'm looking for organic cotton
 *    thongs" → "organic cotton thongs") without bouncing anything.
 * 2. **Refuse** what is still a paragraph about the asker. DESIGN-private-
 *    shopping §2b specifies exactly this — *"enforced in code by rejecting
 *    queries over N tokens that contain first-person pronouns, not by asking
 *    the model nicely"* — and asking nicely is measurably insufficient: in a
 *    v1.3 session a model sent *"I have a business meeting coming up in Japan.
 *    I need to buy 2 new business suits and book flights and hotel in Tokyo
 *    for Aug 28 - September 12…"* verbatim as a query, under a schema that
 *    says to send terms only.
 *
 * Refusing beats truncating. Cutting that example at sixteen words yields
 * "I have a business meeting coming up in Japan. I need to buy 2 new business"
 * — which has leaked the trip *and* searches for nothing. A refusal costs one
 * round trip and gets a query that works.
 */
export function minimizeQuery(query: string): MinimizedQuery {
  const original = query.trim()
  if (!original) return { query: original, dropped: false }

  let working = original
  if (FIRST_PERSON.test(working) || /^(?:can|could|would|will|find|search|look|show|tell)\b/i.test(working)) {
    // Peel the front until nothing matches: "so i'm trying to find a …" needs
    // several passes, and each pattern is individually conservative.
    for (let pass = 0; pass < PREAMBLES.length * 2; pass++) {
      const before = working
      for (const re of PREAMBLES) working = working.replace(re, '')
      working = working.replace(/^[\s,.;:—-]+/, '')
      if (working === before) break
    }
    // v4.1 (G2a): the cut clause may hold the subject's place and day; see
    // `subjectFromContext`.
    const cut = TRAILING_CONTEXT.exec(working)
    if (cut) {
      const head = working.slice(0, cut.index).trim()
      working = [head, ...subjectFromContext(head, cut[0])].join(' ').trim()
    }
  }

  // Stripping must never produce an empty or gutted query; fall back whole.
  if (wordsOf(working).length === 0) working = original

  // v1.9.2: the subject can be *inside* the framing, in which case stripping
  // takes it with it. "What is the best way for me to get from Miami to San
  // Diego?" loses everything from "for me" onward and goes out as "What is the
  // best way" — which leaks nothing and searches for nothing: measured, it
  // returned eight results about public transport in Vienna, and the model
  // answered over the top of them.
  //
  // That is the same failure the length rule above exists to prevent, reached
  // by the other route, so it gets the same answer. Refusing costs one round
  // trip and gets a query that works; sending scaffolding costs a search slot
  // and furnishes the model with noise it will treat as evidence.
  if (working !== original && hasNoSubject(working)) {
    return {
      query: working,
      dropped: true,
      refusalReason: 'removing the personal framing left no subject to look up',
      refusal:
        'Removing the personal framing from that query left nothing to look up — the subject ' +
        'was inside it. Nothing was sent. Call the tool again with the subject as terms (for ' +
        'example "Miami to San Diego travel options" rather than "what is the best way for me ' +
        'to get from Miami to San Diego"). Split separate subjects into separate searches.'
    }
  }

  const words = wordsOf(working)
  const stillPersonal = FIRST_PERSON.test(working)
  const multiSentence = /[.!?]\s+\S/.test(working)

  if (stillPersonal && (words.length > MAX_QUERY_WORDS || multiSentence)) {
    return {
      query: working,
      dropped: working !== original,
      refusalReason: 'the query was a sentence about you, not search terms',
      refusal:
        'That query is a sentence about you, not search terms, so it was not sent. ' +
        'Search providers get the subject only — no first-person framing, no plans, no dates ' +
        'or places that are not part of what you are looking up. Call the tool again with ' +
        'just the terms (for example "grand sumo tournament September 2026 schedule" rather ' +
        'than a description of your trip). Split separate subjects into separate searches.'
    }
  }

  if (words.length > MAX_QUERY_WORDS) {
    working = words.slice(0, MAX_QUERY_WORDS).join(' ')
  }

  return { query: working, dropped: working !== original }
}
