import type { ContextProvider } from './types'
import { tabularAttachmentsOnTurn } from '../attachmentRecall'

/**
 * v1.6: a data file attached on this turn is profiled before the model speaks
 * — the "describe the data before analysing it" step of the data playbook,
 * done mechanically, so the model starts from the file's real shape, types,
 * ranges and a head instead of a slice of it. Recorded like any tool call;
 * the file stays available to run_python at /work/<name>. At most two files.
 */
export const tabularProfileProvider: ContextProvider = {
  id: 'tabularProfile',
  phase: 'serial',
  enabled: (input) =>
    tabularAttachmentsOnTurn(input.convo).length > 0 &&
    input.slotTools.some((t) => t.function.name === 'analyze_file'),
  async gather(input, io) {
    const blocks: string[] = []
    for (const file of tabularAttachmentsOnTurn(input.convo).slice(0, 2)) {
      const result = await io.runTool('analyze_file', { file })
      if (result.ok && result.output) {
        blocks.push(
          `The app profiled the attached data file "${file}" before you answered (analyze_file). Use these facts; ` +
            'compute anything further with run_python on /work/' + file + ' rather than estimating from the head:\n' +
            result.output
        )
      }
      if (input.signal.aborted) break
    }
    return blocks.length > 0 ? { blocks } : null
  }
}
