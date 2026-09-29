import { ACCENT } from '../../../lib/colors'
import type { AccentColor } from '../../../types'

/**
 * A role's colour (v4.0): a label, not a status, so it keeps the measured
 * role palette (lib/colors.ts) rather than the status tones. Marked so the
 * kit check knows it is not a status dot in the wrong palette.
 */
export function RoleDot({ color, size = 'md' }: { color: AccentColor; size?: 'sm' | 'md' }): JSX.Element {
  return <span aria-hidden="true" data-accent-dot className={`inline-block shrink-0 rounded-full ${size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5'} ${ACCENT[color].dot}`} />
}
