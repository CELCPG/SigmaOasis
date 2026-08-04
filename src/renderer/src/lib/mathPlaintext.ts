/**
 * LaTeX math markup → readable plain text.
 *
 * Local chat models (Gemma in particular) like to wrap numbers, units, and
 * arrows in TeX: `$374^\circ\text{C}$`, `$\rightarrow$`, `$\frac{a}{b}$`.
 * The chat renderer handles Markdown but has no math engine, so that markup
 * used to leak through raw and readers saw literal dollar signs and
 * backslashes. This module rewrites the common cases into Unicode plain text
 * before Markdown rendering:
 *
 *   $374^\circ\text{C}$   →  374°C
 *   $\frac{a+b}{c}$       →  (a+b)/c
 *   $x^{2}$ / $H_2O$      →  x² / H₂O
 *   $\rightarrow$         →  →
 *
 * It is a string transform, not a TeX parser: anything it does not recognize
 * is left close to the source rather than dropped. Code spans and fenced code
 * blocks are protected, and currency like "$20 and $30" is left alone.
 */

// Private-use-area sentinels. They survive every regex below because they
// contain no TeX markers, and real user text essentially never uses them.
const CODE_OPEN = ''
const CODE_CLOSE = ''

// [escaped form, placeholder, restored character] for TeX-escaped punctuation.
const ESCAPED_CHARS: Array<[RegExp, string, string]> = [
  [/\\\$/g, '', '$'],
  [/\\%/g, '', '%'],
  [/\\_/g, '', '_'],
  [/\\&/g, '', '&'],
  [/\\#/g, '', '#'],
  [/\\\{/g, '', '{'],
  [/\\\}/g, '', '}']
]

const COMMANDS: Record<string, string> = {
  // Arrows
  rightarrow: '→', to: '→', gets: '←', leftarrow: '←',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', leftrightarrow: '↔',
  mapsto: '↦', implies: '⇒', impliedby: '⇐', iff: '⇔',
  // Operators and relations
  times: '×', div: '÷', cdot: '·', ast: '∗', pm: '±', mp: '∓',
  oplus: '⊕', otimes: '⊗', bullet: '•',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
  equiv: '≡', approx: '≈', cong: '≅', simeq: '≃', sim: '∼', propto: '∝',
  ll: '≪', gg: '≫',
  // Big symbols
  infty: '∞', partial: '∂', nabla: '∇', hbar: 'ℏ', ell: 'ℓ',
  Re: 'ℜ', Im: 'ℑ', wp: '℘', aleph: 'ℵ',
  sum: '∑', prod: '∏', int: '∫', iint: '∬', oint: '∮',
  bigcup: '⋃', bigcap: '⋂',
  // Sets and logic
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃',
  subseteq: '⊆', supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖',
  emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬',
  land: '∧', wedge: '∧', lor: '∨', vee: '∨',
  top: '⊤', bot: '⊥', vdash: '⊢', models: '⊨',
  // Greek
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ',
  varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς',
  tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // Misc
  ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  prime: '′', angle: '∠', perp: '⊥', parallel: '∥', mid: '∣',
  circ: '°', degree: '°',
  langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋'
}

const COMMAND_RE = new RegExp(
  `\\\\(${Object.keys(COMMANDS).sort((a, b) => b.length - a.length).join('|')})\\b`,
  'g'
)

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ'
}

const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ',
  n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ'
}

function toScript(content: string, map: Record<string, string>, marker: string): string {
  let out = ''
  for (const ch of content) {
    const mapped = map[ch]
    if (!mapped) return content.length === 1 ? `${marker}${content}` : `${marker}(${content})`
    out += mapped
  }
  return out
}

function formatFraction(a: string, b: string): string {
  const wrap = (s: string) => (/[+\-−\s]/.test(s) && s.length > 1 ? `(${s})` : s)
  return `${wrap(a)}/${wrap(b)}`
}

/** Convert the inside of one math expression to plain text. */
function texToPlain(tex: string): string {
  let s = tex

  for (const [pattern, placeholder] of ESCAPED_CHARS) {
    s = s.replace(pattern, placeholder)
  }

  // \text{...} and friends keep their contents. Loop for nesting.
  let prev = ''
  while (prev !== s) {
    prev = s
    s = s.replace(
      /\\(?:text|mathrm|mathbf|mathit|mathsf|mathtt|textbf|textit|textrm|textsf|texttt|operatorname|boldsymbol)\{([^{}]*)\}/g,
      '$1'
    )
  }

  // Degree superscripts before generic superscript handling: ^\circ, ^{\circ}.
  s = s.replace(/\^\s*\{?\s*\\circ\s*\}?/g, '°')
  s = s.replace(/\^\s*\{?\s*\\degree\s*\}?/g, '°')

  // Fractions and roots. Loop so nested fractions resolve inside out.
  prev = ''
  while (prev !== s) {
    prev = s
    s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_m, a: string, b: string) =>
      formatFraction(a, b)
    )
  }
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)')
  s = s.replace(/\\sqrt\s*([^\s{])/g, '√$1')

  // Spacing commands.
  s = s.replace(/\\(quad|qquad)\b/g, '  ')
  s = s.replace(/\\[,;:]/g, ' ')
  s = s.replace(/\\ /g, ' ')
  s = s.replace(/\\!/g, '')

  // Named symbols.
  s = s.replace(COMMAND_RE, (_m, name: string) => COMMANDS[name])

  // Super/subscripts: single tokens first, so the parenthesized fallback the
  // braced pass produces (e.g. ^(iθ)) is not re-processed as ^( + "iθ)".
  s = s.replace(/\^([A-Za-z0-9+\-=()])/g, (_m, c: string) => toScript(c, SUPERSCRIPT, '^'))
  s = s.replace(/\^\{([^{}]*)\}/g, (_m, c: string) => toScript(c, SUPERSCRIPT, '^'))
  s = s.replace(/_([A-Za-z0-9+\-=()])/g, (_m, c: string) => toScript(c, SUBSCRIPT, '_'))
  s = s.replace(/_\{([^{}]*)\}/g, (_m, c: string) => toScript(c, SUBSCRIPT, '_'))

  // Unknown commands: drop the backslash so \foobar reads as "foobar".
  s = s.replace(/\\([a-zA-Z]+)/g, '$1')

  // Grouping braces and ties are structural, not content.
  s = s.replace(/[{}]/g, '')
  s = s.replace(/~/g, ' ')

  for (const [, placeholder, original] of ESCAPED_CHARS) {
    s = s.split(placeholder).join(original)
  }

  return s.replace(/[ \t]{2,}/g, ' ').trim()
}

/** A $...$ span is math only when it looks like TeX or is a single token. */
function looksLikeMath(inner: string): boolean {
  if (/[\\^_{}~]/.test(inner)) return true
  // Single short tokens like x, n+1, E=mc2. Multi-word spans ("20 and ")
  // are currency text such as "$20 and $30" and must be left alone.
  return /^\S+$/.test(inner) && inner.length <= 24
}

export function latexToPlainText(input: string): string {
  let s = input

  // Protect fenced code blocks and inline code spans.
  const protectedSpans: string[] = []
  const stash = (text: string): string => {
    protectedSpans.push(text)
    return `${CODE_OPEN}${protectedSpans.length - 1}${CODE_CLOSE}`
  }
  s = s.replace(/```[\s\S]*?(?:```|$)/g, (m) => stash(m))
  s = s.replace(/`[^`\n]*`/g, (m) => stash(m))

  // Escaped dollars outside math are currency, not delimiters.
  s = s.replace(/\\\$/g, ESCAPED_CHARS[0][1])

  // Display math first so its $$ delimiters are consumed before inline $.
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_m, inner: string) => `\n\n${texToPlain(inner)}\n\n`)
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_m, inner: string) => `\n\n${texToPlain(inner)}\n\n`)
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_m, inner: string) => texToPlain(inner))
  s = s.replace(/\$([^\$\n]+?)\$/g, (m, inner: string) =>
    looksLikeMath(inner) ? texToPlain(inner) : m
  )

  // Restore escaped dollars, then protected code.
  s = s.split(ESCAPED_CHARS[0][1]).join('$')
  s = s.replace(
    new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, 'g'),
    (_m, i: string) => protectedSpans[Number(i)]
  )

  return s
}
