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
