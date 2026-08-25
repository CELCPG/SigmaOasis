/**
 * The boundary between what the app knows and what it says.
 *
 * Four rounds of blind critics have found the same thing on screen: a runtime
 * identifier printed where a sentence belongs. Every one of these is verbatim
 * from a recorded run of a build that WON its task.
 *
 * | on screen | where |
 * | --- | --- |
 * | `✗ 🔍 web_search — net::ERR_UNSAFE_PORT` | the collapsed tool row, twice in one turn, and again as the whole `Result` body |
 * | `🧮 Recompute skipped — BodyStreamBuffer was aborted` | the verification line under a reply |
 * | `signal is aborted without reason` | the entire content of an interrupted plan step |
 * | `⚠️ Trying to keep the first 12000 tokens when context the overflows.` | an assistant bubble — and that clause is LM Studio's, relayed verbatim, its garbled word order reading as our bug |
 *
 * A critic on the first: *"an internal error identifier shown to a user who has
 * no way to interpret 'unsafe port'."* A reader needs what happened and what
 * they can do. `ERR_UNSAFE_PORT` is neither.
 *
 * Round 3 already inverted the *logic* around these codes — the app stopped
 * enumerating which `net::` codes mean "unreachable" and started listing the
 * few that mean "a server answered", because a list of known-bad is defeated by
 * an unknown and a list of known-good can only be defeated by something that
 * genuinely answered. That rule lives here now (`searchUnreachable`). Nothing
 * ever stopped *printing* the codes; this module is that half.
 *
 * ## Three rules, because a translation layer can lie
 *
 * A mapping that turns an unfamiliar failure into a confident wrong sentence is
 * worse than the raw code — the reader cannot even search for it. So:
 *
 * 1. **The safe list is of prose, not of identifiers.** `readsAsProse` says
 *    what may be printed as the app's own words. It cannot be defeated by a
 *    code Chromium invents next release, only by something that genuinely reads
 *    as a sentence. Everything else is translated.
 * 2. **Aborts are recognised by type, never by message.** `signal is aborted
 *    without reason` and `BodyStreamBuffer was aborted` are the same
 *    `DOMException` under two engines' wording; matching either message is the
 *    enumeration mistake in miniature. `name === 'AbortError'` is the class.
 * 3. **An unrecognised failure gets an honest sentence, not a guess.** It says
 *    the attempt did not finish and that the app cannot say why — and it keeps
 *    the runtime's exact words as evidence rather than paraphrasing them.
 *
 * ## The identifier does not vanish
 *
 * Someone debugging needs it. It survives in three places, and each is a
 * different reader:
 *
 * - **The text handed to the model** (`ToolCallRecord.result`) is untouched, so
 *   the tool loop still reasons over the real error — and because that string is
 *   what `providerIO` writes to the hash-chained audit log, the log keeps it too.
 * - **The disclosure** carries it under an attribution line naming who said it,
 *   so a reader can tell the app's words from the network stack's or a server's.
 * - **A copy affordance** on that disclosure yields sentence + verbatim text,
 *   which is what a person pastes into a bug report.
 *
 * Pure data and string work, in `shared/` because both processes classify and
 * the node:test suite loads it outside Electron.
 */

// ---- Reachability ----------------------------------------------------------
// Moved here from renderer/lib/claimCheck.ts in v1.17.2, unchanged. It was
// already half of this boundary — it classifies a transport failure — and it
// only lacked a voice. claimCheck re-exports it so its call sites and tests
// read from one place.

/**
 * v1.12.3: a check that cannot succeed must not be run.
 *
 * Measured: with the search provider pointed at a dead port, the claim-check
 * pass still extracted five claims, ran five searches that all failed the same
 * way, and held the finished answer for half a minute to end on five
 * UNVERIFIABLEs. The verdict was decided before the first token.
 *
 * Transport failures only. A provider that answered — HTTP 403, no results, a
 * query the sanitizer refused — is reachable, and the next claim may well fare
 * differently; a refused connection will not.
 */
const UNREACHABLE_PATTERNS = [
  // Kept for codes that reach us stripped of their `net::` prefix; the rule
  // below covers the prefixed form, including codes nobody has listed here.
  /\bERR_(?:CONNECTION|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK_CHANGED|PROXY_CONNECTION_FAILED|SOCKET_NOT_CONNECTED|UNSAFE_PORT)/i,
  /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN)\b/,
  /\bfetch failed\b/i,
  /\brequest timed out after\b/i,
  /\bconnection was closed before the response completed\b/i,
  /\bnothing is\s+listening there\b/i,
  /\bno searxng url configured\b/i,
  /\bno brave search api key set\b/i,
  /\begress policy\b/i
]

/**
 * v1.12.4: the Chromium half of the question, asked the other way round.
 *
 * v1.12.3 listed the `net::ERR_*` codes it had seen — CONNECTION, NAME_NOT_
 * RESOLVED, PROXY_CONNECTION_FAILED — and the code that was actually arriving
 * was not among them. Pointed at `http://127.0.0.1:9`, Chromium refuses the
 * port before it opens a socket (`ERR_UNSAFE_PORT`), so the pass ran a search
 * per claim, each refused in microseconds, and still held the answer. An
 * enumeration is how that mistake gets made twice; the rule below cannot make
 * it, because it does not depend on having seen the code before.
 *
 * Chromium reaches for a `net::` code only when the request did not complete,
 * so the question is which of them nonetheless mean a server answered and the
 * *response* was the problem. Those are nameable and few, and every one of
 * them is per-request — the next claim may fetch a page that decodes. Anything
 * else never reached a provider, and never will this turn.
 */
const RESPONSE_ARRIVED =
  /\bERR_(?:CONTENT_(?:DECODING(?:_INIT)?_FAILED|LENGTH_MISMATCH)|IN(?:COMPLETE|VALID)_CHUNKED_ENCODING|INVALID_HTTP_RESPONSE|RESPONSE_HEADERS_(?:TOO_BIG|MULTIPLE_CONTENT_LENGTH)|TOO_MANY_REDIRECTS|UNSAFE_REDIRECT|EMPTY_RESPONSE)\b/i

/** A Chromium transport code, however it was wrapped on the way here. */
const NET_ERROR = /\bnet::ERR_[A-Z0-9_]+/i

/** Did this search fail because nothing answered, rather than because of what it answered? */
export function searchUnreachable(error: string): boolean {
  if (NET_ERROR.test(error)) return !RESPONSE_ARRIVED.test(error)
  return UNREACHABLE_PATTERNS.some((re) => re.test(error))
}

// ---- What may be printed as the app's own words ----------------------------

/**
 * A token written for a program rather than a person, matched by SHAPE.
 *
 * `net::ERR_UNSAFE_PORT` matches because of `::` and because of the screaming
 * snake run — not because either name is on a list. A code no one has seen has
 * the same shape as one everyone has, which is the entire point: the round-3
 * lesson says an enumeration of names is defeated by the next release, and a
 * shape is not.
 *
 * Four arms, each a convention rather than a vocabulary:
 *
 * - a `::`-qualified token — Chromium's namespacing;
 * - a SCREAMING_SNAKE run — every error-constant convention there is;
 * - a bare errno of six letters or more (`ENOTFOUND`, `ENOENT`), the length
 *   floor keeping ordinary shouted English (`ERROR`) out;
 * - a multi-hump CamelCase name followed by a colon — how every language on
 *   this stack stringifies an exception (`TypeError: …`, `DOMException: …`).
 *   One hump is left alone, because the app writes `Refused: …` itself.
 * - a hex literal of four digits or more — `0x8007007e` is nobody's prose.
 */
const MACHINE_TOKEN =
  /[a-z][a-z0-9]*::[A-Za-z0-9_]+|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\bE[A-Z]{5,}\b|\b[A-Z][a-z]+(?:[A-Z][a-z]+)+:|\b0x[0-9a-fA-F]{4,}\b/

/**
 * May this text stand as the app's own sentence?
 *
 * The list is of what is SAFE to print, not of what is unsafe — round 3's
 * inversion, applied to speech instead of logic. A rejection costs the reader
 * an admission and a quoted line they can still read; an acceptance of the
 * wrong thing costs them `net::ERR_UNSAFE_PORT` with no way to interpret it.
 * The asymmetry says which way to lean, so this leans strict.
 */
export function readsAsProse(text: string): boolean {
  const t = text.trim()
  if (t.length === 0) return false
  if (!/^[A-Z“"(]/.test(t)) return false // a sentence starts like one
  if (!/\s/.test(t)) return false // one token is a token, not a sentence
  return !MACHINE_TOKEN.test(t)
}

// ---- The reader-facing shape -----------------------------------------------

/** Where a remedy control sends the reader. Mirrors SettingsModal's `Tab`. */
export type SettingsTarget = 'connection' | 'models' | 'search' | 'tools'

/** A control that performs the remedy, rather than describing it in prose. */
export interface RemedyControl {
  label: string
  tab: SettingsTarget
}

export interface FailureRemedy {
  /** The remedy in words. Stands alone wherever no control can be rendered. */
  text: string
  /**
   * The control that does it. A critic's only complaint about the app's best
   * failure sentence was that its remedy is prose rather than a control, so
   * where the app can name the exact place, it offers the place.
   */
  control?: RemedyControl
}

/** The runtime's own words, attributed so a reader can tell whose they are. */
export interface FailureDetail {
  /** Who wrote `text` — "the network layer", "LM Studio", "the runtime". */
  source: string
  /** Verbatim. Never paraphrased, never dropped: it is evidence. */
  text: string
}

export interface Failure {
  /**
   * A clause for a collapsed row — no subject, capped, and safe to read at a
   * glance. This is what sits after the `—` beside a tool glyph.
   */
  headline: string
  /** A whole sentence for a disclosure, a step body or a bubble. */
  sentence: string
  remedy: FailureRemedy | null
  /**
   * The raw text, whenever the sentence above is not itself that text. Null in
   * exactly one case — the app wrote the sentence and there is nothing else to
   * keep. The invariant is total: translating never loses the original.
   */
  detail: FailureDetail | null
  /**
   * False when the app could not place this failure. The sentence is then the
   * honest minimum and `detail` is the only real information there is.
   */
  recognised: boolean
}

/** What the call site knows and this module cannot work out for itself. */
export interface FailureContext {
  /** The noun phrase the sentence is about: "The search", "This step". */
  subject?: string
  /**
   * Who wrote the raw text, when it was not this app. Supplying it is what
   * makes a relayed message read as theirs — see the LM Studio case below.
   */
  source?: string
  /** Where an unreachable provider is repointed, when such a place exists. */
  settings?: RemedyControl
}

/** A collapsed row is a glance. Past this it stops being one. */
export const ROW_CHARS = 72

const DEFAULT_SUBJECT = 'The call'

function clause(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > ROW_CHARS ? `${t.slice(0, ROW_CHARS - 1).trimEnd()}…` : t
}

/** The first sentence of app prose, capped — what the row shows of it. */
function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  const stop = t.search(/[.!?](?:\s|$)/)
  return clause(stop > 0 ? t.slice(0, stop + 1) : t)
}

/** The message carried by a thrown value, whatever kind of value it is. */
function messageOf(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw instanceof Error) return raw.message
  if (raw && typeof raw === 'object' && 'message' in raw) {
    const m = (raw as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  return String(raw)
}

/**
 * Rule 2, in code: an abort is recognised by its type tag.
 *
 * `AbortError` is fixed by the DOM standard; the *message* beside it is not.
 * Both strings this round set out to remove — `signal is aborted without
 * reason` and `BodyStreamBuffer was aborted` — are this one exception under two
 * engines. Matching either message would be the enumeration mistake again, one
 * layer down.
 */
function wasAborted(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  return (raw as { name?: unknown }).name === 'AbortError'
}

/**
 * A failure that has already crossed the boundary once.
 *
 * The transport reads LM Studio's error frame, where it knows the author; the
 * turn that catches the throw does not. Without this, the second reading would
 * translate the first one's output — and a sentence quoting a server would be
 * re-classified on the shape of the quote. A translation of a translation is
 * how a layer starts lying, so the reading travels with the error instead.
 */
export class ExplainedError extends Error {
  readonly failure: Failure
  constructor(failure: Failure) {
    super(composeFailure(failure))
    this.name = 'ExplainedError'
    this.failure = failure
  }
}

function alreadyExplained(raw: unknown): Failure | null {
  if (!raw || typeof raw !== 'object') return null
  const carried = (raw as { failure?: unknown }).failure
  if (!carried || typeof carried !== 'object') return null
  const f = carried as Partial<Failure>
  return typeof f.sentence === 'string' && typeof f.headline === 'string' ? (carried as Failure) : null
}

/**
 * Turn a runtime failure into something a reader can act on, keeping the
 * runtime's own words as attributed evidence beside it.
 */
export function explainFailure(raw: unknown, context: FailureContext = {}): Failure {
  const carried = alreadyExplained(raw)
  if (carried) return carried
  const subject = context.subject ?? DEFAULT_SUBJECT
  const text = messageOf(raw).trim()

  // A message the call site knows came from somewhere else is never printed as
  // ours, however well it reads. LM Studio's own "Trying to keep the first
  // 12000 tokens when context the overflows." parses as a fine English
  // sentence and shipped for a round as if the app had written it, garbled
  // word order and all.
  if (context.source) return relayed(subject, context, text)

  if (wasAborted(raw)) {
    return {
      headline: 'stopped before it finished',
      sentence: `${subject} was stopped before it finished.`,
      remedy: null,
      // Kept, even though the wording adds almost nothing to the sentence.
      // "Almost nothing" is a judgement call made per class, and a rule with a
      // judgement call in it is a rule that gets it wrong somewhere: the raw
      // text survives in EVERY class the module translates, without exception,
      // so there is no case to argue and no case to forget.
      detail: { source: 'the runtime', text },
      recognised: true
    }
  }

  // The app writes its own errors as prose, and those sentences are better than
  // anything this module could substitute for them — "No SearXNG URL configured
  // — set it under Settings → Search." already names a cause and a remedy.
  if (readsAsProse(text)) {
    return {
      headline: firstSentence(text),
      sentence: text,
      remedy: null,
      detail: null,
      recognised: true
    }
  }

  if (NET_ERROR.test(text) || UNREACHABLE_PATTERNS.some((re) => re.test(text))) {
    return searchUnreachable(text)
      ? unreachable(subject, context, text)
      : {
          headline: 'the provider answered, but the reply could not be read',
          sentence: `${subject} reached the provider, but the reply could not be read.`,
          remedy: { text: 'Ask again — the next request may read cleanly.' },
          detail: { source: 'the network layer', text },
          recognised: true
        }
  }

  // Rule 3. Everything left is a failure the app has never placed. It gets the
  // one thing that is true of all of them, and the exact words it arrived in.
  return {
    headline: 'failed for a reason the app cannot put in plain words',
    sentence:
      `${subject} did not finish, and the app cannot say why in plain words. ` +
      'The reason it was given is kept below word for word, rather than guessed at.',
    remedy: null,
    detail: { source: 'the runtime', text },
    recognised: false
  }
}

function unreachable(subject: string, context: FailureContext, text: string): Failure {
  const control = context.settings
  return {
    headline: 'nothing answered at that address',
    sentence: `${subject} could not reach the provider — nothing answered at that address.`,
    remedy: control
      ? { text: `Point ${control.label} at a working provider and try again.`, control }
      : { text: 'Check that the provider is running, then try again.' },
    detail: { source: 'the network layer', text },
    recognised: true
  }
}

/**
 * A message another program wrote about our request.
 *
 * Our sentence leads and theirs is quoted as theirs, so a reader can tell whose
 * words are whose. Theirs is never dropped: it is evidence, and on the recorded
 * LM Studio case it is the only thing that names a number.
 */
function relayed(subject: string, context: FailureContext, text: string): Failure {
  const source = context.source ?? 'the server'
  const detail: FailureDetail = { source, text }

  // The one shape the app has learned to read. Note what is claimed and what is
  // not: that the server named the context length is a fact about their text;
  // the second sentence is the app's reading of it, and the reader can now
  // check that reading against the quote.
  if (/context/i.test(text)) {
    return {
      headline: 'the conversation is larger than the model’s loaded context',
      sentence:
        `${subject} was refused by ${source}, which named the context length. ` +
        'This conversation — with its attachments and notes — is larger than the context ' +
        'the model is loaded with.',
      remedy: {
        text: 'Load the model with a larger context in LM Studio, or attach less.',
        ...(context.settings ? { control: context.settings } : {})
      },
      detail,
      recognised: true
    }
  }

  return {
    headline: `${source} refused it, for a reason the app cannot read`,
    sentence: `${subject} was refused by ${source}, which gave a reason the app cannot interpret.`,
    remedy: null,
    detail,
    recognised: false
  }
}

/**
 * The whole thing as one string, for surfaces that have no room for structure —
 * a plan step's body, an error bubble, a line in an export.
 *
 * The order is the argument: what happened, what to do, and only then whose
 * words the evidence is.
 */
export function composeFailure(failure: Failure): string {
  const parts = [failure.sentence]
  if (failure.remedy) parts.push(failure.remedy.text)
  if (failure.detail) parts.push(`${attribution(failure.detail)}\n“${failure.detail.text}”`)
  return parts.join('\n\n')
}

/** "The network layer reported:" — a line, so it starts like one. */
function attribution(detail: FailureDetail): string {
  return `${detail.source.charAt(0).toUpperCase()}${detail.source.slice(1)} reported:`
}

/**
 * What a person pastes into a bug report: the reading and the raw text, so the
 * identifier the app refused to print at them is still one keystroke away.
 */
export function copyableFailure(failure: Failure, subject?: string): string {
  const head = subject ? `${subject}\n` : ''
  return failure.detail
    ? `${head}${failure.sentence}\n\n${attribution(failure.detail)}\n${failure.detail.text}`
    : `${head}${failure.sentence}`
}
