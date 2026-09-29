/**
 * Tool results shaped for a small reader (v4.0, A2 — an experiment, off by
 * default). Every result is text a model must read, and most were raw: a test
 * runner's whole output, grep hits one per line, a listing with no sizes, and
 * a re-read after every edit to see what landed. Each function here puts the
 * part that decides the next step first and leaves the rest reachable.
 *
 * Pure: strings in, strings out, pinned in test/agentDigests.test.ts.
 */

export interface TestDigest {
  runner: 'node' | 'pytest' | 'vitest' | 'jest' | 'go' | 'cargo' | 'unknown'
  passed: number | null
  failed: number | null
  /** One line per failure: its name and, when the runner prints one, its file:line and message. */
  failures: string[]
}

/** The runner's own totals and the failures, read off its output; `unknown` when no runner's shape is found. */
export function digestTestOutput(output: string): TestDigest {
  const lines = output.split(/\r?\n/)
  const num = (re: RegExp): number | null => {
    const m = re.exec(output)
    return m ? Number(m[1]) : null
  }

  // node --test: "ℹ pass N" / "ℹ fail N" and "✖ name" lines.
  if (/^ℹ tests \d+/m.test(output)) {
    const failures = lines.filter((l) => /^\s*✖ /.test(l) && !/^✖ failing tests:/.test(l.trim())).map((l) => l.trim().replace(/^✖ /, '').replace(/\s\(\d+(\.\d+)?ms\)$/, ''))
    return { runner: 'node', passed: num(/^ℹ pass (\d+)/m), failed: num(/^ℹ fail (\d+)/m), failures: dedupe(failures) }
  }
  // pytest: "FAILED path::test - message" and "= N failed, M passed in 1.2s ="
  if (/=+ .*(passed|failed|error).* in [\d.]+s/.test(output) || /^FAILED /m.test(output)) {
    const failures = lines.filter((l) => /^FAILED /.test(l)).map((l) => l.replace(/^FAILED /, ''))
    return { runner: 'pytest', passed: num(/(\d+) passed/), failed: num(/(\d+) failed/) ?? (failures.length || null), failures }
  }
  // vitest / jest: "Tests  N failed | M passed" or "Tests: N failed, M passed" and "✕ name" / "× name" / "FAIL path".
  if (/Tests:?\s+\d+/.test(output)) {
    const failures = lines.filter((l) => /^\s*(✕|×|✗|●) /.test(l)).map((l) => l.trim().replace(/^(✕|×|✗|●) /, '').replace(/\s\(\d+ ?ms\)$/, ''))
    const runner = /vitest|Test Files/.test(output) ? 'vitest' : 'jest'
    return { runner, passed: num(/(\d+) passed/), failed: num(/(\d+) failed/), failures: dedupe(failures) }
  }
  // go test: "--- FAIL: TestName (0.00s)" and "FAIL\tpkg" / "ok  \tpkg".
  if (/^(--- FAIL:|ok\s+\S+\s+[\d.]+s|FAIL\s+\S+)/m.test(output)) {
    const failures = lines.filter((l) => /^--- FAIL: /.test(l)).map((l) => l.replace(/^--- FAIL: /, '').replace(/ \([\d.]+s\)$/, ''))
    const passed = lines.filter((l) => /^--- PASS: /.test(l)).length
    return { runner: 'go', passed: passed || null, failed: failures.length, failures }
  }
  // cargo test: "test name ... FAILED" and "test result: FAILED. N passed; M failed;"
  if (/^test result: /m.test(output)) {
    const failures = lines.filter((l) => /^test .* \.\.\. FAILED$/.test(l)).map((l) => l.replace(/^test /, '').replace(/ \.\.\. FAILED$/, ''))
    return { runner: 'cargo', passed: num(/(\d+) passed;/), failed: num(/(\d+) failed;/), failures }
  }
  return { runner: 'unknown', passed: null, failed: null, failures: [] }
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)]
}

/** How much of the raw output a digested result keeps at its end. */
export const RAW_TAIL_CHARS = 2_000

/**
 * A command result with a test digest first: "3 failed, 41 passed", then each
 * failure, then the raw tail. A result that is not a test run is returned
 * untouched, so nothing is hidden that the digest cannot explain.
 */
export function digestCommandOutput(output: string): string {
  const d = digestTestOutput(output)
  if (d.runner === 'unknown') return output
  const counts = [d.failed !== null ? `${d.failed} failed` : null, d.passed !== null ? `${d.passed} passed` : null].filter(Boolean).join(', ')
  const head = [`Test digest (${d.runner}): ${counts || 'no totals printed'}.`, ...d.failures.slice(0, 20).map((f) => `  ✖ ${f}`), d.failures.length > 20 ? `  … ${d.failures.length - 20} more` : null]
    .filter(Boolean)
    .join('\n')
  const tail = output.length > RAW_TAIL_CHARS ? `…\n${output.slice(-RAW_TAIL_CHARS)}` : output
  return `${head}\n\n--- output (${output.length > RAW_TAIL_CHARS ? `last ${RAW_TAIL_CHARS} of ${output.length} chars` : 'whole'}) ---\n${tail}`
}

/**
 * grep's `path:line: text` lines grouped by file with a count, the files with
 * the most hits first — so a model sees "where" before "what", and reads the
 * file that matters instead of the first.
 */
export function groupGrepOutput(output: string): string {
  const byFile = new Map<string, string[]>()
  const other: string[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const m = /^(.+?):(\d+):\s?(.*)$/.exec(line)
    if (!m) {
      other.push(line)
      continue
    }
    const list = byFile.get(m[1]!) ?? []
    list.push(`  ${m[2]}: ${m[3]}`)
    byFile.set(m[1]!, list)
  }
  if (byFile.size === 0) return output
  const files = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)
  const total = files.reduce((n, [, l]) => n + l.length, 0)
  const body = files.map(([file, hits]) => `${file} (${hits.length})\n${hits.join('\n')}`).join('\n')
  return `${total} hit${total === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}\n${body}${other.length ? `\n${other.join('\n')}` : ''}`
}

/**
 * The lines around an edit, numbered as read_file numbers them, so the model
 * sees what landed without a re-read: `context` lines either side of the
 * changed span.
 */
export function editedWindow(next: string, changedFrom: number, changedTo: number, context = 10): string {
  const lines = next.split('\n')
  const from = Math.max(1, changedFrom - context)
  const to = Math.min(lines.length, changedTo + context)
  const width = String(to).length
  const out: string[] = []
  for (let n = from; n <= to; n++) out.push(`${String(n).padStart(width)}→${lines[n - 1] ?? ''}`)
  return `Lines ${from}–${to} of ${lines.length} after the edit:\n${out.join('\n')}`
}

/** Where the first and last differing lines are between two texts, 1-based; null when identical. */
export function changedSpan(before: string, after: string): { from: number; to: number } | null {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  if (start === a.length && start === b.length) return null
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  return { from: start + 1, to: Math.max(start + 1, endB + 1) }
}
