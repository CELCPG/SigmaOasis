import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recipeFromSkill, selectRecipe, SHIPPED_RECIPES } from '../src/main/agent/recipes'
import { expandCommand, loadCommands, loadCommandsFrom } from '../src/main/agent/commands'
import { copyToInbox, inboxNote, INBOX_DIR } from '../src/main/agent/inbox'
import { agentSystemPrompt } from '../src/main/agent/prompts'
import type { ShellSpec } from '../src/main/agent/types'

/** v4.0 (C3, C6, C7 — experiments, off by default): recipes, the inbox and slash commands. */

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sigma-c-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const SHELL: ShellSpec = { file: 'sh', args: ['-c'], name: 'sh' }

describe('recipes', () => {
  test('four ship, each with triggers the front door’s cards use', () => {
    assert.deepEqual(
      SHIPPED_RECIPES.map((r) => r.id),
      ['tidy-folder', 'summarize-here', 'fill-template', 'fix-failing-test']
    )
    assert.equal(selectRecipe('Please tidy up my Downloads folder')?.id, 'tidy-folder')
    assert.equal(selectRecipe('Fix the failing test in src/stats.js')?.id, 'fix-failing-test')
    assert.equal(selectRecipe('Summarize what is here')?.id, 'summarize-here')
    assert.equal(selectRecipe('Fill the template with every row of customers.csv')?.id, 'fill-template')
    assert.equal(selectRecipe('Rename the photos by date'), null)
  })

  test('a user’s skill with an agent.md is a recipe and matches after the shipped four; without one it is not', () => {
    const mine = recipeFromSkill({ id: 'invoices', name: 'Invoices', triggers: ['invoice'], agentText: '1. Read the invoice.\n2. Total it.' })
    assert.deepEqual(mine, { id: 'invoices', name: 'Invoices', triggers: ['invoice'], text: '1. Read the invoice.\n2. Total it.' })
    assert.equal(recipeFromSkill({ id: 'x', name: 'X', triggers: ['x'] }), null)
    assert.equal(selectRecipe('Total the invoice in inbox', [mine!])?.id, 'invoices')
    assert.equal(selectRecipe('tidy the invoice folder', [mine!])?.id, 'tidy-folder', 'the shipped recipe is first')
  })

  test('the recipe rides the system prompt after the project instructions, named', () => {
    const prompt = agentSystemPrompt({
      workspace: dir,
      permission: 'acceptEdits',
      shell: SHELL,
      platform: 'linux',
      now: new Date(2026, 8, 28),
      notes: { file: 'SIGMA.md', text: 'Use pnpm.', truncated: false },
      listing: [],
      branch: null,
      tools: ['read_file'],
      recipe: { name: 'Tidy a folder', text: '1. List first.' }
    })
    assert.match(prompt, /## Project instructions \(SIGMA\.md\)\nUse pnpm\.\n\n## Method for this task \(the “Tidy a folder” recipe[^\n]*\n1\. List first\./)
    const without = agentSystemPrompt({ workspace: dir, permission: 'acceptEdits', shell: SHELL, platform: 'linux', now: new Date(), notes: null, listing: [], branch: null, tools: [] })
    assert.doesNotMatch(without, /Method for this task/)
  })
})

describe('slash commands', () => {
  test('the folder’s .sigma/commands and the app’s folder, a folder command winning a name; bad names and empty files skipped', async () => {
    mkdirSync(join(dir, '.sigma', 'commands'), { recursive: true })
    mkdirSync(join(dir, 'app-commands'))
    writeFileSync(join(dir, '.sigma', 'commands', 'review.md'), '# Review the diff\n\nReview $ARGUMENTS for bugs.\n')
    writeFileSync(join(dir, '.sigma', 'commands', 'Bad Name.md'), 'nope')
    writeFileSync(join(dir, '.sigma', 'commands', 'empty.md'), '   \n')
    writeFileSync(join(dir, 'app-commands', 'review.md'), 'the app’s review')
    writeFileSync(join(dir, 'app-commands', 'standup.md'), 'What changed since yesterday?')
    const list = await loadCommands(dir, join(dir, 'app-commands'))
    assert.deepEqual(
      list.map((c) => [c.name, c.source, c.summary]),
      [
        ['review', 'folder', 'Review the diff'],
        ['standup', 'app', 'What changed since yesterday?']
      ]
    )
    assert.deepEqual(await loadCommandsFrom(join(dir, 'nowhere'), 'app'), [])
    assert.deepEqual(await loadCommands(null, null), [])
  })

  test('/name args expands with $ARGUMENTS; a body without the placeholder gets the arguments after it; anything else is untouched', async () => {
    const commands = [
      { name: 'review', summary: '', body: 'Review $ARGUMENTS for bugs, then $ARGUMENTS again.', source: 'folder' as const },
      { name: 'standup', summary: '', body: 'What changed since yesterday?', source: 'app' as const }
    ]
    assert.deepEqual(expandCommand('/review src/a.ts', commands), { text: 'Review src/a.ts for bugs, then src/a.ts again.', command: commands[0] })
    assert.equal(expandCommand('/review', commands).text, 'Review  for bugs, then  again.')
    assert.equal(expandCommand('/standup and the blockers', commands).text, 'What changed since yesterday?\n\nand the blockers')
    assert.equal(expandCommand('/Standup', commands).command, commands[1])
    assert.deepEqual(expandCommand('/unknown x', commands), { text: '/unknown x', command: null })
    assert.deepEqual(expandCommand('look at /review later', commands), { text: 'look at /review later', command: null })
    assert.deepEqual(expandCommand('1/2 of the time', commands), { text: '1/2 of the time', command: null })
  })
})

describe('the inbox', () => {
  test('files are copied into .sigma/inbox with free names; a folder or a missing file is skipped and said', async () => {
    const src = join(dir, 'src')
    mkdirSync(src)
    writeFileSync(join(src, 'report.pdf'), 'one')
    writeFileSync(join(src, 'notes.txt'), 'two')
    const work = join(dir, 'work')
    mkdirSync(work)
    mkdirSync(join(work, '.sigma', 'inbox'), { recursive: true })
    writeFileSync(join(work, '.sigma', 'inbox', 'report.pdf'), 'already here')
    const r = await copyToInbox(work, [join(src, 'report.pdf'), join(src, 'notes.txt'), src, join(src, 'missing.md')])
    assert.deepEqual(r.copied, ['.sigma/inbox/report (2).pdf', '.sigma/inbox/notes.txt'])
    assert.deepEqual(r.skipped.map((s) => s.reason), ['not a file', expect_enoent(r.skipped[1]!.reason)])
    assert.equal(readFileSync(join(work, INBOX_DIR, 'report (2).pdf'), 'utf8'), 'one')
    assert.equal(readFileSync(join(work, INBOX_DIR, 'report.pdf'), 'utf8'), 'already here', 'nothing overwritten')
    assert.ok(existsSync(join(work, INBOX_DIR, 'notes.txt')))
    assert.deepEqual(readdirSync(join(work, INBOX_DIR)).sort(), ['notes.txt', 'report (2).pdf', 'report.pdf'])
    const note = inboxNote(r)
    assert.match(note, /^Files dropped in: \.sigma\/inbox\/report \(2\)\.pdf, \.sigma\/inbox\/notes\.txt\nNot copied: src \(not a file\), missing\.md \(/)
  })
})

/** ENOENT's wording differs by platform; the reason is Node's own message, so the test accepts it as it came. */
function expect_enoent(reason: string): string {
  assert.match(reason, /ENOENT|no such file/i)
  return reason
}
