import { DOT_TONE, type Tone } from './tokens'

/** One status dot, one size, one palette (v4.0). Decorative: the text beside it says the state. */
export function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }): JSX.Element {
  return <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT_TONE[tone]}${pulse ? ' animate-pulse' : ''}`} />
}
