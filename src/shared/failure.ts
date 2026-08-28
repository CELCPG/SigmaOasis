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
 * ## v1.17.3: the same boundary, asked *who*
 *
 * Round 9's critics found the module printing true sentences about the wrong
 * party. Two more strings, from two more winning builds:
 *
 * | on screen | what had actually happened |
 * | --- | --- |
 * | `⚠️ Empty reply — nothing came back from the model.` | the server took the POST and wrote nothing for 90 s, and the user pressed Stop |
 * | `This conversation … is larger than the context the model is loaded with.` | LM Studio said "context"; the app's own meter, six inches below, read `~1.7K / 8.2K` |
 *
 * A critic on the first: *"the post-stop message then blames the model for what
 * the fixture record shows was a transport stall"* — and *"it says neither 'the
 * server stopped responding' nor 'you stopped it'"*. On the second: *"the one
 * control that is offered would replay the same oversized conversation into the
 * same 8192-token window."*
 *
 * Neither is a machine identifier, so rules 1–3 had nothing to say about them.
 * They are the same species one level up: **the app stating as its own finding
 * something it had not established.** So a fourth rule:
 *
 * 4. **Name a party only from evidence, and quote the arithmetic.** Who fell
 *    silent is decided from what the transport recorded (`explainEmptyReply`
 *    over `TurnEnding`), never from which sentence is shortest to write. A
 *    server's claim about our request is checked against our own count
 *    (`RequestEstimate`) and reported as agreeing or disagreeing — never
 *    repeated as ours, and never with a remedy naming a term that is not the
 *    large one.
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

/**
 * The app's own arithmetic about what a turn in this conversation costs.
 *
 * v1.17.3. A server that refuses a request "for context" is making a claim the
 * app can check, and until now did not: it repeated the claim as its own
 * ("This conversation … is larger than the context the model is loaded with")
 * while the meter under the composer, reading the same conversation, said
 * `~1.7K / 8.2K`. One number came from a relayed sentence and the other from
 * arithmetic, and the app printed both without noticing they disagreed.
 *
 * This is that arithmetic, handed in so the sentence can quote it. It is the
 * SAME figure the composer's meter draws — one function, one number, three
 * readers (the meter, this sentence, and the gate on Regenerate) — because two
 * spellings of "how full is the window" is how the contradiction happened.
 */
export interface RequestEstimate {
  /** Estimated tokens a turn here costs: history, prompt, tools, reply reserve. */
  total: number
  /** The context length the app was told the model is loaded with. */
  window: number
  /**
   * The largest single term, named for a reader who has to shrink something.
   * "attach less" is only advice when attachments are what is large.
   */
  largest: { label: string; tokens: number; control?: RemedyControl }
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
  /** The app's own measurement, for a refusal that names the context length. */
  request?: RequestEstimate
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
  /**
   * The text this reading was made from, and what was known when it was made.
   *
   * v1.17.3. The transport reads LM Studio's error frame the moment it arrives,
   * which is before the turn's own arithmetic is anywhere in scope — so the one
   * reading that most needs a number ("is this request actually too big?") was
   * always made without one. Keeping the ingredients lets a call site that
   * knows more ask for the reading again, ONCE, from the same raw text.
   *
   * Note what this is not: it is not a licence to re-read the sentence above.
   * `composeFailure`'s output never comes back through here — only `raw` does —
   * so the "translation of a translation" this class exists to prevent stays
   * prevented.
   */
  readonly origin?: { raw: string; context: FailureContext }
  constructor(failure: Failure, origin?: { raw: string; context: FailureContext }) {
    super(composeFailure(failure))
    this.name = 'ExplainedError'
    this.failure = failure
    if (origin) this.origin = origin
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
 * May this carried reading be made again? Only in one direction.
 *
 * The caller now has the app's own measurement and the first reading did not.
 * Anything else — a different subject, a different source, no new facts — keeps
 * the reading that travelled, because re-reading for cosmetic reasons is how a
 * layer starts lying.
 */
function worthReReading(origin: ExplainedError['origin'], context: FailureContext): boolean {
  return origin !== undefined && context.request !== undefined && origin.context.request === undefined
}

/**
 * Turn a runtime failure into something a reader can act on, keeping the
 * runtime's own words as attributed evidence beside it.
 */
export function explainFailure(raw: unknown, context: FailureContext = {}): Failure {
  const carried = alreadyExplained(raw)
  if (carried) {
    const origin = (raw as ExplainedError).origin
    if (worthReReading(origin, context)) {
      // The same raw text, once, with the fact the first reading lacked — and
      // ONLY that fact. The caller's subject and source are deliberately not
      // merged: the first reading knew who wrote the text and what the request
      // was, and letting an outer layer overwrite either is how a relayed
      // message quietly becomes ours.
      return explainFailure(origin!.raw, { ...origin!.context, request: context.request })
    }
    return carried
  }
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
  if (/context/i.test(text)) return overContext(subject, source, detail, context.request)

  return {
    headline: `${source} refused it, for a reason the app cannot read`,
    sentence: `${subject} was refused by ${source}, which gave a reason the app cannot interpret.`,
    remedy: null,
    detail,
    recognised: false
  }
}

/** `8192` → `8.2K`. Mirrors renderer/lib/modelInfo.ts, which shared/ cannot import. */
export function approxTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k >= 10 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}K`
}

/**
 * A refusal that names the context length — and what the app's own arithmetic
 * says about it.
 *
 * Round 9's critics caught this sentence twice over: once for offering a remedy
 * with no control behind either half of it ("Load the model with a larger
 * context in LM Studio, or attach less"), and once for contradicting the meter
 * six inches below it. Both are the same defect — the app repeating a server's
 * claim as its own finding.
 *
 * So the claim is split from the evidence:
 *
 * - **Theirs, always:** the server refused it and named the context length.
 *   That is a fact about their text and the quote is right there.
 * - **Ours, only with a number behind it:** whether the app's own budget for a
 *   turn here agrees. With no measurement it says it cannot check, which is
 *   worse reading and better information than a confident guess.
 * - **The remedy names the term that is actually large.** "Attach less" is
 *   advice only when attachments are the largest thing in the request; on the
 *   measured case the largest thing was the tool schemas the APP adds, and
 *   telling the reader to attach less would have sent them to shrink a fifth
 *   of the problem.
 *
 * The control rides on `largest`, so it is offered exactly where the app has
 * proved which term to shrink — round 8's ClaimCheckBlock rule, applied to a
 * different failure.
 */
function overContext(
  subject: string,
  source: string,
  detail: FailureDetail,
  estimate: RequestEstimate | undefined
): Failure {
  if (!estimate) {
    return {
      headline: 'the server refused it, naming the context length',
      sentence:
        `${subject} was refused by ${source}, which named the context length. ` +
        'The app has no measurement of this request to check that against, so it cannot say ' +
        'what is too large.',
      remedy: { text: 'Load the model with a larger context in LM Studio, or send less in one turn.' },
      detail,
      recognised: true
    }
  }

  const { total, window, largest } = estimate
  const budget = `about ${approxTokens(total)} tokens against a ${approxTokens(window)} window`
  const biggest = `${largest.label}, at about ${approxTokens(largest.tokens)} tokens`
  const control = largest.control ? { control: largest.control } : {}

  // The app's own count says it does not fit either. Now — and only now — the
  // app is stating a finding rather than echoing one.
  if (total > window) {
    return {
      headline: 'too large for the window, by the app’s own count too',
      sentence:
        `${subject} was refused by ${source}, which named the context length, and the app's own ` +
        `count agrees: a turn in this conversation costs ${budget}. The largest part of it is ` +
        `${biggest}.`,
      remedy: {
        text: `Reduce ${largest.label}, or load the model with a larger context in LM Studio.`,
        ...control
      },
      detail,
      recognised: true
    }
  }

  // They disagree. Saying which one is right would be a guess, and the app has
  // been wrong in this exact spot before by guessing; saying that they disagree
  // is checkable — the same figure is under the composer.
  return {
    headline: 'the server refused it for context; the app’s own count disagrees',
    sentence:
      `${subject} was refused by ${source}, which named the context length — but the app's own ` +
      `count does not agree: a turn in this conversation costs ${budget}. One of the two is ` +
      "wrong. The app's count is estimated from text length rather than tokenized, and a model " +
      'can be loaded with less context than it reports.',
    remedy: {
      text: `Ask again; if it is refused again, reduce ${largest.label} — the largest part of the request, at about ${approxTokens(largest.tokens)} tokens — or load the model with a larger context in LM Studio.`,
      ...control
    },
    detail,
    recognised: true
  }
}

// ---- A turn that ended with nothing on screen ------------------------------

/**
 * What the transport saw of a turn that produced no text.
 *
 * Round 9, on a server that accepted the POST and then wrote nothing for 90
 * seconds until the user pressed Stop: *"the post-stop message then blames the
 * model for what the fixture record shows was a transport stall"*, and *"it
 * says neither 'the server stopped responding' nor 'you stopped it'"*. One
 * sentence — `⚠️ Empty reply — nothing came back from the model.` — was
 * standing in for three different events, and it named the wrong party in two
 * of them.
 *
 * The app had every fact needed to tell them apart and threw all of them away
 * at the bubble. They are four booleans and a clock:
 */
export interface TurnEnding {
  /** The POST was answered: response headers arrived. The server is there. */
  accepted: boolean
  /** At least one byte of the response body arrived. A reply had started. */
  streamed: boolean
  /** At least one token of answer or reasoning arrived. The model spoke. */
  produced: boolean
  /** The user pressed Stop. */
  stoppedByUser: boolean
  /** How long the connection had been silent when the turn ended. */
  silentMs: number
}

/** "90s", "2s" — the wait as the person watching it counted it. */
function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`
}

/**
 * Who fell silent, and what the reader can do about it.
 *
 * Three events used to land on one sentence that named the model:
 *
 * | what happened | who is named now |
 * | --- | --- |
 * | the stream ran to its end and carried no text | the model |
 * | the server answered the POST and closed without writing | the server |
 * | the user pressed Stop | the user, with what the server had done by then |
 *
 * The true negative matters as much as the positives: a model that genuinely
 * replies with nothing must still be told it replied with nothing. The
 * distinguishing fact is `streamed` — a body that arrived and carried no text
 * is the model's silence; a body that never arrived is the server's.
 *
 * No control is offered on any of these, and that is the finding rather than an
 * omission. Round 8's rule is that a control is rendered where the app has
 * PROVED the remedy is right; here the app has proved the opposite — the server
 * accepted the request, so the address in Settings → Connection is correct, and
 * sending the reader there would be sending them to fix a working setting. The
 * remedy that is real (reload the model) lives in another application.
 */
export function explainEmptyReply(ending: TurnEnding): Failure {
  const { accepted, streamed, produced, stoppedByUser, silentMs } = ending
  const waited = seconds(silentMs)

  if (stoppedByUser) {
    if (produced) {
      return {
        headline: 'stopped by you',
        sentence: 'You stopped this turn. What had arrived by then is above.',
        remedy: null,
        detail: null,
        recognised: true
      }
    }
    if (!accepted) {
      return {
        headline: 'stopped by you, before the server answered',
        sentence: `You stopped this turn ${waited} in, before LM Studio had answered the request at all.`,
        remedy: { text: 'Ask again — nothing was generated, so nothing was lost.' },
        detail: null,
        recognised: true
      }
    }
    if (!streamed) {
      // The measured case. Both halves are said, in the order they happened:
      // the server's silence is why the user was waiting, and the user's Stop
      // is why the turn ended.
      return {
        headline: `stopped by you, after ${waited} of silence`,
        sentence:
          `You stopped this turn. LM Studio had accepted the request and then sent nothing at ` +
          `all for ${waited} — the reply never started, so the model had produced nothing to stop.`,
        remedy: {
          text: 'Ask again. The address is right — the server took the request — so check that the model is still loaded in LM Studio.'
        },
        detail: null,
        recognised: true
      }
    }
    return {
      headline: `stopped by you, after ${waited} of silence`,
      sentence: `You stopped this turn. LM Studio had started replying and then went quiet for ${waited}; none of what arrived was answer text.`,
      remedy: { text: 'Ask again — the reply that had started carried no text.' },
      detail: null,
      recognised: true
    }
  }

  if (!accepted) {
    // No throw, no answer, no Stop: the app cannot place this, and rule 3 says
    // what to do about that.
    return {
      headline: 'ended without an answer, for a reason the app cannot name',
      sentence:
        'This turn ended without LM Studio answering the request, and the app cannot say why. ' +
        'Nothing was stopped and nothing failed loudly enough to be reported.',
      remedy: { text: 'Ask again.' },
      detail: null,
      recognised: false
    }
  }

  if (!streamed) {
    // The reviewer's empty 200, and the shape of every proxy that answers and
    // hangs up. The server is the subject, because the server is what did it.
    return {
      headline: 'the server answered and then closed without replying',
      sentence:
        'LM Studio accepted the request and closed the connection without sending a reply. ' +
        'Nothing was generated — this is not a short answer, it is no answer.',
      remedy: {
        text: 'Ask again. The server is reachable, so check that the model is still loaded in LM Studio.'
      },
      detail: null,
      recognised: true
    }
  }

  // The true negative. The stream ran, the stream ended, and it carried no
  // text: this one really is the model saying nothing, and must still say so.
  return {
    headline: 'the model produced no text',
    sentence:
      'The model produced no text. LM Studio answered and the reply ran to its end — it was ' +
      'simply empty.',
    remedy: { text: 'Ask again, or rephrase the question.' },
    detail: null,
    recognised: true
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

/**
 * "The network layer reported:" — a line, so it starts like one.
 *
 * Exported because the one place a PERSON reads this label is the message
 * bubble, and it had hand-rolled its own `${source} reported` — no capital, no
 * colon — while this module's own contract says it starts like a line. Two
 * spellings of one label is the drift this file exists to prevent.
 */
export function attribution(detail: FailureDetail): string {
  return `${detail.source.charAt(0).toUpperCase()}${detail.source.slice(1)} reported:`
}

/**
 * The same fact as the NAME of a control, rather than as the opener of a line.
 *
 * v2.4. `attribution` ends in a colon because both its callers put the text on
 * the very next line — `composeFailure` and `copyableFailure` are read top to
 * bottom and never fold. The verification banner's disclosure is the third
 * caller and it *does* fold, so the default view of a collapsed run carried,
 * verbatim (`.h2h-runs/B11/V3-20260828-104955`):
 *
 *     🧮 Recompute skipped — stopped before it finished
 *     The runtime reported:
 *
 * — a label introducing nothing, with `BodyStreamBuffer was aborted` a click
 * away. Round 6 recorded that as probably an artefact of capturing a closed
 * `<details>`; round 11's critics saw it on screen in both arms.
 *
 * The fix is not to unfold the disclosure. This module's whole argument is that
 * a runtime string belongs behind one, and `BodyStreamBuffer was aborted` — a
 * DOMException's wording for a fetch the app itself aborted — is exactly the
 * text it exists to keep off the reader's screen. What was wrong is that a
 * closed control was wearing a line's clothes. So the closed state gets a name
 * for what is inside it, which is what a `<summary>` is; the colon form stays
 * for the two places the text really does follow.
 *
 * Two spellings of one label would be the drift `attribution` was extracted to
 * prevent, so this is not a second hand-rolled string: both come from
 * `detail.source`, and neither call site writes the word "reported" itself.
 */
export function attributionLabel(detail: FailureDetail): string {
  return `What ${detail.source} reported`
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
