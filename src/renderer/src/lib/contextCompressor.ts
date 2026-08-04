/**
 * Context compression utility for long conversations.
 * Summarizes older messages to preserve context while reducing token usage.
 */

import type { ChatMessage } from '../types'

const MESSAGE_AGE_THRESHOLD = 10 // Compress messages older than N turns

interface CompressionResult {
  compressedMessages: ChatMessage[]
  summary: string
  originalCharCount: number
  compressedCharCount: number
}

/**
 * Compress older messages in a conversation by summarizing them.
 * Keeps recent messages intact, summarizes older ones into a single block.
 */
export async function compressOlderMessages(
  messages: ChatMessage[],
  threshold: number = MESSAGE_AGE_THRESHOLD
): Promise<CompressionResult> {
  if (messages.length <= threshold) {
    return {
      compressedMessages: messages,
      summary: '',
      originalCharCount: getTotalCharCount(messages),
      compressedCharCount: getTotalCharCount(messages)
    }
  }

  const recentMessages = messages.slice(-threshold)
  const olderMessages = messages.slice(0, -threshold)
  
  const summary = await generateSummary(olderMessages)
  
  // Create a synthetic system message with the summary
  const summaryMessage: ChatMessage = {
    id: `summary-${Date.now()}`,
    role: 'assistant',
    content: `[Context Summary of ${olderMessages.length} earlier messages]\n${summary}`,
    modelId: 'context-compressor',
    roleName: 'System',
    color: 'blue',
    createdAt: olderMessages[0]?.createdAt ?? Date.now(),
    branchInfo: { branchId: 'compression', isBranch: false }
  }

  const compressedMessages = [summaryMessage, ...recentMessages]

  return {
    compressedMessages,
    summary,
    originalCharCount: getTotalCharCount(messages),
    compressedCharCount: getTotalCharCount(compressedMessages)
  }
}

/**
 * Generate a concise summary of a list of messages.
 * In production, this would call a fast local model.
 * For now, uses a simple heuristic approach.
 */
async function generateSummary(messages: ChatMessage[]): Promise<string> {
  if (messages.length === 0) return ''

  // Simple heuristic summary (in production, use a local LLM)
  const userQueries = messages
    .filter(m => m.role === 'user')
    .map(m => m.content.split('\n')[0].slice(0, 100))
    .slice(0, 5) // Top 5 user queries

  const assistantTopics = messages
    .filter(m => m.role === 'assistant' && !m.modelId?.includes('compressor'))
    .map(m => {
      // Extract key topics from assistant response
      const firstLine = m.content.split('\n')[0].slice(0, 80)
      return firstLine
    })
    .slice(0, 5)

  const parts: string[] = []
  
  if (userQueries.length > 0) {
    parts.push(`User asked about: ${userQueries.join('; ')}`)
  }
  
  if (assistantTopics.length > 0) {
    parts.push(`Assistant covered: ${assistantTopics.join('; ')}`)
  }

  // Check for code blocks
  const codeBlockCount = messages.filter(m => m.content.includes('```')).length
  if (codeBlockCount > 0) {
    parts.push(`${codeBlockCount} code example(s) were provided`)
  }

  // Check for tool calls
  const toolCallCount = messages.reduce((sum, m) => sum + (m.toolCalls?.length ?? 0), 0)
  if (toolCallCount > 0) {
    parts.push(`${toolCallCount} tool operations were performed`)
  }

  return parts.join('.\n') || 'Previous conversation context'
}

function getTotalCharCount(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => {
    let count = m.content.length
    if (m.attachments) {
      count += m.attachments.reduce((s, a) => s + (a.textContent?.length ?? 0), 0)
    }
    return sum + count
  }, 0)
}

/**
 * Smart trim that combines history trimming with optional compression.
 * Falls back to simple trimming if compression doesn't help enough.
 */
export function smartTrimHistory(
  messages: ChatMessage[],
  maxMessages: number = 40,
  maxChars: number = 48_000
): ChatMessage[] {
  // First try simple trimming
  const trimmed = trimMessages(messages, maxMessages, maxChars)
  
  // If still too large, try compression
  if (getTotalCharCount(trimmed) > maxChars * 0.9 && trimmed.length > 15) {
    const compressed = compressOlderMessagesSync(trimmed, 12)
    if (getTotalCharCount(compressed) < getTotalCharCount(trimmed)) {
      return compressToLimit(compressed, maxMessages, maxChars)
    }
  }
  
  return trimmed
}

function trimMessages(messages: ChatMessage[], maxMessages: number, maxChars: number): ChatMessage[] {
  const kept: ChatMessage[] = []
  let chars = 0
  
  for (let i = messages.length - 1; i >= 0 && kept.length < maxMessages; i--) {
    const m = messages[i]
    const size = m.content.length + (m.attachments ?? []).reduce((n, a) => n + (a.textContent?.length ?? 0), 0)
    
    if (kept.length > 0 && chars + size > maxChars) break
    
    kept.unshift(m)
    chars += size
  }
  
  return kept
}

function compressOlderMessagesSync(messages: ChatMessage[], threshold: number): ChatMessage[] {
  if (messages.length <= threshold) return messages
  
  const recentMessages = messages.slice(-threshold)
  const olderMessages = messages.slice(0, -threshold)
  
  const summary = generateSummarySync(olderMessages)
  
  const summaryMessage: ChatMessage = {
    id: `summary-${Date.now()}`,
    role: 'assistant',
    content: `[Context Summary]\n${summary}`,
    modelId: 'context-compressor',
    roleName: 'System',
    color: 'blue',
    createdAt: olderMessages[0]?.createdAt ?? Date.now(),
    branchInfo: { branchId: 'compression', isBranch: false }
  }

  return [summaryMessage, ...recentMessages]
}

function generateSummarySync(messages: ChatMessage[]): string {
  const userCount = messages.filter(m => m.role === 'user').length
  const assistantCount = messages.filter(m => m.role === 'assistant').length
  
  return `Earlier discussion: ${userCount} user messages, ${assistantCount} assistant responses.`
}

function compressToLimit(messages: ChatMessage[], maxMessages: number, maxChars: number): ChatMessage[] {
  let result = messages
  let totalChars = getTotalCharCount(result)
  
  // Remove oldest non-summary messages until under limit
  while (totalChars > maxChars && result.length > 3) {
    const firstNonSummary = result.findIndex(m => !m.content.startsWith('[Context Summary]'))
    if (firstNonSummary === -1 || firstNonSummary >= result.length - 2) break
    
    result = result.slice(0, firstNonSummary).concat(result.slice(firstNonSummary + 1))
    totalChars = getTotalCharCount(result)
  }
  
  return result
}
