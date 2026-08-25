import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  composeFailure,
  copyableFailure,
  explainFailure,
  ExplainedError,
  readsAsProse,
  searchUnreachable,
  type Failure
} from '../src/shared/failure'
import { readToolFailure, toolFailure } from '../src/shared/tools/outcomes'
import { describeRecompute } from '../src/renderer/src/lib/workbenchChecks'

/**
 * Four rounds of blind critics found the same species on screen: a runtime
 * identifier printed where a sentence belongs. Every string below is verbatim
 * from a recorded run of a build that WON its task.
 *
 * | measured | where |
 * | --- | --- |
 * | `net::ERR_UNSAFE_PORT` | the collapsed tool row, twice in one turn, and again as the whole `Result` body |
 * | `BodyStreamBuffer was aborted` | after `🧮 Recompute skipped —`, a line with no disclosure to open |
 * | `signal is aborted without reason` | the ENTIRE body of an interrupted plan step |
 * | `Trying to keep the first 12000 tokens when context the overflows.` | an assistant bubble — and this clause is LM Studio's, not ours |
 *
 * The suite is arranged as the round requires: a true negative beside every
 * true positive. The true positives are that these four stop being printed at
 * a reader. The true negatives are the ones that decide whether the boundary is
 * worth having — that the app's own good sentences survive it untouched, that a
 * code meaning "a server answered" is not called unreachable, that a server's
 * words are not deleted, and above all that a failure the app has NEVER SEEN
 * produces something true rather than a confident guess.
 */

// ---- The corpus the boundary must not damage ---------------------------------

/**
 * Error prose the app writes about itself, harvested from main/ipc/search.ts,
 * main/ipc/net.ts, main/ipc/plan.ts, toolHandlers/* and chatTransport.ts.
 *
 * This is the true-negative set for the whole design. The boundary's job is to
 * catch machine text; the way it fails badly is by catching these too, because
 * every one of them already names a cause and most name a remedy — better than
 * anything a translator could substitute for them.
 */
const APP_PROSE = [
  'No SearXNG URL configured — set it under Settings → Search.',
  'No Brave Search API key set — add one under Settings → Search.',
  'SearXNG returned HTTP 500. If this is 403, enable JSON output on your instance (settings.yml → search: formats: [html, json]).',
  'Brave Search returned HTTP 429',
  'DuckDuckGo returned HTTP 403',
  'DuckDuckGo did not issue an image-search token.',
  'Could not resolve host "search.example".',
  'Could not fetch that page.',
  'Refused: loopback addresses cannot be fetched.',
  'Refused: redirect to a non-HTTPS URL.',
  'Refused: unsupported content type "application/zip".',
  'Refusing to fetch unparseable URL: htp://nope',
  'Redirect (HTTP 302) without a Location header.',
  'Too many redirects.',
  'Not a supported image (text/html).',
  'Tool "web_search" is not allowlisted for this role.',
  'A task is required.',
  'The model did not produce a usable plan.',
  'Request timed out after 300s.',
  'Empty search query.',
  'No results found for "marquee moon" (searxng).',
  'The reply stalled — nothing received for 60s. LM Studio stopped sending mid-answer; whatever arrived before that is above.',
  'LM Studio accepted the request and then sent nothing for 300s. The server is not answering — check that the model is still loaded in LM Studio, then try again.'
]

/** Text written for a program. None of it may reach a reader as our sentence. */
const MACHINE = [
  'net::ERR_UNSAFE_PORT',
  'net::ERR_CONNECTION_REFUSED (http://127.0.0.1:9)',
  'net::ERR_NAME_NOT_RESOLVED',
  'connect ECONNREFUSED 127.0.0.1:9',
  'getaddrinfo ENOTFOUND search.example',
  'write EPIPE',
  'signal is aborted without reason',
  'TypeError: Cannot read properties of undefined (reading "steps")',
  'ENOSPC: no space left on device, write'
]

/** The shape of anything written for a program rather than a person. */
const IDENTIFIER = /[a-z][a-z0-9]*::[A-Za-z0-9_]+|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\bE[A-Z]{5,}\b/

// ---- The safe list is of prose, not of identifiers ---------------------------

describe('what may be printed as the app’s own words', () => {
  test('every sentence the app writes about a failure survives untouched', () => {
    for (const line of APP_PROSE) {
      assert.equal(readsAsProse(line), true, line)
      const f = explainFailure(line)
      assert.equal(f.sentence, line, `the boundary rewrote the app’s own sentence: "${line}"`)
      assert.equal(f.detail, null, line)
      assert.equal(f.recognised, true, line)
    }
  })

  test('nothing written for a program does', () => {
    for (const line of MACHINE) assert.equal(readsAsProse(line), false, line)
  })

  test('shouted English is not mistaken for an errno', () => {
    // The errno arm needs six letters, so ERROR is prose and ENOENT is not.
    assert.equal(readsAsProse('The server said ERROR and hung up.'), true)
    assert.equal(readsAsProse('ENOENT: no such file'), false)
  })
})

// ---- The four measured strings ------------------------------------------------

describe('the four strings a reader could not act on', () => {
  test('TTU3’s row: the reader is told nothing answered, not ERR_UNSAFE_PORT', () => {
    const f = explainFailure('net::ERR_UNSAFE_PORT', { subject: 'The search' })
    assert.match(f.headline, /nothing answered/i)
    assert.doesNotMatch(f.headline, IDENTIFIER)
    assert.doesNotMatch(f.sentence, IDENTIFIER)
    assert.equal(f.detail?.text, 'net::ERR_UNSAFE_PORT')
    assert.match(f.detail?.source ?? '', /network/i)
    assert.ok(f.remedy, 'a provider that cannot be reached has a remedy')
  })

  test('TTU3’s Result body: the whole disclosure is no longer the code', () => {
    const body = composeFailure(readToolFailure(toolFailure('net::ERR_UNSAFE_PORT', 'Tell the user plainly.')))
    const lead = body.split('\n\n')[0] ?? ''
    assert.doesNotMatch(lead, IDENTIFIER, `the disclosure still opens with an identifier: "${lead}"`)
    assert.match(lead, /could not reach/i)
    // …and the code is still in there, attributed rather than asserted.
    assert.match(body, /The network layer reported:/)
    assert.match(body, /net::ERR_UNSAFE_PORT/)
  })

  test('the recompute line: “stopped before it finished”, not BodyStreamBuffer', () => {
    const err = new DOMException('BodyStreamBuffer was aborted', 'AbortError')
    const f = explainFailure(err, { subject: 'The recomputation' })
    const check = describeRecompute({
      ran: false,
      ok: false,
      note: f.headline,
      ...(f.detail ? { detail: f.detail } : {})
    })
    assert.equal(check.summary, '🧮 Recompute skipped — stopped before it finished')
    assert.doesNotMatch(check.summary, /BodyStreamBuffer/)
    assert.equal(check.detail?.text, 'BodyStreamBuffer was aborted')
  })

  test('an interrupted plan step says it was stopped, in a sentence', () => {
    // The other engine's wording for the same exception — see below.
    const err = new DOMException('signal is aborted without reason', 'AbortError')
    const body = composeFailure(explainFailure(err, { subject: 'Step 2' }))
    assert.match(body, /^Step 2 was stopped before it finished\./)
    assert.match(body, /signal is aborted without reason/, 'the wording is evidence and is kept')
  })

  test('an abort is recognised by TYPE, so both engines’ wordings land alike', () => {
    // This is the round-3 lesson one layer down. Matching either message is an
    // enumeration; `name` is the class the DOM standard actually fixes.
    const a = explainFailure(new DOMException('signal is aborted without reason', 'AbortError'))
    const b = explainFailure({ name: 'AbortError', message: 'BodyStreamBuffer was aborted' })
    const c = explainFailure({ name: 'AbortError', message: 'a wording no engine ships yet' })
    assert.equal(a.headline, b.headline)
    assert.equal(b.headline, c.headline)
    assert.match(c.sentence, /stopped before it finished/)
  })

  test('LM Studio’s clause is quoted as theirs, and our sentence leads', () => {
    // Verbatim from the recorded bubble, garbled word order and all.
    const THEIRS = 'Trying to keep the first 12000 tokens when context the overflows.'
    const f = explainFailure(THEIRS, { subject: 'The request', source: 'LM Studio' })
    const body = composeFailure(f)
    assert.ok(body.startsWith('The request was refused by LM Studio'), body)
    assert.ok(
      body.indexOf('The request was refused') < body.indexOf(THEIRS),
      'their words came first, so their garbled clause reads as our bug'
    )
    assert.match(body, /LM Studio reported:/)
    assert.match(body, /“Trying to keep the first 12000 tokens when context the overflows\.”/)
    assert.match(f.sentence, /larger than the context the model is loaded with/)
    assert.match(f.remedy?.text ?? '', /larger context in LM Studio/)
  })

  test('their text is never dropped, even when the app cannot read it', () => {
    const f = explainFailure('gpu_layers mismatch: 33 != 0', {
      subject: 'The request',
      source: 'LM Studio'
    })
    assert.equal(f.recognised, false, 'the app has not learned this one and must not pretend to')
    assert.equal(f.detail?.text, 'gpu_layers mismatch: 33 != 0')
    assert.match(composeFailure(f), /LM Studio reported:/)
  })

  test('a server’s sentence is never printed as ours, however well it reads', () => {
    // The whole reason the LM Studio case shipped for a round: their clause
    // parses as fine English. Attribution is a fact the call site knows, and
    // it beats any shape test.
    const f = explainFailure('The context overflowed and the request was dropped.', {
      subject: 'The request',
      source: 'LM Studio'
    })
    assert.notEqual(f.sentence, 'The context overflowed and the request was dropped.')
    assert.match(f.sentence, /refused by LM Studio/)
  })
})

// ---- The case the design lives or dies on ------------------------------------

describe('a failure the app has never seen', () => {
  /** Codes and messages that do not exist. Nothing here can have been learned. */
  const NEVER_SEEN = [
    'net::ERR_QUIC_HANDSHAKE_ABANDONED_V7',
    'ENOSPC: no space left on device, write',
    'TypeError: Cannot read properties of undefined (reading "steps")',
    'write EPIPE',
    'Fatal: 0x8007007e'
  ]

  test('every one of them still produces something TRUE', () => {
    for (const raw of NEVER_SEEN) {
      const f = explainFailure(raw, { subject: 'The search' })
      // What is claimed is only what is known: it did not finish.
      assert.match(f.sentence, /did not finish|could not reach/i, raw)
      assert.doesNotMatch(f.sentence, IDENTIFIER, `the sentence leaked the identifier: ${raw}`)
      assert.equal(f.detail?.text, raw, 'the raw text is evidence and must survive')
    }
  })

  test('an unfamiliar net:: code is still classified — the round-3 inversion holds', () => {
    // Chromium reaches for a net:: code only when the request did not complete,
    // so a code nobody has listed still means nothing answered. This is the one
    // family where an unknown IS knowable, and it is knowable by inversion.
    const f = explainFailure('net::ERR_QUIC_HANDSHAKE_ABANDONED_V7', { subject: 'The search' })
    assert.equal(f.recognised, true)
    assert.match(f.headline, /nothing answered/i)
    assert.equal(searchUnreachable('net::ERR_QUIC_HANDSHAKE_ABANDONED_V7'), true)
  })

  test('and an unfamiliar code meaning a server ANSWERED is not called unreachable', () => {
    const f = explainFailure('net::ERR_TOO_MANY_REDIRECTS', { subject: 'The page' })
    assert.match(f.sentence, /reached the provider/i)
    assert.doesNotMatch(f.sentence, /nothing answered/i)
  })

  test('a failure outside every family invents no cause at all', () => {
    const f = explainFailure('ENOSPC: no space left on device, write', { subject: 'The search' })
    assert.equal(f.recognised, false)
    assert.equal(f.remedy, null, 'a remedy for a cause nobody established is a guess')
    // The three causes the app CAN diagnose. None may be asserted here.
    assert.doesNotMatch(f.sentence, /reach|connect|context|stopped/i, f.sentence)
    assert.match(f.sentence, /cannot say why/i)
  })

  test('the honest sentence says the words are kept, and they are', () => {
    const f = explainFailure('Fatal: 0x8007007e')
    assert.match(f.sentence, /word for word/i)
    assert.match(composeFailure(f), /The runtime reported:\n“Fatal: 0x8007007e”/)
  })
})

// ---- Invariants, over everything ---------------------------------------------

describe('what holds for every input', () => {
  const EVERYTHING: unknown[] = [
    ...APP_PROSE,
    ...MACHINE,
    '',
    '   ',
    null,
    undefined,
    42,
    { nope: true },
    new Error('net::ERR_ADDRESS_INVALID'),
    new DOMException('signal is aborted without reason', 'AbortError'),
    toolFailure('net::ERR_UNSAFE_PORT', 'Tell the user plainly.')
  ]

  test('no reader-facing sentence ever carries a machine identifier', () => {
    for (const raw of EVERYTHING) {
      const f = explainFailure(raw, { subject: 'The call' })
      assert.doesNotMatch(f.headline, IDENTIFIER, `headline: ${JSON.stringify(raw)}`)
      assert.doesNotMatch(f.sentence, IDENTIFIER, `sentence: ${JSON.stringify(raw)}`)
      if (f.remedy) assert.doesNotMatch(f.remedy.text, IDENTIFIER, `remedy: ${JSON.stringify(raw)}`)
    }
  })

  test('translating never loses the original', () => {
    for (const raw of EVERYTHING) {
      const f = explainFailure(raw)
      const original = typeof raw === 'string' ? raw.trim() : null
      if (original !== null && f.sentence === original) continue // the app wrote it
      if (f.detail === null) {
        assert.fail(`the raw text vanished: ${JSON.stringify(raw)} → ${JSON.stringify(f)}`)
      }
    }
  })

  test('a row is always a glance', () => {
    for (const raw of EVERYTHING) {
      const f = explainFailure(raw)
      assert.ok(f.headline.length <= 72, `${f.headline.length}: ${f.headline}`)
    }
  })

  test('the copyable form carries the identifier the row refused to print', () => {
    const f = explainFailure('net::ERR_UNSAFE_PORT', { subject: 'The search' })
    const copied = copyableFailure(f, 'web_search failed')
    assert.match(copied, /^web_search failed\n/)
    assert.match(copied, /net::ERR_UNSAFE_PORT/)
  })
})

// ---- A translation of a translation is how a layer starts lying ---------------

describe('a reading only happens once', () => {
  test('an already-explained error is passed through, not re-read', () => {
    const first = explainFailure('Trying to keep the first 12000 tokens when context the overflows.', {
      subject: 'The request',
      source: 'LM Studio'
    })
    const thrown = new ExplainedError(first)
    // The turn that catches this does not know who wrote the frame. Without the
    // carried reading it would classify our own sentence on the shape of the
    // quotation inside it.
    const second: Failure = explainFailure(thrown, { subject: 'The turn' })
    assert.deepEqual(second, first)
    assert.match(second.sentence, /refused by LM Studio/)
  })
})

// ---- Declines are known, not guessed ------------------------------------------

describe('a decline never reaches the translator', () => {
  test('the app knows it wrote that clause, which beats any shape test', () => {
    // "the query was a sentence about you, not search terms" — lower-case, no
    // full stop, no verb the shape test can see. It is app prose all the same,
    // and `declinedCall` composed it, so knowing beats guessing.
    const declined = 'Declined — the query was a sentence about you, not search terms'
    const f = readToolFailure(declined)
    assert.equal(f.headline, 'the query was a sentence about you, not search terms')
    assert.equal(f.detail, null)
    assert.equal(f.recognised, true)
  })
})
