import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runAgentTask } from '../src/main/agent/engine'
import type { AgentHost, ChunkTransport, ShellSpec } from '../src/main/agent/types'
import type { ApiMessage } from '../src/renderer/src/lib/agentLoop'

/**
 * What the engine sends, hashed (v4.5, H3).
 *
 * The unrun-claim guard marks a report; it must never change a request. This is
 * the proof, and it stays as the gate: six scripted tasks — the ones the guard
 * has something to say about, and two it has not — are run through the shipping
 * engine, and every request body they send is hashed against a snapshot that
 * was recorded BEFORE the guard existed (commit "the engine's requests,
 * hashed"). A change to any request — a word in the history, a note on a
 * result, a round that was not there — moves a hash and fails here.
 *
 * Three things in a body belong to the machine, not the engine, and are
 * replaced before hashing: the temporary folder's path, the platform's name
 * (the one line of the prompt that names it), and a command's wall time. The
 * snapshot is re-recorded deliberately, never by a passing run:
 *   UPDATE_REPLAY_SNAPSHOTS=1 npm run test:replay   (or --only agentRequests)
 */
const REPO = join(__dirname, '..', '..')
const SNAPSHOT = join(REPO, 'test', 'fixtures', 'wire', 'agent-requests.json')
const UPDATE = process.env.UPDATE_REPLAY_SNAPSHOTS === '1'
const HOW = 'If the change is deliberate, re-record with `UPDATE_REPLAY_SNAPSHOTS=1 npm run test:replay` and commit the snapshot with the change — its diff is what review reads.'
const NOW = new Date('2026-10-03T12:00:00Z')

type Frame = Record<string, unknown>
const say = (content: string): Frame => ({ choices: [{ delta: { content } }] })
const call = (id: string, name: string, args: Record<string, unknown>): Frame => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }]
})

function scripted(replies: Frame[][], bodies: string[]): ChunkTransport {
  let i = 0
  return async (_url, init) => {
    bodies.push(init.body)
    const reply = replies[i++]
    if (!reply) throw new Error(`the script ran out at request ${i}`)
    const enc = new TextEncoder()
    for (const f of [...reply, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }]) init.onChunk(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
    init.onChunk(enc.encode('data: [DONE]\n\n'))
    return { ok: true, status: 200 }
  }
}

/** The shell the commands run in is the platform's; the name the prompt gives it is fixed. */
const SHELL: ShellSpec =
  process.platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'], name: 'sh' }
    : { file: '/bin/sh', args: ['-c'], name: 'sh' }

interface Scenario {
  /** One entry per turn of the task: the user's prompt and the model's replies, round by round. */
  turns: { prompt: string; replies: Frame[][] }[]
}

const SCENARIOS: Record<string, Scenario> = {
  // Says the tests pass; ran nothing.
  'claim-with-no-run': {
    turns: [{ prompt: 'Fix the slice.', replies: [[call('c1', 'read_file', { path: 'src/slice.js' })], [say('Looked it over. All tests pass.')]] }]
  },
  // Ran the tests, they failed, says they pass.
  'claim-after-a-failing-run': {
    turns: [
      {
        prompt: 'Fix the slice.',
        replies: [[call('c1', 'run_command', { command: 'node fail.js' })], [say('Done: the tests pass now.')]]
      }
    ]
  },
  // Ran the tests, they passed, says so.
  'claim-after-a-passing-run': {
    turns: [
      {
        prompt: 'Fix the slice.',
        replies: [[call('c1', 'edit_file', { path: 'src/slice.js', old_string: 'size - 1', new_string: 'size' })], [call('c2', 'run_command', { command: 'node pass.js' })], [say('Fixed it; all tests pass.')]]
      }
    ]
  },
  // The command the model wrote was declined, so nothing ran; it says the tests pass.
  'claim-after-a-declined-run': {
    turns: [{ prompt: 'Run the tests.', replies: [[call('c1', 'run_command', { command: 'node pass.js 2>&1' })], [say('The tests pass.')]] }]
  },
  // A report that claims nothing.
  'no-claim': {
    turns: [{ prompt: 'What does slice.js do?', replies: [[call('c1', 'read_file', { path: 'src/slice.js' })], [say('It returns a page of items, from `start` for `size` of them.')]] }]
  },
  // The next turn of a task that ended on a claim: the history it carries is the same words.
  'second-turn-after-a-claim': {
    turns: [
      { prompt: 'Fix the slice.', replies: [[say('Fixed. All tests pass.')]] },
      { prompt: 'Run them, then.', replies: [[call('c1', 'run_command', { command: 'node pass.js' })], [say('Ran them: 3 passing.')]] }
    ]
  }
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-requests-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'slice.js'), 'exports.slice = (items, start, size) => items.slice(start, start + size - 1)\n')
  writeFileSync(join(dir, 'pass.js'), "console.log('3 passing')\n")
  writeFileSync(join(dir, 'fail.js'), "console.log('1 failing')\nprocess.exit(1)\n")
  return dir
}

/** The engine's requests for one scenario, normalised and hashed. */
async function requestHashes(s: Scenario): Promise<string[]> {
  const dir = workspace()
  const bodies: string[] = []
  const host = (replies: Frame[][]): AgentHost => ({
    transport: scripted(replies, bodies),
    shell: SHELL,
    emit: () => undefined,
    reviewEdit: async () => true,
    approveCommand: async ({ command }) => (/[|&<>]/.test(command) ? 'declined' : 'once')
  })
  try {
    let history: ApiMessage[] | undefined
    for (const turn of s.turns) {
      const result = await runAgentTask(
        { baseUrl: 'http://127.0.0.1:1234/v1', model: 'scripted', workspace: dir, permission: 'acceptEdits', prompt: turn.prompt, history, signal: new AbortController().signal, now: NOW },
        host(turn.replies)
      )
      history = result.history
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // JSON writes a Windows path's backslashes doubled; the folder is found as the body spells it.
  const spelled = JSON.stringify(dir).slice(1, -1)
  return bodies.map((b) =>
    createHash('sha256')
      .update(b.split(spelled).join('<WORKSPACE>').replace(`on ${process.platform}.`, 'on <PLATFORM>.').replace(/\(exit code (\d+), \d+\.\d s/g, '(exit code $1, <T> s'))
      .digest('hex')
  )
}

describe('the engine\'s requests', () => {
  test('every request of every scripted task is the one the snapshot holds', async () => {
    const seen: Record<string, string[]> = {}
    for (const [name, s] of Object.entries(SCENARIOS)) seen[name] = await requestHashes(s)
    if (UPDATE) {
      mkdirSync(dirname(SNAPSHOT), { recursive: true })
      writeFileSync(SNAPSHOT, JSON.stringify(seen, null, 2) + '\n')
    }
    assert.ok(existsSync(SNAPSHOT), `no snapshot at ${SNAPSHOT}. ${HOW}`)
    const held = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, string[]>
    assert.deepEqual(Object.keys(seen), Object.keys(held), `the scenarios are not the snapshot's. ${HOW}`)
    for (const name of Object.keys(seen)) assert.deepEqual(seen[name], held[name], `${name}: a request the engine sends has changed. ${HOW}`)
  })

  test('the scenarios send the requests the snapshot counts on (a round per reply)', async () => {
    for (const [name, s] of Object.entries(SCENARIOS)) {
      const hashes = await requestHashes(s)
      assert.equal(hashes.length, s.turns.reduce((n, t) => n + t.replies.length, 0), `${name}: one request a scripted reply`)
    }
  })

  test('a scenario is deterministic: twice over, the same hashes', async () => {
    const s = SCENARIOS['claim-after-a-passing-run']!
    assert.deepEqual(await requestHashes(s), await requestHashes(s))
  })
})
