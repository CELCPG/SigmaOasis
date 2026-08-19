import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { useAppStore } from '../src/renderer/src/stores/appStore'
import type { Conversation } from '../src/renderer/src/types'

/**
 * v1.11 split view. The invariant everything else depends on:
 * `activeConversationId` always names the FOCUSED pane, because every turn
 * entry point and the chat panel read it and nothing else. `splitOnLeft` exists
 * so focusing a pane can swap the two ids without the chat you are reading
 * moving on screen.
 */

function convo(id: string): Conversation {
  return { id, title: id, mode: 'independent', messages: [], createdAt: 1, updatedAt: 1 }
}

/** Where each chat actually renders, mirroring App.tsx's layout decision. */
function layout(): { left: string | null; right: string | null; focused: string | null } {
  const s = useAppStore.getState()
  const [left, right] = s.splitOnLeft
    ? [s.splitConversationId, s.activeConversationId]
    : [s.activeConversationId, s.splitConversationId]
  return { left, right, focused: s.activeConversationId }
}

beforeEach(() => {
  useAppStore.setState({
    conversations: [convo('a'), convo('b'), convo('c')],
    activeConversationId: 'a',
    splitConversationId: null,
    splitOnLeft: false,
    streaming: false
  })
})

describe('opening and closing a split', () => {
  test('the chat already on screen keeps its side; the new one takes focus', () => {
    useAppStore.getState().openSplit('b')
    assert.deepEqual(layout(), { left: 'a', right: 'b', focused: 'b' })
  })

  test('splitting against the focused chat itself is refused', () => {
    useAppStore.getState().openSplit('a')
    assert.equal(useAppStore.getState().splitConversationId, null)
    assert.equal(useAppStore.getState().activeConversationId, 'a')
  })

  test('closing keeps the focused chat and resets the side', () => {
    useAppStore.getState().openSplit('b')
    useAppStore.getState().closeSplit()
    assert.equal(useAppStore.getState().activeConversationId, 'b')
    assert.equal(useAppStore.getState().splitConversationId, null)
    assert.equal(useAppStore.getState().splitOnLeft, false)
  })
})

describe('focus moves without anything moving on screen', () => {
  test('focusing the other pane swaps ids and flips the side', () => {
    useAppStore.getState().openSplit('b')
    const before = layout()
    useAppStore.getState().focusOtherPane()
    const after = layout()
    // Same chats, same sides — only the focus changed.
    assert.equal(after.left, before.left)
    assert.equal(after.right, before.right)
    assert.equal(after.focused, 'a')
    assert.notEqual(after.focused, before.focused)
  })

  test('focusing twice returns to where it started', () => {
    useAppStore.getState().openSplit('b')
    const before = layout()
    useAppStore.getState().focusOtherPane()
    useAppStore.getState().focusOtherPane()
    assert.deepEqual(layout(), before)
  })

  test('focusOtherPane is a no-op with no split open', () => {
    useAppStore.getState().focusOtherPane()
    assert.deepEqual(layout(), { left: 'a', right: null, focused: 'a' })
  })
})

describe('selecting a chat that is already in the other pane', () => {
  test('focuses that pane instead of showing the chat twice', () => {
    useAppStore.getState().openSplit('b') // a | b, focused b
    useAppStore.getState().setActiveConversationId('a')
    const s = useAppStore.getState()
    assert.equal(s.activeConversationId, 'a')
    assert.equal(s.splitConversationId, 'b')
    // And nothing moved: a was on the left and stays there.
    assert.deepEqual(layout(), { left: 'a', right: 'b', focused: 'a' })
  })

  test('selecting a third chat replaces the focused pane only', () => {
    useAppStore.getState().openSplit('b') // a | b, focused b
    useAppStore.getState().setActiveConversationId('c')
    assert.deepEqual(layout(), { left: 'a', right: 'c', focused: 'c' })
  })

  test('no chat is ever in both panes', () => {
    useAppStore.getState().openSplit('b')
    for (const id of ['a', 'b', 'c', 'a', 'b']) {
      useAppStore.getState().setActiveConversationId(id)
      const s = useAppStore.getState()
      assert.notEqual(s.activeConversationId, s.splitConversationId)
    }
  })
})

describe('closing one pane', () => {
  // ChatPane focuses whichever pane was clicked (capture phase) before the ✕
  // handler runs, so "close this pane" is always focusOtherPane + closeSplit —
  // the sequence drops the focused chat and keeps the other, whichever was
  // clicked. Branching on a `focused` prop here read a stale value.
  test('drops the focused chat and keeps the other', () => {
    useAppStore.getState().openSplit('b') // a | b, focused b
    useAppStore.getState().focusOtherPane()
    useAppStore.getState().closeSplit()
    const s = useAppStore.getState()
    assert.equal(s.activeConversationId, 'a')
    assert.equal(s.splitConversationId, null)
  })
})

describe('deleting a chat that a pane is showing', () => {
  test('deleting the focused chat promotes the split pane', () => {
    useAppStore.getState().openSplit('b') // a | b, focused b
    useAppStore.getState().removeConversation('b')
    const s = useAppStore.getState()
    assert.equal(s.activeConversationId, 'a')
    assert.equal(s.splitConversationId, null, 'no pane left pointing at a deleted chat')
    assert.equal(s.splitOnLeft, false)
  })

  test('deleting the unfocused chat closes the split and keeps focus', () => {
    useAppStore.getState().openSplit('b') // a | b, focused b
    useAppStore.getState().removeConversation('a')
    const s = useAppStore.getState()
    assert.equal(s.activeConversationId, 'b')
    assert.equal(s.splitConversationId, null)
  })

  test('deleting an unrelated chat leaves both panes alone', () => {
    useAppStore.getState().openSplit('b')
    const before = layout()
    useAppStore.getState().removeConversation('c')
    assert.deepEqual(layout(), before)
  })
})
