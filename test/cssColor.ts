/**
 * A computed CSS colour, as Chromium serializes it, to sRGB 0–255 and alpha.
 *
 * v4.7 (M1): until Tailwind 4 every colour the checks read came back as
 * `rgb()`/`rgba()`, and each check took "the first three or four numbers" of
 * the string. Tailwind 4 writes an opacity modifier (`bg-violet-500/15`) as
 * `color-mix(in oklab, …)`, which the engine reports as `oklab(L a b / A)`, and
 * the same reading turned a violet chip into a dark grey: it dropped the minus
 * signs and read L, a and b as red, green and blue. A check measuring contrast
 * against that grey reports a number for a colour that is not on the screen.
 *
 * One reading for every check, exact where the engine is: hex, rgb()/rgba() in
 * either syntax, color(srgb …), oklab() and oklch() — the last two by Björn
 * Ottosson's OKLab → linear sRGB matrices and the sRGB transfer function, the
 * same maths the engine uses to paint them. Anything else throws, naming the
 * value, rather than measuring something else.
 *
 * Self-contained on purpose: the checks that read colours inside the page
 * inline its source (`CSS_COLOR_PARSE_JS`), so it may use no import, no
 * closure and no helper outside its own body.
 */
export function parseCssColor(value: string): [number, number, number, number] {
  const s = value.trim().toLowerCase()
  if (s === 'transparent') return [0, 0, 0, 0]

  const hex = /^#([0-9a-f]{3,8})$/.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
    if (h.length !== 6 && h.length !== 8) throw new Error(`unparseable color: ${value}`)
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16)
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1]
  }

  const fn = /^([a-z]+)\((.*)\)$/.exec(s)
  if (!fn) throw new Error(`unparseable color: ${value}`)
  const name = fn[1]
  // Components and alpha, in either syntax: "r, g, b, a" or "x y z / a".
  const [body, alphaPart] = fn[2].includes('/') ? fn[2].split('/') : [fn[2], undefined]
  const parts = body.split(/[\s,]+/).filter((p) => p !== '')
  const num = (p: string | undefined, percentScale: number): number => {
    if (p === undefined || p === 'none') return 0
    if (p.endsWith('%')) return (parseFloat(p) / 100) * percentScale
    if (p.endsWith('deg')) return parseFloat(p)
    return parseFloat(p)
  }
  let alpha = 1
  if (alphaPart !== undefined) alpha = num(alphaPart.trim(), 1)
  else if ((name === 'rgba' || name === 'rgb') && parts.length === 4) alpha = num(parts[3], 1)

  const toByte = (linear: number): number => {
    const c = Math.min(1, Math.max(0, linear))
    const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
    return encoded * 255
  }
  const fromOklab = (L: number, a: number, b: number): [number, number, number] => {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3)
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3)
    const k = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3)
    return [
      toByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * k),
      toByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * k),
      toByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * k)
    ]
  }

  if (name === 'rgb' || name === 'rgba') {
    if (parts.length < 3) throw new Error(`unparseable color: ${value}`)
    return [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255), alpha]
  }
  if (name === 'color') {
    if (parts[0] !== 'srgb' || parts.length < 4) throw new Error(`unsupported color space: ${value}`)
    return [num(parts[1], 1) * 255, num(parts[2], 1) * 255, num(parts[3], 1) * 255, alpha]
  }
  if (name === 'oklab') {
    if (parts.length < 3) throw new Error(`unparseable color: ${value}`)
    const [r, g, b] = fromOklab(num(parts[0], 1), num(parts[1], 0.4), num(parts[2], 0.4))
    return [r, g, b, alpha]
  }
  if (name === 'oklch') {
    if (parts.length < 3) throw new Error(`unparseable color: ${value}`)
    const L = num(parts[0], 1)
    const C = num(parts[1], 0.4)
    const h = (num(parts[2], 1) * Math.PI) / 180
    const [r, g, b] = fromOklab(L, C * Math.cos(h), C * Math.sin(h))
    return [r, g, b, alpha]
  }
  throw new Error(`unsupported color function: ${value}`)
}

/**
 * The same function as page script: `const parse = (…) => …`, for a check that
 * reads colours inside the page it measures.
 */
export const CSS_COLOR_PARSE_JS = `const parse = ${parseCssColor.toString()}`
