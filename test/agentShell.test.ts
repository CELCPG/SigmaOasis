import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { defaultShell } from '../src/main/agent/command'

/**
 * v4.0 (E7): the shell the agent will use on this machine is decided by
 * `defaultShell` and shown under Settings → Agent. On Windows it is Git Bash
 * when one is installed at a known path, cmd.exe otherwise; elsewhere the
 * login shell. CI's Windows leg runs this with Git installed, so the Git Bash
 * branch is exercised there; a machine without Git takes the other branch,
 * and both are checked to name an executable that exists.
 */
describe('defaultShell', () => {
  test('names a shell that exists and says which syntax it takes', () => {
    const shell = defaultShell()
    assert.ok(shell.file, 'a file')
    assert.ok(shell.name.length > 0, 'a name')
    assert.ok(existsSync(shell.file) || /^cmd\.exe$/i.test(shell.file.split(/[\\/]/).pop() ?? ''), `${shell.file} exists`)
    if (process.platform === 'win32') {
      assert.match(shell.name, /Git Bash \(bash syntax\)|cmd\.exe \(Windows command syntax\)/)
      assert.deepEqual(shell.args, shell.name.startsWith('Git Bash') ? ['-lc'] : ['/d', '/s', '/c'])
    } else {
      assert.match(shell.name, /POSIX shell syntax/)
      assert.deepEqual(shell.args, ['-lc'])
    }
  })
})
