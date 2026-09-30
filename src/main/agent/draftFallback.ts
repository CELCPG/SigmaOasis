import { createSseFrameReader, frameError, parseChatFrame } from '../../shared/sse'
import { isDraftRejection, withoutDraft } from '../../shared/draftModel'
import type { ChunkTransport } from './types'

/**
 * v4.2 (S8): a draft model the server refuses never fails the agent's round.
 *
 * The draft rides the request body (`draft_model`, shared/draftModel.ts). A
 * server can refuse it two ways: an HTTP error before the stream, or a 200
 * whose first frame is an error. Either way, when the words mention the
 * draft, the same request goes once more without the field and the refusal is
 * reported for the notice on Settings → LM Studio.
 *
 * To catch the second way, the bytes are held until the first complete frame
 * is read: an error about the draft is swallowed, anything else releases what
 * was held and the stream passes through untouched. A wrapper at the
 * transport, so the engine (another track's) is not touched and reads the
 * same bytes it always did.
 */
export function withDraftFallback(inner: ChunkTransport, onRejected: (detail: string) => void): ChunkTransport {
  // Once refused, every later round of the task goes without the draft: one
  // retried request per task, not one per round.
  let refusedOnce = false
  return async (url, init) => {
    const stripped = withoutDraft(init.body)
    if (stripped === null) return inner(url, init)
    if (refusedOnce) return inner(url, { ...init, body: stripped })

    // Widened by the cast: the callbacks below move it, which flow analysis cannot see.
    let state = 'peek' as 'peek' | 'pass' | 'refused'
    let held: Uint8Array[] = []
    let refusal = ''
    const frames = createSseFrameReader()
    const decoder = new TextDecoder()
    const decide = (payloads: string[]): void => {
      for (const p of payloads) {
        if (state !== 'peek') return
        const f = parseChatFrame(p)
        if (!f) continue
        const error = frameError(f)
        if (error !== null && isDraftRejection(error)) {
          state = 'refused'
          refusal = error
          held = []
          return
        }
        state = 'pass'
        for (const h of held) init.onChunk(h)
        held = []
      }
    }
    const res = await inner(url, {
      ...init,
      onChunk: (chunk) => {
        if (state === 'pass') return init.onChunk(chunk)
        if (state === 'refused') return
        held.push(chunk)
        decide(frames.push(decoder.decode(chunk, { stream: true })))
      }
    })
    if (state === 'peek') decide(frames.flush())
    // A stream that ended before any frame parsed: give the reader what came.
    if (state === 'peek') for (const h of held) init.onChunk(h)

    if (state === 'refused' || (!res.ok && isDraftRejection(res.errorText))) {
      refusedOnce = true
      onRejected(state === 'refused' ? refusal : (res.errorText ?? `HTTP ${res.status}`))
      return inner(url, { ...init, body: stripped })
    }
    return res
  }
}
