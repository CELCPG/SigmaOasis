import type { ModelConfig, ToolCallRecord } from '../types'
import { streamChat } from './chatTransport'
import { SOURCE_CHECK_MAX_TOKENS, checkAgainstSources, type SourceCheckOutcome } from '../lib/sourceCheck'

/**
 * v4.1 (G4): the source check's one effect — the answering model's short,
 * uncached, tool-less completions (lib/sourceCheck.ts has the pass and why).
 * Cool and short: a verdict is two lines, and temperature 0 makes the same
 * sentence over the same sources come back the same.
 */
export async function runSourceCheck(
  slot: ModelConfig,
  baseUrl: string,
  reply: string,
  records: ToolCallRecord[],
  signal: AbortSignal
): Promise<SourceCheckOutcome> {
  return checkAgainstSources(reply, records, slot.modelId, {
    aborted: () => signal.aborted,
    complete: async (messages) => {
      let text = ''
      await streamChat(
        baseUrl,
        slot.modelId,
        messages,
        [],
        signal,
        (chunk) => {
          text += chunk
        },
        undefined,
        { ...slot.sampling, temperature: 0, maxTokens: SOURCE_CHECK_MAX_TOKENS }
      )
      return text
    }
  })
}
