import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  MAX_RIPPLES,
  THINKING_VISUAL,
  WAIT_COUNT_MS,
  WAIT_ESCALATE_MS,
  WAIT_STALLED_MS,
  capRipples,
  describeOasisState,
  describeWait,
  formatElapsed,
  resolveMotion,
  settleRipple,
  startWaitClock,
  toolVisualForName
} from '../src/renderer/src/lib/oasisRipple'
import { OasisRippleView } from '../src/renderer/src/components/OasisRipple'
import { FIRST_BYTE_TIMEOUT_MS, STREAM_STALL_MS } from '../src/renderer/src/hooks/chatTransport'
import type { ToolCallRecord } from '../src/renderer/src/types'

/**
 * Stress tests for the thinking indicator's state machine. The component
 * (OasisRipple.tsx) is a thin renderer over these pure functions, so hammering
 * them here covers the behavior users see: rapid tool storms, malformed tool
 * names, and every streaming/content combination the engine can produce.
 */

function tc(id: string, name: string, status: ToolCallRecord['status'] = 'running'): ToolCallRecord {
  return { id, name, args: {}, status }
}

// ---- Tool name → visual mapping ------------------------------------------------

test('every built-in tool maps to its documented visual', () => {
  const cases: [string, string, string][] = [
    // [tool name, expected kind, expected label]
    ['web_search', 'search', 'SEARCHING'],
    ['fetch_webpage', 'search', 'SEARCHING'],
    ['deep_research', 'search', 'SEARCHING'],
    ['run_terminal_command', 'code', 'EXECUTING'],
    ['memory_save', 'memory', 'RECALLING'],
    ['memory_search', 'memory', 'RECALLING'],
    ['memory_forget', 'memory', 'RECALLING'],
    ['create_note', 'memory', 'RECALLING'],
    ['list_notes', 'memory', 'RECALLING'],
    ['read_note', 'memory', 'RECALLING'],
    ['write_file', 'write', 'WRITING'],
    ['read_file', 'file', 'READING'],
    ['list_directory', 'file', 'READING'],
    ['consult_model', 'consult', 'CONSULTING'],
    ['get_current_datetime', 'generic', 'WORKING'],
    // v1.12: a market fetch is network activity and shows as such — not the
    // generic teal, which would hide that the app is contacting a host.
    ['market_data', 'search', 'SEARCHING']
  ]
  for (const [name, kind, label] of cases) {
    const visual = toolVisualForName(name)
    assert.equal(visual.kind, kind, `${name} → kind`)
    assert.equal(visual.label, label, `${name} → label`)
    assert.match(visual.color, /^#[0-9a-f]{6}$/, `${name} → hex color`)
  }
})

test('malformed, empty, and invented tool names never break the indicator', () => {
  for (const junk of ['', '   ', '!!@@##', 'delete_everything', '🚀', 'null', 'undefined']) {
    const visual = toolVisualForName(junk)
    assert.equal(visual.kind, 'generic', `"${junk}" degrades to generic`)
    assert.equal(visual.label, 'WORKING')
  }
})

test('tool matching is case-insensitive and whitespace-tolerant', () => {
  assert.equal(toolVisualForName('  WEB_SEARCH ').kind, 'search')
  assert.equal(toolVisualForName('Memory_Search').kind, 'memory')
  assert.equal(toolVisualForName('CONSULT_MODEL').kind, 'consult')
})

test('write_file matches write before the generic file rule', () => {
  // Ordering guard: 'write_file' contains 'file' but must be WRITING.
  assert.equal(toolVisualForName('write_file').kind, 'write')
})

// ---- Thinking state machine ------------------------------------------------------

test('hidden when not streaming, even with tools on the message', () => {
  const state = describeOasisState(false, '', [tc('a', 'web_search')])
  assert.equal(state.mode, 'hidden')
  assert.equal(state.tool, null)
  assert.equal(state.runningCount, 0)
})

test('ambient while the model composes with no tool activity', () => {
  const state = describeOasisState(true, '', [])
  assert.equal(state.mode, 'ambient')
  assert.equal(state.activeToolId, null)
})

test('tool mode while a tool runs with nothing said yet', () => {
  const state = describeOasisState(true, '', [tc('call_1', 'memory_search')])
  assert.equal(state.mode, 'tool')
  assert.equal(state.tool?.label, 'RECALLING')
  assert.equal(state.tool?.color, '#a78bfa')
  assert.equal(state.runningCount, 1)
  assert.equal(state.activeToolId, 'call_1')
})

test('finished tools (done/error) return the pool to ambient', () => {
  const done = describeOasisState(true, '', [tc('a', 'web_search', 'done')])
  assert.equal(done.mode, 'ambient')
  const errored = describeOasisState(true, '', [tc('a', 'web_search', 'error')])
  assert.equal(errored.mode, 'ambient')
})

test('ripple yields as soon as text starts flowing, even mid-tool', () => {
  // Once the model is visibly writing, the message owns the surface —
  // otherwise the indicator and text fight for the same space.
  const state = describeOasisState(true, 'Partial answer…', [tc('a', 'web_search')])
  assert.equal(state.mode, 'hidden')
})

test('whitespace content counts as flowing text', () => {
  const state = describeOasisState(true, ' ', [tc('a', 'web_search')])
  assert.equal(state.mode, 'hidden')
})

// ---- Stress: the agentic loop, exactly as the engine drives it --------------------

test('full tool storm: 8 iterations × 3 parallel calls, most-recent wins', () => {
  // Mirror useLMStudio.runTurn: records accumulate across iterations and are
  // patched as running → done. Feed the whole history at every step.
  const tools = ['web_search', 'fetch_webpage', 'read_file', 'run_terminal_command', 'memory_save']
  let records: ToolCallRecord[] = []
  let dropletEvents = 0

  for (let iteration = 0; iteration < 8; iteration++) {
    // A round can request several calls at once; all enter 'running' together.
    const round = Array.from({ length: 3 }, (_, i) =>
      tc(`r${iteration}c${i}`, tools[(iteration + i) % tools.length])
    )
    for (const record of round) {
      records = [...records, record]
      const state = describeOasisState(true, '', records)
      assert.equal(state.mode, 'tool')
      assert.equal(state.activeToolId, record.id, 'most recently started tool wins')
      assert.equal(state.tool, toolVisualForName(record.name), 'label matches the active tool')
      dropletEvents++
    }
    // Round finishes: all flip to done, pool goes back to ambient.
    records = records.map((r) => ({ ...r, status: 'done' as const }))
    assert.equal(describeOasisState(true, '', records).mode, 'ambient')
  }
  assert.equal(dropletEvents, 24)

  // The message ends: streaming stops, indicator hides. Never leaks a state.
  assert.equal(describeOasisState(false, '', records).mode, 'hidden')
})

test('parallel batch: runningCount reflects simultaneous calls', () => {
  const records = [tc('a', 'web_search'), tc('b', 'read_file'), tc('c', 'memory_save', 'done')]
  const state = describeOasisState(true, '', records)
  assert.equal(state.mode, 'tool')
  assert.equal(state.runningCount, 2)
  assert.equal(state.activeToolId, 'b', 'last running call is the active one')
})

test('mixed statuses: running wins over both done and error', () => {
  const records = [
    tc('a', 'web_search', 'error'),
    tc('b', 'read_file', 'done'),
    tc('c', 'deep_research', 'running')
  ]
  const state = describeOasisState(true, '', records)
  assert.equal(state.activeToolId, 'c')
  assert.equal(state.tool?.label, 'SEARCHING')
})

// ---- Ripple capping ---------------------------------------------------------------

test('ripples cap at MAX_RIPPLES under a droplet flood', () => {
  let active: string[] = []
  for (let i = 0; i < 50; i++) active = capRipples(active, `drop_${i}`)
  assert.equal(active.length, MAX_RIPPLES)
  assert.equal(active[active.length - 1], 'drop_49', 'newest survives')
  assert.equal(active[0], `drop_${50 - MAX_RIPPLES}`, 'oldest evicted first')
})

test('capRipples dedupes and returns identity for no-ops', () => {
  const base = ['a', 'b']
  assert.equal(capRipples(base, 'a'), base, 'duplicate → same reference')
  assert.deepEqual(capRipples(base, 'c', 3), ['a', 'b', 'c'], 'room → appended')
})

test('settleRipple removes only the finished id', () => {
  assert.deepEqual(settleRipple(['a', 'b', 'c'], 'b'), ['a', 'c'])
  const base = ['a']
  assert.equal(settleRipple(base, 'zzz'), base, 'absent → same reference')
})

// ---- Motion policy ------------------------------------------------------------------

test('reduced motion keeps information, drops movement', () => {
  const reduced = resolveMotion(true)
  assert.equal(reduced.animateDroplets, false)
  assert.equal(reduced.animateAmbient, false)
  const full = resolveMotion(false)
  assert.equal(full.animateDroplets, true)
  assert.equal(full.animateAmbient, true)
})

test('ambient thinking visual is always the brand teal THINKING', () => {
  assert.equal(THINKING_VISUAL.label, 'THINKING')
  assert.equal(THINKING_VISUAL.color, '#00d4aa')
})

// ---- The silent wait ----------------------------------------------------------------

/**
 * FR2: a captured run sat for 90.8 s with `sendToFirstVisibleMs: null`, and the
 * snapshots at 60 s and at 90 s were byte-identical to the one at 5 s — an
 * animated disc reading THINKING and nothing else. The transport's stall
 * timeout does not help a reader who never presses Stop; only the screen can.
 *
 * So these assert on the rendered markup, driven by nothing but a clock.
 */

const AMBIENT = describeOasisState(true, '', [])

/** What the transport witnessed, in the three shapes a wait can be in. */
const NOTHING_ANSWERED = { accepted: false, streamed: false }
const ACCEPTED_SILENT = { accepted: true, streamed: false }
const REPLY_BEGUN = { accepted: true, streamed: true }

function frameAt(
  silentMs: number,
  state = AMBIENT,
  deadlineMs = FIRST_BYTE_TIMEOUT_MS,
  seen: { accepted: boolean; streamed: boolean } | null = null
): string {
  return renderToStaticMarkup(
    createElement(OasisRippleView, {
      state,
      reducedMotion: true,
      wait: describeWait(silentMs, state, deadlineMs, seen)
    })
  )
}

test('a silent stream changes the screen on its own, with no user action', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const opening = frameAt(0)
    const frames: string[] = []
    // The only input to the whole run is time passing: no Stop, no keystroke,
    // no chunk. frames[i] is the screen at (i + 1) seconds of silence.
    const stop = startWaitClock((ms) => frames.push(frameAt(ms)))
    for (let second = 0; second < 90; second++) mock.timers.tick(1_000)
    stop()

    assert.equal(frames.length, 90, 'one repaint per second of silence')
    assert.equal(frames[4], opening, 'at 5s the wait is still ordinary — nothing added')

    const firstChange = frames.findIndex((f) => f !== opening)
    assert.equal(firstChange + 1, WAIT_COUNT_MS / 1000, 'the screen first changes at 10s')

    const at60 = frames[59]
    assert.notEqual(at60, frames[4], 'the 60s screen is not the 5s screen')
    assert.match(at60, /data-wait-level="escalated"/)
    assert.match(at60, /still waiting on the model/)
    assert.match(at60, /1:00/, 'elapsed silence, counted')
    assert.match(at60, /gives up at 5:00/, 'and when it recovers by itself')

    // It keeps counting rather than freezing on one number.
    assert.match(frames[89], /1:30/)
    assert.equal(new Set(frames.slice(WAIT_COUNT_MS / 1000)).size, 90 - WAIT_COUNT_MS / 1000)
  } finally {
    mock.timers.reset()
  }
})

test('the wait line is absent from the ordinary range and present after it', () => {
  assert.doesNotMatch(frameAt(0), /oasis-wait/)
  assert.doesNotMatch(frameAt(WAIT_COUNT_MS - 1), /oasis-wait/)
  assert.match(frameAt(WAIT_COUNT_MS), /oasis-wait/)
})

test('describeWait escalates on the two thresholds, and only there', () => {
  const quiet = describeWait(WAIT_COUNT_MS - 1, AMBIENT, FIRST_BYTE_TIMEOUT_MS)
  assert.equal(quiet.level, 'quiet')
  assert.equal(quiet.elapsed, null)

  const counting = describeWait(WAIT_COUNT_MS, AMBIENT, FIRST_BYTE_TIMEOUT_MS)
  assert.equal(counting.level, 'counting')
  assert.equal(counting.elapsed, '10s')
  assert.equal(counting.detail, null, 'no escalation language before 30s')

  const escalated = describeWait(WAIT_ESCALATE_MS, AMBIENT, FIRST_BYTE_TIMEOUT_MS)
  assert.equal(escalated.level, 'escalated')
  assert.equal(escalated.detail, 'still waiting on the model')
  assert.equal(escalated.deadline, 'gives up at 5:00')
})

test('the wait names the running tool, and the deadline it is actually under', () => {
  // A stream that has already produced something is under the stall timeout,
  // not the first-byte ceiling — the line must not promise the wrong minute.
  const tools = describeOasisState(true, '', [tc('a', 'deep_research')])
  const notice = describeWait(45_000, tools, STREAM_STALL_MS)
  assert.equal(notice.detail, 'still waiting on deep_research')
  assert.equal(notice.deadline, 'gives up at 1:00')
  assert.match(frameAt(45_000, tools, STREAM_STALL_MS), /still waiting on deep_research/)
})

test('a hidden ripple never grows a wait line, however long the silence', () => {
  const hidden = describeOasisState(false, '', [])
  assert.equal(describeWait(600_000, hidden, FIRST_BYTE_TIMEOUT_MS).level, 'quiet')
})

/* ---- v1.17.4: what KIND of silence this is ------------------------------- */

/**
 * FR2 again, one level in. Round 8 made the wait visible; a round-11 critic
 * found that ninety seconds of it says the same thing at 30 s and at 90 s and
 * never once says the thing the app knows:
 *
 * > The one thing it knows and never says during the wait is that the server
 * > accepted the request and has sent zero bytes since — the distinction
 * > between a slow model and a dead stream, which is exactly what the reader
 * > needs at 60 seconds to decide whether to keep waiting.
 *
 * The transport records `accepted` (its `fetch` returned a response) and
 * `streamed` (a body byte arrived) already; through v1.17.3 both were read only
 * in the post-mortem, after the reader had spent the ninety seconds.
 *
 * The true negative is the load-bearing half and it is asserted throughout: a
 * model that is genuinely just slow is `accepted && !streamed` for the whole
 * of a long prompt, byte for byte identical to a dead server, so **no line may
 * report a dead stream**. The escalation says what was witnessed; the note past
 * a minute names both readings and refuses to choose.
 */

test('the wait says which silence it is, from what the transport saw', () => {
  const at = (seen: { accepted: boolean; streamed: boolean }): string =>
    describeWait(WAIT_ESCALATE_MS, AMBIENT, FIRST_BYTE_TIMEOUT_MS, seen).detail!

  assert.equal(at(NOTHING_ANSWERED), 'LM Studio has not answered the request yet')
  assert.equal(at(ACCEPTED_SILENT), 'LM Studio took the request and has sent nothing back')
  assert.equal(at(REPLY_BEGUN), 'LM Studio started replying, then went quiet')

  // Three facts, three sentences: the defect was one sentence over all three.
  assert.equal(new Set([at(NOTHING_ANSWERED), at(ACCEPTED_SILENT), at(REPLY_BEGUN)]).size, 3)
})

test('with no transport record the app claims no more than it did before', () => {
  // A plan step's sub-turn, a consultation and the claim-check pass all call
  // the transport without a witness. "The app knows nothing finer" is the one
  // honest thing to say there, and it must not borrow the sentences above.
  const notice = describeWait(WAIT_STALLED_MS * 2, AMBIENT, FIRST_BYTE_TIMEOUT_MS, null)
  assert.equal(notice.detail, 'still waiting on the model')
  assert.equal(notice.note, null, 'no record is no grounds for a second sentence')
  assert.equal(notice.level, 'escalated', 'and no grounds for raising the level either')
})

test('a running tool is what the wait is on — the witness describes a socket, not a tool', () => {
  const tools = describeOasisState(true, '', [tc('a', 'deep_research')])
  const notice = describeWait(WAIT_STALLED_MS * 2, tools, STREAM_STALL_MS, ACCEPTED_SILENT)
  assert.equal(notice.detail, 'still waiting on deep_research')
  assert.equal(notice.note, null, 'a tool that has run a minute is not evidence about a stream')
})

test('the second sentence arrives at a minute, and never before it', () => {
  for (const ms of [WAIT_ESCALATE_MS, WAIT_STALLED_MS - 1]) {
    const early = describeWait(ms, AMBIENT, FIRST_BYTE_TIMEOUT_MS, ACCEPTED_SILENT)
    assert.equal(early.note, null, `no reading offered at ${ms}ms`)
    assert.equal(early.level, 'escalated')
  }
  const late = describeWait(WAIT_STALLED_MS, AMBIENT, FIRST_BYTE_TIMEOUT_MS, ACCEPTED_SILENT)
  assert.equal(late.level, 'stalled')
  assert.match(late.note!, /cannot tell a prompt still being processed from a dead stream/)
})

test('a slow model is never reported as a dead stream', () => {
  // THE true negative. Ten minutes of accepted-and-silent is exactly what a
  // 30k-token prompt on slow hardware looks like, and the app cannot see the
  // difference — so at no elapsed time may it say there is one.
  for (const ms of [WAIT_ESCALATE_MS, WAIT_STALLED_MS, 120_000, 600_000]) {
    const notice = describeWait(ms, AMBIENT, FIRST_BYTE_TIMEOUT_MS, ACCEPTED_SILENT)
    const said = `${notice.detail} ${notice.note ?? ''}`
    assert.doesNotMatch(said, /\bis dead\b|\bhas died\b|\bhas crashed\b|\bnot responding\b/)
    assert.doesNotMatch(said, /the model has stopped|the stream has stopped/)
    if (notice.note) {
      // Both readings, and the innocent one first: the note exists to hand the
      // reader a decision, not a verdict.
      assert.match(notice.note, /cannot tell/)
      assert.ok(
        notice.note.indexOf('prompt still being processed') < notice.note.indexOf('dead stream'),
        'the innocent reading is offered first'
      )
    }
  }
})

/**
 * v1.17.5. The `!accepted` note used to read *"Not even the reply headers have
 * come back"*, and a round-11 critic could not settle it: *"run-2's most useful
 * sentence is also its least verifiable, and it is stated flatly."*
 *
 * It is unverifiable because `accepted` was never the headers. It is set from
 * the transport's `fetch` resolving, and `fetch` does not resolve on every
 * header block — a `103 Early Hints` response and a `302` each put a complete
 * reply header block on the wire and left it pending (measured; see
 * hooks/chatTransport.ts). LM Studio behind any reverse proxy produces either.
 *
 * The useful half is kept, because the note earns its place: it is the
 * difference between *be patient* and *this may never come back*.
 */
test('the pre-answer note claims nothing about headers', () => {
  const notice = describeWait(WAIT_STALLED_MS, AMBIENT, FIRST_BYTE_TIMEOUT_MS, NOTHING_ANSWERED)
  assert.equal(notice.level, 'stalled')
  const said = `${notice.detail} ${notice.note}`
  // The overreach itself. The app cannot see the wire, only its own fetch.
  assert.doesNotMatch(said, /header/i)
  assert.doesNotMatch(said, /\bpacket|\bsocket|\bTCP\b/i)
})

test('the pre-answer note keeps the reading the reader needs, and both halves of it', () => {
  const note = describeWait(
    WAIT_STALLED_MS,
    AMBIENT,
    FIRST_BYTE_TIMEOUT_MS,
    NOTHING_ANSWERED
  ).note!
  // What `!accepted` establishes, and nothing further.
  assert.match(note, /Nothing has come back/)
  // The fact the reader most needs and the app can actually prove: a refused
  // connection rejects `fetch`, and a rejection ends the turn — so while this
  // line is on screen, the address is not the thing to go and check.
  assert.match(note, /nothing was refused/)
  // And the half the note exists for, unchanged.
  assert.match(note, /cannot tell a busy server from one that has stopped answering/)
})

test('a server that has not answered is not reported as dead either', () => {
  // The same true negative as the slow-model one below, on the other branch:
  // a server still processing and a server that has died are indistinguishable
  // before the answer arrives, so no elapsed time may claim the difference.
  for (const ms of [WAIT_STALLED_MS, 120_000, 600_000]) {
    const notice = describeWait(ms, AMBIENT, FIRST_BYTE_TIMEOUT_MS, NOTHING_ANSWERED)
    const said = `${notice.detail} ${notice.note ?? ''}`
    assert.doesNotMatch(said, /\bis dead\b|\bhas died\b|\bhas crashed\b|\bnot responding\b/)
    assert.doesNotMatch(said, /is not running|never started|wrong address/i)
    if (notice.note) {
      assert.match(notice.note, /cannot tell/)
      assert.ok(
        notice.note.indexOf('busy server') < notice.note.indexOf('stopped answering'),
        'the innocent reading is offered first, as on the other branch'
      )
    }
  }
})

test('the two pre-body notes are different sentences, and neither is the other', () => {
  const before = describeWait(WAIT_STALLED_MS, AMBIENT, FIRST_BYTE_TIMEOUT_MS, NOTHING_ANSWERED).note
  const after = describeWait(WAIT_STALLED_MS, AMBIENT, FIRST_BYTE_TIMEOUT_MS, ACCEPTED_SILENT).note
  assert.notEqual(before, after)
  // Each names the pair of readings its own evidence allows, and only that pair.
  assert.doesNotMatch(before!, /prompt still being processed/)
  assert.doesNotMatch(after!, /busy server/)
})

test('a reply that began and went quiet gets no note — its deadline is the note', () => {
  // The transport ends this turn at STREAM_STALL_MS, which is the same instant
  // the note would appear. A sentence the reader cannot finish reading is
  // worse than none.
  const notice = describeWait(WAIT_STALLED_MS, AMBIENT, STREAM_STALL_MS, REPLY_BEGUN)
  assert.equal(notice.note, null)
  assert.equal(notice.deadline, null, 'and the deadline it already passed is not still promised')
})

test('the whole 90-second wait, rendered, with the transport reporting as it goes', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const frames: string[] = []
    // The measured shape: headers land at once, then nothing at all. Time is
    // still the only input — no Stop, no keystroke, no chunk.
    const stop = startWaitClock((ms) => frames.push(frameAt(ms, AMBIENT, FIRST_BYTE_TIMEOUT_MS, ACCEPTED_SILENT)))
    for (let second = 0; second < 90; second++) mock.timers.tick(1_000)
    stop()

    const at30 = frames[29]!
    assert.match(at30, /LM Studio took the request and has sent nothing back/)
    assert.match(at30, /gives up at 5:00/)
    assert.doesNotMatch(at30, /oasis-wait-note/, 'no reading yet at 30s')

    const at60 = frames[59]!
    assert.match(at60, /data-wait-level="stalled"/)
    assert.match(at60, /oasis-wait-note/)
    assert.match(at60, /cannot tell a prompt still being processed from a dead stream/)

    // The round-11 defect, gone: the 90s screen is not the 30s screen, and the
    // difference is a fact rather than a bigger number.
    assert.notEqual(frames[89], at30)
    assert.doesNotMatch(at60, /still waiting on the model/)
  } finally {
    mock.timers.reset()
  }
})

test('elapsed is truncated seconds under a minute, m:ss over it', () => {
  assert.equal(formatElapsed(0), '0s')
  assert.equal(formatElapsed(9_999), '9s')
  assert.equal(formatElapsed(59_999), '59s')
  assert.equal(formatElapsed(60_000), '1:00')
  assert.equal(formatElapsed(90_857), '1:30', 'the captured run')
  assert.equal(formatElapsed(300_000), '5:00')
})
