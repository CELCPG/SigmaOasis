/**
 * v4.2 (R3): MessageBubble.tsx, as the checks that scrape it read it.
 *
 * Its self-contained pieces (the grounding banner, the provenance strip, the
 * revised and think-harder lines, the phase line, the slow-start line, the
 * image gallery) moved verbatim into sibling files. The checks that pin class
 * strings and structure read the bubble whole: these files, in the order the
 * single file held them, so a `section(from, to)` boundary or a first match
 * lands exactly where it did before the split.
 */
import { join } from 'path'
import { readSource } from './harness'

export const MESSAGE_BUBBLE_FILES = [
  'ToolImageGallery.tsx',
  'GroundingWarning.tsx',
  'RevisedLine.tsx',
  'DeliberationLine.tsx',
  'MemoryContextLine.tsx',
  'TurnPhaseLine.tsx',
  'MessageBubble.tsx',
  'SlowReadingLine.tsx'
] as const

const COMPONENTS = join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components')

/** The bubble's source across its files. `read` defaults to the CRLF-folding reader. */
export function messageBubbleSource(read: (path: string) => string = readSource): string {
  return MESSAGE_BUBBLE_FILES.map((name) => read(join(COMPONENTS, name))).join('\n')
}
