import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'
import type { RowMeta } from '../../../lib/settingsKit'
import { HELP, LABEL } from './tokens'

export interface RowProps {
  meta: RowMeta
  /** The control. A single element gets the row's label and help ids wired to it. */
  children?: ReactNode
  /**
   * `inline` (default): label and help left, control right — for a switch, a
   * select, a stepper. `stack`: the control under the label at full width —
   * for a text field, a textarea, a segmented control with cards.
   */
  layout?: 'inline' | 'stack'
  /** A second line under the control: a status, a warning, a note. */
  foot?: ReactNode
}

/**
 * One setting: its label, its help, and its control (v4.0). The one place
 * the label size and the help ink are set, so every tab reads the same.
 * The row carries a `data-row` id so a deep link can scroll to it and the
 * kit check can prove every control lives in one.
 */
export function Row({ meta, children, layout = 'inline', foot }: RowProps): JSX.Element {
  const base = useId()
  const labelId = `${base}-label`
  const helpId = meta.help ? `${base}-help` : undefined
  const control =
    isValidElement(children) && typeof children.type !== 'string'
      ? cloneElement(children as ReactElement<{ labelledBy?: string; describedBy?: string }>, {
          labelledBy: labelId,
          describedBy: helpId
        })
      : children

  if (layout === 'stack') {
    return (
      <div className="kit-row" data-row={meta.id}>
        <div id={labelId} className={LABEL}>
          {meta.label}
        </div>
        {meta.help && (
          <p id={helpId} data-help className={`${HELP} mt-0.5`}>
            {meta.help}
          </p>
        )}
        <div className="mt-2">{control}</div>
        {foot && <div className="mt-1.5">{foot}</div>}
      </div>
    )
  }
  return (
    <div className="kit-row" data-row={meta.id}>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div id={labelId} className={LABEL}>
            {meta.label}
          </div>
          {meta.help && (
            <p id={helpId} data-help className={`${HELP} mt-0.5`}>
              {meta.help}
            </p>
          )}
        </div>
        {control !== undefined && control !== null && <div className="flex shrink-0 items-center pt-0.5">{control}</div>}
      </div>
      {foot && <div className="mt-1.5">{foot}</div>}
    </div>
  )
}
