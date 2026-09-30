import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { exportTraces, outcomeKey, redactorFor, redactText, type AuditEntryLike } from '../src/main/ipc/traceExport'

/**
 * v4.1 (F3): what an agent task puts in the audit — `.sigma/` paths, what a
 * document says, paths from anywhere on the machine, and a tool result's
 * emails and phone numbers — does not reach a trace. Each case is written the
 * way the agent's audit line is (`[agent] name(argsJson)\n→ result`, from
 * renderer/src/hooks/agentTasks.ts) and run through the whole exporter, so a
 * rule that exists but is not applied to that field fails here. Through v4.0
 * a call's parsed arguments were not redacted at all.
 */

let clock = 0
function entry(partial: Partial<AuditEntryLike> & Pick<AuditEntryLike, 'kind' | 'conversationId' | 'text'>): AuditEntryLike {
  clock += 1
  return { at: new Date(clock).toISOString(), ...partial }
}

const agentCall = (toolName: string, args: Record<string, unknown>, result: string): AuditEntryLike =>
  entry({ kind: 'tool_call', conversationId: 'a1', toolName, ok: true, text: `[agent] ${toolName}(${JSON.stringify(args)})\n→ ${result}` })

interface Msg {
  role: string
  content: string | null
  tool_calls?: { function: { arguments: string } }[]
}

/** One agent turn through exportTraces, labelled positive: its line, and its messages. */
function exported(calls: AuditEntryLike[], opts: { privatePaths?: string[] } = {}): { line: string; messages: Msg[] } {
  const entries = [
    entry({ kind: 'user_input', conversationId: 'a1', text: 'Summarize the offer letter.' }),
    ...calls,
    entry({ kind: 'assistant_output', conversationId: 'a1', text: 'Done.' })
  ]
  const r = exportTraces(entries, { outcomes: new Map([[outcomeKey('a1', 0), { unverified: false }]]), ...opts })
  assert.equal(r.positive.length, 1)
  const line = r.positive[0]!
  return { line, messages: (JSON.parse(line) as { messages: Msg[] }).messages }
}

const argsOf = (m: Msg): unknown => JSON.parse(m.tool_calls![0]!.function.arguments)

describe('trace redaction of what an agent task records (v4.1)', () => {
  test(".sigma/: a dropped file's name, a trashed file's, a worktree's and its branch go; notes, hooks and commands stay", () => {
    const out = redactText(
      [
        '.sigma/inbox/divorce-settlement.pdf',
        '.sigma\\trash\\payroll-2026.xlsx',
        'worked in .sigma/worktrees/fix-ada-lovelace-login-1432 on branch sigma/fix-ada-lovelace-login-1432',
        'read .sigma/notes.md, .sigma/hooks.json and .sigma/commands/review.md'
      ].join('\n')
    )
    for (const leak of ['divorce', 'payroll', 'lovelace']) assert.ok(!out.toLowerCase().includes(leak), `${leak} in ${out}`)
    assert.match(out, /\.sigma\/inbox\/\[name\]/)
    assert.match(out, /\.sigma\\trash\\\[name\]/)
    assert.match(out, /\.sigma\/worktrees\/\[name\] on branch sigma\/\[branch\]/)
    assert.match(out, /read \.sigma\/notes\.md, \.sigma\/hooks\.json and \.sigma\/commands\/review\.md/)
  })

  test("read_document: what the document says is withheld whole, only its size kept; the path's file name goes", () => {
    const doc = '# Offer\n\nDear Ada Lovelace,\n\n| Salary | $250,000 |\n\nStart date: 1 November. Reply to hr@acme.example.'
    const { line, messages } = exported([agentCall('read_document', { path: '.sigma/inbox/offer-letter-ada.docx' }, doc)])
    for (const leak of ['Lovelace', '250,000', 'hr@acme', 'offer-letter-ada']) assert.ok(!line.includes(leak), leak)
    assert.equal(messages[2]!.content, `[document text withheld from traces: ${doc.length} characters]`)
    assert.deepEqual(argsOf(messages[1]!), { path: '.sigma/inbox/[name]' })
  })

  test('write_document: the path and the one-line result stay; the text, the rows and the diff of what it says go', () => {
    const { line, messages } = exported([
      agentCall('write_document', { path: 'reply.docx', content: '# Reply\n\nThank you, Ada Lovelace.' }, 'Applied to reply.docx: new file, 3 lines.\n\n+# Reply\n+Thank you, Ada Lovelace.'),
      agentCall('write_document', { path: 'pay.xlsx', sheets: [{ name: 'Pay', rows: [['Ada Lovelace', 250000]] }] }, 'Applied to pay.xlsx: new file.')
    ])
    assert.ok(!line.includes('Lovelace') && !line.includes('250000'), line)
    const first = argsOf(messages[1]!) as Record<string, string>
    assert.equal(first.path, 'reply.docx')
    assert.match(first.content!, /^\[document text withheld from traces: \d+ characters\]$/)
    assert.equal(messages[2]!.content, 'Applied to reply.docx: new file, 3 lines.')
    assert.match((argsOf(messages[3]!) as Record<string, string>).sheets!, /^\[document text withheld/)
  })

  test('paths from anywhere on the machine: any drive, either slash, UNC, ~, $HOME, %USERPROFILE%, volumes, /tmp, /root', () => {
    for (const c of [
      'D:\\clients\\acme\\plan.xlsx',
      'C:/Users/ada/Documents/taxes.pdf',
      '~/Documents/taxes.pdf',
      '$HOME/.ssh/id_ed25519',
      '%USERPROFILE%\\Desktop\\medical.pdf',
      '\\\\fileserver\\hr\\reviews.xlsx',
      '/home/ada/notes.txt',
      '/Volumes/Backup/ada/photos',
      '/tmp/ada-scratch/x.txt',
      '/root/.bash_history'
    ]) {
      assert.equal(redactText(`saw ${c} today`), 'saw [path] today', c)
    }
  })

  test('a home folder with a space in it: the literal goes whole, in either slash and any case', () => {
    const redact = redactorFor(['C:\\Users\\Ada Lovelace\\', ''])
    assert.equal(redact('opened C:\\Users\\Ada Lovelace\\notes.txt'), 'opened [path]')
    assert.ok(!redact('opened c:/users/ada lovelace/notes.txt').toLowerCase().includes('lovelace'))
    // The pattern alone stops at the space — which is why the literal exists.
    assert.equal(redactText('opened C:\\Users\\Ada Lovelace\\notes.txt'), 'opened [path] Lovelace\\notes.txt')
    assert.equal(redactorFor([]), redactText, 'no paths: the plain redactor')
    const { line } = exported([agentCall('run_command', { command: 'type "C:\\Users\\Ada Lovelace\\notes.txt"' }, 'C:\\Users\\Ada Lovelace\\notes.txt: 3 lines')], {
      privatePaths: ['C:\\Users\\Ada Lovelace']
    })
    assert.ok(!line.includes('Lovelace'), line)
  })

  test("a call's parsed arguments are redacted value by value and stay valid JSON (through v4.0 they went out whole)", () => {
    const { line, messages } = exported([
      agentCall('read_file', { path: 'C:\\Users\\ada\\secret.txt' }, 'ok'),
      agentCall('run_command', { command: 'cd "C:\\Users\\ada\\proj" && curl https://intranet.acme.example/api?key=abc' }, 'ok'),
      agentCall('mcp__crm__lookup', { email: 'ada@acme.example', nested: { phone: '+1 555 123 4567' } }, 'ok')
    ])
    for (const leak of ['ada', 'intranet', '555 123']) assert.ok(!line.includes(leak), `${leak} in ${line}`)
    assert.deepEqual(argsOf(messages[1]!), { path: '[path]' })
    assert.deepEqual(argsOf(messages[3]!), { command: 'cd "[path]" && curl [url]' })
    assert.deepEqual(argsOf(messages[5]!), { email: '[email]', nested: { phone: '[phone]' } })
  })

  test('emails and phone numbers in a tool result go; dates, versions, times and counts stay', () => {
    const { messages } = exported([
      agentCall('grep', { pattern: 'contact' }, 'CONTACTS.md:3: Ada, ada.lovelace@example.org, +44 20 7946 0958\nCONTACTS.md:4: Grace, (555) 123-4567, 555.987.6543, +15551234567')
    ])
    const out = messages[2]!.content!
    for (const leak of ['lovelace@', '7946', '123-4567', '987.6543', '15551234567']) assert.ok(!out.includes(leak), `${leak} in ${out}`)
    assert.equal((out.match(/\[phone\]/g) ?? []).length, 4)
    const kept = 'On 2026-09-30, v4.0.2 ran 3224 tests in 84.7 s; 12:30 at port 1234.'
    assert.equal(redactText(kept), kept)
  })
})
