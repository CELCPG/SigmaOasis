import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * v4.4: `.github/workflows/release-dryrun.yml` is release.yml's signed macOS
 * build, started by hand, publishing nothing. Nothing runs it here — Actions
 * does, on Colin's word — so this suite is what keeps its two promises: it can
 * never publish (no release, no tap, no write token, `--publish never` only),
 * and it builds the way the release builds (release.yml's macOS steps, every
 * one, unchanged and in order). The second promise is the one that rots: when
 * release.yml's macOS job changes, this fails until the dry run follows.
 *
 * js-yaml is electron-updater's (a runtime dependency) and electron-builder's;
 * the suite adds no package for it.
 */

const yaml = require('js-yaml') as { load: (text: string) => unknown }

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown>; if?: string }
type Job = { 'runs-on'?: string; needs?: unknown; permissions?: unknown; steps: Step[] }
type Workflow = { name?: string; on: Record<string, unknown>; permissions?: unknown; jobs: Record<string, Job> }

const dir = join(__dirname, '..', '..', '.github', 'workflows')
const dry = yaml.load(readFileSync(join(dir, 'release-dryrun.yml'), 'utf8')) as Workflow
const release = yaml.load(readFileSync(join(dir, 'release.yml'), 'utf8')) as Workflow

/**
 * Everything the dry run would execute or hand to a step — every key and value
 * of the parsed file, one per line — without its comments (which name the
 * tokens and jobs it leaves out, to say so).
 */
const leaves = (v: unknown): string[] =>
  v !== null && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...leaves(x)]) : [String(v)]
const dryWire = leaves(dry).join('\n')
const dryRuns = Object.values(dry.jobs).flatMap((j) => j.steps.map((s) => s.run ?? ''))

test('the dry run starts by hand only — no push, tag, pull request or schedule', () => {
  assert.deepEqual(Object.keys(dry.on), ['workflow_dispatch'])
  const inputs = (dry.on.workflow_dispatch as { inputs?: Record<string, { required?: boolean }> } | null)?.inputs ?? {}
  assert.deepEqual(Object.keys(inputs), ['ref'])
  assert.equal(inputs.ref.required, false)
})

test('the dry run is one macOS job and none of release.yml\'s writers', () => {
  assert.deepEqual(Object.keys(dry.jobs), ['macos'])
  assert.equal(dry.jobs.macos['runs-on'], release.jobs.macos['runs-on'])
  assert.equal(dry.jobs.macos.needs, undefined, 'no guard: there is no tag to check')
  for (const writer of ['publish', 'homebrew']) assert.ok(release.jobs[writer], `release.yml still has ${writer}`)
})

test('the dry run\'s token can only read', () => {
  assert.deepEqual(dry.permissions, { contents: 'read' })
  for (const job of Object.values(dry.jobs)) assert.deepEqual(job.permissions, { contents: 'read' })
  assert.doesNotMatch(dryWire, /^write$/m)
})

test('electron-builder never publishes from the dry run', () => {
  // Every script line that runs electron-builder, but for the one printing its
  // version (shell comments are not commands).
  const lines = dryRuns
    .flatMap((r) => r.split('\n'))
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('#') && /\belectron-builder\b/.test(l) && !/electron-builder --version\b/.test(l))
  assert.deepEqual(lines, ['npx electron-builder --mac --publish never'])
  assert.doesNotMatch(dryWire, /EP_DRAFT|EP_PRE_RELEASE|EP_GH_IGNORE_TIME/)
})

test('no step can reach a release or the tap — no GitHub token, gh, upload host or push', () => {
  for (const forbidden of [
    /GH_TOKEN/,
    /GITHUB_TOKEN/,
    /secrets\.HOMEBREW_TAP_TOKEN/,
    /homebrew-tap/,
    /\bgh (release|api|workflow)\b/,
    /uploads\.github\.com/,
    /api\.github\.com/,
    /\bgit push\b/,
    /softprops\/action-gh-release|ncipollo\/release-action/,
    /actions\/download-artifact/
  ]) {
    assert.doesNotMatch(dryWire, forbidden)
  }
})

test('release.yml\'s macOS steps are all in the dry run, unchanged and in order', () => {
  // The two documented differences: checkout takes the `ref` input, and the
  // artifact is named for the dry run. Anything else that differs fails here.
  const allowedWith: Record<string, string[]> = {
    'actions/checkout': ['ref'],
    'actions/upload-artifact': ['name']
  }
  const same = (a: Step, b: Step): boolean => {
    if ((a.uses ?? '') !== (b.uses ?? '') || (a.run ?? '') !== (b.run ?? '') || (a.if ?? '') !== (b.if ?? '')) return false
    if (JSON.stringify(a.env ?? {}) !== JSON.stringify(b.env ?? {})) return false
    const free = allowedWith[(a.uses ?? '').split('@')[0]] ?? []
    const strip = (w: Record<string, unknown> | undefined): string =>
      JSON.stringify(Object.fromEntries(Object.entries(w ?? {}).filter(([k]) => !free.includes(k))))
    return strip(a.with) === strip(b.with)
  }
  const ours = dry.jobs.macos.steps
  let at = 0
  for (const step of release.jobs.macos.steps) {
    const found = ours.findIndex((s, i) => i >= at && same(step, s))
    assert.notEqual(found, -1, `release.yml's macOS step "${step.name ?? step.uses ?? step.run}" is missing from the dry run, changed, or out of order`)
    at = found + 1
  }
  // The checkout really does take the input.
  const checkout = ours.find((s) => s.uses?.startsWith('actions/checkout@'))
  assert.equal(checkout?.with?.ref, '${{ inputs.ref }}')
})

test('the dry run\'s DMGs leave the runner as a workflow artifact, and the keychain is always removed last', () => {
  const steps = dry.jobs.macos.steps
  const upload = steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))
  assert.ok(upload)
  assert.equal(upload.with?.name, 'dryrun-installers-mac')
  assert.match(String(upload.with?.path), /dist\/\*\.dmg\n/)
  const last = steps[steps.length - 1]
  assert.equal(last.if, 'always()')
  assert.match(last.run ?? '', /security delete-keychain/)
})
