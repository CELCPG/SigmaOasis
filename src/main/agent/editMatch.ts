/**
 * Search-and-replace for the agent's edit_file (v3.0) — the pure half.
 *
 * An exact match is always tried first, and it is what a well-behaved call
 * gets. Then three recoveries, each for a way a small model's `old_string` is
 * right about the code and wrong about the bytes, all measured as the common
 * failures of search/replace editing:
 *
 * 1. **Line endings.** read_file shows lines, not `\r`, so a model editing a
 *    CRLF file on Windows quotes LF text that is never found. The edit is
 *    retried with its text in the file's own line ending, and the new text
 *    lands in that ending too — a CRLF file stays CRLF.
 * 2. **Line-number prefixes.** read_file numbers its lines; a model that
 *    pastes `   12\tconst x = 1` as its search has quoted the display, not the
 *    file. When every line of the search carries a prefix, they are stripped
 *    (from the replacement too, if it has them) and the edit retried.
 * 3. **Trailing whitespace.** Compared line by line with trailing spaces
 *    ignored, and accepted only when that finds exactly one place.
 *
 * None of them guesses between places: an ambiguous match is an error in
 * every tier, with the count, so the model adds context instead of the app
 * picking an occurrence. A miss says where the closest line is.
 */

export type EditMatch =
  | { ok: true; text: string; count: number; how: 'exact' | 'line-endings' | 'line-numbers' | 'trailing-space' }
  | { ok: false; error: string }

const NUMBERED = /^\s*\d+(?:\t|→|\s\|\s?)/

function countOf(haystack: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  let at = haystack.indexOf(needle)
  while (at >= 0) {
    n++
    at = haystack.indexOf(needle, at + needle.length)
  }
  return n
}

function replaceExact(
  text: string,
  oldS: string,
  newS: string,
  replaceAll: boolean,
  how: 'exact' | 'line-endings' | 'line-numbers'
): EditMatch | null {
  const n = countOf(text, oldS)
  if (n === 0) return null
  if (n > 1 && !replaceAll) {
    return {
      ok: false,
      error:
        `old_string occurs ${n} times in the file. Include more surrounding lines so it matches exactly one place, ` +
        'or set replace_all to true to change every occurrence.'
    }
  }
  return { ok: true, text: replaceAll ? text.split(oldS).join(newS) : text.replace(oldS, () => newS), count: n, how }
}

function withEol(s: string, eol: string): string {
  return s.replace(/\r?\n/g, eol)
}

function tryWithEndings(text: string, oldS: string, newS: string, replaceAll: boolean, how: 'exact' | 'line-numbers'): EditMatch | null {
  const direct = replaceExact(text, oldS, newS, replaceAll, how)
  if (direct) return direct
  if (text.includes('\r\n') && !oldS.includes('\r\n')) {
    return replaceExact(text, withEol(oldS, '\r\n'), withEol(newS, '\r\n'), replaceAll, how === 'exact' ? 'line-endings' : how)
  }
  return null
}

function stripNumbers(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(NUMBERED, ''))
    .join('\n')
}

export function applyEdit(original: string, oldString: string, newString: string, replaceAll = false): EditMatch {
  if (oldString === newString) return { ok: false, error: 'old_string and new_string are identical; there is nothing to change.' }
  if (oldString === '') return { ok: false, error: 'old_string is empty. To create a file use write_file; to change one, quote the exact text to replace.' }

  const tier1 = tryWithEndings(original, oldString, newString, replaceAll, 'exact')
  if (tier1) return tier1

  const lines = oldString.split('\n').filter((l) => l.trim() !== '')
  if (lines.length > 0 && lines.every((l) => NUMBERED.test(l))) {
    const newLines = newString.split('\n').filter((l) => l.trim() !== '')
    const newStripped = newLines.length > 0 && newLines.every((l) => NUMBERED.test(l)) ? stripNumbers(newString) : newString
    const tier2 = tryWithEndings(original, stripNumbers(oldString), newStripped, replaceAll, 'line-numbers')
    if (tier2) return tier2
  }

  const tier3 = trailingSpaceMatch(original, oldString, newString)
  if (tier3) return tier3

  return { ok: false, error: notFound(original, oldString) }
}

/** Line-by-line comparison with trailing whitespace ignored; exactly one hit or nothing. */
function trailingSpaceMatch(original: string, oldString: string, newString: string): EditMatch | null {
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const fileLines = original.split(/\r?\n/)
  // A search that ends at a line break names whole lines; so does its
  // replacement, and the break itself is the file's, not the edit's.
  const endsAtBreak = /\r?\n$/.test(oldString)
  const want = oldString.replace(/\r?\n$/, '').split(/\r?\n/).map((l) => l.trimEnd())
  if (want.length === 1 && want[0] === '') return null
  const hits: number[] = []
  for (let i = 0; i + want.length <= fileLines.length; i++) {
    let same = true
    for (let j = 0; j < want.length; j++) {
      if (fileLines[i + j]!.trimEnd() !== want[j]) {
        same = false
        break
      }
    }
    if (same) hits.push(i)
  }
  if (hits.length !== 1) return null
  const at = hits[0]!
  const repl = endsAtBreak ? newString.replace(/\r?\n$/, '') : newString
  const replacement = repl === '' ? [] : repl.split(/\r?\n/)
  const next = [...fileLines.slice(0, at), ...replacement, ...fileLines.slice(at + want.length)].join(eol)
  return { ok: true, text: next, count: 1, how: 'trailing-space' }
}

/** Say where the closest line is, so the next attempt quotes the file rather than memory. */
function notFound(original: string, oldString: string): string {
  const first = oldString
    .split(/\r?\n/)
    .map((l) => l.replace(NUMBERED, '').trim())
    .find((l) => l.length > 0)
  const base = 'old_string was not found in the file. Copy it exactly from read_file output — without the line numbers — including indentation.'
  if (!first) return base
  const fileLines = original.split(/\r?\n/)
  const exact = fileLines.findIndex((l) => l.trim() === first)
  if (exact >= 0) {
    return `${base} Its first line appears at line ${exact + 1}; read that region again and quote the lines after it exactly.`
  }
  const words = first.split(/\W+/).filter((w) => w.length > 2)
  let best = -1
  let bestScore = 0
  fileLines.forEach((l, i) => {
    const score = words.filter((w) => l.includes(w)).length
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  })
  if (best >= 0 && bestScore >= Math.max(1, Math.ceil(words.length / 2))) {
    return `${base} The closest line is ${best + 1}: \`${fileLines[best]!.trim().slice(0, 160)}\`.`
  }
  return base
}
