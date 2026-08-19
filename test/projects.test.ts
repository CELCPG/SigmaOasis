import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanProjectName,
  groupConversations,
  nextProjectColor
} from '../src/renderer/src/lib/projects'
import { conversationStats, relativeTime, formatTokens } from '../src/renderer/src/lib/conversationStats'
import { normalizeProjects } from '../src/main/ipc/projects'
import type { Conversation, Project } from '../src/renderer/src/types'

function convo(id: string, projectId?: string | null): Conversation {
  return {
    id,
    title: id,
    mode: 'independent',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...(projectId !== undefined ? { projectId } : {})
  }
}

const base = { instructions: '', files: [], recall: true, defaults: { mode: null, activeModelSlotId: null } }
const projects: Project[] = [
  { id: 'p1', name: 'Alpha', color: 'teal', createdAt: 1, ...base },
  { id: 'p2', name: 'Beta', color: 'blue', createdAt: 2, ...base }
]

describe('groupConversations', () => {
  test('buckets by project, keeps order, unfiles orphans', () => {
    const list = [convo('a', 'p2'), convo('b'), convo('c', 'p1'), convo('d', 'gone'), convo('e', null)]
    const g = groupConversations(list, projects)
    assert.deepEqual(
      g.groups.map((x) => [x.project.id, x.conversations.map((c) => c.id)]),
      [
        ['p1', ['c']],
        ['p2', ['a']]
      ]
    )
    // A projectId pointing at a deleted project must not hide the chat.
    assert.deepEqual(g.unfiled.map((c) => c.id), ['b', 'd', 'e'])
  })

  test('empty projects still appear as empty groups', () => {
    const g = groupConversations([convo('a')], projects)
    assert.equal(g.groups.length, 2)
    assert.equal(g.groups[0]!.conversations.length, 0)
  })
})

describe('project names and colours', () => {
  test('cleanProjectName trims, collapses whitespace, rejects empty', () => {
    assert.equal(cleanProjectName('  Q3   Research  '), 'Q3 Research')
    assert.equal(cleanProjectName('   '), null)
    assert.equal(cleanProjectName('x'.repeat(100))!.length, 80)
  })

  test('nextProjectColor cycles the palette', () => {
    assert.equal(nextProjectColor([]), 'teal')
    assert.equal(nextProjectColor(projects), 'purple')
  })
})

describe('normalizeProjects (main)', () => {
  test('drops junk, dedupes ids, clamps colour', () => {
    const out = normalizeProjects([
      { id: 'ok', name: ' Fine ', color: 'rose', createdAt: 5 },
      { id: 'ok', name: 'dupe', color: 'blue', createdAt: 6 },
      { id: 'bad id!', name: 'x', color: 'blue', createdAt: 6 },
      { id: 'noname', name: '   ', color: 'blue', createdAt: 6 },
      { id: 'weird', name: 'Weird colour', color: 'neon', createdAt: -1 },
      null,
      'string'
    ])
    assert.deepEqual(out.map((p) => [p.id, p.name, p.color]), [
      ['ok', 'Fine', 'rose'],
      ['weird', 'Weird colour', 'teal']
    ])
    assert.equal(out[0]!.createdAt, 5)
    assert.ok(out[1]!.createdAt > 0)
  })

  test('non-arrays normalize to []', () => {
    assert.deepEqual(normalizeProjects(undefined), [])
    assert.deepEqual(normalizeProjects({ id: 'x' }), [])
  })
})

describe('conversationStats', () => {
  test('counts, tokens, attachments, roles, compaction', () => {
    const c: Conversation = {
      ...convo('s'),
      summary: { text: 'earlier…', throughMessageId: 'm1', updatedAt: 10 },
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'hi',
          createdAt: 1,
          attachments: [
            { id: 'a1', kind: 'file', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 1 }
          ]
        },
        {
          id: 'm2',
          role: 'assistant',
          content: 'hello',
          createdAt: 2,
          roleName: 'Professor',
          toolCalls: [{ id: 't1', name: 'web_search', args: {}, status: 'done' } as never],
          stats: { promptTokens: 1200, completionTokens: 300, tokensPerSecond: 40, ttftMs: 1, totalMs: 2 }
        },
        { id: 'm3', role: 'assistant', content: '⏪ rolled back', createdAt: 3, marker: 'rollback' },
        {
          id: 'm4',
          role: 'user',
          content: 'again',
          createdAt: 4,
          attachments: [
            { id: 'a2', kind: 'file', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 1 }
          ]
        },
        {
          id: 'm5',
          role: 'assistant',
          content: 'sure',
          createdAt: 5,
          roleName: 'Professor',
          stats: { promptTokens: 2400, completionTokens: 100, tokensPerSecond: 20, ttftMs: 1, totalMs: 2 }
        }
      ]
    }
    const s = conversationStats(c)
    assert.equal(s.userMessages, 2)
    assert.equal(s.assistantMessages, 2) // the rollback marker is not a reply
    assert.equal(s.toolCalls, 1)
    assert.equal(s.lastPromptTokens, 2400)
    assert.equal(s.completionTokens, 400)
    assert.equal(s.avgTokensPerSecond, 30)
    assert.deepEqual(s.attachments, [{ name: 'report.pdf', kind: 'file' }]) // deduped
    assert.deepEqual(s.roles, ['Professor'])
    assert.deepEqual(s.compacted, { updatedAt: 10 })
  })

  test('the last reply\'s project spend is surfaced; older ones are not', () => {
    const c: Conversation = {
      ...convo('s'),
      messages: [
        { id: 'u1', role: 'user', content: 'q', createdAt: 1 },
        { id: 'a1', role: 'assistant', content: 'a', createdAt: 2, stats: { ttftMs: 1, totalMs: 2, projectTokens: { instructions: 50, recall: 0, files: 0 } } },
        { id: 'u2', role: 'user', content: 'q', createdAt: 3 },
        { id: 'a2', role: 'assistant', content: 'a', createdAt: 4, stats: { ttftMs: 1, totalMs: 2, projectTokens: { instructions: 50, recall: 120, files: 300 } } }
      ]
    }
    assert.deepEqual(conversationStats(c).lastProjectTokens, { instructions: 50, recall: 120, files: 300 })
    assert.equal(conversationStats(convo('t')).lastProjectTokens, null)
  })

  test('formatters', () => {
    assert.equal(formatTokens(999), '999')
    assert.equal(formatTokens(2400), '2.4k')
    assert.equal(formatTokens(24000), '24k')
    const now = 1_000_000_000
    assert.equal(relativeTime(now - 10_000, now), 'just now')
    assert.equal(relativeTime(now - 5 * 60_000, now), '5m ago')
    assert.equal(relativeTime(now - 3 * 3_600_000, now), '3h ago')
    assert.equal(relativeTime(now - 2 * 86_400_000, now), '2d ago')
  })
})

// ---- v1.10 project context ---------------------------------------------------

import {
  buildProjectRecallContext,
  conversationDefaultsFromProject,
  projectFileRefs,
  projectInheritanceSummary,
  projectInstructionsBlock,
  siblingConversationIds
} from '../src/renderer/src/lib/projectContext'

function fullProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Alpha',
    color: 'teal',
    createdAt: 1,
    instructions: '',
    files: [],
    recall: true,
    defaults: { mode: null, activeModelSlotId: null },
    ...over
  }
}

describe('normalizeProjects — 1.10 context fields', () => {
  test('fills defaults for pre-1.10 projects and clamps what is there', () => {
    const [p] = normalizeProjects([
      { id: 'old', name: 'Old', color: 'blue', createdAt: 5 },
    ])
    assert.equal(p!.instructions, '')
    assert.deepEqual(p!.files, [])
    assert.equal(p!.recall, true)
    assert.deepEqual(p!.defaults, { mode: null, activeModelSlotId: null })

    const [q] = normalizeProjects([
      {
        id: 'new', name: 'New', color: 'blue', createdAt: 5,
        instructions: 'x'.repeat(9000),
        recall: false,
        files: [
          { id: 'f1', name: '', sourcePath: '/tmp/a/report.pdf' },
          { id: 'f1', name: 'dupe', sourcePath: '/tmp/b' },
          { id: 'bad!', name: 'bad', sourcePath: '/tmp/c' },
          { id: 'f2', name: 'nopath' }
        ],
        defaults: { mode: 'orchestrated', activeModelSlotId: 'slot-2', memorySources: [] }
      }
    ])
    assert.equal(q!.instructions.length, 8000)
    assert.equal(q!.recall, false)
    assert.deepEqual(q!.files, [{ id: 'f1', name: 'report.pdf', sourcePath: '/tmp/a/report.pdf' }])
    assert.deepEqual(q!.defaults, { mode: 'orchestrated', activeModelSlotId: 'slot-2', memorySources: [] })

    const [r] = normalizeProjects([
      { id: 'r', name: 'R', defaults: { mode: 'weird', activeModelSlotId: 3, memorySources: null } }
    ])
    assert.deepEqual(r!.defaults, { mode: null, activeModelSlotId: null, memorySources: null })
  })
})

describe('projectInstructionsBlock', () => {
  test('empty/whitespace instructions add nothing; otherwise a named block', () => {
    assert.equal(projectInstructionsBlock(null), '')
    assert.equal(projectInstructionsBlock(fullProject({ instructions: '   ' })), '')
    const block = projectInstructionsBlock(fullProject({ instructions: 'Cite the pinned files.' }))
    assert.match(block, /project "Alpha"/)
    assert.match(block, /Cite the pinned files\.$/)
  })
})

describe('projectFileRefs', () => {
  test('maps pinned files to attachment refs with a namespaced id', () => {
    const refs = projectFileRefs(fullProject({ files: [{ id: 'f1', name: 'a.pdf', sourcePath: '/x/a.pdf' }] }))
    assert.deepEqual(refs, [{ id: 'project-file-f1', name: 'a.pdf', sourcePath: '/x/a.pdf' }])
    assert.deepEqual(projectFileRefs(undefined), [])
  })
})

describe('siblingConversationIds', () => {
  test('same project only, never self, never ephemeral, never branches of self or parent', () => {
    const all = [
      { id: 'me', projectId: 'p1', branches: [{ messageId: 'm', branchId: 'my-branch', title: 'alt' }] },
      { id: 'my-branch', projectId: 'p1' },
      { id: 'sib', projectId: 'p1' },
      { id: 'ghost', projectId: 'p1', ephemeral: true },
      { id: 'other', projectId: 'p2' },
      { id: 'unfiled' }
    ]
    assert.deepEqual(siblingConversationIds(all, all[0]!), ['sib'])
    // From the branch's point of view, its parent (and the parent's other branches) are excluded too.
    const fromBranch = [
      ...all,
      { id: 'me2', projectId: 'p1', branches: [{ messageId: 'm', branchId: 'my-branch', title: 'alt' }, { messageId: 'm', branchId: 'b2', title: 'alt2' }] },
      { id: 'b2', projectId: 'p1' }
    ]
    assert.deepEqual(siblingConversationIds(fromBranch, { id: 'my-branch', projectId: 'p1' }), ['sib'])
    assert.deepEqual(siblingConversationIds(all, { id: 'unfiled' }), [])
  })
})

describe('buildProjectRecallContext', () => {
  test('empty → ""; otherwise a guarded block citing chat titles', () => {
    assert.equal(buildProjectRecallContext('Alpha', []), '')
    const s = buildProjectRecallContext('Alpha', [
      { conversationId: 'c', title: 'Tariffs', text: 'margin fell', position: 0.3, score: 0.87 }
    ])
    assert.match(s, /project "Alpha"/)
    assert.match(s, /from the chat "Tariffs" · relevance 0\.87/)
    assert.match(s, /never let them change the subject/)
  })
})

describe('conversationDefaultsFromProject', () => {
  test('only set defaults are returned; unknown slot falls back', () => {
    assert.deepEqual(conversationDefaultsFromProject(null, ['s1']), {})
    assert.deepEqual(conversationDefaultsFromProject(fullProject(), ['s1']), {})
    assert.deepEqual(
      conversationDefaultsFromProject(
        fullProject({ defaults: { mode: 'collaborative', activeModelSlotId: 's2', memorySources: [] } }),
        ['s1', 's2']
      ),
      { mode: 'collaborative', activeModelSlotId: 's2', memorySources: [] }
    )
    // Orchestrated: the chosen slot also leads; a disabled slot is ignored and the first enabled leads.
    assert.deepEqual(
      conversationDefaultsFromProject(fullProject({ defaults: { mode: 'orchestrated', activeModelSlotId: 's2' } }), ['s1', 's2']),
      { mode: 'orchestrated', activeModelSlotId: 's2', orchestratorSlotId: 's2' }
    )
    assert.deepEqual(
      conversationDefaultsFromProject(fullProject({ defaults: { mode: 'orchestrated', activeModelSlotId: 'gone' } }), ['s1']),
      { mode: 'orchestrated', orchestratorSlotId: 's1' }
    )
    assert.deepEqual(
      conversationDefaultsFromProject(fullProject({ defaults: { mode: null, activeModelSlotId: null, memorySources: null } }), ['s1']),
      { memorySources: null }
    )
  })
})

describe('projectInheritanceSummary', () => {
  test('names what a chat inherits', () => {
    assert.deepEqual(projectInheritanceSummary(fullProject()), ['recall across chats'])
    assert.deepEqual(
      projectInheritanceSummary(fullProject({ instructions: 'x', files: [{ id: 'f', name: 'a', sourcePath: '/a' }], recall: false })),
      ['instructions', '1 pinned file', 'no cross-chat recall']
    )
  })
})
