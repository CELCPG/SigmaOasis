import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { useAppStore } from '../src/renderer/src/stores/appStore'
import type { ChatMessage, Conversation } from '../src/renderer/src/types'

/**
 * The conversation store is where the first-turn ghost bug lived: appending
 * the opening user message and retitling the placeholder were two separate
 * immutable updates, and the caller upserted a snapshot taken before the
 * append, wiping the message. Append + retitle is now one atomic action;
 * these tests pin that contract down.
 */

function placeholder(): Conversation {
  return {
    id: 'c1',
    title: 'New conversation',
    mode: 'independent',
    messages: [],
    createdAt: 1,
    updatedAt: 1
  }
}

function userMessage(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, createdAt: Date.now() }
}

beforeEach(() => {
  useAppStore.setState({ conversations: [], activeConversationId: null, streaming: false })
})

describe('appendMessage with retitle', () => {
  test('retitling a placeholder keeps the appended message', () => {
    // The exact regression: the first message of a new conversation must
    // survive the retitle, because it is the message the model answers.
    useAppStore.getState().upsertConversation(placeholder())
    useAppStore
      .getState()
      .appendMessage('c1', userMessage('m1', 'How do retries work?'), {
        retitle: 'How do retries work?'
      })

    const convo = useAppStore.getState().conversations[0]!
    assert.equal(convo.title, 'How do retries work?')
    assert.equal(convo.messages.length, 1)
    assert.equal(convo.messages[0]!.content, 'How do retries work?')
  })

  test('retitle only applies to placeholder conversations', () => {
    const titled: Conversation = { ...placeholder(), title: 'Existing title' }
    useAppStore.getState().upsertConversation(titled)
    useAppStore
      .getState()
      .appendMessage('c1', userMessage('m1', 'follow-up'), { retitle: 'follow-up' })

    const convo = useAppStore.getState().conversations[0]!
    assert.equal(convo.title, 'Existing title')
    assert.equal(convo.messages.length, 1)
  })

  test('append without retitle never touches the title', () => {
    useAppStore.getState().upsertConversation(placeholder())
    useAppStore.getState().appendMessage('c1', userMessage('m1', 'hello'))

    const convo = useAppStore.getState().conversations[0]!
    assert.equal(convo.title, 'New conversation')
    assert.equal(convo.messages.length, 1)
  })

  test('messages accumulate: the second message keeps the first', () => {
    useAppStore.getState().upsertConversation(placeholder())
    useAppStore
      .getState()
      .appendMessage('c1', userMessage('m1', 'first'), { retitle: 'first' })
    useAppStore.getState().appendMessage('c1', userMessage('m2', 'second'))

    const convo = useAppStore.getState().conversations[0]!
    assert.deepEqual(
      convo.messages.map((m) => m.content),
      ['first', 'second']
    )
  })

  test('assistant replies append after the retitled first turn', () => {
    // Mirrors runTurn's ordering: user message + retitle, then the assistant
    // placeholder lands on the same conversation.
    useAppStore.getState().upsertConversation(placeholder())
    useAppStore
      .getState()
      .appendMessage('c1', userMessage('m1', 'question'), { retitle: 'question' })
    useAppStore.getState().appendMessage('c1', {
      id: 'a1',
      role: 'assistant',
      content: '',
      createdAt: Date.now()
    })

    const convo = useAppStore.getState().conversations[0]!
    assert.deepEqual(
      convo.messages.map((m) => m.role),
      ['user', 'assistant']
    )
  })
})

/* ---- v2.0.1: what a load from disk may do to what memory is holding -------- */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  DEFAULT_HISTORY_LIMIT,
  historyLimit,
  planLoad
} from '../src/renderer/src/lib/conversationLoad'

/**
 * `load()` ended in `setConversations(list)` — the store replaced wholesale by
 * what `listConversations()` returned — and it re-ran on every change to
 * `settings.baseUrl`, which the reader can make at any moment from Settings.
 *
 * Three things the store can hold that a list of files structurally cannot,
 * all of them deleted by a change of *server address*:
 *
 *   - an ephemeral conversation, whose entire definition is "never written to
 *     disk" — enforced in two layers so the promise survives a renderer
 *     regression, and then undone from RAM by the loader;
 *   - the assistant message a turn is streaming into, after which the executor
 *     went on patching an id the store no longer had — `patchMessage` matches
 *     nothing, so tokens kept arriving and nothing appeared;
 *   - a conversation created a moment ago, which `createConversation` upserts
 *     without saving, leaving `activeConversationId` pointing at a deletion.
 */

function saved(id: string, updatedAt: number, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: id,
    mode: 'independent',
    messages: [],
    createdAt: 1,
    updatedAt,
    ...extra
  }
}

const streaming = (id: string): Conversation =>
  saved(id, 50, { messages: [userMessage('m1', 'two weeks of water')] })

const NO_CAP = 100

/** What the store should hold, for a load with a cap nothing reaches. */
const merged = (fromDisk: Conversation[], inStore: Conversation[]): Conversation[] =>
  planLoad(fromDisk, inStore, NO_CAP).keep

describe('a load reconciles with the store instead of replacing it', () => {
  test('an ephemeral conversation survives a reload that cannot contain it', () => {
    // The sharpest case, and it needs no streaming turn: disk has no file to
    // return, so any rule that says "the store becomes the file list" deletes
    // the feature.
    const ghost = saved('eph', 90, { ephemeral: true, title: 'Ephemeral chat' })
    const keep = merged([saved('c1', 10)], [saved('c1', 10), ghost])
    assert.deepEqual(keep.map((c) => c.id), ['eph', 'c1'])
    assert.equal(keep[0], ghost, 'the ephemeral conversation was rebuilt rather than kept')
  })

  test('an ephemeral conversation is never handed to the file deleter', () => {
    const ghost = saved('eph', 90, { ephemeral: true })
    const { prune } = planLoad([saved('c1', 10)], [ghost], 1)
    assert.deepEqual(prune, [], 'a conversation with no file was queued for deletion')
  })

  test('a conversation created and not yet saved survives', () => {
    const fresh = saved('new', 99, { title: 'New conversation' })
    assert.deepEqual(merged([saved('c1', 10)], [fresh]).map((c) => c.id), ['new', 'c1'])
  })

  test('memory wins where both hold the same conversation', () => {
    // The turn in progress: disk has the conversation as it stood at the end
    // of the last turn, memory has it with the message being written into.
    const onDisk = saved('c1', 10)
    const inStore = streaming('c1')
    const keep = merged([onDisk], [inStore])
    assert.equal(keep.length, 1)
    assert.equal(keep[0], inStore, 'the streamed message was replaced by the stale file')
    assert.equal(keep[0]!.messages.length, 1)
  })

  test('a conversation only disk has is taken from disk', () => {
    const onDisk = saved('c1', 10)
    assert.deepEqual(merged([onDisk], []), [onDisk])
    assert.equal(merged([onDisk], [])[0], onDisk)
  })

  test('the result is newest first, whichever side it came from', () => {
    const keep = merged(
      [saved('c1', 30), saved('c2', 10)],
      [saved('eph', 20, { ephemeral: true })]
    )
    assert.deepEqual(keep.map((c) => c.id), ['c1', 'eph', 'c2'])
  })

  test('neither input is mutated', () => {
    const fromDisk = [saved('c2', 10), saved('c1', 30)]
    const inStore = [saved('eph', 90, { ephemeral: true })]
    planLoad(fromDisk, inStore, NO_CAP)
    assert.deepEqual(fromDisk.map((c) => c.id), ['c2', 'c1'], 'the file list was sorted in place')
    assert.deepEqual(inStore.map((c) => c.id), ['eph'])
  })

  test('an empty store — the startup case — is exactly the file list', () => {
    const fromDisk = [saved('c1', 30), saved('c2', 10)]
    assert.deepEqual(merged(fromDisk, []), fromDisk)
  })

  test('a load with nothing on disk keeps what memory has', () => {
    const ghost = saved('eph', 90, { ephemeral: true })
    assert.deepEqual(merged([], [ghost]), [ghost])
  })
})

/**
 * The boundary the merge and the cap share, which each of them gets wrong on
 * its own — in opposite directions, and invisibly either way.
 */
describe('the history limit and the merge decide the same boundary', () => {
  test('the cap prunes the oldest files and the store follows', () => {
    const { keep, prune } = planLoad([saved('c1', 30), saved('c2', 20), saved('c3', 10)], [], 2)
    assert.deepEqual(keep.map((c) => c.id), ['c1', 'c2'])
    assert.deepEqual(prune.map((c) => c.id), ['c3'])
  })

  test('a conversation the cap dropped is not added back from memory', () => {
    // It is not "disk cannot hold this" — it is "disk was told to stop holding
    // this", and its file is being deleted in the same breath. Keeping it
    // would make the limit stop being a limit for the rest of the session.
    const old = saved('c3', 10)
    const { keep, prune } = planLoad(
      [saved('c1', 30), saved('c2', 20), old],
      [saved('c1', 30), old],
      2
    )
    assert.deepEqual(keep.map((c) => c.id), ['c1', 'c2'])
    assert.deepEqual(prune.map((c) => c.id), ['c3'])
  })

  test('a conversation with no file cannot push one over the cap', () => {
    // The same defect pointed outward: an ephemeral chat causing a *saved*
    // conversation to be deleted.
    const ghost = saved('eph', 99, { ephemeral: true })
    const { keep, prune } = planLoad([saved('c1', 30), saved('c2', 20)], [ghost], 2)
    assert.deepEqual(keep.map((c) => c.id), ['eph', 'c1', 'c2'])
    assert.deepEqual(prune, [])
  })

  test('the cap reads the file list in date order, not the order it arrived', () => {
    const { keep, prune } = planLoad([saved('old', 1), saved('new', 99)], [], 1)
    assert.deepEqual(keep.map((c) => c.id), ['new'])
    assert.deepEqual(prune.map((c) => c.id), ['old'])
  })
})

describe('historyLimit', () => {
  test('a configured number is used', () => {
    assert.equal(historyLimit(25), 25)
    assert.equal(historyLimit(1), 1)
  })

  test('a value that would delete the whole history falls back', () => {
    // This number decides what is deleted, so every way of not being a usable
    // count has to land on the default rather than on zero.
    for (const bad of [0, -5, 0.5, NaN, Infinity, -Infinity, undefined]) {
      assert.equal(historyLimit(bad as number | undefined), DEFAULT_HISTORY_LIMIT, `${bad}`)
    }
  })

  test('a fractional count is floored, not rounded up past what was asked', () => {
    assert.equal(historyLimit(2.9), 2)
  })

  test('nothing is pruned at the default when the history is smaller than it', () => {
    const files = Array.from({ length: 10 }, (_, i) => saved(`c${i}`, i))
    assert.deepEqual(planLoad(files, [], historyLimit(undefined)).prune, [])
  })
})

describe('the loader is wired the way planLoad assumes', () => {
  const REPO_ROOT = join(__dirname, '..', '..')
  const loadSrc = readFileSync(
    join(REPO_ROOT, 'src/renderer/src/hooks/useConversations.ts'),
    'utf8'
  )
  const appSrc = readFileSync(join(REPO_ROOT, 'src/renderer/src/App.tsx'), 'utf8')
  const load = loadSrc.slice(
    loadSrc.indexOf('const load ='),
    loadSrc.indexOf('const createConversation')
  )

  test('the store is reconciled before it is replaced', () => {
    assert.ok(load.length > 0, 'useConversations no longer defines load before createConversation')
    assert.match(load, /planLoad\(/)
    assert.ok(
      load.indexOf('planLoad(') < load.indexOf('setConversations('),
      'setConversations is reached without the reconciliation'
    )
  })

  test('the reconciliation is given what the store is actually holding', () => {
    assert.match(load, /planLoad\(\s*list,\s*store\.conversations,/)
  })

  test('the cap is planLoad’s and nothing slices beside it', () => {
    // Two places deciding one boundary is how they came apart in the first
    // place: whichever half is edited, the other keeps its own idea of which
    // conversations exist.
    assert.match(load, /historyLimit\(store\.settings\?\.historyLimit\)/)
    assert.ok(!/\.slice\(/.test(load), `load slices the list itself: ${load.match(/.*\.slice\(.*/)}`)
  })

  test('only what planLoad says has a file is deleted', () => {
    assert.match(load, /for \(const stale of prune\)/)
    assert.match(load, /deleteConversation\(stale\.id\)/)
  })

  test('conversations are not reloaded because the server address changed', () => {
    // They are local files and have nothing to do with the base URL. Coupling
    // the two is what made "the store is replaced by disk" a mid-session event
    // rather than a startup one.
    const effects = appSrc.split('useEffect(')
    const withLoad = effects.filter((e) => /\bvoid load\(\)/.test(e))
    assert.equal(withLoad.length, 1, 'load() is triggered from more than one effect')
    const deps = withLoad[0]!.match(/\}, \[([^\]]*)\]\)/)
    assert.ok(deps, 'the effect that loads conversations states no dependencies')
    assert.ok(!/baseUrl/.test(deps![1]!), `load still re-runs on baseUrl: [${deps![1]}]`)
    assert.match(deps![1]!, /settingsLoaded/)
  })

  test('probing the server still follows the address it probes', () => {
    const probe = appSrc.split('useEffect(').filter((e) => /\bvoid refresh\(\)/.test(e))
    assert.equal(probe.length, 1)
    assert.match(probe[0]!.match(/\}, \[([^\]]*)\]\)/)![1]!, /baseUrl/)
  })
})
