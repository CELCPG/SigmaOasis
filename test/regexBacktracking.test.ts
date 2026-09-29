import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { readSource } from './harness'

/**
 * v4.0.1: no pattern in src/ backtracks exponentially.
 *
 * 4.0.0 shipped one that did (groundingChecks/claimedTools.ts,
 * DISCLOSURE_HEADING): a group of runs inside a repeat, so a line of markdown
 * furniture could be split 2^n ways, and a table's separator row held the
 * window at 100% CPU until it was killed. test/groundingDeadline.test.ts pins
 * that pattern and the pass that reads it. This is the class: every regex
 * literal under src/ is read out of the source and run against short runs of
 * the characters it names, under a deadline.
 *
 * Short on purpose. At 34 characters a pattern that doubles per character has
 * 2^34 ways to fail and does not come back; one that is merely quadratic
 * finishes in microseconds. So this finds the defect that cannot be waited
 * out, and says nothing of patterns that are slow on a 20,000-character run —
 * those were measured once for 4.0.1 (RELEASE-NOTES-v4.0.1.md) and none sits
 * where a reply or a page can reach it at that length.
 *
 * Not covered: a pattern assembled at run time with `new RegExp`, which has no
 * literal to read. The ones the grounding pass builds are run by
 * groundingDeadline.test.ts.
 *
 * A pattern that backtracks cannot be interrupted from inside the process it
 * runs in, so the probing happens in a child: this same file, started with
 * REGEX_PROBE set, which registers no tests and works through the list.
 */

interface Literal {
  file: string
  line: number
  source: string
  flags: string
}

const RUN_LENGTH = 34
const SLOW_MS = 1000
const BATCH_DEADLINE_MS = 60_000
const ONE_DEADLINE_MS = 5000

/** Runs of the characters the pattern names, and of the words it looks for. */
function attacksFor(source: string): string[] {
  const named = new Set<string>()
  for (const ch of source.replace(/\\[dDwWsSbBnrt]/g, '')) {
    if (/[^A-Za-z0-9\\()[\]{}?+*^$]/.test(ch)) named.add(ch)
  }
  const alphabet = [...new Set([' ', 'a', '1', '-', '\t', '\n', '.', 'A', ...[...named].slice(0, 10)])]
  const units = [...alphabet]
  for (const a of alphabet) for (const b of alphabet) if (a !== b) units.push(a + b)
  for (const word of [...new Set(source.match(/[A-Za-z]{3,}/g) ?? [])].slice(0, 6)) units.push(`${word} `, word)
  const out: string[] = []
  for (const unit of units) {
    const run = unit.repeat(Math.max(1, Math.floor(RUN_LENGTH / unit.length)))
    // Ending on a character no pattern asks for: a run that matches proves nothing.
    out.push(`${run}\u0001`, `\n${run}\n\u0001`, `x ${run}!`)
  }
  return out
}

function probe(literal: Literal): number {
  let re: RegExp
  try {
    re = new RegExp(literal.source, literal.flags)
  } catch {
    return 0
  }
  let worst = 0
  for (const text of attacksFor(literal.source)) {
    const started = Date.now()
    re.lastIndex = 0
    if (literal.flags.includes('g')) {
      let count = 0
      for (const _ of text.matchAll(re)) if (++count > 1000) break
    } else {
      re.test(text)
    }
    worst = Math.max(worst, Date.now() - started)
  }
  return worst
}

/** The child: work through the list from `from`, saying which pattern is next before trying it. */
function runProbe(listFile: string): void {
  const { literals, from, progress } = JSON.parse(readFileSync(listFile, 'utf8')) as { literals: Literal[]; from: number; progress: string }
  for (let i = from; i < literals.length; i++) {
    appendFileSync(progress, `start ${i}\n`)
    const worst = probe(literals[i])
    if (worst > SLOW_MS) appendFileSync(progress, `slow ${i} ${worst}\n`)
  }
  appendFileSync(progress, 'done\n')
}

function literalsIn(root: string): Literal[] {
  const out: Literal[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) read(path)
    }
  }
  const read = (path: string): void => {
    const sf = ts.createSourceFile(path, readSource(path), ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
        const raw = node.getText(sf)
        const close = raw.lastIndexOf('/')
        out.push({
          file: relative(root, path).replace(/\\/g, '/'),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          source: raw.slice(1, close),
          flags: raw.slice(close + 1)
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  walk(join(root, 'src'))
  return out
}

/** Every pattern that did not come back, or came back late. One child per stretch between hangs. */
function failuresIn(literals: Literal[], deadlineMs: number): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'regex-probe-'))
  const failures: string[] = []
  try {
    let from = 0
    while (from < literals.length) {
      const listFile = join(dir, `list-${from}.json`)
      const progress = join(dir, `progress-${from}.txt`)
      writeFileSync(progress, '')
      writeFileSync(listFile, JSON.stringify({ literals, from, progress }))
      spawnSync(process.execPath, [__filename], { env: { ...process.env, REGEX_PROBE: listFile }, timeout: deadlineMs, encoding: 'utf8' })
      const lines = readFileSync(progress, 'utf8').split('\n').filter(Boolean)
      const name = (i: number): string => `${literals[i].file}:${literals[i].line} /${literals[i].source}/${literals[i].flags}`
      for (const line of lines) {
        const slow = /^slow (\d+) (\d+)$/.exec(line)
        if (slow) failures.push(`${name(Number(slow[1]))} took ${slow[2]} ms on ${RUN_LENGTH} characters`)
      }
      if (lines.at(-1) === 'done') break
      const last = [...lines].reverse().find((l) => l.startsWith('start '))
      assert.ok(last, 'the probe never started')
      const hung = Number(last.slice('start '.length))
      failures.push(`${name(hung)} did not return on ${RUN_LENGTH} characters`)
      from = hung + 1
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return failures
}

if (process.env.REGEX_PROBE) {
  runProbe(process.env.REGEX_PROBE)
} else {
  describe('no pattern in src/ backtracks exponentially (v4.0.1)', () => {
    const root = join(__dirname, '..', '..')

    test('the probe finds the pattern 4.0.0 shipped', () => {
      const shipped: Literal = {
        file: 'src/renderer/src/lib/groundingChecks/claimedTools.ts',
        line: 0,
        source: String.raw`^[ \t]*(?:[#>*_\-|]+[ \t]*)*\**[ \t]*tools?[ \t]+(?:i[ \t]+|we[ \t]+)?(?:used|use|called|ran|run|invoked|consulted)\b`,
        flags: 'im'
      }
      const failures = failuresIn([shipped], ONE_DEADLINE_MS)
      assert.equal(failures.length, 1)
      assert.match(failures[0], /did not return/)
    })

    test('and nothing in src/ is one', () => {
      const literals = literalsIn(root)
      // The count is not pinned, only that the reader found the source at all.
      assert.ok(literals.length > 500, `read only ${literals.length} patterns from src/`)
      assert.ok(
        literals.some((l) => l.file.endsWith('groundingChecks/claimedTools.ts') && l.source.includes('tools?')),
        'the reader did not find DISCLOSURE_HEADING'
      )
      assert.deepEqual(failuresIn(literals, BATCH_DEADLINE_MS), [])
    })
  })
}
