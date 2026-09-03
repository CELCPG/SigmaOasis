import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load, resetState, state, testUserDataDir } from './harness'
import { buildSkillContext, describeSkillForConfirmation, selectSkill, validateSkillManifest } from '../src/shared/skills'
import { gatherTurnContext } from '../src/renderer/src/lib/contextProviders'
import { skillProvider } from '../src/renderer/src/lib/contextProviders/skill'
import { playbookProvider } from '../src/renderer/src/lib/contextProviders/playbook'
import type { ProviderIO, TurnInput } from '../src/renderer/src/lib/contextProviders'

/**
 * v2.7: skills. The format is validated at install; selection is a trigger
 * phrase at a word boundary with code stripped; a fired skill takes the
 * method slot and the playbook stands down; the installer copies the folder,
 * installs its pack, saves its server switched off, and lists it all first.
 */

const manifest = (over: Record<string, unknown> = {}) => ({
  formatVersion: 1,
  id: 'trekker-pricing',
  name: 'Trekker pricing',
  description: 'Use when the user asks about Nordvik backpack prices. Do not use for other brands. Example: "What does the Trekker 40 cost?"',
  triggers: ['trekker', 'nordvik price'],
  ...over
})

describe('the skill format', () => {
  test('a valid manifest normalizes its triggers and keeps only what it names', () => {
    const m = validateSkillManifest(manifest({ triggers: ['  Trekker ', 'NORDVIK price', 'x'], playbook: 'playbook.md', helpers: ['prices.py'] }))
    assert.deepEqual(m.triggers, ['trekker', 'nordvik price'])
    assert.equal(m.playbook, 'playbook.md')
    assert.deepEqual(m.helpers, ['prices.py'])
    assert.equal(m.pack, undefined)
  })

  test('the problems are named: version, id, description, triggers, file names, server command', () => {
    assert.throws(() => validateSkillManifest({ ...manifest(), formatVersion: 2 }), /format version/)
    assert.throws(() => validateSkillManifest(manifest({ id: 'Bad Id' })), /Invalid skill id/)
    assert.throws(() => validateSkillManifest(manifest({ description: '' })), /needs a description/)
    assert.throws(() => validateSkillManifest(manifest({ triggers: [] })), /trigger phrase/)
    assert.throws(() => validateSkillManifest(manifest({ playbook: '../etc/passwd.md' })), /must be a .md file name/)
    assert.throws(() => validateSkillManifest(manifest({ helpers: ['../x.py'] })), /helper must be a .py file name/)
    assert.throws(() => validateSkillManifest(manifest({ pack: 'a/b' })), /sub-folder name/)
    assert.throws(() => validateSkillManifest(manifest({ mcp: { args: [] } })), /needs a command/)
  })

  test('an MCP spec keeps only well-formed env names and a trimmed cwd', () => {
    const m = validateSkillManifest(manifest({ mcp: { command: 'npx', args: ['-y', 'srv'], env: { TOKEN: 'x', 'bad-name': 'y', N: 3 }, cwd: ' /tmp ' } }))
    assert.deepEqual(m.mcp, { command: 'npx', args: ['-y', 'srv'], env: { TOKEN: 'x' }, cwd: '/tmp' })
  })
})

describe('skill selection', () => {
  const skills = [validateSkillManifest(manifest()), validateSkillManifest(manifest({ id: 'other', name: 'Other', triggers: ['museum ticket'] }))]

  test('a trigger at a word boundary selects, in install order, with code stripped', () => {
    assert.equal(selectSkill('What does the Trekker 40 cost?', skills)?.skill.id, 'trekker-pricing')
    assert.equal(selectSkill('Museum ticket prices please', skills)?.skill.id, 'other')
    assert.equal(selectSkill('the trekkers walked', skills), null)
    assert.equal(selectSkill('run `trekker` in the shell', skills), null)
    assert.equal(selectSkill('```\ntrekker\n```\nhello', skills), null)
    assert.equal(selectSkill('nothing here', skills), null)
  })

  test('the method block names the skill, carries the description, the method and the helper names', () => {
    const block = buildSkillContext({ id: 'trekker-pricing', name: 'Trekker pricing', description: 'Use when…', playbookText: '1. Search.\n2. Read.', helpers: ['prices.py'] })
    assert.ok(block.startsWith('Method for this kind of question (the user\'s "Trekker pricing" skill'))
    assert.match(block, /1\. Search\.\n2\. Read\./)
    assert.match(block, /trekker-pricing_prices\.py/)
  })

  test('the confirmation lists what the folder carries, names only for environment values', () => {
    const text = describeSkillForConfirmation(validateSkillManifest(manifest({ playbook: 'playbook.md', pack: 'pack', mcp: { command: 'npx', args: ['srv'], env: { TOKEN: 'secret-value' } }, helpers: ['a.py'] })))
    assert.match(text, /2 trigger phrase/)
    assert.match(text, /a method \(playbook\.md\)/)
    assert.match(text, /a library pack \(pack\/\)/)
    assert.match(text, /an MCP server: npx srv; environment: TOKEN \(values not shown\)/)
    assert.ok(!text.includes('secret-value'))
    assert.match(text, /1 Python helper file/)
  })
})

describe('the skill provider', () => {
  const input = (text: string): TurnInput =>
    ({
      convo: { id: 'c', messages: [] },
      conversations: [],
      slot: { id: 's', roleName: 'A', modelId: 'm' },
      slotTools: [],
      lastUserContent: text,
      previousUserContent: undefined,
      offline: false,
      factualTurn: false,
      referenceTurn: false,
      shoppingTurn: false,
      project: null,
      assistantMsgId: 'a',
      signal: new AbortController().signal
    }) as unknown as TurnInput
  const io = (skills: unknown[]) => {
    const patches: Record<string, unknown>[] = []
    const o = {
      async runTool() {
        return { ok: true, output: '' }
      },
      recordSyntheticCall() {},
      api: { skillsList: async () => skills, skillHelpers: async (id: string) => [{ name: `${id}_prices.py`, sourcePath: '/x/prices.py' }] },
      patch(p: Record<string, unknown>) {
        patches.push(p)
      },
      settings: () => ({ grounding: { playbooks: true } })
    } as unknown as ProviderIO
    return { io: o, patches }
  }
  const installed = { ...validateSkillManifest(manifest({ helpers: ['prices.py'] })), playbookText: '1. Search the price.', installedAt: '2026-09-03' }

  test('a fired skill takes the method slot, stands the playbook down, and hands back its helpers', async () => {
    const { io: o, patches } = io([installed])
    const g = await gatherTurnContext([skillProvider, playbookProvider], input('Compare the Trekker 40 to a rival and give a plan'), o)
    assert.equal(g.blocks.length, 1)
    assert.match(g.blocks[0]!, /the user's "Trekker pricing" skill/)
    assert.deepEqual(patches, [{ skill: 'Trekker pricing' }])
    assert.deepEqual(g.attachments, [{ name: 'trekker-pricing_prices.py', sourcePath: '/x/prices.py' }])
  })

  test('no match: the playbook rides as before and nothing is patched', async () => {
    const { io: o, patches } = io([installed])
    const g = await gatherTurnContext([skillProvider, playbookProvider], input('Plan a trip to Lisbon for my family'), o)
    assert.ok(g.blocks.length >= 1)
    assert.ok(g.blocks.every((b) => !b.includes('skill')))
    assert.deepEqual(patches.filter((p) => 'skill' in p), [])
    assert.deepEqual(g.attachments, [])
  })
})

describe('the skill installer', () => {
  const skillsMod = load<typeof import('../src/main/ipc/skills')>('skills')
  const lib = load<typeof import('../src/main/ipc/library')>('library')
  let source = ''
  let libDir = ''

  beforeEach(async () => {
    resetState()
    state.hasWindow = true
    rmSync(join(testUserDataDir(), 'skills'), { recursive: true, force: true })
    libDir = mkdtempSync(join(tmpdir(), 'sigma-skill-lib-'))
    lib.setLibraryDirForTests(libDir)
    source = mkdtempSync(join(tmpdir(), 'sigma-skill-src-'))
    writeFileSync(join(source, 'skill.json'), JSON.stringify(manifest({ playbook: 'playbook.md', pack: 'pack', helpers: ['prices.py'], mcp: { command: 'node', args: ['srv.mjs'], env: { TOKEN: 'v' } } })))
    writeFileSync(join(source, 'playbook.md'), '1. Search the price.\n2. Read the page.')
    writeFileSync(join(source, 'prices.py'), 'def parse(s):\n    return s\n')
    mkdirSync(join(source, 'pack', 'docs'), { recursive: true })
    writeFileSync(join(source, 'pack', 'manifest.json'), JSON.stringify({ formatVersion: 1, id: 'trekker-prices', name: 'Trekker prices', description: 'd', version: '1', license: 'CC0', kind: 'curated', docs: [{ id: 'sheet', title: 'Price sheet', file: 'sheet.md', chars: 0 }] }))
    writeFileSync(join(source, 'pack', 'docs', 'sheet.md'), '# Prices\n\nThe Trekker 40 costs $149.\n')
  })

  test('inspect names what a folder carries without writing anything', async () => {
    const { manifest: m, packId } = await skillsMod.inspectSkillFolder(source)
    assert.equal(m.id, 'trekker-pricing')
    assert.equal(packId, 'trekker-prices')
    assert.deepEqual(await skillsMod.listSkills(), [])
    rmSync(join(source, 'playbook.md'))
    await assert.rejects(() => skillsMod.inspectSkillFolder(source), /method file "playbook.md" is missing/)
  })

  test('install copies the folder, installs the pack, saves the server off, and lists it; remove leaves the pack', async () => {
    const s = await skillsMod.installSkill(source)
    assert.equal(s.id, 'trekker-pricing')
    assert.equal(s.playbookText, '1. Search the price.\n2. Read the page.')
    assert.equal(s.packId, 'trekker-prices')
    assert.equal(s.mcpServerId, 'skill-trekker-pricing')
    assert.ok((await lib.listPacks()).some((p) => p.id === 'trekker-prices'))
    const server = (state.settings as { mcp?: { servers: { id: string; enabled: boolean; approval: string }[] } }).mcp?.servers.find((x) => x.id === 'skill-trekker-pricing')
    assert.equal(server?.enabled, false)
    assert.equal(server?.approval, 'ask')
    const helpers = await skillsMod.skillHelperRefs('trekker-pricing')
    assert.deepEqual(helpers.map((h) => h.name), ['trekker-pricing_prices.py'])
    // the source is not referenced: deleting it changes nothing
    rmSync(source, { recursive: true, force: true })
    assert.equal((await skillsMod.listSkills()).length, 1)
    const r = await skillsMod.removeSkill('trekker-pricing')
    assert.deepEqual(r, { removed: true, packLeft: 'trekker-prices' })
    assert.deepEqual(await skillsMod.listSkills(), [])
    assert.ok((await lib.listPacks()).some((p) => p.id === 'trekker-prices'))
    assert.ok(!(state.settings as { mcp?: { servers: { id: string }[] } }).mcp?.servers.some((x) => x.id === 'skill-trekker-pricing'))
  })
})
