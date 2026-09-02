import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'fs'
import { join } from 'path'
import { load, resetState, state, testUserDataDir } from './harness'

const audit = load<typeof import('../src/main/ipc/audit')>('audit')

const { recordAuditEntry, readSessionPlaintext, purgeAuditLogs, currentAuditSessionId } = audit

function auditFile(): string {
  return join(testUserDataDir(), 'audit', `${currentAuditSessionId()}.jsonl`)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/**
 * The suite runs in file order against one module instance (the hash chain is
 * module state, exactly as in production): first the refusal paths, which must
 * write nothing, then a valid chain, then tampering, then purge.
 */
before(async () => {
  resetState()
  await fs.rm(join(testUserDataDir(), 'audit'), { recursive: true, force: true })
})

describe('audit log refusals (nothing is written)', () => {
  test('disabled log records nothing', async () => {
    resetState()
    state.settings.audit = { enabled: false, autoPurgeOnQuit: false }
    await recordAuditEntry({ conversationId: 'c1', kind: 'user_input', text: 'hello' })
    assert.equal(await fileExists(auditFile()), false)
  })

  test('ephemeral conversations are refused even when the log is enabled', async () => {
    resetState()
    state.settings.audit = { enabled: true, autoPurgeOnQuit: false }
    await recordAuditEntry({
      conversationId: 'c1',
      kind: 'user_input',
      text: 'secret phrase',
      ephemeral: true
    })
    assert.equal(await fileExists(auditFile()), false)
  })

  test('no OS keychain means no log — never plaintext instead', async () => {
    resetState()
    state.settings.audit = { enabled: true, autoPurgeOnQuit: false }
    state.encryptionAvailable = false
    await recordAuditEntry({ conversationId: 'c1', kind: 'user_input', text: 'hello' })
    assert.equal(await fileExists(auditFile()), false)
  })
})

describe('audit log recording', () => {
  test('entries are encrypted on disk and the hash chain verifies', async () => {
    resetState()
    state.settings.audit = { enabled: true, autoPurgeOnQuit: false }
    await recordAuditEntry({ conversationId: 'c1', kind: 'user_input', text: 'secret phrase' })
    await recordAuditEntry({
      conversationId: 'c1',
      kind: 'assistant_output',
      roleName: 'Assistant',
      modelId: 'fake-chat',
      text: 'an answer'
    })
    await recordAuditEntry({
      conversationId: 'c1',
      kind: 'tool_call',
      toolName: 'web_search',
      ok: true,
      text: 'web_search({"q":"x"})'
    })

    // On disk, none of the content is readable as plaintext.
    const raw = await fs.readFile(auditFile(), 'utf-8')
    assert.equal(raw.includes('secret phrase'), false)
    assert.equal(raw.includes('an answer'), false)

    // Decrypted, the chain (genesis + 3 entries) verifies end to end.
    const result = await readSessionPlaintext(currentAuditSessionId())
    assert.ok(!('error' in result))
    if ('error' in result) return
    assert.equal(result.chainValid, true)
    assert.equal(result.entries.length, 4)
    assert.equal(result.entries[0]!.kind, 'session_start')
    assert.deepEqual(
      result.entries.slice(1).map((e) => e.kind),
      ['user_input', 'assistant_output', 'tool_call']
    )
    assert.equal(result.entries[1]!.text, 'secret phrase')
  })

  test('a tampered log reports a broken chain rather than hiding it', async () => {
    // Corrupt the second line: it will not decrypt, which is itself evidence.
    const raw = await fs.readFile(auditFile(), 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim())
    lines[1] = Buffer.from('forged entry').toString('base64')
    await fs.writeFile(auditFile(), `${lines.join('\n')}\n`, 'utf-8')

    const result = await readSessionPlaintext(currentAuditSessionId())
    assert.ok(!('error' in result))
    if ('error' in result) return
    assert.equal(result.chainValid, false)
  })

  test('purge deletes every session log', async () => {
    const { removed } = await purgeAuditLogs()
    assert.equal(removed, 1)
    assert.equal(await fileExists(auditFile()), false)
  })
})
describe('audit directory bound (v2.4)', () => {
  test('pruning removes the oldest launches beyond the caps and never the live session', async () => {
    resetState()
    const fs = await import('node:fs/promises')
    const { join } = await import('node:path')
    const dir = join(testUserDataDir(), 'audit')
    await fs.rm(dir, { recursive: true, force: true })
    await fs.mkdir(dir, { recursive: true })
    // Six old sessions, oldest first by mtime, 100 bytes each.
    for (let i = 0; i < 6; i++) {
      const f = join(dir, `session-old${i}.jsonl`)
      await fs.writeFile(f, 'x'.repeat(100))
      const t = new Date(Date.now() - (6 - i) * 60_000)
      await fs.utimes(f, t, t)
    }
    const audit = load<typeof import('../src/main/ipc/audit')>('audit')
    // Cap of 4 launches counts the live one: 6 on disk + 1 live = 7 → remove the 3 oldest.
    const byCount = await audit.pruneAuditLogs({ maxSessions: 4, maxBytes: Number.MAX_SAFE_INTEGER })
    assert.deepEqual(byCount, { sessions: 3, bytes: 300 })
    const left = (await fs.readdir(dir)).sort()
    assert.deepEqual(left, ['session-old3.jsonl', 'session-old4.jsonl', 'session-old5.jsonl'])
    // Byte cap: 300 bytes on disk, cap 150 → the two oldest remaining go.
    const byBytes = await audit.pruneAuditLogs({ maxSessions: 100, maxBytes: 150 })
    assert.deepEqual(byBytes, { sessions: 2, bytes: 200 })
    assert.deepEqual(await fs.readdir(dir), ['session-old5.jsonl'])
    // Within both caps: nothing goes.
    assert.deepEqual(await audit.pruneAuditLogs({ maxSessions: 100, maxBytes: 1000 }), { sessions: 0, bytes: 0 })
  })
})
