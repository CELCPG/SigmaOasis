import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'fs'
import { join } from 'path'
import { load, resetState, state, testUserDataDir } from './harness'
import { wasDeclined } from '../src/shared/tools/outcomes'

/**
 * v2.6: the confirmation dialogs gain a third answer. "Allow once" runs and
 * stores nothing; "Always allow" runs and mints a grant bound to this exact
 * call in this exact working directory; "Cancel" declines. A later call that
 * matches a grant runs without a dialog and says so in its output; a call
 * that differs by one byte asks. No window means decline, grant or not.
 */

const { fileHandlers } = load<typeof import('../src/main/ipc/toolHandlers/files')>('toolHandlers/files')
const grants = load<typeof import('../src/main/ipc/grants')>('grants')

const ctx = { sender: {} as never }

beforeEach(async () => {
  resetState()
  await fs.rm(join(testUserDataDir(), 'grants.json'), { force: true })
  await fs.mkdir(testUserDataDir(), { recursive: true })
  state.hasWindow = true
  state.settings.workingDirectory = ''
})

describe('run_terminal_command with grants', () => {
  test('the dialog offers three answers and cancel is the default', async () => {
    state.dialogResponses = [2]
    const r = await fileHandlers.run_terminal_command({ command: 'echo hi' }, ctx)
    assert.equal(r.ok, false)
    assert.ok(wasDeclined(r.error ?? ''))
    const shown = state.dialogsShown[0]!
    assert.deepEqual(shown.buttons, ['Allow once', 'Always allow', 'Cancel'])
    assert.equal(shown.defaultId, 2)
    assert.equal(shown.cancelId, 2)
    assert.equal((await grants.listGrants()).length, 0)
  })

  test('no window: declined without consulting anything', async () => {
    state.hasWindow = false
    const r = await fileHandlers.run_terminal_command({ command: 'echo hi' }, ctx)
    assert.ok(wasDeclined(r.error ?? ''))
    assert.equal(state.dialogsShown.length, 0)
  })

  test('allow once runs and mints nothing; the next call asks again', async () => {
    state.dialogResponses = [0, 0]
    const a = await fileHandlers.run_terminal_command({ command: 'echo hi' }, ctx)
    assert.ok(a.ok)
    assert.equal(a.output, 'hi')
    assert.equal((await grants.listGrants()).length, 0)
    const b = await fileHandlers.run_terminal_command({ command: 'echo hi' }, ctx)
    assert.ok(b.ok)
    assert.equal(state.dialogsShown.length, 2)
  })

  test('always allow mints a grant for this command here; the same call then runs unasked and says so', async () => {
    state.settings.workingDirectory = testUserDataDir()
    state.dialogResponses = [1]
    const a = await fileHandlers.run_terminal_command({ command: 'echo hi' }, ctx)
    assert.ok(a.ok)
    const list = await grants.listGrants()
    assert.equal(list.length, 1)
    assert.equal(list[0]!.tool, 'run_terminal_command')
    assert.equal(list[0]!.summary, 'echo hi')
    assert.equal(list[0]!.cwd, testUserDataDir())

    const b = await fileHandlers.run_terminal_command({ command: 'echo hi' }, ctx)
    assert.ok(b.ok)
    assert.ok(b.output!.startsWith('hi'))
    assert.ok(b.output!.includes(grants.GRANT_NOTE))
    assert.equal(state.dialogsShown.length, 1)
    assert.equal((await grants.listGrants())[0]!.uses, 1)
  })

  test('one byte of difference, or another working directory, asks again', async () => {
    state.settings.workingDirectory = testUserDataDir()
    state.dialogResponses = [1]
    assert.ok((await fileHandlers.run_terminal_command({ command: 'echo hi' }, ctx)).ok)

    // nothing queued: an asked dialog cancels
    const variant = await fileHandlers.run_terminal_command({ command: 'echo hi!' }, ctx)
    assert.ok(wasDeclined(variant.error ?? ''))
    state.settings.workingDirectory = join(testUserDataDir(), 'elsewhere')
    const moved = await fileHandlers.run_terminal_command({ command: 'echo hi' }, ctx)
    assert.ok(wasDeclined(moved.error ?? ''))
    assert.equal(state.dialogsShown.length, 3)
  })

  test('a revoked grant asks again', async () => {
    state.dialogResponses = [1]
    assert.ok((await fileHandlers.run_terminal_command({ command: 'echo hi' }, ctx)).ok)
    const [g] = await grants.listGrants()
    await grants.revokeGrant(g!.id)
    const r = await fileHandlers.run_terminal_command({ command: 'echo hi' }, ctx)
    assert.ok(wasDeclined(r.error ?? ''))
  })
})

describe('write_file with grants', () => {
  test('outside a working directory, always allow binds the target path and not the content', async () => {
    const target = join(testUserDataDir(), 'granted.txt')
    state.dialogResponses = [1]
    const a = await fileHandlers.write_file({ path: target, content: 'first' }, ctx)
    assert.ok(a.ok)
    const list = await grants.listGrants()
    assert.equal(list.length, 1)
    assert.equal(list[0]!.tool, 'write_file')
    assert.equal(list[0]!.summary, target)

    const b = await fileHandlers.write_file({ path: target, content: 'second' }, ctx)
    assert.ok(b.ok)
    assert.ok(b.output!.includes(grants.GRANT_NOTE))
    assert.equal(await fs.readFile(target, 'utf-8'), 'second')
    assert.equal(state.dialogsShown.length, 1)

    const other = await fileHandlers.write_file({ path: join(testUserDataDir(), 'other.txt'), content: 'x' }, ctx)
    assert.ok(wasDeclined(other.error ?? ''))
  })

  test('inside a working directory nothing asks and nothing is minted, as before', async () => {
    state.settings.workingDirectory = testUserDataDir()
    const r = await fileHandlers.write_file({ path: 'scoped.txt', content: 'x' }, ctx)
    assert.ok(r.ok)
    assert.equal(state.dialogsShown.length, 0)
    assert.equal((await grants.listGrants()).length, 0)
  })
})
