import type { ChatMessage } from '../types'
import { describeRevisionOutcome } from '../lib/toolGrounding'

/**
 * The answer on screen is not the one the model first produced. Saying so is
 * not optional: a correction the user cannot see is the app quietly editing the
 * record, which is exactly what every other check here exists to prevent.
 *
 * But saying it is not enough on its own. Through v1.14 this line read "N
 * unsupported items were sent back for verification or removal" — a request,
 * described in green as though it were an outcome — and a revision is kept
 * whenever it *reduces* the findings, so it sat over answers where the finding
 * was still standing. See `describeRevisionOutcome`; the wording, the count and
 * the tone are all its verdict, and this component only paints it.
 *
 * `after` on the record is authoritative. `grounding` is the same report and is
 * the fallback for messages persisted before `after` was stored.
 */
export function RevisedLine({ message }: { message: ChatMessage }): JSX.Element | null {
  const revision = describeRevisionOutcome(
    message.corrected?.before ?? null,
    message.corrected?.after ?? message.grounding ?? null
  )
  if (!revision.text) return null
  return (
    <div
      className={
        revision.resolved
          ? 'mt-2 text-[11px] text-ink-ok'
          : 'mt-2 text-[11px] text-ink-warn'
      }
      title={
        revision.resolved
          ? 'A mechanical check found specifics the turn\'s tools did not support, and the ' +
            'model was asked to verify or remove them. What you are reading is the revision, ' +
            're-checked: none of the named items is still faulted.'
          : 'A mechanical check found specifics the turn\'s tools did not support, and the ' +
            'model was asked to verify or remove them. What you are reading is the revision — ' +
            'and the items named here survived it, so they are still unsupported.'
      }
    >
      ✎ {revision.text}
    </div>
  )
}
